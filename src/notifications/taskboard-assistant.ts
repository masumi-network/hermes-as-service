import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient, resolveSokosumiTarget } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv, normalizeAutonomy } from '../config.js';
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
 *    leave a comment / flag it to the user for a decision;
 *  - a FINISHED task (COMPLETED / CANCELED / FAILED) → Hermes tells the user
 *    in chat what finished and what it produced, then continues the plan if
 *    memory says there was one (one follow-up task, max, to a coworker).
 *
 * Why finished tasks belong HERE and not in the job sweeps: a task run by a
 * coworker — off a schedule, or straight out of the user's own chat with that
 * coworker — produces no job the orchestrator can see. followup-continuation
 * and urgent.ts are both JOB-level, and urgent.ts is explicitly the only sweep
 * allowed to message the user about completions, so coworker-run work fell
 * through every net: nobody told the user, and nobody continued the plan. The
 * taskboard is the one place that work is visible.
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
/**
 * Finished tasks are picked up if they changed within this window. Wider than
 * the new-task window because a completion is worth reporting even if the
 * sweep was down for a while, and dedup makes it at-most-once anyway.
 */
const DONE_TASK_WINDOW_MS = 24 * 60 * 60_000;
/** Prune dedup rows older than this. */
const DEDUP_TTL_MS = 45 * 24 * 60 * 60_000;
const NEW_TASK_STATUSES = new Set(['draft', 'queued', 'ready', 'running']);
/** Terminal statuses worth telling the user about. Sokosumi returns CANCELED
 *  (one L); the variant is accepted defensively. */
const DONE_TASK_STATUSES = new Set(['completed', 'canceled', 'cancelled', 'failed']);

export interface BoardTask {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** null = the user's personal workspace. */
  orgId: string | null;
  /**
   * `input` — coworker blocked, needs an answer.
   * `done`  — just finished (completed/canceled/failed): tell the user and
   *           continue the plan if memory says there was one.
   * `new`   — freshly created, may deserve extra context.
   */
  kind: 'new' | 'input' | 'done';
  /** Sort key — oldest first so over-cap tasks are handled next tick. */
  sortKey: string;
  /** Who did the work, when known — the user thinks in coworker names. */
  assignee?: string;
}

export async function assistTaskboardForInstance(
  instanceId: string,
): Promise<{ handled: number; reason?: string; requestId?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { handled: 0, reason: 'no_row' };
  if (row.destroyedAt) return { handled: 0, reason: 'destroyed' };
  if (!row.endpointUrl) return { handled: 0, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { handled: 0, reason: `status=${row.status}` };
  }
  const autonomy =
    normalizeAutonomy(row.autonomyLevel);
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

  // Workspaces to scan, personal first. MUST be listWorkspaceScopes (not
  // listOrganizations): it always includes the personal workspace (id:null),
  // where a per-user assistant's own INPUT_REQUIRED tasks live.
  let orgs: Array<{ id: string | null }> = [];
  try {
    orgs = (await client.listWorkspaceScopes()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'taskboard_list_orgs_failed');
    return { handled: 0, reason: 'list_orgs_failed' };
  }

  const now = Date.now();
  const raw: BoardTask[] = [];

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

  // Two precise calls per workspace instead of paging the whole board.
  //
  // Unlike /jobs, /tasks?status= is a genuine CURRENT-state filter — verified
  // against production: the per-status buckets sum exactly to the unfiltered
  // total (123) with zero mismatched rows. So:
  //
  //  (1) INPUT_REQUIRED has NO recency bound (a task can sit blocked for
  //      weeks), and the status filter returns all of them in one small page.
  //      This is strictly safer than the old full-pagination approach, whose
  //      whole reason for existing was that a blocked task below a page cut
  //      never bumps updatedAt to resurface.
  //  (2) `new` (6h) and `done` (24h) are both recency-bounded, and the board
  //      pages newest-first, so ONE early-stopped listing covers both.
  const recentCutoff = new Date(now - Math.max(NEW_TASK_WINDOW_MS, DONE_TASK_WINDOW_MS));
  for (const org of orgs) {
    const orgClient = client.withOrganization(org.id);
    const owned = (t: RawTask): boolean =>
      (!!t.ownerId && ownerIds.has(t.ownerId)) || (!!t.userId && ownerIds.has(t.userId));
    const who = (t: RawTask): string | undefined => t.assignee?.name ?? t.coworker?.name ?? undefined;

    try {
      const [blocked, recent] = await Promise.all([
        orgClient.listAllTasks({ scope: 'workspace', status: 'INPUT_REQUIRED', maxItems: 200 }),
        orgClient.listAllTasks({ scope: 'workspace', maxItems: 500, stopWhenOlderThan: recentCutoff }),
      ]);

      for (const t of blocked.items as RawTask[]) {
        // Own tasks only — never comment on colleagues' tasks unprompted.
        if (!t.id || !owned(t)) continue;
        raw.push({
          id: t.id, name: t.name ?? '(unnamed)', description: t.description ?? null,
          status: 'INPUT_REQUIRED', orgId: org.id, kind: 'input',
          sortKey: t.updatedAt ?? t.createdAt ?? '',
          ...(who(t) ? { assignee: who(t) } : {}),
        });
      }

      for (const t of recent.items as RawTask[]) {
        if (!t.id || !owned(t)) continue;
        const status = (t.status ?? '').toLowerCase();
        if (status === 'input_required') continue; // already covered above
        if (DONE_TASK_STATUSES.has(status)) {
          // A finished task's updatedAt moves when it finishes, which is what
          // the window is measured against.
          const stamp = t.updatedAt ?? t.createdAt;
          if (!stamp || now - new Date(stamp).getTime() > DONE_TASK_WINDOW_MS) continue;
          raw.push({
            id: t.id, name: t.name ?? '(unnamed)', description: t.description ?? null,
            status: (t.status ?? '').toUpperCase(), orgId: org.id, kind: 'done', sortKey: stamp,
            ...(who(t) ? { assignee: who(t) } : {}),
          });
        } else if (
          NEW_TASK_STATUSES.has(status) &&
          t.createdAt &&
          now - new Date(t.createdAt).getTime() <= NEW_TASK_WINDOW_MS
        ) {
          raw.push({
            id: t.id, name: t.name ?? '(unnamed)', description: t.description ?? null,
            status: (t.status ?? '').toUpperCase(), orgId: org.id, kind: 'new', sortKey: t.createdAt,
            ...(who(t) ? { assignee: who(t) } : {}),
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

  // Priority: a blocked coworker is waiting on us; a finished task is news the
  // user wants; a new task is the lowest-value case ("silence beats noise").
  // Oldest-first within a kind, so over-cap tasks are handled next tick.
  const KIND_RANK: Record<BoardTask['kind'], number> = { input: 0, done: 1, new: 2 };
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
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
  const doneTasks = batch.filter((b) => b.kind === 'done').length;
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
      doneTasks,
      autonomy,
      requestId,
    },
  });
  log.info({ tasks: batch.length, newTasks, inputTasks, doneTasks, autonomy }, 'taskboard_assistant_handled');
  return { handled: batch.length, requestId };
}

let sweepInFlight = false;

export async function runTaskboardAssistantSweep(): Promise<{ scanned: number; handled: number; requestId?: string }> {
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

async function runTaskboardAssistantSweepInner(): Promise<{ scanned: number; handled: number; requestId?: string }> {
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
  let requestId: string | undefined;
  for (const instance of due) {
    try {
      const res = await assistTaskboardForInstance(instance.id);
      if (res.handled > 0) handled++;
      // Surface the most recent agent turn so the admin Crons "Output" link
      // opens a real prompt+response for this sweep.
      if (res.requestId) requestId = res.requestId;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'taskboard_assistant_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, handled }, 'taskboard_assistant_sweep_done');
  }
  return { scanned: due.length, handled, requestId };
}

/** Exported for tests — the prompt IS the behaviour of this sweep. */
export function buildTaskboardPrompt(tasks: BoardTask[], autonomy: 'medium' | 'high'): string {
  const label = (t: BoardTask): string =>
    t.kind === 'input' ? 'NEEDS INPUT to continue.' : t.kind === 'done' ? 'JUST FINISHED.' : 'newly created.';
  const block = tasks
    .map(
      (t, i) =>
        `${i + 1}. [${t.status}] "${t.name}" — task_id=${t.id} (org=${t.orgId})\n   ${label(t)}${t.assignee ? ` Worked by: ${t.assignee}.` : ''}${t.description ? `\n   Description: ${t.description.slice(0, 400)}` : ''}`,
    )
    .join('\n');

  const gatingNote =
    autonomy === 'high'
      ? 'At high autonomy this executes immediately — you own the call.'
      : 'At medium, just fire the tool and stop — the orchestrator handles it (a comment posts now; a provide_job_input goes to the user to approve). Don\'t ask in chat first.';
  const followupGating =
    autonomy === 'high'
      ? 'At high autonomy sokosumi_create_task executes immediately, so only create a follow-up you are confident the user wants.'
      : 'At medium, sokosumi_create_task raises a confirmation card — that IS how you propose it to the user. Fire the tool once, then stop; do not also ask in chat.';

  const kinds = new Set(tasks.map((t) => t.kind));

  return `Internal task — reply discarded; act through tools only.

The recent conversation is above. START by reading your memory (memory tool) for this user's standing preferences, past decisions, and any PLAN these tasks belong to — that memory is what makes you useful here rather than a status bot. Respond like you KNOW this user: decide what is yours to decide, and never ask an open "what would you like to do?".

Scope check before you act: your job is to coordinate. You decide, comment, notify, and route work to coworkers. You do NOT produce a coworker's deliverable yourself.

Your own tasks that just changed (handle each once, now):
${block}

A task COMMENT is read by the coworker doing that task, NOT the user. Write every comment as direction to the coworker. To reach the USER, message them in chat with your outbox-send skill — NEVER put a message meant for the user in a task comment.
${
  kinds.has('done')
    ? `
FINISHED task (COMPLETED / CANCELED / FAILED) → two jobs, in this order.

 1. TELL THE USER, in chat, via outbox-send. This is the default, not the exception — a task finishing is news they want, especially work a coworker ran from a schedule or from their own chat with that coworker, which they may not be watching. Call sokosumi_get_task first and read the actual result, then write 1-3 sentences: what finished, who did it, what it produced, and the one thing worth knowing about the outcome. Name the task the way the USER would recognise it ("the weekly release report task"), not by id.
    - Search memory for what this task was FOR before writing. If it came out of a plan, a standing schedule, or something they asked for days ago, say so — "the weekly release task we set up on Friday just finished" is worth far more than "a task completed".
    - SKIP the message only if you already told them (check the conversation above), or the task is genuinely trivial or abandoned (a test task, a duplicate, something they cancelled themselves).
    - CANCELED / FAILED: say so plainly, with what is known about why. Do not dress up a failure as progress.

 2. THEN consider a follow-up. Search memory and the recent conversation for a next step that was actually agreed or clearly implied by the plan this task belongs to.
    - If there IS one and it is now unblocked: check sokosumi_list_tasks for an existing task already covering it (an earlier pass may have made one) — if so, do nothing. Otherwise create it with sokosumi_create_task, assigned to the right coworker (sokosumi_list_coworkers), in the same workspace, with a description that references what just finished. ${followupGating}
    - The follow-up is a task FOR A COWORKER. Never assign it to yourself and never do the work yourself.
    - If there is NO agreed or clearly-implied next step: do not invent one. A completion is not a plan. Mention in your chat message what you think the natural next step would be and let the user decide.
    - Create AT MOST ONE follow-up task this turn. If several finished tasks all suggest work, tell the user and let them pick.
`
    : ''
}${
    kinds.has('new')
      ? `
NEW task → comment ONLY if you have real, specific context the creator may have missed (an email thread, prior research, a deadline, a person to involve). Otherwise skip — silence beats noise.
`
      : ''
  }${
    kinds.has('input')
      ? `
INPUT_REQUIRED task → the coworker is blocked; sokosumi_get_task shows what they asked for. You are the user's AUTHORITY on their board: DEFAULT TO DECIDING IT YOURSELF — don't punt to the user.
 - Approvals & direction — approve a plan, request specific changes, pick an option, answer a question, provide a value: these are YOUR call. Read what's asked and settle it in the comment (or sokosumi_provide_job_input). "Approve the plan?" → read the plan and approve it or request concrete changes; do NOT ask the user. ${gatingNote}
 - Escalate to the USER only when the decision truly needs them — it SPENDS credits, publishes / commits externally, or hinges on a preference only they hold. When it does: message the USER in chat (outbox-send) THIS SAME TURN, leading with your recommendation ("I'd approve the plan as-is because Y — ok?"). ONLY after you've actually sent that chat message may you note on the task that it's with the user. NEVER comment "getting the user's decision" without sending the message — a promise you don't keep is worse than silence.
 - If you genuinely cannot source an answer and it is not the user's call either, say so in the comment rather than padding it — an honest "blocked on X, chasing it" beats a comment with no content.
`
      : ''
  }
Tools: sokosumi_get_task / get_job / get_job_input_request / list_jobs / list_tasks / list_coworkers, sokosumi_add_task_comment, sokosumi_provide_job_input${kinds.has('done') ? ', sokosumi_create_task (follow-ups only, at most one)' : ''}, outbox-send, memory/mail/calendar. Do NOT start jobs (sokosumi_create_job) and do NOT spend credits.

Nothing warrants action? Reply "skip".`;
}
