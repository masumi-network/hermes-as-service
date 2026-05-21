import { prisma } from '../db.js';
import { logger } from '../logger.js';
import type { InstanceContext } from '../routes/sokosumi-mcp.js';

interface CreateInput {
  instanceId: string;
  userId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  summary: string;
}

export async function createPendingConfirmation(
  input: CreateInput,
): Promise<{ id: string; summary: string }> {
  const row = await prisma.pendingConfirmation.create({
    data: {
      instanceId: input.instanceId,
      userId: input.userId,
      toolName: input.toolName,
      toolArgs: input.toolArgs as object,
      summary: input.summary.slice(0, 1000),
      status: 'pending',
    },
  });
  logger.info(
    {
      instanceId: input.instanceId,
      userId: input.userId,
      toolName: input.toolName,
      confirmationId: row.id,
    },
    'pending_confirmation_created',
  );
  return { id: row.id, summary: row.summary };
}

/**
 * Best-effort human-readable summary of a tool call. The Sokosumi UI
 * renders this in the confirmation box body. Hermes sees the same string
 * in the tool response, so it can repeat the same wording in chat.
 *
 * Currently rule-based per tool — keeps it predictable and fast. If we
 * later want a model-generated summary, swap this for an LLM call.
 */
export async function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: InstanceContext,
): Promise<string> {
  switch (toolName) {
    case 'sokosumi_create_task': {
      const taskName = String(args['name'] ?? '(unnamed)').slice(0, 120);
      const coworkerId = String(args['coworker_id'] ?? '(unspecified)');
      return `Create a new task "${taskName}" and assign it to coworker ${coworkerId}.`;
    }
    case 'sokosumi_create_job': {
      const agentId = String(args['agent_id'] ?? '(unspecified)');
      const taskId = String(args['task_id'] ?? '(unspecified)');
      return `Start a Sokosumi agent job: agent=${agentId} task=${taskId}. This will spend credits.`;
    }
    case 'sokosumi_add_task_comment': {
      const taskId = String(args['task_id'] ?? '(unspecified)');
      const comment = String(args['comment'] ?? '');
      const snippet = comment.length > 140 ? comment.slice(0, 140) + '…' : comment;
      return `Post a comment on task ${taskId}: "${snippet}".`;
    }
    case 'sokosumi_provide_job_input': {
      const jobId = String(args['job_id'] ?? '(unspecified)');
      return `Provide input to job ${jobId} so it can continue.`;
    }
    case 'sokosumi_refund_job': {
      const jobId = String(args['job_id'] ?? '(unspecified)');
      return `Request a refund for failed job ${jobId}.`;
    }
    default:
      return `Run ${toolName} with arguments: ${JSON.stringify(args).slice(0, 240)}`;
  }
  // ctx reserved for future per-env summary tweaks
  void ctx;
}

interface ApproveResult {
  ok: boolean;
  status: 'approved' | 'errored' | 'not_found' | 'already_resolved';
  resultText?: string;
  errorMessage?: string;
}

/**
 * Approve a pending confirmation: execute the stored tool call, persist
 * the result, push an outbox message back to Hermes so its next chat turn
 * sees the resolution.
 *
 * Idempotent: re-approving an already-resolved row is a no-op that
 * returns the original result.
 */
export async function approveConfirmation(
  instanceId: string,
  confirmationId: string,
): Promise<ApproveResult> {
  const row = await prisma.pendingConfirmation.findFirst({
    where: { id: confirmationId, instanceId },
  });
  if (!row) return { ok: false, status: 'not_found' };
  if (row.status !== 'pending') {
    return {
      ok: row.status === 'approved',
      status: row.status === 'approved' ? 'approved' : 'already_resolved',
      resultText:
        typeof row.resultPayload === 'string'
          ? row.resultPayload
          : row.resultPayload
            ? JSON.stringify(row.resultPayload)
            : undefined,
      errorMessage: row.errorMessage ?? undefined,
    };
  }

  const instance = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!instance || instance.destroyedAt) {
    await prisma.pendingConfirmation.update({
      where: { id: row.id },
      data: { status: 'errored', resolvedAt: new Date(), errorMessage: 'instance gone' },
    });
    return { ok: false, status: 'errored', errorMessage: 'instance gone' };
  }

  const { executeTool } = await import('../routes/sokosumi-mcp.js');
  const { isValidSokosumiEnv } = await import('../config.js');
  const ctx: InstanceContext = {
    instanceId: instance.id,
    userId: instance.userId,
    env: isValidSokosumiEnv(instance.sokosumiEnv) ? instance.sokosumiEnv : null,
    autonomyLevel: 'high', // bypass the medium gate now that the user approved
  };

  let resultText: string;
  let errored = false;
  let errorMessage: string | undefined;
  try {
    resultText = await executeTool(row.toolName, row.toolArgs as Record<string, unknown>, ctx);
  } catch (err) {
    errored = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    resultText = JSON.stringify({ error: errorMessage });
  }

  await prisma.pendingConfirmation.update({
    where: { id: row.id },
    data: {
      status: errored ? 'errored' : 'approved',
      resolvedAt: new Date(),
      resolvedBy: 'user',
      resultPayload: { text: resultText } as object,
      errorMessage: errorMessage ?? null,
    },
  });

  // Push a follow-up message to Hermes' outbox so the next chat turn
  // sees the resolution and can act on it.
  try {
    const { enqueueOutboxMessage } = await import('../outbox/enqueue.js');
    const head = errored
      ? `Your earlier ${row.toolName} call was approved by the user but failed when executed: ${errorMessage}`
      : `The user approved your earlier ${row.toolName} request. The action was executed; here's the result you can act on:`;
    await enqueueOutboxMessage({
      instanceId: instance.id,
      userId: instance.userId,
      kind: 'confirmation_resolved',
      content: `${head}\n\n${resultText.slice(0, 4000)}`,
    });
  } catch (err) {
    logger.warn({ err, confirmationId }, 'confirmation_outbox_enqueue_failed');
  }

  return {
    ok: !errored,
    status: errored ? 'errored' : 'approved',
    resultText,
    errorMessage,
  };
}

export async function rejectConfirmation(
  instanceId: string,
  confirmationId: string,
  reason?: string,
): Promise<{ ok: boolean; status: 'rejected' | 'not_found' | 'already_resolved' }> {
  const row = await prisma.pendingConfirmation.findFirst({
    where: { id: confirmationId, instanceId },
  });
  if (!row) return { ok: false, status: 'not_found' };
  if (row.status !== 'pending') return { ok: true, status: 'already_resolved' };

  await prisma.pendingConfirmation.update({
    where: { id: row.id },
    data: {
      status: 'rejected',
      resolvedAt: new Date(),
      resolvedBy: 'user',
      errorMessage: reason ? reason.slice(0, 500) : null,
    },
  });

  try {
    const { enqueueOutboxMessage } = await import('../outbox/enqueue.js');
    const reasonText = reason ? ` Reason: "${reason}".` : '';
    await enqueueOutboxMessage({
      instanceId,
      userId: row.userId,
      kind: 'confirmation_resolved',
      content: `The user rejected your earlier ${row.toolName} request.${reasonText} Do not retry the same call. Ask them what they'd prefer instead, or move on.`,
    });
  } catch (err) {
    logger.warn({ err, confirmationId }, 'confirmation_outbox_enqueue_failed');
  }

  return { ok: true, status: 'rejected' };
}

export async function listPendingConfirmations(instanceId: string): Promise<
  Array<{
    id: string;
    toolName: string;
    summary: string;
    createdAt: string;
  }>
> {
  const rows = await prisma.pendingConfirmation.findMany({
    where: { instanceId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, toolName: true, summary: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));
}
