import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';
import { runCronAgentTurn } from './cron-agent-turn.js';

/**
 * INPUT_REQUIRED auto-responder.
 *
 * Every few minutes, scan each user's workspaces for Sokosumi jobs paused in
 * AWAITING_INPUT and — at medium/high autonomy — drive Hermes to answer them.
 *
 * The sweep does NOT call the Sokosumi tools itself; it PROMPTS the agent over
 * its chat endpoint (like urgent.ts) and lets the agent call
 * `sokosumi_get_job_input_request` + `sokosumi_provide_job_input`. The MCP
 * layer's autonomy gating then does the right thing with zero extra logic:
 *   - high   → provide_job_input executes immediately (true auto-answer)
 *   - medium → provide_job_input raises the user's confirmation card
 *   - low    → write tools are stripped, so we skip the agent entirely here and
 *              let the urgent-interrupt sweep keep doing its notify-the-user job
 *              (avoids double-notifying).
 *
 * Guardrail: the prompt tells Hermes to answer ONLY from real context (the
 * task's purpose, the user's prior instructions, memory, prior results) and to
 * SKIP rather than invent an answer — at high autonomy a fabricated input would
 * submit unreviewed.
 */

const MAX_JOBS_PER_TICK = 5;
const AGENT_TURN_TIMEOUT_MS = 4 * 60_000;

interface PausedJob {
  jobId: string;
  name: string;
  orgId: string;
  timestamp: string;
}

export async function respondToInputRequestsForInstance(
  instanceId: string,
): Promise<{ prompted: number; reason?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { prompted: 0, reason: 'no_row' };
  if (row.destroyedAt) return { prompted: 0, reason: 'destroyed' };
  if (!row.endpointUrl) return { prompted: 0, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { prompted: 0, reason: `status=${row.status}` };
  }

  // Auto-answer is a medium/high feature. At low autonomy the write tools are
  // stripped anyway, and the urgent-interrupt sweep already notifies the user.
  const autonomy =
    row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  if (autonomy === 'low') return { prompted: 0, reason: 'low_autonomy' };

  if (!(await isSystemSweepEnabled(row.id, 'input-responder'))) {
    return { prompted: 0, reason: 'sweep_disabled' };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env, row.userId)) return { prompted: 0, reason: 'no_sokosumi_key' };

  const log = logger.child({ instanceId, userId: row.userId, fn: 'input_responder' });
  const client = new SokosumiClient(row.userId, env);

  let orgs: Array<{ id: string }> = [];
  try {
    orgs = (await client.listOrganizations()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'input_responder_list_orgs_failed');
    return { prompted: 0, reason: 'list_orgs_failed' };
  }

  // Only act on input-requests newer than our own watermark, so a job that
  // stays paused (because the agent couldn't answer it) isn't re-prompted
  // every tick. Separate column from the urgent sweep's watermark.
  // 6h lookback on first run (no watermark yet) so activating the feature on an
  // existing instance doesn't reach back over very stale paused jobs.
  const since = row.lastInputResponderAt ?? new Date(Date.now() - 6 * 60 * 60_000);
  const paused: PausedJob[] = [];
  let anyOrgFailed = false;

  for (const org of orgs.slice(0, 5)) {
    const orgClient = client.withOrganization(org.id);
    try {
      const jobs = (await orgClient.listJobs({ status: 'AWAITING_INPUT', limit: 15 })) as Array<{
        id?: string;
        name?: string;
        status?: string;
        updatedAt?: string;
        createdAt?: string;
      }>;
      for (const j of jobs) {
        // Sokosumi's /jobs endpoint ignores the status query filter and
        // returns all statuses (lowercase), so re-check client-side —
        // otherwise a recently-touched COMPLETED job would be treated as
        // awaiting input and waste an agent turn.
        if (j.status && j.status.toLowerCase() !== 'awaiting_input') continue;
        const stampStr = j.updatedAt ?? j.createdAt;
        if (!stampStr || !j.id) continue;
        const stamp = new Date(stampStr);
        if (isNaN(stamp.getTime()) || stamp.getTime() <= since.getTime()) continue;
        paused.push({ jobId: j.id, name: j.name ?? '(unnamed job)', orgId: org.id, timestamp: stampStr });
      }
    } catch (err) {
      anyOrgFailed = true;
      log.warn({ err, orgId: org.id }, 'input_responder_list_jobs_failed');
    }
  }

  const now = new Date();
  if (paused.length === 0) {
    // Only advance the watermark on a GENUINE empty window. If an org list
    // failed, leave it untouched so a job hidden by the transient error is
    // reconsidered next tick instead of being stranded behind the watermark.
    if (!anyOrgFailed) {
      await prisma.hermesInstance.update({ where: { id: instanceId }, data: { lastInputResponderAt: now } });
    }
    return { prompted: 0, reason: anyOrgFailed ? 'list_failed_retry' : 'no_paused_jobs' };
  }

  // Process OLDEST first, and advance the watermark only to the newest job we
  // actually HANDLE. When more jobs are paused than the per-tick cap, the
  // over-cap (newer) jobs stay above the watermark and get picked up next tick
  // — instead of being skipped past forever (the bug if we advanced to `now`).
  paused.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const batch = paused.slice(0, MAX_JOBS_PER_TICK);

  const apiKey = await decryptSecret(row.apiServerKey);
  let requestId: string;
  try {
    const turn = await runCronAgentTurn({
      instanceId,
      userId: row.userId,
      endpointUrl: row.endpointUrl,
      apiKey,
      source: 'input_responder',
      prompt: buildAnswerPrompt(batch, autonomy),
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
    });
    requestId = turn.requestId;
  } catch (err) {
    // Transient agent-turn failure (endpoint down / timeout): do NOT advance the
    // watermark — a paused job doesn't bump its own updatedAt, so advancing here
    // would strand it. Leaving it means we retry the same batch next tick (at
    // most once per 5 min, so no tight storm).
    log.warn({ err }, 'input_responder_agent_turn_failed');
    return { prompted: 0, reason: 'agent_turn_failed_retry' };
  }

  // Advance to the newest timestamp we handled, clamped to now (guards against a
  // clock-skewed future timestamp pushing the watermark ahead of real time).
  // Skipped-but-still-paused jobs sit at/below this and won't re-fire; genuinely
  // newer events are above it and will.
  const handledTs = new Date(batch[batch.length - 1]!.timestamp).getTime();
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastInputResponderAt: new Date(Math.min(handledTs, now.getTime())) },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: { source: 'input_responder', jobs: batch.length, autonomy, requestId },
  });
  log.info({ jobs: batch.length, autonomy }, 'input_responder_prompted');
  return { prompted: batch.length };
}

let sweepInFlight = false;

export async function runInputResponderSweep(): Promise<{ scanned: number; prompted: number }> {
  // Re-entrancy guard: each instance with paused jobs holds a 4-minute
  // agent-turn timeout, so two busy instances already exceed the 5-minute
  // tick — an overlapping sweep would read the not-yet-advanced watermark
  // and prompt the SAME jobs concurrently (duplicate spend; at high
  // autonomy potentially duplicate provide_job_input submissions).
  if (sweepInFlight) return { scanned: 0, prompted: 0 };
  sweepInFlight = true;
  try {
    return await runInputResponderSweepInner();
  } finally {
    sweepInFlight = false;
  }
}

async function runInputResponderSweepInner(): Promise<{ scanned: number; prompted: number }> {
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true },
    take: 100,
  });
  const { continueFollowupsForInstance } = await import('./followup-continuation.js');
  let prompted = 0;
  for (const instance of due) {
    try {
      const res = await respondToInputRequestsForInstance(instance.id);
      if (res.prompted > 0) prompted++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'input_responder_sweep_item_failed');
    }
    // Plan continuation rides the same tick: newly-COMPLETED jobs get a
    // "was there an agreed next step?" pass (see followup-continuation.ts).
    try {
      await continueFollowupsForInstance(instance.id);
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'followup_continuation_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, prompted }, 'input_responder_sweep_done');
  }
  return { scanned: due.length, prompted };
}

function buildAnswerPrompt(jobs: PausedJob[], autonomy: 'medium' | 'high'): string {
  const jobsBlock = jobs
    .map((j, i) => `${i + 1}. "${j.name}" — job_id=${j.jobId} (workspace org=${j.orgId})`)
    .join('\n');

  const gatingNote =
    autonomy === 'high'
      ? 'At your autonomy level your sokosumi_provide_job_input call submits the answer immediately.'
      : 'At your autonomy level your sokosumi_provide_job_input call raises a confirmation card for the user to approve — that is expected; fire the tool, then stop.';

  return `Internal task — your reply text here is discarded; act through tools only.

These Sokosumi job(s) are paused in AWAITING_INPUT and will not finish until someone answers:
${jobsBlock}

For EACH job, in order:
1. Call sokosumi_get_job_input_request with the job_id to read exactly what it needs — you'll get an event_id plus the question / requested fields.
2. Decide the answer ONLY from real context you actually have: the task's purpose, the user's earlier instructions in this workspace, your memory, and prior job results. For EVERY field you fill, you must be able to point to where the value came from. If any required field has no clear source, treat the whole job as unanswerable.
3. If — and only if — every required field has a real source, call sokosumi_provide_job_input with the job_id, that event_id, and input_data matching the requested fields. ${gatingNote}
4. Otherwise — a human decision, a preference you don't know, or missing info — DO NOT GUESS and DO NOT invent values. Skip that job and leave it paused for the user. A fabricated answer is far worse than a paused job, and at high autonomy it submits unreviewed.

HARD LIMITS for this turn: the ONLY tools you may use are sokosumi_get_job_input_request and sokosumi_provide_job_input. Do NOT create tasks, do NOT start jobs, do NOT spend credits, do NOT comment, do NOT take any action other than answering the input requests above. Never make up input values; when in doubt, skip.`;
}
