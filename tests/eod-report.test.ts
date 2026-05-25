import { describe, it, expect } from 'vitest';
import {
  aggregateCrons,
  aggregateOutbox,
  currentLocalHour,
  startOfLocalDay,
} from '../src/eod-report/sweep.js';

describe('currentLocalHour', () => {
  it('returns 22 for Europe/Berlin when UTC is 20:30 (CEST = UTC+2)', () => {
    const utc = new Date('2026-07-15T20:30:00Z');
    expect(currentLocalHour('Europe/Berlin', utc)).toBe(22);
  });

  it('returns 17 for America/New_York when UTC is 21:00 (EDT = UTC-4)', () => {
    const utc = new Date('2026-07-15T21:00:00Z');
    expect(currentLocalHour('America/New_York', utc)).toBe(17);
  });

  it('returns 22 for UTC when no tz is set (default UTC)', () => {
    const utc = new Date('2026-07-15T22:42:00Z');
    expect(currentLocalHour('UTC', utc)).toBe(22);
  });
});

describe('startOfLocalDay', () => {
  it('returns the UTC instant of midnight in the user TZ', () => {
    // 2026-07-15 23:30 UTC is 2026-07-16 01:30 Europe/Berlin (CEST).
    // Start of local day is 2026-07-16T00:00:00+02:00 → 2026-07-15T22:00:00Z.
    const at = new Date('2026-07-15T23:30:00Z');
    const start = startOfLocalDay('Europe/Berlin', at);
    expect(start.toISOString()).toBe('2026-07-15T22:00:00.000Z');
  });

  it('handles New York DST correctly (EDT)', () => {
    // 2026-07-15 12:00 UTC is 2026-07-15 08:00 New York. Start of local day
    // is 2026-07-15 00:00 EDT → 2026-07-15T04:00:00Z.
    const at = new Date('2026-07-15T12:00:00Z');
    const start = startOfLocalDay('America/New_York', at);
    expect(start.toISOString()).toBe('2026-07-15T04:00:00.000Z');
  });
});

describe('aggregateCrons', () => {
  const day = new Date('2026-05-25T08:00:00Z');

  it('counts inbox_refresh and sokosumi_sync onboarding_step events', () => {
    const stats = aggregateCrons([
      {
        event: 'onboarding_step',
        detail: { step: 'inbox_refresh', status: 'done', providers: ['gmail', 'google_calendar'] },
        createdAt: day,
      },
      {
        event: 'onboarding_step',
        detail: { step: 'inbox_refresh', status: 'done', providers: ['gmail'] },
        createdAt: day,
      },
      {
        event: 'onboarding_step',
        detail: { step: 'sokosumi_sync', status: 'done', source: 'cron' },
        createdAt: day,
      },
    ]);
    expect(stats.inboxRefresh.ran).toBe(2);
    expect(stats.inboxRefresh.failed).toBe(0);
    expect(stats.inboxRefresh.lastDetail).toBe('gmail');
    expect(stats.sokosumiSync.ran).toBe(1);
    expect(stats.totalFailed).toBe(0);
  });

  it('counts chat_proxied events split by source', () => {
    const stats = aggregateCrons([
      {
        event: 'chat_proxied',
        detail: { source: 'urgent_interrupt', events: 3, reason: 'completed-jobs' },
        createdAt: day,
      },
      {
        event: 'chat_proxied',
        detail: { source: 'task_augmentation', scanned: 5, commented: 2 },
        createdAt: day,
      },
    ]);
    expect(stats.urgent.ran).toBe(1);
    expect(stats.urgent.lastDetail).toBe('3 event(s) considered');
    expect(stats.taskAugmentation.ran).toBe(1);
    expect(stats.taskAugmentation.lastDetail).toBe('5 scanned, 2 commented');
  });

  it('counts hermes executor picks and failures', () => {
    const stats = aggregateCrons([
      { event: 'hermes_task_picked', detail: { taskId: 't1', taskName: 'Draft reply' }, createdAt: day },
      { event: 'hermes_task_picked', detail: { taskId: 't2', taskName: 'Summarize PR' }, createdAt: day },
      { event: 'hermes_task_failed', detail: { taskId: 't3', error: 'timeout' }, createdAt: day },
    ]);
    expect(stats.hermesExecutor.ran).toBe(2);
    expect(stats.hermesExecutor.failed).toBe(1);
    expect(stats.hermesExecutor.lastDetail).toBe('Summarize PR');
    expect(stats.totalFailed).toBe(1);
  });

  it('ignores unrelated events', () => {
    const stats = aggregateCrons([
      { event: 'integration_connected', detail: { provider: 'gmail' }, createdAt: day },
      { event: 'resumed', detail: {}, createdAt: day },
    ]);
    expect(stats.inboxRefresh.ran).toBe(0);
    expect(stats.hermesExecutor.ran).toBe(0);
  });
});

describe('aggregateOutbox', () => {
  const day = new Date('2026-05-25T07:00:00Z');

  it('counts messages by known kind and captures the last snippet', () => {
    const stats = aggregateOutbox([
      { kind: 'research_intro', content: 'Welcome — here is your intro.', createdAt: day },
      { kind: 'daily_brief', content: 'Today: 2 meetings, 3 PRs to review.', createdAt: day },
      { kind: 'daily_brief', content: 'Reminder: standup at 10.', createdAt: new Date(day.getTime() + 3600_000) },
      { kind: 'task_result', content: 'Done with summarization', createdAt: day },
    ]);
    expect(stats.researchIntro.count).toBe(1);
    expect(stats.dailyBrief.count).toBe(2);
    expect(stats.dailyBrief.lastSnippet).toBe('Reminder: standup at 10.');
    expect(stats.taskResult.count).toBe(1);
    expect(stats.dailySuggestions.count).toBe(0);
  });

  it('ignores unknown kinds (e.g. eod_report itself, text)', () => {
    const stats = aggregateOutbox([
      { kind: 'eod_report', content: 'Yesterday summary', createdAt: day },
      { kind: 'text', content: 'random push', createdAt: day },
    ]);
    expect(stats.researchIntro.count).toBe(0);
    expect(stats.dailyBrief.count).toBe(0);
    expect(stats.dailySuggestions.count).toBe(0);
    expect(stats.taskResult.count).toBe(0);
  });

  it('collapses whitespace and truncates long content in snippets', () => {
    const long = 'a'.repeat(500);
    const stats = aggregateOutbox([
      { kind: 'task_result', content: `line1\n\nline2   line3 ${long}`, createdAt: day },
    ]);
    expect(stats.taskResult.lastSnippet).toMatch(/…$/);
    expect(stats.taskResult.lastSnippet!.length).toBeLessThanOrEqual(201);
    expect(stats.taskResult.lastSnippet).toContain('line1 line2 line3');
  });
});
