import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

const MAX_TASKS_PER_TICK = 5; // per-instance cap

/**
 * Task augmentation — Hermes auto-comments on newly created tasks with
 * useful context from its memory + tools.
 *
 * Runs ONLY for instances at autonomyLevel === "high". The cron picks
 * tasks created since lastTaskAugmentationAt for each high-autonomy user,
 * fires a Hermes prompt asking it to evaluate whether it has useful
 * context to add, and lets Hermes call sokosumi_add_task_comment if so.
 *
 * Cost: comments are free (no Sokosumi credits) so this can run aggressively
 * without draining the user's balance. Cost is only the LLM call (~$0.001 per
 * gated decision with DeepSeek V4 Flash).
 */
export async function augmentTasksForInstance(instanceId: string): Promise<{ commented: number; scanned: number }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { commented: 0, scanned: 0 };
  if (row.destroyedAt) return { commented: 0, scanned: 0 };
  if (!row.endpointUrl) return { commented: 0, scanned: 0 };
  if (row.autonomyLevel !== 'high') return { commented: 0, scanned: 0 };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { commented: 0, scanned: 0 };
  }
  if (!(await isSystemSweepEnabled(row.id, 'task-augmentation'))) {
    return { commented: 0, scanned: 0 };
  }
  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env)) return { commented: 0, scanned: 0 };

  const log = logger.child({ instanceId, userId: row.userId, fn: 'task_augment' });
  const since = row.lastTaskAugmentationAt ?? new Date(Date.now() - 24 * 60 * 60_000);
  const client = new SokosumiClient(row.userId, env);

  // Scan each org for new tasks created since the watermark.
  let orgs: Array<{ id: string; name?: string }>;
  try {
    orgs = await client.listOrganizations();
  } catch (err) {
    log.warn({ err }, 'task_augment_list_orgs_failed');
    return { commented: 0, scanned: 0 };
  }

  const newTasks: Array<{
    id: string;
    name: string;
    description: string | null;
    orgId: string;
    createdAt: string;
  }> = [];

  for (const org of orgs.slice(0, 5)) {
    try {
      const tasks = (await client.withOrganization(org.id).listTasks({ limit: 30, scope: 'workspace' })) as Array<{
        id?: string;
        name?: string;
        description?: string | null;
        createdAt?: string;
      }>;
      for (const t of tasks) {
        if (!t.id || !t.createdAt) continue;
        const created = new Date(t.createdAt);
        if (isNaN(created.getTime())) continue;
        if (created.getTime() <= since.getTime()) continue;
        newTasks.push({
          id: t.id,
          name: t.name ?? '(unnamed)',
          description: t.description ?? null,
          orgId: org.id,
          createdAt: t.createdAt,
        });
      }
    } catch (err) {
      log.warn({ err, orgId: org.id }, 'task_augment_list_tasks_failed');
    }
  }

  if (newTasks.length === 0) {
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { lastTaskAugmentationAt: new Date() },
    });
    return { commented: 0, scanned: 0 };
  }

  newTasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const targets = newTasks.slice(0, MAX_TASKS_PER_TICK);

  const apiKey = await decryptSecret(row.apiServerKey);

  let commented = 0;
  for (const task of targets) {
    try {
      const fired = await augmentOneTask(row.endpointUrl, apiKey, task, log);
      if (fired) commented++;
    } catch (err) {
      log.warn({ err, taskId: task.id }, 'task_augment_one_failed');
    }
  }

  // Advance watermark to the newest task we considered.
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastTaskAugmentationAt: new Date(targets[0]!.createdAt) },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: { source: 'task_augmentation', scanned: targets.length, commented },
  });
  log.info({ scanned: targets.length, commented }, 'task_augmentation_done');
  return { commented, scanned: targets.length };
}

export async function runTaskAugmentationSweep(): Promise<{ scanned: number; commented: number }> {
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      autonomyLevel: 'high',
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true },
    take: 50,
  });
  let commented = 0;
  let scanned = 0;
  for (const instance of due) {
    try {
      const res = await augmentTasksForInstance(instance.id);
      commented += res.commented;
      scanned += res.scanned;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'task_augmentation_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ instances: due.length, scanned, commented }, 'task_augmentation_sweep_done');
  }
  return { scanned, commented };
}

// ---------- single-task augmentation prompt + dispatch ----------

async function augmentOneTask(
  endpointUrl: string,
  apiKey: string,
  task: { id: string; name: string; description: string | null; orgId: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<boolean> {
  const prompt = `Internal background task — your reply is parsed by code \
and not shown to the user directly.

A new Sokosumi task was just created in this user's workspace:

  Task id: ${task.id}
  Name: ${task.name}
  Description: ${task.description ?? '(none)'}

Your job: decide whether you have useful context to add as a comment. \
Check your memory, your connected mail/calendar MCPs if you have them, \
and your Sokosumi tools (sokosumi_get_job for past results, \
sokosumi_list_jobs for prior work on similar topics). Substance > volume — \
only comment if you actually have something the task creator might not \
have considered (relevant email thread, prior research, an upcoming \
deadline, a person worth involving).

If you have something useful, call sokosumi_add_task_comment with:
  task_id: ${task.id}
  comment: <1-3 short paragraphs, lead with the substance, cite sources \
  briefly (e.g., "from your email with X on Tuesday")>

If you DON'T have useful context to add, do nothing. Reply with just \
"skip" — silence beats noise.

Don't ask the user for permission. This is the autonomy-high path; \
they've opted into background commenting.`;

  const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(3 * 60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`augment ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = (json.choices?.[0]?.message?.content ?? '').trim();

  // We don't parse the reply — Hermes either called the MCP tool
  // (sokosumi_add_task_comment) which we can see via Sokosumi's own state,
  // or it said "skip". Either way, this is purely best-effort. The reply
  // text is logged for debugging.
  const fired = !/^\s*skip\s*$/i.test(reply);
  log.info({ taskId: task.id, fired, replyHead: reply.slice(0, 120) }, 'task_augmented_one');
  return fired;
}
