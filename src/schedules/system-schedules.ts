import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { safeNextRun } from './cron.js';

/**
 * The orchestrator owns a set of "system" ScheduledTask rows per instance,
 * created at onboarding-finalize and re-synced any time the autonomy
 * level changes. They come in two flavors:
 *
 * - "system_sweep"  — informational mirror of an orchestrator-level
 *                     background sweep (sokosumi-sync, inbox-refresh,
 *                     urgent-interrupts, task-augmentation). The scheduler
 *                     ignores these; the matching sweep in cron.ts reads
 *                     the row's `enabled` flag to gate work per user.
 *
 * - "system_prompt" — a recurring chat prompt (morning-brief, weekly-wrap,
 *                     etc.) that the scheduler dispatches like any
 *                     user-created cron. Auto-created based on autonomy.
 *
 * All rows are stable-IDed (`{name}-{instanceId}`) so this function is
 * idempotent: re-running it never duplicates rows. Rows can be deleted
 * when autonomy drops or recreated when it rises.
 */

type Autonomy = 'low' | 'medium' | 'high';

interface SystemScheduleSpec {
  /** Stable suffix used in the row id. */
  slug: string;
  kind: 'system_sweep' | 'system_prompt';
  name: string;
  description: string;
  /** UTC cron expression OR a local-time one when timezone is set. */
  cronExpr: string;
  /** True if the cron expression is meant to run in the user's timezone. */
  localTime: boolean;
  /** Min autonomy at which this row should exist. */
  minAutonomy: Autonomy;
  /** Extra predicate beyond autonomy (e.g. only if mail integration present). */
  requires?: (ctx: SyncContext) => boolean;
  /** Only used by system_prompt rows — the chat prompt to dispatch. */
  prompt?: string;
}

const AUTONOMY_RANK: Record<Autonomy, number> = { low: 0, medium: 1, high: 2 };

const SYSTEM_SCHEDULES: SystemScheduleSpec[] = [
  // ---------- system_sweep rows ----------
  {
    slug: 'sokosumi-sync',
    kind: 'system_sweep',
    name: 'Sokosumi workspace sync',
    description:
      'Daily refresh of your Sokosumi workspace (tasks, completed jobs, conversations, credits, coworkers) into Hermes’ memory so the agent stays current.',
    cronExpr: '0 9 * * *',
    localTime: false,
    minAutonomy: 'low',
    requires: (ctx) => ctx.sokosumiConfigured,
  },
  {
    slug: 'inbox-refresh',
    kind: 'system_sweep',
    name: 'Inbox refresh',
    description:
      'Silently re-reads your inbox and calendar every 6 hours so Hermes always knows what arrived without you having to ask.',
    cronExpr: '15 */6 * * *',
    localTime: false,
    minAutonomy: 'low',
    requires: (ctx) => ctx.hasMailOrCalendar,
  },
  {
    slug: 'urgent-interrupts',
    kind: 'system_sweep',
    name: 'Urgent interrupts',
    description:
      'Hourly watcher for completed Sokosumi jobs, AWAITING_INPUT events, and failures — sends a notification only when something genuinely needs your attention.',
    cronExpr: '30 * * * *',
    localTime: false,
    minAutonomy: 'low',
  },
  {
    slug: 'task-augmentation',
    kind: 'system_sweep',
    name: 'Auto-comment on new tasks',
    description:
      'Hourly pass: Hermes reads new tasks on your board and adds useful context (relevant emails, prior work, your preferences) as a comment when it has something to add.',
    cronExpr: '45 * * * *',
    localTime: false,
    minAutonomy: 'high',
  },
  {
    slug: 'hermes-executor',
    kind: 'system_sweep',
    name: 'Personal-board task executor',
    description:
      'Every 5 minutes: scans your personal Sokosumi board for tasks you assigned directly to Hermes (status READY). When one is found, Hermes works through it end-to-end and posts the result as a comment, marking the task COMPLETED. Preprod only for now.',
    cronExpr: '*/5 * * * *',
    localTime: false,
    minAutonomy: 'low',
  },

  // ---------- system_prompt rows (medium+) ----------
  {
    slug: 'morning-brief',
    kind: 'system_prompt',
    name: 'Weekday morning brief',
    description:
      'Mon–Fri 8am brief: yesterday’s completed jobs, today’s calendar, top open tasks needing action.',
    cronExpr: '0 8 * * 1-5',
    localTime: true,
    minAutonomy: 'medium',
    prompt:
      'Good morning. Give the user their weekday brief: (a) Sokosumi jobs that completed since their last brief — names + 1-line takeaway each, (b) today’s calendar at a glance if a calendar MCP is connected, (c) the 2–3 open Sokosumi tasks most worth touching today. Keep it tight — under 180 words, no preamble.',
  },
  {
    slug: 'weekly-wrap',
    kind: 'system_prompt',
    name: 'Friday weekly wrap',
    description:
      'Friday 4pm: this week’s job completions, credit spend, and what to chase on Monday.',
    cronExpr: '0 16 * * 5',
    localTime: true,
    minAutonomy: 'medium',
    prompt:
      'Give the user a Friday wrap-up: (a) Sokosumi jobs completed this week with a 1-line takeaway per job, (b) total credits spent this week and the top 3 most expensive jobs, (c) open tasks that should move first thing Monday. Tight, scannable, under 200 words.',
  },
  {
    slug: 'awaiting-input-chaser',
    kind: 'system_prompt',
    name: 'Stuck jobs reminder',
    description:
      'Every 4 hours: nudges you about Sokosumi jobs that have been waiting on your input for over a day.',
    cronExpr: '0 */4 * * *',
    localTime: false,
    minAutonomy: 'medium',
    prompt:
      'Scan for Sokosumi jobs in AWAITING_INPUT status that have been stuck for >24h. If any exist, send a short reminder naming the job and what input the agent needs. If none are stuck, reply with the literal string "ok" and nothing else — the orchestrator will discard short acknowledgements so the user isn’t spammed.',
  },
  {
    slug: 'low-credits-watcher',
    kind: 'system_prompt',
    name: 'Low credits watcher',
    description:
      'Daily 9am check: pings you when your Sokosumi credit balance drops below 25.',
    cronExpr: '0 9 * * *',
    localTime: true,
    minAutonomy: 'medium',
    prompt:
      'Call sokosumi_get_credits. If the balance is below 25, send a one-sentence heads-up about the current balance and the 1–2 most recent jobs that drove the spend. If balance is 25 or above, reply only with "ok" (orchestrator drops it).',
  },

  // ---------- system_prompt rows (high only) ----------
  {
    slug: 'followup-task-generator',
    kind: 'system_prompt',
    name: 'Auto follow-up tasks',
    description:
      'Daily 6am: reads yesterday’s completed Sokosumi jobs and creates follow-up tasks (assigned to the right coworker) when the result implies a clear next step.',
    cronExpr: '0 6 * * *',
    localTime: true,
    minAutonomy: 'high',
    prompt:
      'For each Sokosumi job that completed in the last 24h, read the result and decide whether it implies a clearly defined next task. For each qualifying job: pick the right coworker via sokosumi_list_coworkers, create the follow-up task via sokosumi_create_task, and add a brief comment linking back to the source job. Skip jobs where the next step is ambiguous — do not invent work. End with a one-paragraph summary of what you created, or "ok" if no follow-ups were warranted.',
  },
  {
    slug: 'workspace-cleanup',
    kind: 'system_prompt',
    name: 'Sunday workspace cleanup',
    description:
      'Sunday 11pm: surfaces stale DRAFT tasks untouched for 30+ days and offers to refund FAILED jobs older than a week.',
    cronExpr: '0 23 * * 0',
    localTime: true,
    minAutonomy: 'high',
    prompt:
      'Audit the user’s Sokosumi workspace: list DRAFT tasks untouched for >30 days and FAILED jobs older than 7 days that were never refunded. Offer to cancel/refund them in plain language — do not act without confirmation in chat. Skip the message entirely (reply "ok") if neither category has anything.',
  },
  {
    slug: 'coworker-idle-nudge',
    kind: 'system_prompt',
    name: 'Idle coworker nudge',
    description:
      'Monday 10am: flags Sokosumi coworkers you haven’t used in 30+ days with a short note on what they could help with.',
    cronExpr: '0 10 * * 1',
    localTime: true,
    minAutonomy: 'high',
    prompt:
      'List coworkers from sokosumi_list_coworkers who have no tasks assigned in the last 30 days. For each, write one sentence on what they could help with based on their capabilities. Cap at 3 coworkers; if all are active, reply "ok".',
  },
];

export interface SyncContext {
  instanceId: string;
  userId: string;
  autonomy: Autonomy;
  timezone: string;
  sokosumiConfigured: boolean;
  hasMailOrCalendar: boolean;
}

/**
 * Idempotent: brings the per-user system schedules in line with the
 * current autonomy + integrations. Creates missing rows, deletes rows
 * that should no longer exist for this autonomy level, leaves user-
 * created rows untouched.
 */
export async function syncSystemSchedules(ctx: SyncContext): Promise<{
  created: number;
  deleted: number;
  kept: number;
}> {
  const log = logger.child({ instanceId: ctx.instanceId, userId: ctx.userId, fn: 'sync_system_schedules' });
  const eligible = SYSTEM_SCHEDULES.filter(
    (s) => AUTONOMY_RANK[ctx.autonomy] >= AUTONOMY_RANK[s.minAutonomy] && (s.requires?.(ctx) ?? true),
  );
  const eligibleIds = new Set(eligible.map((s) => systemRowId(s.slug, ctx.instanceId)));

  const existing = await prisma.scheduledTask.findMany({
    where: { instanceId: ctx.instanceId, kind: { in: ['system_sweep', 'system_prompt'] } },
    select: { id: true },
  });

  // Delete system rows that no longer apply at the current autonomy.
  const toDelete = existing.filter((r) => !eligibleIds.has(r.id)).map((r) => r.id);
  if (toDelete.length > 0) {
    await prisma.scheduledTask.deleteMany({ where: { id: { in: toDelete } } });
  }

  let created = 0;
  let kept = 0;
  for (const spec of eligible) {
    const id = systemRowId(spec.slug, ctx.instanceId);
    const tz = spec.localTime ? ctx.timezone : 'UTC';
    const nextRunAt = safeNextRun(spec.cronExpr, tz, new Date()) ?? new Date(Date.now() + 24 * 60 * 60_000);
    const existed = await prisma.scheduledTask.upsert({
      where: { id },
      create: {
        id,
        instanceId: ctx.instanceId,
        userId: ctx.userId,
        kind: spec.kind,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt ?? `[orchestrator] ${spec.name}`,
        cronExpr: spec.cronExpr,
        timezone: tz,
        enabled: true,
        nextRunAt,
      },
      update: {
        kind: spec.kind,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt ?? `[orchestrator] ${spec.name}`,
        cronExpr: spec.cronExpr,
        timezone: tz,
      },
    });
    if (existed.createdAt.getTime() > Date.now() - 5_000) created++;
    else kept++;
  }
  log.info({ created, deleted: toDelete.length, kept, autonomy: ctx.autonomy }, 'system_schedules_synced');
  return { created, deleted: toDelete.length, kept };
}

export function systemRowId(slug: string, instanceId: string): string {
  return `system-${slug}-${instanceId}`;
}

/**
 * Resolve a "system_sweep" row for an instance + slug. Sweeps in cron.ts
 * call this to honor the user's enabled/disabled toggle.
 */
export async function isSystemSweepEnabled(
  instanceId: string,
  slug:
    | 'sokosumi-sync'
    | 'inbox-refresh'
    | 'urgent-interrupts'
    | 'task-augmentation'
    | 'hermes-executor',
): Promise<boolean> {
  const id = systemRowId(slug, instanceId);
  const row = await prisma.scheduledTask.findUnique({ where: { id }, select: { enabled: true } });
  // Legacy instances created before this feature won't have a row; default
  // to enabled so the sweep continues to work as before.
  if (!row) return true;
  return row.enabled;
}
