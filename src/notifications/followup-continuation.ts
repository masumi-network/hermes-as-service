import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';
import { runCronAgentTurn } from './cron-agent-turn.js';

/**
 * Plan continuation — the "do X, then when it's done do Y" follow-through.
 *
 * Runs inside the 5-minute input-responder sweep. When a Sokosumi job flips
 * to COMPLETED, Hermes is prompted to check its memory and the recent
 * conversation: did the user and Hermes agree on a next step that this
 * completion unblocks (e.g. "once the research tasks are done, have Alex
 * build a dashboard")? If yes, Hermes continues the plan NOW — comments on
 * the task and/or creates the follow-up task. The MCP autonomy gating does
 * the rest: high executes immediately, medium raises confirmation cards.
 *
 * Guardrails: act only on real, remembered plans (never invent
 * follow-ups); per-instance watermark advanced BEFORE the agent turn
 * (at-most-once — a duplicate follow-up task is worse than a missed one,
 * and the prompt's existing-task check backstops misses); ticks skip
 * entirely when any org listing fails so partial views can't bury
 * completions behind the watermark.
 *
 * Deliberately excluded tools: sokosumi_create_job (spends credits — a
 * follow-up that needs a paid job should be created as a task for a
 * coworker instead) and anything unrelated to continuing the plan.
 */

const MAX_COMPLETIONS_PER_TICK = 3;
const AGENT_TURN_TIMEOUT_MS = 4 * 60_000;

interface CompletedJob {
  jobId: string;
  name: string;
  orgId: string;
  timestamp: string;
}

export async function continueFollowupsForInstance(
  instanceId: string,
): Promise<{ prompted: number; reason?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { prompted: 0, reason: 'no_row' };
  if (row.destroyedAt) return { prompted: 0, reason: 'destroyed' };
  if (!row.endpointUrl) return { prompted: 0, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { prompted: 0, reason: `status=${row.status}` };
  }
  const autonomy =
    row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  if (autonomy === 'low') return { prompted: 0, reason: 'low_autonomy' };

  // Honors the same settings toggle as the input-responder — its mirror
  // description explicitly advertises the follow-up pass as part of it.
  if (!(await isSystemSweepEnabled(row.id, 'input-responder'))) {
    return { prompted: 0, reason: 'sweep_disabled' };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env, row.userId)) return { prompted: 0, reason: 'no_sokosumi_key' };

  const log = logger.child({ instanceId, userId: row.userId, fn: 'followup_continuation' });
  const client = new SokosumiClient(row.userId, env);

  let orgs: Array<{ id: string }> = [];
  try {
    orgs = (await client.listOrganizations()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'followup_list_orgs_failed');
    return { prompted: 0, reason: 'list_orgs_failed' };
  }

  // First run looks back 1h only — activating the feature must not replay
  // days of historical completions as "fresh".
  const since = row.lastFollowupSweepAt ?? new Date(Date.now() - 60 * 60_000);
  const completed: CompletedJob[] = [];
  let anyOrgFailed = false;

  for (const org of orgs.slice(0, 5)) {
    const orgClient = client.withOrganization(org.id);
    try {
      const jobs = (await orgClient.listJobs({ status: 'COMPLETED', limit: 15 })) as Array<{
        id?: string;
        name?: string;
        status?: string;
        completedAt?: string;
        updatedAt?: string;
        createdAt?: string;
      }>;
      for (const j of jobs) {
        // Sokosumi's /jobs endpoint ignores the status filter (returns all
        // statuses, lowercase) — re-check client-side so we only continue
        // plans off genuinely completed jobs.
        if (j.status && j.status.toLowerCase() !== 'completed') continue;
        // completedAt preferred (same as urgent.ts): updatedAt moves on any
        // post-completion touch (rating, refund) and would replay old jobs.
        const stampStr = j.completedAt ?? j.updatedAt ?? j.createdAt;
        if (!stampStr || !j.id) continue;
        const stamp = new Date(stampStr);
        if (isNaN(stamp.getTime()) || stamp.getTime() <= since.getTime()) continue;
        completed.push({ jobId: j.id, name: j.name ?? '(unnamed job)', orgId: org.id, timestamp: stampStr });
      }
    } catch (err) {
      anyOrgFailed = true;
      log.warn({ err, orgId: org.id }, 'followup_list_jobs_failed');
    }
  }

  const now = new Date();
  // Any org listing failure = skip the whole tick and retry in 5 min.
  // Processing a partial view here would advance the watermark past the
  // failed org's unseen completions and bury them forever.
  if (anyOrgFailed) return { prompted: 0, reason: 'list_failed_retry' };
  if (completed.length === 0) {
    await prisma.hermesInstance.update({ where: { id: instanceId }, data: { lastFollowupSweepAt: now } });
    return { prompted: 0, reason: 'no_new_completions' };
  }

  // Oldest first; watermark advances only past what we actually handled
  // (same semantics as the input-responder — over-cap completions get
  // picked up next tick instead of skipped forever).
  completed.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const batch = completed.slice(0, MAX_COMPLETIONS_PER_TICK);

  // AT-MOST-ONCE: advance the watermark BEFORE the agent turn. A timed-out
  // turn may still have completed sokosumi_create_task on the machine
  // (client-side abort doesn't stop the agent), so retrying the same batch
  // would create DUPLICATE follow-up tasks — worse than occasionally
  // missing one (the prompt also tells the agent to check for an existing
  // follow-up before creating, as a second line of defense).
  const handledTs = new Date(batch[batch.length - 1]!.timestamp).getTime();
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastFollowupSweepAt: new Date(Math.min(handledTs, now.getTime())) },
  });

  const apiKey = await decryptSecret(row.apiServerKey);
  let requestId: string;
  try {
    const turn = await runCronAgentTurn({
      instanceId,
      userId: row.userId,
      endpointUrl: row.endpointUrl,
      apiKey,
      source: 'followup_continuation',
      prompt: buildContinuePrompt(batch, autonomy),
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
    });
    requestId = turn.requestId;
  } catch (err) {
    log.warn({ err }, 'followup_agent_turn_failed');
    return { prompted: 0, reason: 'agent_turn_failed' };
  }
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: { source: 'followup_continuation', jobs: batch.length, autonomy, requestId },
  });
  log.info({ jobs: batch.length, autonomy }, 'followup_continuation_prompted');
  return { prompted: batch.length };
}

function buildContinuePrompt(jobs: CompletedJob[], autonomy: 'medium' | 'high'): string {
  const jobsBlock = jobs
    .map((j, i) => `${i + 1}. "${j.name}" — job_id=${j.jobId} (workspace org=${j.orgId})`)
    .join('\n');

  const gatingNote =
    autonomy === 'high'
      ? 'At your autonomy level your write tools execute immediately.'
      : 'At your autonomy level sokosumi_create_task / sokosumi_add_task_comment raise confirmation cards for the user to approve — that is expected; fire the tool, then stop.';

  return `Internal task — your reply text here is discarded; act through tools only.

These Sokosumi job(s) just COMPLETED:
${jobsBlock}

For EACH one, check whether it unblocks a next step the user and you ACTUALLY agreed on — a plan in your memory or in your recent conversation (e.g. "once the research tasks are done, create a dashboard task for Alex"). Steps:
1. Call sokosumi_get_job to read the result (and sokosumi_get_task on its task if you need the surrounding context).
2. Search your memory and recall the recent conversation: was there a concrete, user-approved next step waiting on this result? Is it now fully unblocked (i.e. every prerequisite job/task it was waiting on is also complete — check with sokosumi_list_tasks / sokosumi_list_jobs if the plan involved several)?
3. If yes: FIRST check sokosumi_list_tasks for an existing follow-up task already covering this step (an earlier pass or the daily follow-up generator may have created it) — if one exists, do nothing. Otherwise CONTINUE THE PLAN NOW. Create the follow-up task via sokosumi_create_task (right coworker via sokosumi_list_coworkers, same workspace as the source task unless the plan says otherwise) with a description that references the completed work, and add a short comment on the source task linking forward. ${gatingNote}
4. If the plan is only PARTIALLY unblocked (other prerequisite jobs still running), do nothing yet — you'll be prompted again when the rest complete.
5. If there was NO agreed next step: reply "skip". Do NOT invent follow-up work — a completion alone is not a plan. The separate notification sweep handles telling the user about interesting completions.

HARD LIMITS for this turn: allowed tools are sokosumi_get_job, sokosumi_get_task, sokosumi_list_tasks, sokosumi_list_jobs, sokosumi_list_coworkers, sokosumi_create_task, sokosumi_add_task_comment, and your memory tools. Do NOT start jobs (sokosumi_create_job), do NOT spend credits, do NOT message the user directly.`;
}
