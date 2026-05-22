import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { safeNextRun } from './cron.js';
import { recordEvent } from '../audit.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';

let scheduled: cron.ScheduledTask | null = null;

/** Wires the orchestrator-level scheduled-task runner. Runs every minute. */
export function startScheduler(): void {
  if (scheduled) return;
  scheduled = cron.schedule('* * * * *', () => {
    void runDueOnce().catch((err) => logger.error({ err }, 'scheduler_tick_failed'));
  });
  logger.info('scheduler_started');
}

export function stopScheduler(): void {
  scheduled?.stop();
  scheduled = null;
}

/** Public so tests / admin endpoints can trigger a tick on demand. */
export async function runDueOnce(): Promise<number> {
  const due = await prisma.scheduledTask.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: new Date() },
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

  // Mirror this firing as a Sokosumi task on the user's personal scope
  // when the env supports it (preprod today). Silent no-op everywhere
  // else. The cron runs regardless of whether the mirror succeeds.
  const { startCronTask } = await import('./cron-task-logger.js');
  const cronTask = await startCronTask({
    userId: instance.userId,
    sokosumiEnv: instance.sokosumiEnv,
    cronName: task.name,
    cronExpr: task.cronExpr,
    prompt: task.prompt,
  }).catch((err) => {
    log.warn({ err }, 'cron_task_mirror_start_failed');
    return null;
  });
  await cronTask?.markRunning();

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
    await cronTask?.markFailed(err instanceof Error ? err.message : 'fetch failed');
    return;
  }

  let content = '';
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;
  try {
    const json = JSON.parse(respText) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
      error?: { message?: string };
    };
    if (json.error?.message) errorMessage = json.error.message;
    content = json.choices?.[0]?.message?.content ?? '';
    finishReason = json.choices?.[0]?.finish_reason ?? null;
    model = json.model ?? null;
    promptTokens = json.usage?.prompt_tokens ?? null;
    completionTokens = json.usage?.completion_tokens ?? null;
    totalTokens = json.usage?.total_tokens ?? null;
  } catch {
    content = respText.slice(0, 4000);
    errorMessage = 'unparseable_response';
  }
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
  // Skip on errors with empty content — no point notifying the user about
  // an internal failure (it shows in the admin dashboard instead).
  if (content) {
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

  // Finalise the Sokosumi task mirror with the result (or the error).
  if (errorMessage) {
    await cronTask?.markFailed(errorMessage);
  } else {
    const summary =
      content.length > 0
        ? content
        : '(cron ran but produced no chat output — likely a silent acknowledgement)';
    await cronTask?.markCompleted(summary);
  }

  log.info({ latencyMs: Date.now() - t0, errorMessage, cronTaskMirrored: !!cronTask }, 'scheduled_task_done');
}
