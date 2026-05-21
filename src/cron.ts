import cron from 'node-cron';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { runSokosumiDailySweep } from './sokosumi/sync.js';

let scheduled: cron.ScheduledTask | null = null;
let sokosumiScheduled: cron.ScheduledTask | null = null;

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
