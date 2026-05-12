import { CronExpressionParser } from 'cron-parser';
import { logger } from '../logger.js';

export interface CronInfo {
  nextRunAt: Date;
}

export function isValidCron(expr: string, timezone: string = 'UTC'): boolean {
  try {
    CronExpressionParser.parse(expr, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

export function nextRun(expr: string, timezone: string = 'UTC', from?: Date): Date {
  const it = CronExpressionParser.parse(expr, {
    tz: timezone,
    currentDate: from ?? new Date(),
  });
  return it.next().toDate();
}

export function describe(expr: string): string {
  // Very rough human-readable hint. We rely on the agent to format nicely
  // when surfacing to users; this is just a fallback for the admin UI.
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts;
  if (!m) return expr;
  if (dom === '*' && mon === '*' && dow === '*') return `every day at ${h}:${m.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '1-5') return `weekdays at ${h}:${m.padStart(2, '0')}`;
  if (dom === '*' && mon === '*') return `cron(${expr})`;
  return expr;
}

export function safeNextRun(expr: string, timezone: string, from?: Date): Date | null {
  try {
    return nextRun(expr, timezone, from);
  } catch (err) {
    logger.warn({ err, expr, timezone }, 'cron_parse_failed');
    return null;
  }
}
