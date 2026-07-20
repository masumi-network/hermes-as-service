import cron from 'node-cron';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { runSokosumiDailySweep } from './sokosumi/sync.js';
import { runInboxRefreshSweep } from './inbox/refresh.js';
import { runUrgentInterruptSweep } from './notifications/urgent.js';
import { runTaskAugmentationSweep } from './notifications/augment.js';
import { runInputResponderSweep } from './notifications/input-responder.js';
import { runEodReportSweep } from './eod-report/sweep.js';
import { runPoolReplenishSweep, schedulePoolReplenishSoon } from './provision/pool.js';
import { freshenSweepMirrors } from './schedules/system-schedules.js';

const registered = new Map<string, cron.ScheduledTask>();

/**
 * Register a cron with the shared guard rails every sweep needs:
 * once-only registration, a try/catch so a transient error can never
 * become an unhandled rejection (node-cron does not await or catch),
 * and a best-effort freshen of the sweep's per-instance mirror rows so
 * the Sokosumi settings panel shows truthful last/next-run times.
 */
function register(
  name: string,
  expr: string,
  run: () => Promise<unknown>,
  mirrorSlug?: Parameters<typeof freshenSweepMirrors>[0],
): void {
  if (registered.has(name)) return;
  registered.set(
    name,
    cron.schedule(
      expr,
      async () => {
        let ok = false;
        try {
          await run();
          ok = true;
        } catch (err) {
          logger.error({ err }, `${name}_threw`);
        }
        // Freshen mirrors only after a tick that actually ran — a crashed
        // sweep must not stamp a successful-looking "last run".
        if (ok && mirrorSlug) {
          try {
            await freshenSweepMirrors(mirrorSlug);
          } catch (err) {
            logger.warn({ err, mirrorSlug }, 'sweep_mirror_freshen_failed');
          }
        }
      },
      { scheduled: true },
    ),
  );
  logger.info(`${name}_started`);
}

/**
 * Marks idle instances as suspended in the DB. Pure bookkeeping on Fly
 * always-on (no compute is released; the chat proxy flips status back to
 * running on the next message) — Sokosumi uses it as a "we haven't heard
 * from this user lately" signal.
 */
export function startIdleSuspendCron(): void {
  register('idle_suspend_cron', '*/5 * * * *', runOnce);
}

export async function runOnce(): Promise<number> {
  const cfg = loadConfig();
  const cutoff = new Date(Date.now() - cfg.DEFAULT_IDLE_SUSPEND_MINUTES * 60_000);
  const result = await prisma.hermesInstance.updateMany({
    where: { status: 'running', lastActivityAt: { lt: cutoff } },
    data: { status: 'suspended' },
  });
  if (result.count > 0) {
    logger.info({ count: result.count, cutoff }, 'idle_suspend_swept');
  }
  return result.count;
}

/**
 * Hourly cron that picks every instance whose Sokosumi workspace snapshot
 * is >23h old and re-syncs. Caps at 100 instances per tick. Skips
 * gracefully if no Sokosumi API key is configured.
 */
export function startSokosumiDailySyncCron(): void {
  register('sokosumi_daily_sync_cron', '0 * * * *', runSokosumiDailySweep, 'sokosumi-sync');
}

/**
 * Hourly cron — silent inbox refresh. For each instance with connected
 * mail/calendar MCPs whose lastInboxRefreshAt is >6h old, ask Hermes to
 * scan new mail and update memory. No user-visible output.
 */
export function startInboxRefreshCron(): void {
  register('inbox_refresh_cron', '15 * * * *', runInboxRefreshSweep, 'inbox-refresh');
}

/**
 * Hourly cron — proactive urgent-interrupt check. For each ready instance,
 * scan for newly-completed Sokosumi jobs and ask Hermes to gate whether
 * any are worth interrupting the user about. Gated by a 2h cooldown floor
 * to prevent spam. YES events fire a notification to the user's outbox.
 */
export function startUrgentInterruptCron(): void {
  register('urgent_interrupt_cron', '30 * * * *', runUrgentInterruptSweep, 'urgent-interrupts');
}

/**
 * Hourly cron — task augmentation for HIGH-autonomy users only. Picks up
 * newly-created Sokosumi tasks since the user's lastTaskAugmentationAt,
 * asks Hermes to evaluate each one and (if it has useful context) post
 * a comment. Comments are free; LLM gating costs ~$0.001 per evaluated
 * task. Skips users at low/medium autonomy entirely.
 */
export function startTaskAugmentationCron(): void {
  register('task_augmentation_cron', '45 * * * *', runTaskAugmentationSweep, 'task-augmentation');
}

/**
 * Every 5 minutes — input-responder + follow-up continuation sweep.
 * Detects Sokosumi jobs paused in AWAITING_INPUT and, at medium/high autonomy,
 * drives Hermes to answer them (high = submit immediately, medium = raise a
 * confirmation card). Low autonomy is skipped (urgent-interrupts notifies).
 * The same sweep also spots newly-COMPLETED jobs and asks Hermes whether a
 * planned next step should continue (create follow-up tasks / comment).
 */
export function startInputResponderCron(): void {
  register('input_responder_cron', '2-59/5 * * * *', runInputResponderSweep, 'input-responder');
}

/**
 * Hourly cron — end-of-day personal cron summary. Fires at :50 (staggered
 * off the :00 sokosumi-sync tick); the sweep itself filters by current
 * local hour (22:00) per-user via the instance's stored timezone, and
 * gates on the user's "eod-report" system_sweep toggle. Each delivery is
 * idempotent (skipped if today's report already sits in the user's outbox).
 */
export function startEodReportCron(): void {
  register('eod_report_cron', '50 * * * *', runEodReportSweep, 'eod-report');
}

/**
 * Every 2 minutes — top the warm pool back up to WARM_POOL_TARGET ready
 * machines (reaping stale-image / stuck-claim records first). No-op when
 * WARM_POOL_TARGET=0. Also kicks one sweep immediately on boot so the pool
 * fills after a deploy without waiting for the first tick.
 */
export function startPoolReplenishCron(): void {
  register('pool_replenish_cron', '*/2 * * * *', runPoolReplenishSweep);
  schedulePoolReplenishSoon();
}
