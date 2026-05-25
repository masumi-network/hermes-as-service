import cron from 'node-cron';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { runSokosumiDailySweep } from './sokosumi/sync.js';
import { runInboxRefreshSweep } from './inbox/refresh.js';
import { runUrgentInterruptSweep } from './notifications/urgent.js';
import { runTaskAugmentationSweep } from './notifications/augment.js';
import { runHermesExecutorSweep } from './notifications/hermes-executor.js';
import { runEodReportSweep } from './eod-report/sweep.js';

let scheduled: cron.ScheduledTask | null = null;
let sokosumiScheduled: cron.ScheduledTask | null = null;
let inboxRefreshScheduled: cron.ScheduledTask | null = null;
let urgentInterruptScheduled: cron.ScheduledTask | null = null;
let taskAugmentationScheduled: cron.ScheduledTask | null = null;
let hermesExecutorScheduled: cron.ScheduledTask | null = null;
let eodReportScheduled: cron.ScheduledTask | null = null;

/**
 * Marks idle instances as suspended in the DB. Sprites itself releases compute
 * automatically on idle, so this is bookkeeping only — Sokosumi reads `status`
 * to decide whether to call /resume before sending traffic.
 */
export function startIdleSuspendCron(): void {
  if (scheduled) return;
  scheduled = cron.schedule('*/5 * * * *', runOnce, { scheduled: true });
  logger.info('idle_suspend_cron_started');
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

export function stopIdleSuspendCron(): void {
  if (scheduled) {
    scheduled.stop();
    scheduled = null;
  }
}

/**
 * Hourly cron that picks every instance whose Sokosumi workspace snapshot
 * is >23h old and re-syncs. Caps at 100 instances per tick. Skips
 * gracefully if SOKOSUMI_COWORKER_API_KEY isn't configured.
 */
export function startSokosumiDailySyncCron(): void {
  if (sokosumiScheduled) return;
  sokosumiScheduled = cron.schedule(
    '0 * * * *', // top of every hour
    async () => {
      try {
        await runSokosumiDailySweep();
      } catch (err) {
        logger.error({ err }, 'sokosumi_daily_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('sokosumi_daily_sync_cron_started');
}

export function stopSokosumiDailySyncCron(): void {
  if (sokosumiScheduled) {
    sokosumiScheduled.stop();
    sokosumiScheduled = null;
  }
}

/**
 * Hourly cron — silent inbox refresh. For each instance with connected
 * mail/calendar MCPs whose lastInboxRefreshAt is >6h old, ask Hermes to
 * scan new mail and update memory. No user-visible output.
 */
export function startInboxRefreshCron(): void {
  if (inboxRefreshScheduled) return;
  inboxRefreshScheduled = cron.schedule(
    '15 * * * *', // 15 past every hour
    async () => {
      try {
        await runInboxRefreshSweep();
      } catch (err) {
        logger.error({ err }, 'inbox_refresh_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('inbox_refresh_cron_started');
}

export function stopInboxRefreshCron(): void {
  if (inboxRefreshScheduled) {
    inboxRefreshScheduled.stop();
    inboxRefreshScheduled = null;
  }
}

/**
 * Hourly cron — proactive urgent-interrupt check. For each ready instance,
 * scan for newly-completed Sokosumi jobs and ask Hermes to gate whether
 * any are worth interrupting the user about. Gated by a 2h cooldown floor
 * to prevent spam. YES events fire a notification to the user's outbox.
 */
export function startUrgentInterruptCron(): void {
  if (urgentInterruptScheduled) return;
  urgentInterruptScheduled = cron.schedule(
    '30 * * * *', // 30 past every hour (staggered from inbox refresh)
    async () => {
      try {
        await runUrgentInterruptSweep();
      } catch (err) {
        logger.error({ err }, 'urgent_interrupt_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('urgent_interrupt_cron_started');
}

export function stopUrgentInterruptCron(): void {
  if (urgentInterruptScheduled) {
    urgentInterruptScheduled.stop();
    urgentInterruptScheduled = null;
  }
}

/**
 * Hourly cron — task augmentation for HIGH-autonomy users only. Picks up
 * newly-created Sokosumi tasks since the user's lastTaskAugmentationAt,
 * asks Hermes to evaluate each one and (if it has useful context) post
 * a comment. Comments are free; LLM gating costs ~$0.001 per evaluated
 * task. Skips users at low/medium autonomy entirely.
 */
export function startTaskAugmentationCron(): void {
  if (taskAugmentationScheduled) return;
  taskAugmentationScheduled = cron.schedule(
    '45 * * * *', // 45 past every hour (staggered from urgent interrupts)
    async () => {
      try {
        await runTaskAugmentationSweep();
      } catch (err) {
        logger.error({ err }, 'task_augmentation_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('task_augmentation_cron_started');
}

export function stopTaskAugmentationCron(): void {
  if (taskAugmentationScheduled) {
    taskAugmentationScheduled.stop();
    taskAugmentationScheduled = null;
  }
}

/**
 * Every 5 minutes — Hermes-as-executor sweep. Scans each user's
 * PERSONAL Sokosumi board for tasks in status READY assigned to the
 * Hermes coworker. For each such task, runs the description as a
 * chat prompt and posts the result as the completion comment.
 *
 * Gated to preprod only (Patrick's flag). Skips cron-mirror tasks
 * (those prefixed "Cron · ") so we don't double-process them.
 */
export function startHermesExecutorCron(): void {
  if (hermesExecutorScheduled) return;
  hermesExecutorScheduled = cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        await runHermesExecutorSweep();
      } catch (err) {
        logger.error({ err }, 'hermes_executor_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('hermes_executor_cron_started');
}

export function stopHermesExecutorCron(): void {
  if (hermesExecutorScheduled) {
    hermesExecutorScheduled.stop();
    hermesExecutorScheduled = null;
  }
}

/**
 * Hourly cron — end-of-day personal cron summary. Fires every hour; the
 * sweep itself filters by current local hour (22:00) per-user via the
 * instance's stored timezone, and gates on the user's "eod-report"
 * system_sweep toggle. Each delivery is idempotent (skipped if today's
 * report already sits in the user's outbox).
 */
export function startEodReportCron(): void {
  if (eodReportScheduled) return;
  eodReportScheduled = cron.schedule(
    '0 * * * *',
    async () => {
      try {
        await runEodReportSweep();
      } catch (err) {
        logger.error({ err }, 'eod_report_sweep_threw');
      }
    },
    { scheduled: true },
  );
  logger.info('eod_report_cron_started');
}

export function stopEodReportCron(): void {
  if (eodReportScheduled) {
    eodReportScheduled.stop();
    eodReportScheduled = null;
  }
}
