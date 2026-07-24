import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient, resolveSokosumiTarget } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';
import { runCronAgentTurn } from './cron-agent-turn.js';

/**
 * Taskboard assistant — the TASK-level counterpart to the job sweeps.
 *
 * Input requests and new work surface reliably at the TASK level
 * (list_tasks shows every task including ones a coworker like Hannah is
 * running, with a real uppercase status), whereas the orchestrator's job
 * listing is blind to coworker-run jobs. So this watches the taskboard and,
 * per the user's OWN tasks:
 *
 *  - a genuinely NEW task → Hermes comments with helpful material if it has
 *    any (relevant email, prior research, a deadline, a person to involve);
 *  - an INPUT_REQUIRED task → Hermes helps it CONTINUE: answer the input if
 *    it can source every field AND the answer isn't sensitive, otherwise
 *    leave a comment / flag it to the user for a decision.
 *
 * DEDUP: each acted-on task gets a HermesTaskAssist row, so a task is handled
 * AT MOST ONCE. This is deliberately NOT a plain updatedAt watermark: the
 * agent's own comment on an INPUT_REQUIRED task bumps that task's updatedAt,
 * which a watermark would treat as "changed again" and re-select every tick —
 * an infinite 5-minute comment loop. The dedup row is immune to that. (A task
 * that leaves INPUT_REQUIRED and later re-enters is the rare exception; the
 * stuck-jobs native cron covers ongoing reminders.)
 *
 * Autonomy: medium/high only (low never writes). The MCP layer gates the
 * writes — at medium every comment/input is a confirmation card (so "ask the
 * user first" is automatic); at high they execute directly and the prompt
 * carries the sensitivity judgment. Scoped to the user's OWN tasks, honoring
 * the SOUL rule against commenting on colleagues' tasks unprompted.
 */

const MAX_TASKS_PER_TICK = 5;
const AGENT_TURN_TIMEOUT_MS = 4 * 60_000;
/** New tasks only get commented on if created within this window — so
 *  activating the feature (or a deploy gap) doesn't dredge the whole board. */
const NEW_TASK_WINDOW_MS = 6 * 60 * 60_000;
/** Prune dedup rows older than this. */
const DEDUP_TTL_MS = 45 * 24 * 60 * 60_000;
const NEW_TASK_STATUSES = new Set(['draft', 'queued', 'ready', 'running']);

interface BoardTask {
  id: string;
  name: string;
  description: string | null;
  status: string;
  orgId: string;
  kind: 'new' | 'input';
  /** Sort key — oldest first so over-cap tasks are handled next tick. */
  sortKey: string;
}

export async function assistTaskboardForInstance(
  instanceId: string,
): Promise<{ handled: number; reason?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { handled: 0, reason: 'no_row' };
  if (row.destroyedAt) return { handled: 0, reason: 'destroyed' };
  if (!row.endpointUrl) return { handled: 0, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { handled: 0, reason: `status=${row.status}` };
  }
  const autonomy =
    row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  if (autonomy === 'low') return { handled: 0, reason: 'low_autonomy' };
  if (!(await isSystemSweepEnabled(row.id, 'taskboard-assistant'))) {
    return { handled: 0, reason: 'sweep_disabled' };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env, row.userId)) return { handled: 0, reason: 'no_sokosumi_key' };

  const log = logger.child({ instanceId, userId: row.userId, fn: 'taskboard_assistant' });
  const client = new SokosumiClient(row.userId, env);
  // Tasks come back under the RESOLVED user id (SOKOSUMI_OVERRIDES remaps
  // fixture accounts), so compare ownership against that, not the raw row id.
  const { userId: effectiveUserId } = resolveSokosumiTarget(row.userId, env);
  const ownerIds = new Set([row.userId, effectiveUserId]);

  let orgs: Array<{ id: string }> = [];
  try {
    orgs = (await client.listOrganizations()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'taskboard_list_orgs_failed');
    return { handled: 0, reason: 'list_orgs_failed' };
  }

  const now = Date.now();
  const raw: BoardTask[] = [];

  for (const org of orgs.slice(0, 5)) {
    try {
      const tasks = (await client.withOrganization(org.id).listTasks({ limit: 30, scope: 'workspace' })) as Array<{
        id?: string;
        name?: string;
        description?: string | null;
        status?: string;
        ownerId?: string;
        userId?: string;
        createdAt?: string;
        updatedAt?: string;
      }>;
      for (const t of tasks) {
        if (!t.id) continue;
        // Own tasks only — never comment on colleagues' tasks unprompted.
        if (!(t.ownerId && ownerIds.has(t.ownerId)) && !(t.userId && ownerIds.has(t.userId))) continue;
        const status = (t.status ?? '').toLowerCase();
        if (status === 'input_required') {
          raw.push({
            id: t.id, name: t.name ?? '(unnamed)', description: t.description ?? null,
            status: 'INPUT_REQUIRED', orgId: org.id, kind: 'input', sortKey: t.updatedAt ?? t.createdAt ?? '',
          });
        } else if (NEW_TASK_STATUSES.has(status) && t.createdAt && now - new Date(t.createdAt).getTime() <= NEW_TASK_WINDOW_MS) {
          raw.push({
            id: t.id, name: t.name ?? '(unnamed)', description: t.description ?? null,
            status: (t.status ?? '').toUpperCase(), orgId: org.id, kind: 'new', sortKey: t.createdAt,
          });
        }
      }
    } catch (err) {
      // Partial failure is fine — dedup is per-task, so processing the healthy
      // orgs now can't bury the failed org's tasks (they'll be picked up when
      // that org recovers). No whole-tick bail.
      log.warn({ err, orgId: org.id }, 'taskboard_list_tasks_failed');
    }
  }

  if (raw.length === 0) return { handled: 0, reason: 'no_candidate_tasks' };

  // Drop tasks we've already acted on (dedup table — immune to the agent's
  // own comment bumping updatedAt). Keyed by (taskId, kind) so a task
  // handled as 'new' can STILL get 'input' help when it later pauses.
  const already = new Set(
    (
      await prisma.hermesTaskAssist.findMany({
        where: { instanceId, taskId: { in: raw.map((t) => t.id) } },
        select: { taskId: true, kind: true },
      })
    ).map((r) => `${r.taskId}:${r.kind}`),
  );
  const candidates = raw.filter((t) => !already.has(`${t.id}:${t.kind}`));
  if (candidates.length === 0) return { handled: 0, reason: 'all_already_handled' };

  // Input requests first (more time-sensitive), then oldest-first within each.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'input' ? -1 : 1;
    return a.sortKey.localeCompare(b.sortKey);
  });
  const batch = candidates.slice(0, MAX_TASKS_PER_TICK);

  // Record dedup rows BEFORE the turn (at-most-once): a timed-out turn may
  // still have posted a comment on the machine, and re-doing it would
  // duplicate. createMany skipDuplicates guards the unique (instanceId,taskId).
  await prisma.hermesTaskAssist.createMany({
    data: batch.map((t) => ({ instanceId, taskId: t.id, kind: t.kind })),
    skipDuplicates: true,
  });

  const apiKey = await decryptSecret(row.apiServerKey);
  let requestId: string;
  try {
    const turn = await runCronAgentTurn({
      instanceId,
      userId: row.userId,
      endpointUrl: row.endpointUrl,
      apiKey,
      source: 'taskboard_assistant',
      prompt: buildTaskboardPrompt(batch, autonomy),
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
      // Give the agent the recent conversation so it responds like it knows
      // the user (their preferences/decisions) instead of asking open questions.
      includeHistory: 8,
    });
    requestId = turn.requestId;
  } catch (err) {
    log.warn({ err }, 'taskboard_agent_turn_failed');
    return { handled: 0, reason: 'agent_turn_failed' };
  }

  const newTasks = batch.filter((b) => b.kind === 'new').length;
  const inputTasks = batch.filter((b) => b.kind === 'input').length;
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: {
      source: 'taskboard_assistant',
      // scanned/commented aliases so the EOD report's cron aggregator reads them.
      scanned: batch.length,
      commented: batch.length,
      tasks: batch.length,
      newTasks,
      inputTasks,
      autonomy,
      requestId,
    },
  });
  log.info({ tasks: batch.length, newTasks, inputTasks, autonomy }, 'taskboard_assistant_handled');
  return { handled: batch.length };
}

let sweepInFlight = false;

export async function runTaskboardAssistantSweep(): Promise<{ scanned: number; handled: number }> {
  // Re-entrancy guard (same as the sibling sweeps): each instance holds a
  // 4-min agent turn, so a busy tick can exceed the 5-min cadence — an
  // overlapping sweep would double-run the candidate→createMany window.
  if (sweepInFlight) return { scanned: 0, handled: 0 };
  sweepInFlight = true;
  try {
    return await runTaskboardAssistantSweepInner();
  } finally {
    sweepInFlight = false;
  }
}

async function runTaskboardAssistantSweepInner(): Promise<{ scanned: number; handled: number }> {
  // Cheap prune of stale dedup rows so the table can't grow unbounded.
  await prisma.hermesTaskAssist
    .deleteMany({ where: { assistedAt: { lt: new Date(Date.now() - DEDUP_TTL_MS) } } })
    .catch(() => {});

  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      autonomyLevel: { in: ['medium', 'high'] },
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true },
    take: 100,
  });
  let handled = 0;
  for (const instance of due) {
    try {
      const res = await assistTaskboardForInstance(instance.id);
      if (res.handled > 0) handled++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'taskboard_assistant_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, handled }, 'taskboard_assistant_sweep_done');
  }
  return { scanned: due.length, handled };
}

function buildTaskboardPrompt(tasks: BoardTask[], autonomy: 'medium' | 'high'): string {
  const block = tasks
    .map((t, i) => `${i + 1}. [${t.status}] "${t.name}" — task_id=${t.id} (org=${t.orgId})\n   ${t.kind === 'input' ? 'NEEDS INPUT to continue.' : 'newly created.'}${t.description ? `\n   Description: ${t.description.slice(0, 400)}` : ''}`)
    .join('\n');

  const gatingNote =
    autonomy === 'high'
      ? 'At high autonomy this executes immediately — you own the call.'
      : 'At medium, just fire the tool and stop — the orchestrator handles it (a comment posts now; a provide_job_input goes to the user to approve). Don\'t ask in chat first.';

  return `Internal task — reply discarded; act through tools only.

The recent conversation is above; also read your memory (memory tool) for the user's standing preferences and past decisions. Respond like you KNOW this user: take a position, handle what you can yourself, and never ask an open "what would you like to do?".

Your own tasks that just changed (handle each once, now):
${block}

A task COMMENT is read by the coworker doing that task, NOT the user. Write every comment as direction to the coworker. To reach the USER, message them in chat with your outbox-send skill — NEVER put a message meant for the user in a task comment.

NEW task → comment ONLY if you have real, specific context the creator may have missed (an email thread, prior research, a deadline, a person to involve). Otherwise skip — silence beats noise.

INPUT_REQUIRED task → the coworker is blocked. sokosumi_get_task shows what they asked for.
 - Can you settle it from real context (the task's purpose, the user's instructions, your memory, prior results)? Then unblock the coworker: sokosumi_provide_job_input, or a comment telling them how to proceed. ${gatingNote}
 - Genuinely the user's call (spends credits, publishes, external commitment)? First handle every free/reversible part yourself (comment your approval where nothing is spent, direct the coworker), so all that's left is the actual decision. Then message the USER in chat (outbox-send) LEADING WITH YOUR RECOMMENDATION and one line of why — e.g. "I'd go with the 6-month plan (X) because Y; approve to proceed." A bare list of options with "what would you like to do?" is a failure — always recommend.

Tools: sokosumi_get_task / get_job / get_job_input_request / list_jobs, sokosumi_add_task_comment, sokosumi_provide_job_input, memory/mail/calendar. Don't create tasks, start jobs, or spend credits.

Nothing warrants action? Reply "skip".`;
}
