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
  // Dedup: if an identical proposal (same tool + same args) is already pending
  // for this user, return it instead of stacking a duplicate confirmation card.
  // Guards against a retrying agent and the background input-responder
  // re-prompting the same paused job before the user has approved.
  const argsJson = JSON.stringify(input.toolArgs ?? {});
  const pending = await prisma.pendingConfirmation.findMany({
    where: { userId: input.userId, toolName: input.toolName, status: 'pending' },
    select: { id: true, summary: true, toolArgs: true },
    take: 50,
  });
  const dup = pending.find((p) => JSON.stringify(p.toolArgs ?? {}) === argsJson);
  if (dup) {
    logger.info(
      { userId: input.userId, toolName: input.toolName, confirmationId: dup.id },
      'pending_confirmation_deduped',
    );
    return { id: dup.id, summary: dup.summary };
  }
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
  /** First-class fields for a created task, so the UI needn't parse `resultText`. */
  taskId?: string;
  taskStatus?: string;
  taskTitle?: string;
  coworker?: string;
}

/**
 * Pull the created task's id/status/coworker out of a sokosumi_create_task
 * result so the approve response can expose them as first-class fields. The
 * result text is the JSON `executeTool` returns:
 *   { scope, assignedTo:{name,...}, task:{ id, status, ... } }
 * Returns {} for other tools or anything unparseable — best-effort.
 */
export function extractTaskRef(
  toolName: string,
  resultText: string | undefined,
): { taskId?: string; taskStatus?: string; taskTitle?: string; coworker?: string } {
  if (toolName !== 'sokosumi_create_task' || !resultText) return {};
  try {
    const parsed = JSON.parse(resultText) as {
      task?: { id?: unknown; status?: unknown; name?: unknown };
      assignedTo?: { name?: unknown };
    };
    const out: { taskId?: string; taskStatus?: string; taskTitle?: string; coworker?: string } = {};
    if (typeof parsed.task?.id === 'string') out.taskId = parsed.task.id;
    if (typeof parsed.task?.status === 'string') out.taskStatus = parsed.task.status;
    if (typeof parsed.task?.name === 'string') out.taskTitle = parsed.task.name;
    if (typeof parsed.assignedTo?.name === 'string') out.coworker = parsed.assignedTo.name;
    return out;
  } catch {
    return {};
  }
}

/**
 * Optional patches applied to the queued tool args at approve time. The
 * Sokosumi UI surfaces these as inline controls in the confirmation card
 * (e.g. an org dropdown when the proposed tool is org-aware), so the user
 * can redirect a proposal without rejecting it.
 *
 * Forward-compatible: extra keys are tolerated and silently dropped.
 */
export interface ApprovalOverrides {
  /**
   * organizationId override. `string` substitutes the id into the args.
   * `null` means "personal scope" — the key is removed from the args so
   * the tool's no-org path applies. Distinct from `undefined`, which is
   * "no override, run with whatever Hermes proposed."
   */
  organizationId?: string | null;
}

/** Tools whose `organization_id` arg can be replaced at approve time.
 *  Anything not in this set silently drops the override (so the UI can
 *  evolve without breaking the orchestrator). */
const ORG_AWARE_TOOLS = new Set<string>([
  'sokosumi_create_task',
  'sokosumi_create_job',
]);

/**
 * Apply approve-time overrides to the queued tool args. Pure — returns a
 * shallow copy with the substitutions applied, doesn't mutate the
 * original. Logs every applied / dropped override at info level so we
 * can audit "Hermes filed it in the wrong workspace" complaints.
 */
export function _applyApprovalOverridesForTests(
  toolName: string,
  args: Record<string, unknown>,
  overrides: ApprovalOverrides | undefined,
): Record<string, unknown> {
  return applyApprovalOverrides(toolName, args, overrides, {
    instanceId: 'test',
    confirmationId: 'test',
  });
}

function applyApprovalOverrides(
  toolName: string,
  args: Record<string, unknown>,
  overrides: ApprovalOverrides | undefined,
  ctx: { instanceId: string; confirmationId: string },
): Record<string, unknown> {
  if (!overrides) return args;
  if (!('organizationId' in overrides)) return args;
  if (!ORG_AWARE_TOOLS.has(toolName)) {
    logger.info(
      { ...ctx, toolName, overrideKey: 'organizationId' },
      'approval_override_ignored_tool_not_org_aware',
    );
    return args;
  }
  // For null we KEEP organization_id present but set to null so the
  // downstream dispatcher can distinguish "user explicitly chose
  // personal scope" (null) from "Hermes didn't propose an org and the
  // user didn't override either" (undefined / absent). Stripping the
  // key collapses those two cases and the dispatcher falls back to
  // iterate-orgs, which is wrong for an explicit personal click.
  const next = { ...args };
  next['organization_id'] = overrides.organizationId;
  logger.info(
    {
      ...ctx,
      toolName,
      from: args['organization_id'] ?? null,
      to: overrides.organizationId,
    },
    'approval_override_applied',
  );
  return next;
}

/**
 * Approve a pending confirmation: execute the stored tool call, persist
 * the result, push an outbox message back to Hermes so its next chat turn
 * sees the resolution.
 *
 * Idempotent: re-approving an already-resolved row is a no-op that
 * returns the original result.
 *
 * `overrides` patches the queued tool args before execution — see
 * ApprovalOverrides. Used by Sokosumi's UI to redirect a proposed task or
 * job into a different workspace without rejecting + re-prompting.
 */
export async function approveConfirmation(
  userId: string,
  confirmationId: string,
  overrides?: ApprovalOverrides,
): Promise<ApproveResult> {
  const row = await prisma.pendingConfirmation.findFirst({
    where: { id: confirmationId, userId },
  });
  if (!row) return { ok: false, status: 'not_found' };
  if (row.status !== 'pending') {
    const priorText =
      row.resultPayload && typeof row.resultPayload === 'object' && 'text' in row.resultPayload
        ? String((row.resultPayload as { text?: unknown }).text ?? '')
        : typeof row.resultPayload === 'string'
          ? row.resultPayload
          : row.resultPayload
            ? JSON.stringify(row.resultPayload)
            : undefined;
    return {
      ok: row.status === 'approved',
      status: row.status === 'approved' ? 'approved' : 'already_resolved',
      resultText: priorText,
      errorMessage: row.errorMessage ?? undefined,
      ...extractTaskRef(row.toolName, priorText),
    };
  }

  // Resolve the user's CURRENT live instance. The confirmation may have been
  // orphaned (instanceId = null) by a prior instance destroy — we run against
  // whatever instance is live now and re-bind the row to it below.
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    await prisma.pendingConfirmation.update({
      where: { id: row.id },
      data: { status: 'errored', resolvedAt: new Date(), errorMessage: 'no live instance to execute' },
    });
    return { ok: false, status: 'errored', errorMessage: 'no live instance to execute' };
  }

  const { executeTool } = await import('../routes/sokosumi-mcp.js');
  const { isValidSokosumiEnv } = await import('../config.js');
  const ctx: InstanceContext = {
    instanceId: instance.id,
    userId: instance.userId,
    env: isValidSokosumiEnv(instance.sokosumiEnv) ? instance.sokosumiEnv : null,
    autonomyLevel: 'high', // bypass the medium gate now that the user approved
  };

  const effectiveArgs = applyApprovalOverrides(
    row.toolName,
    row.toolArgs as Record<string, unknown>,
    overrides,
    { instanceId: instance.id, confirmationId: row.id },
  );

  let resultText: string;
  let errored = false;
  let errorMessage: string | undefined;
  try {
    resultText = await executeTool(row.toolName, effectiveArgs, ctx);
  } catch (err) {
    errored = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    resultText = JSON.stringify({ error: errorMessage });
  }

  await prisma.pendingConfirmation.update({
    where: { id: row.id },
    data: {
      instanceId: instance.id, // re-bind in case it was orphaned by a prior destroy
      status: errored ? 'errored' : 'approved',
      resolvedAt: new Date(),
      resolvedBy: 'user',
      resultPayload: { text: resultText } as object,
      errorMessage: errorMessage ?? null,
    },
  });

  // Push to the outbox. This lands in the user's chat — often a minute+
  // after approval, once they've scrolled on — so it MUST stand on its own:
  // lead with the task title + status, not read as a reply to whatever they
  // just typed. Sokosumi renders the trailing JSON as the /tasks/:id card.
  try {
    const { enqueueOutboxMessage } = await import('../outbox/enqueue.js');
    const ref = extractTaskRef(row.toolName, resultText);
    const argName = (row.toolArgs as Record<string, unknown>)?.['name'];
    const title = ref.taskTitle ?? (typeof argName === 'string' ? argName : undefined);
    let head: string;
    if (errored) {
      head = title
        ? `Heads-up — the task you approved earlier, "${title}", couldn't be created: ${errorMessage}.`
        : `Heads-up — your approved ${row.toolName} request couldn't be completed: ${errorMessage}.`;
    } else if (row.toolName === 'sokosumi_create_task' && title) {
      const status = ref.taskStatus ? ` (${ref.taskStatus})` : '';
      const who = ref.coworker ? ` for ${ref.coworker}` : '';
      head = `Here's the task you set up earlier${who} — "${title}"${status}. It's ready to view.`;
    } else {
      head = `Done — your earlier ${row.toolName} request was approved and completed.`;
    }
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
    ...(errored ? {} : extractTaskRef(row.toolName, resultText)),
  };
}

export async function rejectConfirmation(
  userId: string,
  confirmationId: string,
  reason?: string,
): Promise<{ ok: boolean; status: 'rejected' | 'not_found' | 'already_resolved' }> {
  const row = await prisma.pendingConfirmation.findFirst({
    where: { id: confirmationId, userId },
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

  // Tell the user's current live instance (if any) so the next turn knows.
  try {
    const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
    if (instance && !instance.destroyedAt) {
      const { enqueueOutboxMessage } = await import('../outbox/enqueue.js');
      const reasonText = reason ? ` Reason: "${reason}".` : '';
      await enqueueOutboxMessage({
        instanceId: instance.id,
        userId,
        kind: 'confirmation_resolved',
        content: `The user rejected your earlier ${row.toolName} request.${reasonText} Do not retry the same call. Ask them what they'd prefer instead, or move on.`,
      });
    }
  } catch (err) {
    logger.warn({ err, confirmationId }, 'confirmation_outbox_enqueue_failed');
  }

  return { ok: true, status: 'rejected' };
}

/** Pull the workspace the agent proposed for an org-aware tool call out of
 *  the stored args. Returns null for personal-scope or non-org tools. The
 *  Sokosumi UI uses this to pre-select the confirmation card's workspace
 *  dropdown to what Hermes actually chose (instead of defaulting to
 *  Personal and clobbering it on approve). */
function extractOrganizationId(toolArgs: unknown): string | null {
  if (toolArgs && typeof toolArgs === 'object' && 'organization_id' in toolArgs) {
    const v = (toolArgs as Record<string, unknown>)['organization_id'];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}

export async function listPendingConfirmations(userId: string): Promise<
  Array<{
    id: string;
    toolName: string;
    summary: string;
    createdAt: string;
    /** Workspace Hermes proposed for this action (null = personal scope or
     *  not an org-aware tool). The org NAME is resolved separately by the
     *  route that needs it (avoids a network call on every list). */
    organizationId: string | null;
  }>
> {
  const rows = await prisma.pendingConfirmation.findMany({
    where: { userId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, toolName: true, summary: true, createdAt: true, toolArgs: true },
  });
  return rows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    organizationId: extractOrganizationId(r.toolArgs),
  }));
}
