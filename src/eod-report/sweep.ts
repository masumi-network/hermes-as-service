import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { recordEvent } from '../audit.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

const DELIVER_HOUR_LOCAL = 22;
const SNIPPET_CHARS = 200;

export interface CronStat {
  ran: number;
  failed: number;
  lastDetail?: string;
}

export interface OutboxStat {
  count: number;
  lastSnippet?: string;
  lastAt?: Date;
}

/**
 * Daily personal cron summary for each user. Runs hourly; for any instance
 * whose local time is currently the delivery hour and that hasn't already
 * received today's report, builds a per-user roll-up of:
 *
 *   - Orchestrator-side sweeps (inbox refresh, sokosumi sync, urgent
 *     interrupts, task augmentation, hermes executor) — counts pulled from
 *     ProvisionEvent in the last 24h.
 *   - Machine-side native crons — counts pulled from the user's outbox
 *     (research_intro / daily_suggestions / daily_brief / task_result).
 *
 * Posts the summary to the user's outbox with kind="eod_report". The
 * sweep is gated by the "eod-report" system_sweep row so users can mute
 * it from Sokosumi settings.
 */
export async function runEodReportSweep(): Promise<{ scanned: number; delivered: number }> {
  const candidates = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true, userId: true, timezone: true },
  });

  let delivered = 0;
  for (const inst of candidates) {
    try {
      const tz = inst.timezone || 'UTC';
      if (currentLocalHour(tz) !== DELIVER_HOUR_LOCAL) continue;
      if (!(await isSystemSweepEnabled(inst.id, 'eod-report'))) continue;
      const startOfDay = startOfLocalDay(tz);
      if (await alreadySentSince(inst.userId, startOfDay)) continue;

      const summary = await buildSummary(inst.id, inst.userId, startOfDay, tz);
      await enqueueOutboxMessage({
        instanceId: inst.id,
        userId: inst.userId,
        kind: 'eod_report',
        content: summary,
      });
      await recordEvent({
        userId: inst.userId,
        instanceId: inst.id,
        event: 'eod_report_sent',
        detail: { tz },
      });
      delivered++;
    } catch (err) {
      logger.error({ err, instanceId: inst.id }, 'eod_report_item_failed');
    }
  }

  if (candidates.length > 0) {
    logger.info({ scanned: candidates.length, delivered }, 'eod_report_sweep_done');
  }
  return { scanned: candidates.length, delivered };
}

async function alreadySentSince(userId: string, startOfDay: Date): Promise<boolean> {
  const existing = await prisma.outboxMessage.findFirst({
    where: { userId, kind: 'eod_report', createdAt: { gte: startOfDay } },
    select: { id: true },
  });
  return existing !== null;
}

async function buildSummary(
  instanceId: string,
  userId: string,
  startOfDay: Date,
  tz: string,
): Promise<string> {
  const [events, outboxMessages] = await Promise.all([
    prisma.provisionEvent.findMany({
      where: { instanceId, createdAt: { gte: startOfDay } },
      orderBy: { createdAt: 'asc' },
      select: { event: true, detail: true, createdAt: true },
    }),
    prisma.outboxMessage.findMany({
      where: { userId, createdAt: { gte: startOfDay } },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, content: true, createdAt: true },
    }),
  ]);
  return composeSummary(events, outboxMessages, startOfDay, tz);
}

/**
 * Pure renderer for the EOD summary. Splitting from buildSummary lets us
 * unit-test the markdown output without a DB.
 */
export function composeSummary(
  events: Array<{ event: string; detail: unknown; createdAt: Date }>,
  outboxMessages: Array<{ kind: string; content: string; createdAt: Date }>,
  startOfDay: Date,
  tz: string,
): string {
  const cronStats = aggregateCrons(events);
  const outboxStats = aggregateOutbox(outboxMessages);
  const dateLabel = formatLocalDate(startOfDay, tz);

  const lines: string[] = [];
  lines.push(`**Your cron summary — ${dateLabel}**`);
  lines.push('');

  lines.push('_Background sweeps_');
  lines.push(renderCron('Inbox refresh', cronStats.inboxRefresh));
  lines.push(renderCron('Sokosumi sync', cronStats.sokosumiSync));
  lines.push(renderCron('Urgent interrupts', cronStats.urgent, 'check'));
  lines.push(renderCron('Task augmentation', cronStats.taskAugmentation, 'pass'));
  lines.push(renderCron('Personal-board executor', cronStats.hermesExecutor, 'task'));

  const hasOutbox =
    outboxStats.researchIntro.count +
      outboxStats.dailyBrief.count +
      outboxStats.dailySuggestions.count +
      outboxStats.taskResult.count >
    0;
  if (hasOutbox) {
    lines.push('');
    lines.push('_Messages sent to your chat today_');
    if (outboxStats.researchIntro.count) lines.push(renderOutbox('Research intro', outboxStats.researchIntro));
    if (outboxStats.dailyBrief.count) lines.push(renderOutbox('Daily brief', outboxStats.dailyBrief));
    if (outboxStats.dailySuggestions.count) lines.push(renderOutbox('Daily suggestions', outboxStats.dailySuggestions));
    if (outboxStats.taskResult.count) lines.push(renderOutbox('Task results', outboxStats.taskResult));
  }

  if (cronStats.totalFailed > 0) {
    lines.push('');
    lines.push(`_${cronStats.totalFailed} failure${cronStats.totalFailed === 1 ? '' : 's'} today — ask me to dig in if you want details._`);
  }

  return lines.join('\n');
}

/**
 * Single-user driver used by the admin smoke endpoint and the sweep.
 * `force` bypasses the local-hour and already-sent gates so we can
 * verify the report end-to-end without waiting for 22:00.
 * `dryRun` skips enqueue + recordEvent and just returns the summary.
 */
export async function runEodReportForInstance(
  instanceId: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<{ delivered: boolean; reason?: string; summary?: string }> {
  const inst = await prisma.hermesInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, userId: true, timezone: true, status: true, destroyedAt: true, onboardedAt: true },
  });
  if (!inst) return { delivered: false, reason: 'instance not found' };
  if (inst.destroyedAt) return { delivered: false, reason: 'instance destroyed' };
  if (!inst.onboardedAt) return { delivered: false, reason: 'instance not onboarded' };
  const tz = inst.timezone || 'UTC';
  if (!opts.force && currentLocalHour(tz) !== DELIVER_HOUR_LOCAL) {
    return { delivered: false, reason: `local hour ${currentLocalHour(tz)} != ${DELIVER_HOUR_LOCAL}` };
  }
  if (!opts.force && !(await isSystemSweepEnabled(inst.id, 'eod-report'))) {
    return { delivered: false, reason: 'eod-report sweep muted' };
  }
  const startOfDay = startOfLocalDay(tz);
  if (!opts.force && (await alreadySentSince(inst.userId, startOfDay))) {
    return { delivered: false, reason: 'already sent today' };
  }
  const summary = await buildSummary(inst.id, inst.userId, startOfDay, tz);
  if (opts.dryRun) return { delivered: false, reason: 'dry run', summary };
  await enqueueOutboxMessage({
    instanceId: inst.id,
    userId: inst.userId,
    kind: 'eod_report',
    content: summary,
  });
  await recordEvent({
    userId: inst.userId,
    instanceId: inst.id,
    event: 'eod_report_sent',
    detail: { tz, forced: !!opts.force },
  });
  return { delivered: true, summary };
}

export interface AggregatedCrons {
  inboxRefresh: CronStat;
  sokosumiSync: CronStat;
  urgent: CronStat;
  taskAugmentation: CronStat;
  hermesExecutor: CronStat;
  totalFailed: number;
}

export function aggregateCrons(
  events: Array<{ event: string; detail: unknown; createdAt: Date }>,
): AggregatedCrons {
  const stats: AggregatedCrons = {
    inboxRefresh: { ran: 0, failed: 0 },
    sokosumiSync: { ran: 0, failed: 0 },
    urgent: { ran: 0, failed: 0 },
    taskAugmentation: { ran: 0, failed: 0 },
    hermesExecutor: { ran: 0, failed: 0 },
    totalFailed: 0,
  };

  for (const ev of events) {
    const detail = (ev.detail ?? {}) as Record<string, unknown>;
    switch (ev.event) {
      case 'onboarding_step': {
        const step = String(detail.step ?? '');
        const status = String(detail.status ?? '');
        if (step === 'inbox_refresh') {
          if (status === 'done') {
            stats.inboxRefresh.ran++;
            stats.inboxRefresh.lastDetail = providerList(detail.providers);
          } else if (status === 'failed') {
            stats.inboxRefresh.failed++;
            stats.totalFailed++;
          }
        } else if (step === 'sokosumi_sync') {
          if (status === 'done') stats.sokosumiSync.ran++;
          else if (status === 'failed') {
            stats.sokosumiSync.failed++;
            stats.totalFailed++;
          }
        }
        break;
      }
      case 'chat_proxied': {
        const source = String(detail.source ?? '');
        if (source === 'urgent_interrupt') {
          stats.urgent.ran++;
          stats.urgent.lastDetail = `${detail.events ?? 0} event(s) considered`;
        } else if (source === 'task_augmentation') {
          stats.taskAugmentation.ran++;
          const scanned = Number(detail.scanned ?? 0);
          const commented = Number(detail.commented ?? 0);
          stats.taskAugmentation.lastDetail = `${scanned} scanned, ${commented} commented`;
        }
        break;
      }
      case 'hermes_task_picked':
        stats.hermesExecutor.ran++;
        if (detail.taskName) stats.hermesExecutor.lastDetail = String(detail.taskName);
        break;
      case 'hermes_task_failed':
        stats.hermesExecutor.failed++;
        stats.totalFailed++;
        break;
    }
  }
  return stats;
}

export interface AggregatedOutbox {
  researchIntro: OutboxStat;
  dailyBrief: OutboxStat;
  dailySuggestions: OutboxStat;
  taskResult: OutboxStat;
}

export function aggregateOutbox(
  msgs: Array<{ kind: string; content: string; createdAt: Date }>,
): AggregatedOutbox {
  const init = (): OutboxStat => ({ count: 0 });
  const out: AggregatedOutbox = {
    researchIntro: init(),
    dailyBrief: init(),
    dailySuggestions: init(),
    taskResult: init(),
  };
  for (const m of msgs) {
    const stat = pickStat(out, m.kind);
    if (!stat) continue;
    stat.count++;
    stat.lastAt = m.createdAt;
    stat.lastSnippet = snippet(m.content);
  }
  return out;
}

function pickStat(out: AggregatedOutbox, kind: string): OutboxStat | null {
  switch (kind) {
    case 'research_intro': return out.researchIntro;
    case 'daily_brief': return out.dailyBrief;
    case 'daily_suggestions': return out.dailySuggestions;
    case 'task_result': return out.taskResult;
    default: return null;
  }
}

export function renderCron(label: string, s: CronStat, runWord = 'run'): string {
  if (s.ran === 0 && s.failed === 0) return `- ${label}: _no activity_`;
  const parts: string[] = [];
  if (s.ran > 0) parts.push(`${s.ran} ${runWord}${s.ran === 1 ? '' : 's'}`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  const head = `- ${label}: ${parts.join(', ')}`;
  return s.lastDetail ? `${head} — _${s.lastDetail}_` : head;
}

export function renderOutbox(label: string, s: OutboxStat): string {
  const head = `- ${label}: ${s.count} message${s.count === 1 ? '' : 's'}`;
  if (!s.lastSnippet) return head;
  return `${head}\n  > ${s.lastSnippet}`;
}

function providerList(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw.map(String).join(', ');
}

function snippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNIPPET_CHARS ? `${oneLine.slice(0, SNIPPET_CHARS)}…` : oneLine;
}

export function currentLocalHour(tz: string, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).format(now);
  // hour12:false sometimes returns "24" at midnight depending on engine; clamp.
  const n = Number(hour);
  return n === 24 ? 0 : n;
}

export function startOfLocalDay(tz: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  // Midnight at this local date, expressed in UTC. We back-compute by
  // forming the ISO string in the target TZ via offset lookup.
  const localMidnightUtc = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const tzOffsetMin = timezoneOffsetMinutes(tz, localMidnightUtc);
  return new Date(localMidnightUtc.getTime() - tzOffsetMin * 60_000);
}

function timezoneOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - at.getTime()) / 60_000;
}

function formatLocalDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(at);
}
