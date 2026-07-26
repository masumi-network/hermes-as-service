import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { safeNextRun } from './cron.js';

/**
 * The orchestrator owns a set of "system" ScheduledTask rows per instance,
 * created at onboarding-finalize and re-synced any time the autonomy
 * level changes. These are all kind "system_sweep": informational mirrors
 * of orchestrator-level background sweeps (sokosumi-sync, inbox-refresh,
 * board-sweep, eod-report). The
 * scheduler never dispatches them; the matching sweep in cron.ts reads the
 * row's `enabled` flag to gate work per user, and freshens the row's
 * last/next-run stamps after each tick so the settings panel stays honest.
 *
 * Recurring AGENT prompts (weekly wrap, stuck-jobs reminder, etc.) are NOT
 * orchestrator rows anymore — they're installed as native cronjobs on the
 * machine itself (see native-prompts.ts), per the locked scheduling design:
 * the built-in cronjob tool is THE scheduler; orchestrator rows are mirrors.
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
      'Daily refresh of your Sokosumi workspace (tasks, completed jobs, credits, coworkers) into Hermes’ memory so the agent stays current.',
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
    slug: 'board-sweep',
    kind: 'system_sweep',
    name: 'Board watcher',
    description:
      'Every 5 minutes: Hermes watches everything on your board — tasks and the paid jobs under them. When work FINISHES (including work a coworker ran from a schedule or from your own chat with them) it messages you what finished and what it produced, and continues the plan with a follow-up task when you had agreed on a next step. When something is BLOCKED waiting on an answer it settles it where it safely can, and flags you when the call is genuinely yours. On brand-new tasks it adds context only when it actually has some. Interrupts are rate-limited to one every 2 hours — failures and blocked work always come through, and anything held back appears in your end-of-day report. (Medium autonomy: answers and any follow-up task arrive as confirmation cards; high: it acts directly.)',
    cronExpr: '4-59/5 * * * *',
    localTime: false,
    minAutonomy: 'medium',
    requires: (ctx) => ctx.sokosumiConfigured,
  },
  {
    slug: 'eod-report',
    kind: 'system_sweep',
    name: 'End-of-day cron summary',
    description:
      'Each evening at 10 PM (your time): a brief recap of what Hermes’ background sweeps did for you today — inbox refreshes, Sokosumi syncs, urgent interrupts, auto-comments, and any proactive messages sent to your chat.',
    cronExpr: '0 22 * * *',
    localTime: true,
    minAutonomy: 'low',
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

  // Slug migrations. Carry the user's enabled/disabled toggle across so a prior
  // opt-out isn't silently lost when the old row is deleted below and the new
  // one is created enabled-by-default.
  //   task-augmentation                                    → taskboard-assistant
  //   taskboard-assistant + input-responder + urgent-interrupts → board-sweep
  // For the 3→1 merge, a user who had opted OUT of ANY of the three keeps the
  // merged sweep off: silently re-enabling work they'd turned off is worse than
  // making them switch it back on.
  const MIGRATIONS: Array<{ from: string[]; to: string }> = [
    { from: ['task-augmentation'], to: 'taskboard-assistant' },
    { from: ['taskboard-assistant', 'input-responder', 'urgent-interrupts'], to: 'board-sweep' },
  ];
  for (const mig of MIGRATIONS) {
    const spec = SYSTEM_SCHEDULES.find((sp) => sp.slug === mig.to);
    if (!spec) continue;
    const newId = systemRowId(mig.to, ctx.instanceId);
    const olds = await prisma.scheduledTask.findMany({
      where: { id: { in: mig.from.map((f) => systemRowId(f, ctx.instanceId)) } },
      select: { enabled: true },
    });
    if (olds.length === 0 || olds.every((o) => o.enabled)) continue;
    const newRow = await prisma.scheduledTask.findUnique({ where: { id: newId }, select: { id: true } });
    if (newRow) {
      await prisma.scheduledTask.update({ where: { id: newId }, data: { enabled: false } });
    } else {
      // New row not created yet — stash the intent by pre-creating a disabled
      // placeholder the upsert below will keep (its update block never touches
      // enabled). Uses the current spec's cadence so nextRunAt is sane.
      await prisma.scheduledTask
        .create({
          data: {
            id: newId,
            instanceId: ctx.instanceId,
            userId: ctx.userId,
            kind: 'system_sweep',
            name: spec.name,
            description: spec.description,
            prompt: `[orchestrator] ${spec.name}`,
            cronExpr: spec.cronExpr,
            timezone: 'UTC',
            enabled: false,
            nextRunAt: safeNextRun(spec.cronExpr, 'UTC', new Date()) ?? new Date(Date.now() + 3_600_000),
          },
        })
        .catch(() => {});
    }
  }

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
        // Heal stale next-run displays (rows created before a cadence
        // change kept their old nextRunAt until the sweep's next freshen).
        nextRunAt,
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
 * Stamp a sweep's per-instance mirror rows with truthful last/next-run
 * times after the orchestrator-side sweep ticked. Without this the settings
 * panel shows the mirrors as perpetually overdue with "last run: —" even
 * though the sweep runs fine (only sokosumi-sync used to freshen its row).
 *
 * UTC-cron slugs share one nextRunAt; local-time rows (eod-report) get a
 * per-row computation since each user's timezone differs.
 */
export async function freshenSweepMirrors(
  slug:
    | 'sokosumi-sync'
    | 'inbox-refresh'
    | 'board-sweep'
    | 'eod-report',
): Promise<void> {
  const spec = SYSTEM_SCHEDULES.find((s) => s.slug === slug);
  if (!spec) return;
  const now = new Date();
  // Only enabled rows: a user who toggled a sweep off must not see a fresh
  // "last run" stamp on the thing they disabled (the sweep skips them via
  // isSystemSweepEnabled, so a stamp would be a lie).
  if (!spec.localTime) {
    const nextRunAt = safeNextRun(spec.cronExpr, 'UTC', now) ?? new Date(now.getTime() + 60 * 60_000);
    await prisma.scheduledTask.updateMany({
      where: { id: { startsWith: `system-${slug}-` }, kind: 'system_sweep', enabled: true },
      data: { lastRunAt: now, nextRunAt },
    });
    return;
  }
  // Local-time rows: few enough to update individually per timezone.
  const rows = await prisma.scheduledTask.findMany({
    where: { id: { startsWith: `system-${slug}-` }, kind: 'system_sweep', enabled: true },
    select: { id: true, timezone: true },
  });
  for (const r of rows) {
    const nextRunAt = safeNextRun(spec.cronExpr, r.timezone, now) ?? new Date(now.getTime() + 24 * 60 * 60_000);
    await prisma.scheduledTask.update({ where: { id: r.id }, data: { lastRunAt: now, nextRunAt } }).catch(() => {});
  }
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
    | 'board-sweep'
    | 'eod-report',
): Promise<boolean> {
  const id = systemRowId(slug, instanceId);
  const row = await prisma.scheduledTask.findUnique({ where: { id }, select: { enabled: true } });
  // Legacy instances created before this feature won't have a row; default
  // to enabled so the sweep continues to work as before.
  if (!row) return true;
  return row.enabled;
}
