import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient, resolveSokosumiTarget } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

/**
 * Listener for Sokosumi tasks assigned to the Hermes coworker on a
 * user's PERSONAL scope. When a user creates such a task (status=READY,
 * coworker=hermes, scope=owned), Hermes picks it up, runs the
 * description as a chat prompt, posts the result as a comment, and
 * marks the task COMPLETED.
 *
 * Gated to preprod only — same env policy as the cron-task mirror.
 *
 * De-dup: we only pick up tasks in status READY. Once Hermes accepts,
 * the task moves to RUNNING (then COMPLETED or FAILED), so it never
 * gets re-picked. Cron-mirror tasks created by the orchestrator (name
 * prefixed with "Cron · ") are skipped — those are written by us, not
 * the user, and have their own lifecycle.
 */

const ENABLED_ENVS: SokosumiEnv[] = ['preprod'];
const MAX_TASKS_PER_TICK = 3; // cap per instance per sweep
const CRON_MIRROR_PREFIX = 'Cron · ';

export async function runHermesExecutorForInstance(
  instanceId: string,
): Promise<{ executed: number; scanned: number }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { executed: 0, scanned: 0 };
  if (!row.endpointUrl) return { executed: 0, scanned: 0 };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { executed: 0, scanned: 0 };
  }
  const rawEnv: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  const effectiveEnv = resolveSokosumiTarget(row.userId, rawEnv).env;
  if (!effectiveEnv || !ENABLED_ENVS.includes(effectiveEnv)) return { executed: 0, scanned: 0 };
  if (!SokosumiClient.isConfigured(effectiveEnv, row.userId)) return { executed: 0, scanned: 0 };
  if (!(await isSystemSweepEnabled(row.id, 'hermes-executor'))) return { executed: 0, scanned: 0 };

  const log = logger.child({ fn: 'hermes_executor', instanceId: row.id, userId: row.userId });
  const client = new SokosumiClient(row.userId, effectiveEnv);

  const hermesCoworkerId = await findHermesCoworkerId(client);
  if (!hermesCoworkerId) {
    log.debug('no hermes coworker — skipping');
    return { executed: 0, scanned: 0 };
  }

  let personalTasks: Array<{
    id?: string;
    name?: string;
    status?: string;
    description?: string | null;
    coworkerId?: string;
  }>;
  try {
    personalTasks = (await client.listTasks({ scope: 'owned', limit: 30 })) as Array<{
      id?: string;
      name?: string;
      status?: string;
      description?: string | null;
      coworkerId?: string;
    }>;
  } catch (err) {
    log.warn({ err }, 'list_personal_tasks_failed');
    return { executed: 0, scanned: 0 };
  }

  // Pick READY tasks assigned to Hermes, excluding our own cron mirrors.
  const candidates = personalTasks.filter(
    (t) =>
      t.id &&
      t.coworkerId === hermesCoworkerId &&
      (t.status ?? '').toUpperCase() === 'READY' &&
      !(t.name ?? '').startsWith(CRON_MIRROR_PREFIX),
  );

  if (candidates.length === 0) return { executed: 0, scanned: personalTasks.length };

  log.info(
    { found: candidates.length, scanned: personalTasks.length },
    'hermes_executor_picked_tasks',
  );

  let apiKey: string;
  try {
    apiKey = await decryptSecret(row.apiServerKey);
  } catch (err) {
    log.error({ err }, 'apikey_decrypt_failed');
    return { executed: 0, scanned: personalTasks.length };
  }

  let executed = 0;
  for (const task of candidates.slice(0, MAX_TASKS_PER_TICK)) {
    if (!task.id) continue;
    try {
      await executeOneTask({
        client,
        taskId: task.id,
        taskName: task.name ?? '(unnamed)',
        description: task.description ?? '',
        endpointUrl: row.endpointUrl,
        apiKey,
        log,
        instanceId: row.id,
        userId: row.userId,
      });
      executed++;
    } catch (err) {
      log.warn({ err, taskId: task.id }, 'hermes_executor_task_failed');
    }
  }

  return { executed, scanned: personalTasks.length };
}

interface ExecuteArgs {
  client: SokosumiClient;
  taskId: string;
  taskName: string;
  description: string;
  endpointUrl: string;
  apiKey: string;
  log: { info: (data: unknown, msg: string) => void; warn: (data: unknown, msg: string) => void };
  instanceId: string;
  userId: string;
}

async function executeOneTask(args: ExecuteArgs): Promise<void> {
  const { client, taskId, taskName, description, endpointUrl, apiKey, log, instanceId, userId } = args;

  // Move to RUNNING immediately so a parallel tick doesn't double-pick.
  await client
    .addTaskEvent(taskId, {
      status: 'RUNNING',
      comment: `Hermes picked this up at ${new Date().toISOString()} and is working on it.`,
    })
    .catch((err) => log.warn({ err, taskId }, 'mark_running_failed'));

  await recordEvent({
    userId,
    instanceId,
    event: 'hermes_task_picked',
    detail: { taskId, taskName },
  });

  const prompt = buildExecutionPrompt(taskName, description);

  let respText = '';
  let chatErr: string | null = null;
  let status = 0;
  try {
    const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    status = res.status;
    respText = await res.text();
    if (status >= 400) chatErr = `upstream_${status}`;
  } catch (err) {
    chatErr = err instanceof Error ? err.message : 'fetch failed';
  }

  if (chatErr) {
    await client
      .addTaskEvent(taskId, {
        status: 'FAILED',
        comment: `Hermes hit an error while executing this task: ${chatErr}`,
      })
      .catch((err) => log.warn({ err, taskId }, 'mark_failed_failed'));
    await recordEvent({
      userId,
      instanceId,
      event: 'hermes_task_failed',
      detail: { taskId, error: chatErr },
    });
    return;
  }

  let content = '';
  try {
    const json = JSON.parse(respText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    content = json?.choices?.[0]?.message?.content ?? '';
  } catch {
    content = respText.slice(0, 4000);
  }

  if (!content.trim()) {
    await client
      .addTaskEvent(taskId, {
        status: 'COMPLETED',
        comment: 'Hermes finished but produced no chat output.',
      })
      .catch((err) => log.warn({ err, taskId }, 'mark_completed_failed'));
    return;
  }

  await client
    .addTaskEvent(taskId, {
      status: 'COMPLETED',
      comment: truncate(content, 8000),
    })
    .catch((err) => log.warn({ err, taskId }, 'mark_completed_failed'));

  await recordEvent({
    userId,
    instanceId,
    event: 'hermes_task_completed',
    detail: { taskId, taskName, bytes: content.length },
  });
  log.info({ taskId, bytes: content.length }, 'hermes_executor_task_done');
}

function buildExecutionPrompt(taskName: string, description: string): string {
  return `You have been assigned a task on the user's personal Sokosumi board.

Task name: "${taskName}"

Description / instructions:
"""
${description || '(no description provided)'}
"""

This is a direct user assignment to YOU (the Hermes coworker), not a coordination request. \
Work the task end-to-end using your tools (Sokosumi MCP, mail/calendar MCPs, web search, \
memory, code execution as needed). When you're done, write a clear final answer that fully \
addresses what the user asked for — that answer will be posted as a comment on the task and \
the task will be marked COMPLETED with it.

Rules:
- No greeting, no meta about being assigned. Just the work and the result.
- If the task is ambiguous, do your best with reasonable assumptions and call out the \
  assumptions in your final answer. Don't ask clarifying questions back — there's no user \
  in this loop right now.
- If you absolutely cannot complete it (missing tool access, requires confirmation that \
  has to come from chat), reply with a short explanation of what you'd need and the \
  orchestrator will mark the task FAILED with that as the reason.
- Keep the final answer under ~6000 characters. Lead with the answer, then any supporting \
  detail. Tight prose, no padding.`;
}

async function findHermesCoworkerId(client: SokosumiClient): Promise<string | null> {
  try {
    const coworkers = (await client.listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
      id?: string;
      slug?: string;
    }>;
    const hermes = coworkers.find((c) => c.slug === 'hermes');
    if (hermes?.id) return hermes.id;
  } catch {
    // try orgs
  }
  try {
    const orgs = await client.listOrganizations();
    for (const org of orgs.slice(0, 5)) {
      try {
        const coworkers = (await client
          .withOrganization(org.id)
          .listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
          id?: string;
          slug?: string;
        }>;
        const hermes = coworkers.find((c) => c.slug === 'hermes');
        if (hermes?.id) return hermes.id;
      } catch {
        // try next
      }
    }
  } catch {
    // no orgs
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Hourly sweep — picks the small set of users on enabled envs and
 *  checks their personal-scope task boards. */
export async function runHermesExecutorSweep(): Promise<{ instances: number; executed: number }> {
  const due = await prisma.hermesInstance.findMany({
    where: {
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true },
    take: 100,
  });
  let executed = 0;
  for (const r of due) {
    try {
      const res = await runHermesExecutorForInstance(r.id);
      executed += res.executed;
    } catch (err) {
      logger.error({ err, instanceId: r.id }, 'hermes_executor_sweep_item_failed');
    }
  }
  if (executed > 0 || due.length > 0) {
    logger.info({ instances: due.length, executed }, 'hermes_executor_sweep_done');
  }
  return { instances: due.length, executed };
}
