import cron from 'node-cron';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';

let scheduled: cron.ScheduledTask | null = null;

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
