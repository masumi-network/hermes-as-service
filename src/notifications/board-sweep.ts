import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient, mapLimit, resolveSokosumiTarget } from '../sokosumi/client.js';
import { awaitingInputTimestamp, couldBeAwaitingInput } from '../sokosumi/job-state.js';
import { isValidSokosumiEnv, type SokosumiEnv, normalizeAutonomy } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';
import { runCronAgentTurn } from './cron-agent-turn.js';

/**
 * Board sweep — ONE 5-minute pass over everything that changed on a user's
 * board, tasks and jobs together.
 *
 * Replaces three sweeps that were doing overlapping work at different levels:
 *
 *   taskboard-assistant  (4-59/5)  TASK level: input / done / new
 *   input-responder      (2-59/5)  JOB level: awaiting-input + follow-ups
 *   urgent-interrupts    (30 * * *) JOB level: notify on completed/failed
 *
 * They ran 2 minutes apart, each fanned out over every workspace, and each
 * built its own listing — and between them there were THREE separate
 * implementations of "create a follow-up task from finished work", each
 * defending against the others by grepping list_tasks first.
 *
 * ── Tasks vs jobs ──────────────────────────────────────────────────────────
 * These are NOT interchangeable and the merge does not flatten them.
 *
 * TASKS are the primary view. A task run by a coworker — off a schedule, or
 * straight out of the user's own chat with that coworker — produces no job the
 * orchestrator can see. Task level is the only place that work exists.
 *
 * JOBS still matter, because a job can have NO task at all (`taskId: null`,
 * observed in production). Those are invisible at task level, so they get
 * their own path here.
 *
 * The two are reconciled by DROPPING any job whose task is already in this
 * batch — the task entry represents it, at the level the user thinks in. Only
 * orphan jobs survive as their own items. Tasks always sort above jobs.
 *
 * ── At-most-once, without watermarks ───────────────────────────────────────
 * Every item is deduped through HermesTaskAssist on (id, kind), so nothing is
 * handled twice. That replaces five separate watermark columns and all their
 * failure modes ("don't advance on a partial listing", "clamp to captureAt",
 * "a comment bumps updatedAt so a watermark re-selects forever"). Recency
 * windows stop a first run from dredging history.
 *
 * ── Notification discipline (inherited from urgent-interrupts) ─────────────
 * A 2h cooldown on interrupting the user, so a burst of completions can't
 * become a burst of messages. Blocked work and FAILURES bypass it — those are
 * time-critical. Cooled-down completions are still processed for follow-ups;
 * they just don't ping, and the end-of-day report covers them.
 */

const MAX_ITEMS_PER_TICK = 5;
const AGENT_TURN_TIMEOUT_MS = 4 * 60_000;
/** New tasks are only worth commenting on while they're fresh. */
const NEW_TASK_WINDOW_MS = 6 * 60 * 60_000;
/** Finished work stays reportable for a day — dedup makes it at-most-once. */
const DONE_WINDOW_MS = 24 * 60 * 60_000;
/** Minimum gap between unsolicited chat interrupts about completions. */
const NOTIFY_COOLDOWN_MS = 2 * 60 * 60_000;
/** Per-workspace ceiling on job-detail probes in one tick. */
const MAX_PROBES_PER_SCOPE = 25;
/** Prune dedup rows older than this. */
const DEDUP_TTL_MS = 45 * 24 * 60 * 60_000;

const NEW_TASK_STATUSES = new Set(['draft', 'queued', 'ready', 'running']);
/** Terminal task statuses worth reporting. Sokosumi returns CANCELED (one L). */
const DONE_TASK_STATUSES = new Set(['completed', 'canceled', 'cancelled', 'failed']);
/** Terminal values the job `status` FIELD genuinely carries — see
 *  ../sokosumi/job-state.ts for why awaiting_input is NOT among them. */
const DONE_JOB_STATUSES = new Set(['completed', 'failed']);

export type ItemKind = 'input' | 'done' | 'new';

export interface BoardItem {
  /** Tasks are the primary view; jobs fill the gap tasks can't see. */
  source: 'task' | 'job';
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** null = the user's personal workspace. */
  orgId: string | null;
  kind: ItemKind;
  /** Oldest-first within a rank, so over-cap items are handled next tick. */
  sortKey: string;
  /** Who did the work, when known — the user thinks in coworker names. */
  assignee?: string;
  /** For a job: its parent task, when it has one. Used to drop jobs already
   *  represented by a task in the same batch. */
  parentTaskId?: string | null;
  /** True when the cooldown says: handle it, but don't ping the user. */
  quiet?: boolean;
}

/** Dedup key — one namespace for tasks and jobs. */
export function dedupKind(item: Pick<BoardItem, 'source' | 'kind'>): string {
  return `${item.source}_${item.kind}`;
}

/**
 * Tasks first, and within that the blocked coworker before the news before the
 * noise. Orphan jobs sit below every task but above brand-new tasks, which are
 * the lowest-value case ("silence beats noise").
 */
const RANK: Record<string, number> = {
  task_input: 0,
  task_done: 1,
  job_input: 2,
  job_done: 3,
  task_new: 4,
};

export function rankOf(item: Pick<BoardItem, 'source' | 'kind'>): number {
  return RANK[dedupKind(item)] ?? 99;
}

/** Sort a candidate list into handling order. Exported for tests. */
export function orderItems(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => {
    const d = rankOf(a) - rankOf(b);
    if (d !== 0) return d;
    return a.sortKey.localeCompare(b.sortKey);
  });
}

/**
 * Drop jobs already represented by a task in this batch. The task entry is the
 * better one: it's the level the user thinks in and it carries the coworker.
 * Exported for tests — this is the tasks-vs-jobs reconciliation.
 */
export function dropJobsCoveredByTasks(items: BoardItem[]): BoardItem[] {
  const taskIds = new Set(items.filter((i) => i.source === 'task').map((i) => i.id));
  return items.filter(
    (i) => i.source === 'task' || !i.parentTaskId || !taskIds.has(i.parentTaskId),
  );
}

interface RawTask {
  id?: string;
  name?: string;
  description?: string | null;
  status?: string;
  ownerId?: string;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
  assignee?: { name?: string } | null;
  coworker?: { name?: string } | null;
}

interface RawJob {
  id?: string;
  name?: string;
  status?: string;
  taskId?: string | null;
  agentId?: string;
  completedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  jobStatusSettled?: boolean;
  result?: string;
}

export async function sweepBoardForInstance(
  instanceId: string,
): Promise<{ handled: number; reason?: string; requestId?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { handled: 0, reason: 'no_row' };
  if (row.destroyedAt) return { handled: 0, reason: 'destroyed' };
  if (!row.endpointUrl) return { handled: 0, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { handled: 0, reason: `status=${row.status}` };
  }
  const autonomy = normalizeAutonomy(row.autonomyLevel);
  if (autonomy === 'low') return { handled: 0, reason: 'low_autonomy' };
  if (!(await isSystemSweepEnabled(row.id, 'board-sweep'))) {
    return { handled: 0, reason: 'sweep_disabled' };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env, row.userId)) return { handled: 0, reason: 'no_sokosumi_key' };

  const log = logger.child({ instanceId, userId: row.userId, fn: 'board_sweep' });
  const client = new SokosumiClient(row.userId, env);
  // Tasks come back under the RESOLVED user id (SOKOSUMI_OVERRIDES remaps
  // fixture accounts), so compare ownership against that, not the raw row id.
  const { userId: effectiveUserId } = resolveSokosumiTarget(row.userId, env);
  const ownerIds = new Set([row.userId, effectiveUserId]);

  // MUST be listWorkspaceScopes (not listOrganizations): it always includes the
  // personal workspace (id:null), where a per-user assistant's own work lives.
  let orgs: Array<{ id: string | null }> = [];
  try {
    orgs = (await client.listWorkspaceScopes()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'board_sweep_list_orgs_failed');
    return { handled: 0, reason: 'list_orgs_failed' };
  }

  const now = Date.now();
  const recentCutoff = new Date(now - Math.max(NEW_TASK_WINDOW_MS, DONE_WINDOW_MS));
  const found: BoardItem[] = [];

  const perScope = await mapLimit(orgs, 5, async (org): Promise<BoardItem[]> => {
    const oc = client.withOrganization(org.id);
    const out: BoardItem[] = [];
    const owned = (t: RawTask): boolean =>
      (!!t.ownerId && ownerIds.has(t.ownerId)) || (!!t.userId && ownerIds.has(t.userId));
    const who = (t: RawTask): string | undefined =>
      t.assignee?.name ?? t.coworker?.name ?? undefined;

    // ---------- TASKS (primary) ----------
    // /tasks?status= is a genuine CURRENT-state filter — verified in
    // production: per-status buckets sum exactly to the unfiltered total with
    // zero mismatched rows. INPUT_REQUIRED has no recency bound (a task can
    // sit blocked for weeks), so it needs the filter rather than a window.
    try {
      const [blocked, recent] = await Promise.all([
        oc.listAllTasks({ scope: 'workspace', status: 'INPUT_REQUIRED', maxItems: 200 }),
        oc.listAllTasks({ scope: 'workspace', maxItems: 500, stopWhenOlderThan: recentCutoff }),
      ]);
      for (const t of blocked.items as RawTask[]) {
        if (!t.id || !owned(t)) continue; // never touch a colleague's task
        out.push({
          source: 'task', id: t.id, name: t.name ?? '(unnamed task)',
          description: t.description ?? null, status: 'INPUT_REQUIRED', orgId: org.id,
          kind: 'input', sortKey: t.updatedAt ?? t.createdAt ?? '',
          ...(who(t) ? { assignee: who(t) } : {}),
        });
      }
      for (const t of recent.items as RawTask[]) {
        if (!t.id || !owned(t)) continue;
        const status = (t.status ?? '').toLowerCase();
        if (status === 'input_required') continue; // covered above
        if (DONE_TASK_STATUSES.has(status)) {
          const stamp = t.updatedAt ?? t.createdAt;
          if (!stamp || now - new Date(stamp).getTime() > DONE_WINDOW_MS) continue;
          out.push({
            source: 'task', id: t.id, name: t.name ?? '(unnamed task)',
            description: t.description ?? null, status: (t.status ?? '').toUpperCase(),
            orgId: org.id, kind: 'done', sortKey: stamp,
            ...(who(t) ? { assignee: who(t) } : {}),
          });
        } else if (
          NEW_TASK_STATUSES.has(status) &&
          t.createdAt &&
          now - new Date(t.createdAt).getTime() <= NEW_TASK_WINDOW_MS
        ) {
          out.push({
            source: 'task', id: t.id, name: t.name ?? '(unnamed task)',
            description: t.description ?? null, status: (t.status ?? '').toUpperCase(),
            orgId: org.id, kind: 'new', sortKey: t.createdAt,
            ...(who(t) ? { assignee: who(t) } : {}),
          });
        }
      }
    } catch (err) {
      // Partial failure is safe: dedup is per-item, so handling the healthy
      // workspaces now can't bury this one's work — it resurfaces next tick.
      log.warn({ err, orgId: org.id }, 'board_sweep_list_tasks_failed');
    }

    // ---------- JOBS (only what tasks can't see) ----------
    try {
      const [everAwaiting, recentJobs] = await Promise.all([
        // Lifecycle filter = "has EVER been in this state", so it narrows the
        // candidate set only; liveness is confirmed per job below.
        //
        // Runs EVERY tick, deliberately. The predecessor sweep put this on a
        // 30-minute cadence to save one call per workspace, which meant a job
        // that paused before the recency window could wait half an hour to be
        // noticed. A blocked job is the most time-critical thing on the board;
        // detection latency is worth more than the call.
        oc.listAllJobs({ status: 'AWAITING_INPUT', maxItems: 200 }),
        oc.listAllJobs({ maxItems: 500, stopWhenOlderThan: recentCutoff }),
      ]);

      const candidates = (everAwaiting.items as RawJob[])
        .filter((j) => j.id && couldBeAwaitingInput(j))
        .slice(0, MAX_PROBES_PER_SCOPE);
      const confirmed = await mapLimit(candidates, 5, async (j): Promise<BoardItem | null> => {
        try {
          const ev = await oc.getPendingInputRequest(j.id!);
          if (!ev) return null;
          const stamp = awaitingInputTimestamp(ev, j);
          if (!stamp) return null;
          return {
            source: 'job', id: j.id!, name: j.name ?? '(unnamed job)', description: null,
            status: 'AWAITING_INPUT', orgId: org.id, kind: 'input', sortKey: stamp,
            parentTaskId: j.taskId ?? null,
          };
        } catch (err) {
          log.warn({ err, orgId: org.id, jobId: j.id }, 'board_sweep_job_probe_failed');
          return null;
        }
      });
      out.push(...confirmed.filter((c): c is BoardItem => c !== null));

      for (const j of recentJobs.items as RawJob[]) {
        if (!j.id) continue;
        const status = (j.status ?? '').toLowerCase();
        if (!DONE_JOB_STATUSES.has(status)) continue;
        const stamp = status === 'completed' ? j.completedAt ?? j.updatedAt : j.updatedAt ?? j.createdAt;
        if (!stamp || now - new Date(stamp).getTime() > DONE_WINDOW_MS) continue;
        out.push({
          source: 'job', id: j.id, name: j.name ?? '(unnamed job)', description: null,
          status: status.toUpperCase(), orgId: org.id, kind: 'done', sortKey: stamp,
          parentTaskId: j.taskId ?? null,
        });
      }
    } catch (err) {
      log.warn({ err, orgId: org.id }, 'board_sweep_list_jobs_failed');
    }

    return out;
  });
  found.push(...perScope.flat());

  if (found.length === 0) return { handled: 0, reason: 'nothing_changed' };

  // Reconcile the two levels, then drop anything already handled.
  const reconciled = dropJobsCoveredByTasks(found);
  const seen = new Set(
    (
      await prisma.hermesTaskAssist.findMany({
        where: { instanceId, taskId: { in: reconciled.map((i) => i.id) } },
        select: { taskId: true, kind: true },
      })
    ).map((r) => `${r.taskId}:${r.kind}`),
  );
  const fresh = reconciled.filter((i) => !seen.has(`${i.id}:${dedupKind(i)}`));
  if (fresh.length === 0) return { handled: 0, reason: 'all_already_handled' };

  const batch = orderItems(fresh).slice(0, MAX_ITEMS_PER_TICK);

  // Notification cooldown (from the retired urgent-interrupts sweep). Blocked
  // work and failures are time-critical and bypass it; ordinary completions
  // inside the window are still processed for follow-ups but stay quiet, and
  // the end-of-day report picks them up.
  const inCooldown =
    !!row.lastUrgentInterruptAt &&
    row.lastUrgentInterruptAt.getTime() > now - NOTIFY_COOLDOWN_MS;
  const bypasses = (i: BoardItem): boolean => i.kind === 'input' || i.status === 'FAILED';
  for (const item of batch) {
    if (inCooldown && !bypasses(item)) item.quiet = true;
  }
  const willNotify = batch.some((i) => !i.quiet);

  // At-most-once: claim the items BEFORE the turn, because a turn that times
  // out may still have commented on the machine and redoing it would double
  // up. Rolled back below only when the turn provably never started.
  await prisma.hermesTaskAssist.createMany({
    data: batch.map((i) => ({ instanceId, taskId: i.id, kind: dedupKind(i) })),
    skipDuplicates: true,
  });
  const releaseClaims = async (): Promise<void> => {
    await prisma.hermesTaskAssist
      .deleteMany({
        where: {
          instanceId,
          OR: batch.map((i) => ({ taskId: i.id, kind: dedupKind(i) })),
        },
      })
      .catch((err) => log.warn({ err }, 'board_sweep_claim_release_failed'));
  };

  let apiKey: string;
  try {
    apiKey = await decryptSecret(row.apiServerKey);
  } catch (err) {
    // The turn provably never started — give the items back so they aren't
    // silently lost. (The old sweeps stranded them here.)
    await releaseClaims();
    log.warn({ err }, 'board_sweep_decrypt_failed');
    return { handled: 0, reason: 'decrypt_failed' };
  }

  let requestId: string;
  try {
    const turn = await runCronAgentTurn({
      instanceId,
      userId: row.userId,
      endpointUrl: row.endpointUrl,
      apiKey,
      source: 'board_sweep',
      prompt: buildBoardPrompt(batch, autonomy, { inCooldown }),
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
      // The recent conversation lets it avoid re-telling the user something
      // it already said, and answer like it knows them.
      includeHistory: 8,
    });
    requestId = turn.requestId;
  } catch (err) {
    log.warn({ err }, 'board_sweep_agent_turn_failed');
    return { handled: 0, reason: 'agent_turn_failed' };
  }

  if (willNotify) {
    await prisma.hermesInstance
      .update({ where: { id: instanceId }, data: { lastUrgentInterruptAt: new Date() } })
      .catch((err) => log.warn({ err }, 'board_sweep_cooldown_stamp_failed'));
  }

  const counts = {
    taskInput: batch.filter((i) => i.source === 'task' && i.kind === 'input').length,
    taskDone: batch.filter((i) => i.source === 'task' && i.kind === 'done').length,
    taskNew: batch.filter((i) => i.source === 'task' && i.kind === 'new').length,
    jobInput: batch.filter((i) => i.source === 'job' && i.kind === 'input').length,
    jobDone: batch.filter((i) => i.source === 'job' && i.kind === 'done').length,
    quiet: batch.filter((i) => i.quiet).length,
  };
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: {
      source: 'board_sweep',
      // scanned/commented aliases so the EOD report's aggregator reads them.
      scanned: batch.length,
      commented: batch.length,
      items: batch.length,
      ...counts,
      autonomy,
      requestId,
    },
  });
  log.info({ items: batch.length, ...counts, autonomy }, 'board_sweep_handled');
  return { handled: batch.length, requestId };
}

let sweepInFlight = false;

export async function runBoardSweep(): Promise<{
  scanned: number;
  handled: number;
  requestId?: string;
}> {
  // Re-entrancy guard: each instance can hold a 4-minute agent turn, so a busy
  // tick exceeds the 5-minute cadence and an overlapping sweep would race the
  // claim window.
  if (sweepInFlight) return { scanned: 0, handled: 0 };
  sweepInFlight = true;
  try {
    return await runBoardSweepInner();
  } finally {
    sweepInFlight = false;
  }
}

async function runBoardSweepInner(): Promise<{
  scanned: number;
  handled: number;
  requestId?: string;
}> {
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
  let requestId: string | undefined;
  for (const instance of due) {
    try {
      const res = await sweepBoardForInstance(instance.id);
      if (res.handled > 0) handled++;
      if (res.requestId) requestId = res.requestId;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'board_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, handled }, 'board_sweep_done');
  }
  return { scanned: due.length, handled, requestId };
}

/** Exported for tests — the prompt IS the behaviour of this sweep. */
export function buildBoardPrompt(
  items: BoardItem[],
  autonomy: 'medium' | 'high',
  opts: { inCooldown: boolean } = { inCooldown: false },
): string {
  const label = (i: BoardItem): string =>
    i.kind === 'input' ? 'NEEDS INPUT to continue.' : i.kind === 'done' ? 'JUST FINISHED.' : 'newly created.';
  const idField = (i: BoardItem): string => (i.source === 'task' ? 'task_id' : 'job_id');
  const block = items
    .map(
      (i, n) =>
        `${n + 1}. [${i.source.toUpperCase()} · ${i.status}] "${i.name}" — ${idField(i)}=${i.id} (org=${i.orgId})\n   ${label(i)}${i.assignee ? ` Worked by: ${i.assignee}.` : ''}${i.quiet ? ' (Do NOT message the user about this one — see the quiet rule below.)' : ''}${i.description ? `\n   Description: ${i.description.slice(0, 400)}` : ''}`,
    )
    .join('\n');

  const kinds = new Set(items.map((i) => dedupKind(i)));
  const anyDone = kinds.has('task_done') || kinds.has('job_done');
  const anyInput = kinds.has('task_input') || kinds.has('job_input');
  const anyNew = kinds.has('task_new');
  const anyQuiet = items.some((i) => i.quiet);
  const anyJob = items.some((i) => i.source === 'job');

  const gatingNote =
    autonomy === 'high'
      ? 'At high autonomy this executes immediately — you own the call.'
      : 'At medium, just fire the tool and stop — the orchestrator handles it (a comment posts now; a provide_job_input goes to the user to approve). Don\'t ask in chat first.';
  const followupGating =
    autonomy === 'high'
      ? 'At high autonomy sokosumi_create_task executes immediately, so only create a follow-up you are confident the user wants.'
      : 'At medium, sokosumi_create_task raises a confirmation card — that IS how you propose it to the user. Fire the tool once, then stop; do not also ask in chat.';

  return `Internal task — reply discarded; act through tools only.

The recent conversation is above. START by reading your memory (memory tool) for this user's standing preferences, past decisions, and any PLAN these items belong to — that memory is what makes you useful here rather than a status bot.

Scope check before you act: your job is to coordinate. You decide, comment, notify, and route work to coworkers. You do NOT produce a coworker's deliverable yourself.

What changed on ${autonomy === 'high' ? 'the' : 'your'} board (handle each once, now):
${block}
${
  anyJob
    ? `
TASKS vs JOBS: a task is the unit the user thinks in; a job is one paid run underneath one. Items marked JOB here have no task of their own (or their task isn't in this list), which is why they appear separately. Refer to a job by what it was FOR, not by its id.
`
    : ''
}
A task COMMENT is read by the coworker doing that task, NOT the user. Write every comment as direction to the coworker. To reach the USER, message them in chat with your outbox-send skill — NEVER put a message meant for the user in a task comment.
${
  anyQuiet
    ? `
QUIET items: you already interrupted this user recently. For anything marked quiet, do the work (follow-ups, comments) but do NOT send a chat message — tonight's end-of-day report covers it. If you genuinely believe one is urgent enough to override that, you may message about that ONE item and say why.
`
    : ''
}${
    anyDone
      ? `
JUST FINISHED (COMPLETED / CANCELED / FAILED) → two jobs, in this order.

 1. TELL THE USER, in chat, via outbox-send. This is the default, not the exception — work finishing is news they want, especially work a coworker ran from a schedule or from their own chat with that coworker, which they may not be watching. Read the actual result first (sokosumi_get_task, or sokosumi_get_job for a JOB item), then write 1-3 sentences: what finished, who did it, what it produced, and the one thing worth knowing about the outcome. Name it the way the USER would recognise it ("the weekly release report"), never by id.
    - Search memory for what this was FOR before writing. If it came out of a plan, a standing schedule, or something they asked for days ago, say so — "the weekly release task we set up on Friday just finished" is worth far more than "a task completed".
    - SKIP the message only if you already told them (check the conversation above), or it is genuinely trivial or abandoned (a test task, a duplicate, something they cancelled themselves).
    - CANCELED / FAILED: say so plainly, with what is known about why. Do not dress up a failure as progress. For a FAILED paid job, mention they can ask you to request a refund.

 2. THEN consider a follow-up. Search memory and the recent conversation for a next step that was actually agreed or clearly implied by the plan this belongs to.
    - If there IS one and it is now unblocked: check sokosumi_list_tasks for an existing task already covering it — if so, do nothing. Otherwise create it with sokosumi_create_task, assigned to the right coworker (sokosumi_list_coworkers), in the same workspace, with a description that references what just finished. ${followupGating}
    - The follow-up is a task FOR A COWORKER. Never assign it to yourself and never do the work yourself.
    - If there is NO agreed or clearly-implied next step: do not invent one. A completion is not a plan. Mention in your chat message what you think the natural next step would be and let the user decide.
    - Create AT MOST ONE follow-up task this turn. If several finished items all suggest work, tell the user and let them pick.
`
      : ''
  }${
    anyInput
      ? `
NEEDS INPUT → someone is blocked waiting on an answer. You are the user's AUTHORITY on their board: DEFAULT TO DECIDING IT YOURSELF — don't punt to the user.
 - For a TASK: sokosumi_get_task shows what was asked; answer in a comment. For a JOB: sokosumi_get_job_input_request gives the event_id and the requested fields; answer with sokosumi_provide_job_input.
 - Approvals & direction — approve a plan, request specific changes, pick an option, answer a question, provide a value: these are YOUR call. Settle it. "Approve the plan?" → read the plan and approve it or request concrete changes; do NOT ask the user. ${gatingNote}
 - Fill a field ONLY from a real source you can point to: the recent conversation, the task's purpose, the user's earlier instructions, your memory, a prior result. If any required field has no source, treat it as unanswerable and leave it for the user — a fabricated answer is far worse than a paused job, and at high autonomy it submits unreviewed.
 - Escalate to the USER only when the decision truly needs them — it SPENDS credits, publishes / commits externally, or hinges on a preference only they hold. When it does: message the USER in chat (outbox-send) THIS SAME TURN, leading with your recommendation ("I'd approve the plan as-is because Y — ok?"). ONLY after you've actually sent that chat message may you note on the task that it's with the user. NEVER comment "getting the user's decision" without sending the message — a promise you don't keep is worse than silence.
 - If you genuinely cannot source an answer and it is not the user's call either, say so plainly rather than padding it — an honest "blocked on X, chasing it" beats a comment with no content.
`
      : ''
  }${
    anyNew
      ? `
NEWLY CREATED task → comment ONLY if you have real, specific context the creator may have missed (an email thread, prior research, a deadline, a person to involve). Otherwise skip — silence beats noise.
`
      : ''
  }
Tools: sokosumi_get_task / get_job / get_job_input_request / list_tasks / list_jobs / list_coworkers, sokosumi_add_task_comment, sokosumi_provide_job_input${anyDone ? ', sokosumi_create_task (follow-ups only, at most one)' : ''}, outbox-send, memory/mail/calendar. Do NOT start jobs (sokosumi_create_job) and do NOT spend credits.

Nothing warrants action? Reply "skip".`;
}
