import { describe, it, expect } from 'vitest';
import {
  aggregateCrons,
  aggregateOutbox,
  composeSummary,
  currentLocalHour,
  renderCron,
  renderOutbox,
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

  it('ignores unrelated events', () => {
    const stats = aggregateCrons([
      { event: 'integration_connected', detail: { provider: 'gmail' }, createdAt: day },
      { event: 'resumed', detail: {}, createdAt: day },
    ]);
    expect(stats.inboxRefresh.ran).toBe(0);
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

describe('renderCron', () => {
  it('renders "no activity" when neither ran nor failed', () => {
    expect(renderCron('Inbox refresh', { ran: 0, failed: 0 })).toBe(
      '- Inbox refresh: _no activity_',
    );
  });

  it('renders run count alone when no failures', () => {
    expect(renderCron('Inbox refresh', { ran: 1, failed: 0 })).toBe('- Inbox refresh: 1 run');
    expect(renderCron('Inbox refresh', { ran: 4, failed: 0 })).toBe('- Inbox refresh: 4 runs');
  });

  it('renders failed alone when no successful runs', () => {
    expect(renderCron('Sokosumi sync', { ran: 0, failed: 1 })).toBe('- Sokosumi sync: 1 failed');
  });

  it('combines ran + failed counts', () => {
    expect(renderCron('Inbox refresh', { ran: 3, failed: 2 })).toBe('- Inbox refresh: 3 runs, 2 failed');
  });

  it('appends a lastDetail snippet when present', () => {
    expect(renderCron('Inbox refresh', { ran: 1, failed: 0, lastDetail: 'gmail' })).toBe(
      '- Inbox refresh: 1 run — _gmail_',
    );
  });

  it('respects a custom run word', () => {
    expect(renderCron('Urgent interrupts', { ran: 5, failed: 0 }, 'check')).toBe(
      '- Urgent interrupts: 5 checks',
    );
  });
});

describe('renderOutbox', () => {
  it('renders count alone when no lastSnippet', () => {
    expect(renderOutbox('Daily brief', { count: 3 })).toBe('- Daily brief: 3 messages');
  });

  it('renders the snippet on a quoted second line', () => {
    expect(renderOutbox('Daily brief', { count: 1, lastSnippet: 'Today: 2 meetings.' })).toBe(
      '- Daily brief: 1 message\n  > Today: 2 meetings.',
    );
  });

  it('singularizes "message" for count == 1', () => {
    expect(renderOutbox('Task results', { count: 1 })).toBe('- Task results: 1 message');
  });
});

describe('composeSummary', () => {
  // Force the rendering tests into a stable TZ so the date-label doesn't
  // depend on the machine running CI.
  const tz = 'Europe/Berlin';
  // 2026-05-25T00:00 in Berlin (CEST = UTC+2) is 2026-05-24T22:00Z.
  const startOfDay = new Date('2026-05-24T22:00:00Z');

  it('builds a quiet-day summary when nothing happened', () => {
    const out = composeSummary([], [], startOfDay, tz);
    expect(out).toContain('**Your cron summary — Monday, May 25**');
    expect(out).toContain('_Background sweeps_');
    expect(out).toContain('- Inbox refresh: _no activity_');
    expect(out).toContain('- Sokosumi sync: _no activity_');
    expect(out).toContain('- Urgent interrupts: _no activity_');
    expect(out).toContain('- Task augmentation: _no activity_');
    expect(out).not.toContain('_Messages sent to your chat today_');
    expect(out).not.toContain('failure');
  });

  it('renders a full active day with cron stats + outbox snippet', () => {
    const events = [
      {
        event: 'onboarding_step',
        detail: { step: 'inbox_refresh', status: 'done', providers: ['gmail'] },
        createdAt: startOfDay,
      },
      {
        event: 'chat_proxied',
        detail: { source: 'urgent_interrupt', events: 2, reason: 'completed-jobs' },
        createdAt: startOfDay,
      },
    ];
    const outbox = [
      { kind: 'daily_brief', content: 'Today: light schedule.', createdAt: startOfDay },
    ];
    const out = composeSummary(events, outbox, startOfDay, tz);
    expect(out).toContain('- Inbox refresh: 1 run — _gmail_');
    expect(out).toContain('- Urgent interrupts: 1 check — _2 event(s) considered_');
    expect(out).toContain('_Messages sent to your chat today_');
    expect(out).toContain('- Daily brief: 1 message');
    expect(out).toContain('> Today: light schedule.');
    expect(out).not.toContain('failure');
  });

  it('appends a failure footer when totalFailed > 0', () => {
    const events = [
      {
        event: 'onboarding_step',
        detail: { step: 'sokosumi_sync', status: 'failed', source: 'cron' },
        createdAt: startOfDay,
      },
    ];
    const out = composeSummary(events, [], startOfDay, tz);
    expect(out).toContain('- Sokosumi sync: 1 failed');
    expect(out).toContain('_1 failure today');
  });

  it('pluralizes the failure footer for >1', () => {
    const events = [
      {
        event: 'onboarding_step',
        detail: { step: 'sokosumi_sync', status: 'failed', source: 'cron' },
        createdAt: startOfDay,
      },
      {
        event: 'onboarding_step',
        detail: { step: 'inbox_refresh', status: 'failed', source: 'cron' },
        createdAt: startOfDay,
      },
    ];
    const out = composeSummary(events, [], startOfDay, tz);
    expect(out).toContain('_2 failures today');
  });

  it('omits outbox section when no proactive messages were sent', () => {
    const events = [
      {
        event: 'onboarding_step',
        detail: { step: 'inbox_refresh', status: 'done', providers: ['gmail'] },
        createdAt: startOfDay,
      },
    ];
    const out = composeSummary(events, [], startOfDay, tz);
    expect(out).not.toContain('_Messages sent to your chat today_');
  });
});
