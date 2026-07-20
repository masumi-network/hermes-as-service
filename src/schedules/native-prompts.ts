import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';

/**
 * Recurring agent prompts installed as NATIVE cronjobs on each user's
 * machine — per the locked scheduling design: the built-in cronjob tool is
 * THE scheduler; the orchestrator only holds visibility mirrors (which the
 * agent registers itself, exactly like its daily-brief at onboarding).
 *
 * The native path also gets quiet acknowledgements for free: the machine's
 * cron-outbox-bridge discards "ok"/"done"/"[silent]" replies, so a tick
 * with nothing to say never reaches the user's chat.
 *
 * syncNativePromptCrons() reconciles a machine to the desired set for its
 * autonomy level: one idempotent agent turn that creates/updates the
 * eligible cronjobs and deletes the ineligible/retired ones. Called at
 * onboarding finalize, on autonomy change, and from the admin resync.
 */

type Autonomy = 'low' | 'medium' | 'high';
const AUTONOMY_RANK: Record<Autonomy, number> = { low: 0, medium: 1, high: 2 };

/**
 * Bump on ANY change to NATIVE_PROMPTS (content, cadence, names). Instances
 * whose HermesInstance.nativePromptsVersion is older get re-reconciled by
 * the hourly reconciler cron — that's how spec changes roll out fleet-wide
 * without manual resyncs, and how onboarding-time sync failures self-heal.
 */
export const NATIVE_PROMPTS_VERSION = 1;

interface NativePromptSpec {
  /** Cronjob name on the machine AND mirror-row name — stable identifier. */
  name: string;
  /** Cron expression. When `localTime`, the HOUR is written in the user's
   * local time and shifted to UTC at install (machines run UTC cron). */
  cronExpr: string;
  localTime: boolean;
  minAutonomy: Autonomy;
  /** One-line summary for the mirror registration. */
  summary: string;
  prompt: string;
}

export const NATIVE_PROMPTS: NativePromptSpec[] = [
  {
    name: 'weekly-wrap',
    cronExpr: '0 16 * * 5',
    localTime: true,
    minAutonomy: 'medium',
    summary: 'Friday wrap-up — completions, credit spend, Monday priorities.',
    prompt:
      'Give the user a Friday wrap-up: (a) Sokosumi jobs completed this week with a 1-line takeaway per job, (b) total credits spent this week and the top 3 most expensive jobs, (c) open tasks that should move first thing Monday. Tight, scannable, under 200 words.',
  },
  {
    name: 'stuck-jobs-reminder',
    cronExpr: '0 */4 * * *',
    localTime: false,
    minAutonomy: 'medium',
    summary: 'Every 4h — nudge about jobs waiting on your input for >24h.',
    prompt:
      'Scan for Sokosumi jobs in AWAITING_INPUT status that have been stuck for >24h. If any exist, send a short reminder naming the job and what input it needs. If none are stuck, reply with the literal string "ok" and nothing else.',
  },
  {
    name: 'low-credits-watcher',
    cronExpr: '0 9 * * *',
    localTime: true,
    minAutonomy: 'medium',
    summary: 'Daily 9am — heads-up when a workspace credit balance drops below 25.',
    prompt:
      'Call sokosumi_get_credits (no org filter — check every workspace balance). If any workspace balance is below 25 credits, send a one-sentence heads-up naming the workspace, the balance, and the 1–2 most recent jobs that drove the spend. If all balances are 25 or above, reply only with "ok".',
  },
  {
    name: 'followup-task-generator',
    cronExpr: '0 6 * * *',
    localTime: true,
    minAutonomy: 'high',
    summary: 'Daily 6am — create follow-up tasks from yesterday’s completed jobs.',
    prompt:
      'For each Sokosumi job that completed in the last 24h, read the result and decide whether it implies a clearly defined next task. FIRST check sokosumi_list_tasks for an existing follow-up already covering it (the 5-minute continuation pass may have created one) — skip those. For each qualifying job: pick the right coworker via sokosumi_list_coworkers, create the follow-up task via sokosumi_create_task, and add a brief comment linking back to the source job. Skip jobs where the next step is ambiguous — do not invent work. End with a one-paragraph summary of what you created, or reply only "ok" if no follow-ups were warranted.',
  },
  {
    name: 'workspace-cleanup',
    cronExpr: '0 23 * * 0',
    localTime: true,
    minAutonomy: 'high',
    summary: 'Sunday 11pm — surface stale drafts and unrefunded failed jobs.',
    prompt:
      'Audit the user’s Sokosumi workspace: list DRAFT tasks untouched for >30 days and FAILED jobs older than 7 days that were never refunded. Offer to cancel/refund them in plain language — do not act without confirmation in chat. Reply only "ok" if neither category has anything.',
  },
  {
    name: 'coworker-idle-nudge',
    cronExpr: '0 10 * * 1',
    localTime: true,
    minAutonomy: 'high',
    summary: 'Monday 10am — flag coworkers unused for 30+ days.',
    prompt:
      'List coworkers from sokosumi_list_coworkers who have no tasks assigned in the last 30 days. For each, write one sentence on what they could help with based on their capabilities. Cap at 3 coworkers; reply only "ok" if all are active.',
  },
];

/** Names that once existed (any design iteration) and must be removed if
 * present on a machine. morning-brief was folded into the daily-brief. */
const RETIRED_NATIVE_NAMES = ['morning-brief', 'awaiting-input-chaser'];

/**
 * Shift a local-time cron's hour (and day-of-week, when the shift crosses
 * midnight) to UTC using the timezone's CURRENT offset, computed to minute
 * precision and rounded to the nearest hour — deterministic for half-hour
 * zones (Kolkata always rounds the same way; ±30min residual accepted).
 * DST changes drift the fire time by an hour twice a year — fine for
 * briefs/nudges. Only single-value DOW fields are shifted ('*' passes
 * through; our specs use nothing else).
 */
export function localCronToUtc(cronExpr: string, timezone: string): string {
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5 || !/^\d+$/.test(parts[1] ?? '')) return cronExpr;
  try {
    // Snap to the minute: the formatter has no seconds field, so an
    // unsnapped instant makes the diff (offset − currentSeconds) and the
    // rounding flips nondeterministically at half-hour boundaries.
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    // Minute-precise tz offset: format the same instant in the target zone
    // and diff against UTC.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    const tzAsUtc = Date.UTC(
      Number(p['year']), Number(p['month']) - 1, Number(p['day']),
      Number(p['hour']) % 24, Number(p['minute']),
    );
    const offsetHours = Math.round((tzAsUtc - now.getTime()) / 3_600_000);
    const localHour = Number(parts[1]);
    const raw = localHour - offsetHours;
    const utcHour = ((raw % 24) + 24) % 24;
    // Crossing midnight shifts the UTC day: raw<0 → previous UTC day,
    // raw>23 → next UTC day. Shift single-number DOW fields accordingly.
    const dayShift = raw < 0 ? -1 : raw > 23 ? 1 : 0;
    let dow = parts[4] ?? '*';
    if (dayShift !== 0 && /^\d$/.test(dow)) {
      dow = String(((Number(dow) + dayShift) % 7 + 7) % 7);
    }
    return [parts[0], String(utcHour), parts[2], parts[3], dow].join(' ');
  } catch {
    return cronExpr;
  }
}

/**
 * One idempotent agent turn that reconciles the machine's native prompt
 * cronjobs to the desired set for its autonomy. Best-effort: failures log
 * and return false; the next sync (autonomy change / admin resync) retries.
 */
export async function syncNativePromptCrons(instanceId: string): Promise<boolean> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || row.destroyedAt || !row.endpointUrl) return false;
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') return false;

  const log = logger.child({ instanceId, userId: row.userId, fn: 'sync_native_prompts' });
  const autonomy: Autonomy =
    row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  const tz = row.timezone ?? 'UTC';

  // The mirror rows carry the user's intent: a native cron whose mirror the
  // user disabled in the Sokosumi settings panel must NOT run on the
  // machine. The reconciler treats disabled ones as removals, so even if
  // the immediate toggle propagation failed, this converges hourly.
  const disabledMirrors = await prisma.scheduledTask.findMany({
    where: {
      instanceId,
      kind: 'user',
      enabled: false,
      name: { in: NATIVE_PROMPTS.map((n) => n.name) },
    },
    select: { name: true },
  });
  const disabledNames = new Set(disabledMirrors.map((m) => m.name));

  const desired = NATIVE_PROMPTS.filter(
    (s) => AUTONOMY_RANK[autonomy] >= AUTONOMY_RANK[s.minAutonomy] && !disabledNames.has(s.name),
  );
  const removeNames = [
    ...NATIVE_PROMPTS.filter(
      (s) => AUTONOMY_RANK[autonomy] < AUTONOMY_RANK[s.minAutonomy] || disabledNames.has(s.name),
    ).map((s) => s.name),
    ...RETIRED_NATIVE_NAMES,
  ];

  const desiredBlocks = desired
    .map((s) => {
      const expr = s.localTime ? localCronToUtc(s.cronExpr, tz) : s.cronExpr;
      return `- name: "${s.name}" · cron expression "${expr}" (UTC) · deliver to "local"
  Prompt content:
  <prompt>
  ${s.prompt}
  </prompt>
  Mirror summary: ${s.summary}`;
    })
    .join('\n\n');

  const prompt = `Internal orchestration — your reply is discarded; do not greet.

Reconcile your recurring background cronjobs to EXACTLY this desired state. Use your cronjob tool (cronjob.list / cronjob.create / cronjob.remove or your equivalents).

DESIRED cronjobs (create any that are missing; if one exists under the same name but with a different cron expression or prompt, remove and recreate it; if it already matches, leave it alone):

${desiredBlocks || '(none for your autonomy level)'}

REMOVE these cronjobs if they exist (retired, disabled by the user, or above your autonomy level): ${removeNames.map((n) => `"${n}"`).join(', ')}. Do NOT touch "daily-brief" or any cronjob the user asked you to create.

Then, for EVERY cronjob in the DESIRED list above (including ones you left alone), register/refresh its visibility mirror — this is how the orchestrator verifies the install, so do it for all of them. Your shell does NOT inherit the gateway env, so source /opt/data/.env first:

   set -a; . /opt/data/.env; set +a
   curl -sS -X POST \\
     -H "Authorization: Bearer \$ORCHESTRATOR_OUTBOX_TOKEN" \\
     -H "Content-Type: application/json" \\
     -d '{"name":"<cronjob name>","prompt":"<the mirror summary from above>","cron_expr":"<the cron expression>","timezone":"UTC","enabled":true}' \\
     "\$ORCHESTRATOR_BASE/v1/llm/\$INSTANCE_ID/schedules"

If a mirror request fails, retry it once; the cronjob itself runs regardless.

When done, reply "ok".`;

  const turnStartedAt = new Date();
  try {
    const apiKey = await decryptSecret(row.apiServerKey);
    const res = await fetch(`${row.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`native prompt sync ${res.status}: ${body.slice(0, 200)}`);
    }
    // Clean up mirror rows for cronjobs this sync removed from the machine.
    // Guarded by prompt==mirror-summary so a USER-created schedule that
    // happens to share a native name is never deleted (its prompt differs).
    // Disabled-by-user rows are kept (they hold the "disabled" intent).
    const removableForAutonomy = NATIVE_PROMPTS.filter(
      (n) => AUTONOMY_RANK[autonomy] < AUTONOMY_RANK[n.minAutonomy],
    ).map((n) => n.name);
    const knownSummaries = NATIVE_PROMPTS.map((n) => n.summary);
    await prisma.scheduledTask.deleteMany({
      where: {
        instanceId,
        kind: 'user',
        OR: [
          { name: { in: removableForAutonomy }, prompt: { in: knownSummaries } },
          { name: { in: RETIRED_NATIVE_NAMES } },
        ],
      },
    });

    // VERIFY: the reconcile prompt makes the agent re-register a mirror for
    // every desired cronjob — those curls hit our own schedules API, so a
    // fresh updatedAt on each desired name's mirror row is hard evidence
    // the agent actually processed the list. Only a verified sync stamps
    // the version; unverified ones are retried by the hourly reconciler.
    let verified = true;
    if (desired.length > 0) {
      const mirrors = await prisma.scheduledTask.findMany({
        where: { instanceId, kind: 'user', name: { in: desired.map((d) => d.name) } },
        select: { name: true, updatedAt: true },
      });
      const fresh = new Set(
        mirrors.filter((m) => m.updatedAt >= turnStartedAt).map((m) => m.name),
      );
      verified = desired.every((d) => fresh.has(d.name));
    }
    if (verified) {
      await prisma.hermesInstance.update({
        where: { id: instanceId },
        data: { nativePromptsVersion: NATIVE_PROMPTS_VERSION, nativePromptsSyncedAt: new Date() },
      });
      log.info({ autonomy, desired: desired.length, removed: removeNames.length }, 'native_prompts_synced');
    } else {
      log.warn({ autonomy, desired: desired.length }, 'native_prompts_sync_unverified_will_retry');
    }
    return verified;
  } catch (err) {
    log.warn({ err }, 'native_prompts_sync_failed');
    return false;
  }
}

/**
 * Hourly reconciler sweep: retries instances whose native prompt install
 * was never verified (onboarding-time failure) or predates the current
 * NATIVE_PROMPTS_VERSION (spec rollout). Small cap — each item is a full
 * agent turn.
 */
export async function runNativePromptReconcilerSweep(): Promise<{ scanned: number; synced: number }> {
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      endpointUrl: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
      OR: [
        { nativePromptsVersion: null },
        { nativePromptsVersion: { lt: NATIVE_PROMPTS_VERSION } },
      ],
    },
    select: { id: true },
    take: 5,
  });
  let synced = 0;
  for (const instance of due) {
    try {
      if (await syncNativePromptCrons(instance.id)) synced++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'native_prompt_reconciler_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, synced }, 'native_prompt_reconciler_done');
  }
  return { scanned: due.length, synced };
}

/**
 * Propagate a Sokosumi-UI schedule toggle/removal to the MACHINE's native
 * cronjob. There is no machine-side HTTP cron API, so this is an agent
 * turn; best-effort with convergence backstops:
 *  - native prompt crons: the hourly reconciler enforces the mirror row's
 *    enabled flag even if this immediate turn fails.
 *  - other agent-created crons (incl. daily-brief): this turn is the only
 *    propagation, so failures are logged loudly.
 */
export async function propagateCronToggleToMachine(
  instanceId: string,
  opts: { name: string; enable: boolean; cronExpr?: string; mirrorPrompt?: string },
): Promise<boolean> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || row.destroyedAt || !row.endpointUrl) return false;

  const log = logger.child({ instanceId, userId: row.userId, fn: 'propagate_cron_toggle' });
  const spec = NATIVE_PROMPTS.find((n) => n.name === opts.name);

  let instruction: string;
  if (!opts.enable) {
    instruction = `The user just DISABLED the scheduled job "${opts.name}" in their Sokosumi settings. Use your cronjob tool to disable it; if your tool has no disable/pause, REMOVE the cronjob named "${opts.name}". Do not touch any other cronjob.`;
  } else if (spec) {
    const expr = spec.localTime ? localCronToUtc(spec.cronExpr, row.timezone ?? 'UTC') : spec.cronExpr;
    instruction = `The user just RE-ENABLED the scheduled job "${opts.name}" in their Sokosumi settings. Ensure a cronjob named "${opts.name}" exists and is enabled — if it's missing, create it with cron expression "${expr}" (UTC), deliver to "local", and this prompt content:\n<prompt>\n${spec.prompt}\n</prompt>`;
  } else {
    instruction = `The user just RE-ENABLED the scheduled job "${opts.name}" in their Sokosumi settings. Ensure a cronjob named "${opts.name}" exists and is enabled. If you removed it earlier, re-create it${opts.cronExpr ? ` with cron expression "${opts.cronExpr}"` : ''} — reconstruct its prompt from your memory of what this job does${opts.mirrorPrompt ? ` (summary: ${opts.mirrorPrompt})` : ''}.`;
  }

  const prompt = `Internal orchestration — your reply is discarded; do not greet.\n\n${instruction}\n\nWhen done, reply "ok".`;

  try {
    const apiKey = await decryptSecret(row.apiServerKey);
    const res = await fetch(`${row.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(3 * 60_000),
    });
    if (!res.ok) throw new Error(`propagate toggle ${res.status}`);
    log.info({ name: opts.name, enable: opts.enable }, 'cron_toggle_propagated');
    return true;
  } catch (err) {
    log.error({ err, name: opts.name, enable: opts.enable }, 'cron_toggle_propagation_failed');
    return false;
  }
}

/** Removal = disable without re-enable path; same machinery. */
export async function propagateCronRemovalToMachine(
  instanceId: string,
  name: string,
): Promise<boolean> {
  return propagateCronToggleToMachine(instanceId, { name, enable: false });
}
