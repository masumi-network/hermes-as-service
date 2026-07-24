import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { parseChatCompletion } from '../llm/hermes-chat.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { safeNextRun } from './cron.js';
import { recordEvent } from '../audit.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';

/** Public so tests / admin endpoints can trigger a tick on demand. */
export async function runDueOnce(): Promise<number> {
  // Rows overdue by MORE than an hour are re-armed to their next occurrence
  // WITHOUT dispatching. The orchestrator scheduler is normally disabled
  // (native machine cron is THE scheduler), so rows can sit overdue for
  // weeks — dispatching that backlog on an admin "run now" would fire
  // dozens of paid agent turns + off-hours messages at once; but silently
  // ignoring them would strand the rows forever (nextRunAt is only ever
  // advanced here). Skip-and-re-arm keeps them alive and cheap.
  const stale = await prisma.scheduledTask.findMany({
    where: {
      enabled: true,
      nextRunAt: { lt: new Date(Date.now() - 60 * 60_000) },
      kind: { in: ['user', 'system_prompt'] },
    },
    select: { id: true, cronExpr: true, timezone: true },
    take: 200,
  });
  for (const row of stale) {
    const next = safeNextRun(row.cronExpr, row.timezone, new Date());
    await prisma.scheduledTask
      .update({ where: { id: row.id }, data: next ? { nextRunAt: next } : { enabled: false, lastError: 'invalid cron expression' } })
      .catch(() => {});
  }

  const due = await prisma.scheduledTask.findMany({
    where: {
      enabled: true,
      // Due within the last hour ONLY — older rows were just re-armed above.
      nextRunAt: { lte: new Date(), gte: new Date(Date.now() - 60 * 60_000) },
      // system_sweep rows are informational mirrors of orchestrator-level
      // background sweeps — they don't dispatch a prompt themselves.
      kind: { in: ['user', 'system_prompt'] },
    },
    take: 50,
    include: { instance: true },
  });
  if (due.length === 0) return 0;
  logger.info({ count: due.length }, 'scheduler_firing');

  // Run sequentially per instance to avoid hammering one sprite; cross-
  // instance parallelism is fine.
  const byInstance = new Map<string, typeof due>();
  for (const t of due) {
    const arr = byInstance.get(t.instanceId) ?? [];
    arr.push(t);
    byInstance.set(t.instanceId, arr);
  }
  await Promise.allSettled(
    Array.from(byInstance.values()).map((tasks) =>
      tasks.reduce<Promise<void>>(
        (chain, task) => chain.then(() => runOne(task).catch(() => undefined)),
        Promise.resolve(),
      ),
    ),
  );
  return due.length;
}

type Task = Awaited<ReturnType<typeof prisma.scheduledTask.findMany>>[number] & {
  instance: {
    id: string;
    userId: string;
    spriteName: string;
    endpointUrl: string | null;
    apiServerKey: string;
    sokosumiEnv: string | null;
  };
};

async function runOne(task: Task): Promise<void> {
  const log = logger.child({ taskId: task.id, userId: task.userId, name: task.name });
  const t0 = Date.now();

  // Advance nextRunAt FIRST so a crash here doesn't cause infinite retries.
  const next = safeNextRun(task.cronExpr, task.timezone, new Date());
  if (!next) {
    log.warn('invalid cron — disabling');
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { enabled: false, lastError: 'invalid cron expression' },
    });
    return;
  }

  const instance = task.instance;
  if (!instance.endpointUrl) {
    log.warn('instance has no endpoint — skipping');
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: next, lastError: 'no endpoint' },
    });
    return;
  }

  const requestId = randomUUID();
  let apiServerKey: string;
  try {
    apiServerKey = await decryptSecret(instance.apiServerKey);
  } catch (err) {
    log.error({ err }, 'apiserverkey_decrypt_failed');
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: next, lastError: 'decrypt failed' },
    });
    return;
  }

  // Persist the synthetic user-side message first so the dashboard shows the
  // attribution even if the call hangs.
  await prisma.chatMessage.create({
    data: {
      instanceId: instance.id,
      userId: instance.userId,
      requestId,
      role: 'user',
      content: task.prompt,
      kind: 'scheduled',
      scheduledTaskId: task.id,
    },
  });

  // Call Hermes the same way Sokosumi would (direct to sprite endpoint).
  // We do NOT go through the orchestrator's chat proxy here — that proxy
  // also captures messages and we'd get duplicate rows.
  let response: Response | null = null;
  let respText = '';
  try {
    response = await fetch(`${instance.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiServerKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: task.prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    respText = await response.text();
  } catch (err) {
    log.error({ err }, 'scheduled_call_failed');
    await prisma.chatMessage.create({
      data: {
        instanceId: instance.id,
        userId: instance.userId,
        requestId,
        role: 'assistant',
        content: '',
        kind: 'scheduled',
        scheduledTaskId: task.id,
        errorMessage: err instanceof Error ? err.message : 'fetch failed',
        latencyMs: Date.now() - t0,
      },
    });
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: next, lastRunAt: new Date(), lastError: err instanceof Error ? err.message : 'fetch failed' },
    });
    await recordEvent({ userId: instance.userId, instanceId: instance.id, event: 'chat_failed', detail: { scheduledTaskId: task.id, source: 'scheduler' } });
    return;
  }

  const parsed = parseChatCompletion(respText);
  const { content, model, promptTokens, completionTokens, totalTokens, finishReason } = parsed;
  let errorMessage = parsed.errorMessage;
  if (response && response.status >= 400 && !errorMessage) {
    errorMessage = `upstream_${response.status}`;
  }

  await prisma.chatMessage.create({
    data: {
      instanceId: instance.id,
      userId: instance.userId,
      requestId,
      role: 'assistant',
      content,
      kind: 'scheduled',
      scheduledTaskId: task.id,
      model: model ?? undefined,
      promptTokens: promptTokens ?? undefined,
      completionTokens: completionTokens ?? undefined,
      totalTokens: totalTokens ?? undefined,
      finishReason: finishReason ?? undefined,
      latencyMs: Date.now() - t0,
      errorMessage: errorMessage ?? undefined,
    },
  });

  await prisma.scheduledTask.update({
    where: { id: task.id },
    data: { nextRunAt: next, lastRunAt: new Date(), lastError: errorMessage ?? null },
  });

  await prisma.hermesInstance.update({
    where: { id: instance.id },
    data: { lastActivityAt: new Date() },
  });

  // Push the result to the user's outbox so Sokosumi's poll picks it up.
  // Skip on errors with empty content, and drop quiet acknowledgements —
  // same sentinel set the machine's cron-outbox-bridge discards, so both
  // delivery paths behave identically and "ok" never reaches the chat.
  const QUIET_ACKS = new Set(['', 'ok', 'ok.', 'done', 'done.', '[silent]', '[noop]', '[none]', '[noreply]']);
  const isQuietAck = QUIET_ACKS.has(content.trim().toLowerCase());
  if (content && !isQuietAck) {
    await enqueueOutboxMessage({
      instanceId: instance.id,
      userId: instance.userId,
      content,
      kind: 'task_result',
    }).catch((err) => log.warn({ err }, 'scheduled_outbox_enqueue_failed'));
  }

  await recordEvent({
    userId: instance.userId,
    instanceId: instance.id,
    event: errorMessage ? 'chat_failed' : 'chat_proxied',
    detail: { scheduledTaskId: task.id, source: 'scheduler', latencyMs: Date.now() - t0 },
  });

  log.info({ latencyMs: Date.now() - t0, errorMessage }, 'scheduled_task_done');
}
