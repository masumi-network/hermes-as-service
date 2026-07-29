import { describe, expect, it } from 'vitest';
import {
  buildBoardPrompt,
  dedupKind,
  dropJobsCoveredByTasks,
  orderItems,
  rankOf,
  type BoardItem,
} from '../src/notifications/board-sweep.js';

/**
 * The board sweep replaces three overlapping sweeps (taskboard-assistant,
 * input-responder + follow-up continuation, urgent-interrupts). These cover the
 * two things the merge must not get wrong:
 *
 *   · TASKS and JOBS are different. Tasks are the primary view — coworker-run
 *     work produces no visible job — but a job can have NO task at all, so the
 *     job path has to survive. They're reconciled, not flattened.
 *   · The notification discipline inherited from urgent-interrupts (2h
 *     cooldown, with failures and blocked work bypassing it).
 */

const task = (over: Partial<BoardItem> = {}): BoardItem => ({
  source: 'task',
  id: 't1',
  name: 'Weekly Masumi Release Report',
  description: 'Pull commits and summarise the week.',
  status: 'COMPLETED',
  orgId: null,
  kind: 'done',
  sortKey: '2026-07-26T16:00:00Z',
  ...over,
});
const job = (over: Partial<BoardItem> = {}): BoardItem => ({
  source: 'job',
  id: 'j1',
  name: 'Research run',
  description: null,
  status: 'COMPLETED',
  orgId: null,
  kind: 'done',
  sortKey: '2026-07-26T16:00:00Z',
  parentTaskId: null,
  ...over,
});

describe('tasks vs jobs — reconciliation', () => {
  it('keeps an ORPHAN job (no task at all) — tasks cannot see it', () => {
    // Observed in production: jobs with taskId: null.
    const items = [task({ id: 'tA' }), job({ id: 'jX', parentTaskId: null })];
    expect(dropJobsCoveredByTasks(items).map((i) => i.id)).toEqual(['tA', 'jX']);
  });

  it('drops a job whose task is already in the batch (same work, twice)', () => {
    const items = [task({ id: 'tA' }), job({ id: 'jX', parentTaskId: 'tA' })];
    expect(dropJobsCoveredByTasks(items).map((i) => i.id)).toEqual(['tA']);
  });

  it('keeps a job whose task is NOT in this batch', () => {
    // Its task didn't change, so nothing else is reporting this work.
    const items = [task({ id: 'tA' }), job({ id: 'jX', parentTaskId: 'tOther' })];
    expect(dropJobsCoveredByTasks(items).map((i) => i.id)).toEqual(['tA', 'jX']);
  });

  it('never drops a task', () => {
    const items = [task({ id: 'tA' }), task({ id: 'tB', kind: 'input' })];
    expect(dropJobsCoveredByTasks(items)).toHaveLength(2);
  });
});

describe('ordering — tasks outrank jobs, blocked outranks news', () => {
  it('ranks task_input → task_done → job_input → job_done → task_new', () => {
    expect(rankOf({ source: 'task', kind: 'input' })).toBeLessThan(rankOf({ source: 'task', kind: 'done' }));
    expect(rankOf({ source: 'task', kind: 'done' })).toBeLessThan(rankOf({ source: 'job', kind: 'input' }));
    expect(rankOf({ source: 'job', kind: 'input' })).toBeLessThan(rankOf({ source: 'job', kind: 'done' }));
    expect(rankOf({ source: 'job', kind: 'done' })).toBeLessThan(rankOf({ source: 'task', kind: 'new' }));
  });

  it('a blocked TASK beats a blocked JOB', () => {
    const out = orderItems([job({ id: 'j', kind: 'input' }), task({ id: 't', kind: 'input' })]);
    expect(out.map((i) => i.id)).toEqual(['t', 'j']);
  });

  it('oldest-first within the same rank, so over-cap items come back next tick', () => {
    const out = orderItems([
      task({ id: 'new', sortKey: '2026-07-26T18:00:00Z' }),
      task({ id: 'old', sortKey: '2026-07-26T09:00:00Z' }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['old', 'new']);
  });

  it('does not mutate its input', () => {
    const input = [task({ id: 'b', kind: 'new' }), task({ id: 'a', kind: 'input' })];
    orderItems(input);
    expect(input.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('dedup keys are namespaced per source', () => {
  it('a task and a job with the same id do not collide', () => {
    expect(dedupKind({ source: 'task', kind: 'done' })).toBe('task_done');
    expect(dedupKind({ source: 'job', kind: 'done' })).toBe('job_done');
  });

  it('the same id handled as input can still be handled as done later', () => {
    expect(dedupKind({ source: 'task', kind: 'input' })).not.toBe(
      dedupKind({ source: 'task', kind: 'done' }),
    );
  });
});

describe('prompt — finished work', () => {
  const p = () => buildBoardPrompt([task()], 'medium');

  it('orders notify-then-follow-up, and makes notifying the default', () => {
    const out = p();
    expect(out.indexOf('TELL THE USER')).toBeGreaterThan(-1);
    expect(out.indexOf('THEN consider a follow-up')).toBeGreaterThan(out.indexOf('TELL THE USER'));
    expect(out).toContain('This is the default, not the exception');
  });

  it('requires memory before writing, and again for the follow-up', () => {
    const out = p();
    expect(out).toContain('START by reading your memory');
    expect(out).toContain('Search memory for what this was FOR before writing');
    expect(out).toContain('Search memory and the recent conversation for a next step');
  });

  it('routes completion news to CHAT, never a task comment', () => {
    const out = p();
    expect(out).toContain('TELL THE USER, in chat, via outbox-send');
    expect(out).toContain('NEVER put a message meant for the user in a task comment');
  });

  it('forbids inventing a follow-up and caps it at one', () => {
    const out = p();
    expect(out).toContain('A completion is not a plan');
    expect(out).toContain('AT MOST ONE follow-up task this turn');
    expect(out).toContain('Never assign it to yourself and never do the work yourself');
  });

  it('reports failures honestly and mentions refunds for a paid job', () => {
    const out = buildBoardPrompt([job({ status: 'FAILED' })], 'medium');
    expect(out).toContain('Do not dress up a failure as progress');
    expect(out).toContain('request a refund');
  });

  it('explains what a JOB is only when one is present', () => {
    expect(buildBoardPrompt([job()], 'medium')).toContain('TASKS vs JOBS');
    expect(buildBoardPrompt([task()], 'medium')).not.toContain('TASKS vs JOBS');
  });

  it('labels each item with its source and the right id field', () => {
    expect(buildBoardPrompt([task({ id: 'tZ' })], 'medium')).toContain('task_id=tZ');
    expect(buildBoardPrompt([job({ id: 'jZ' })], 'medium')).toContain('job_id=jZ');
    expect(buildBoardPrompt([job()], 'medium')).toContain('[JOB · COMPLETED]');
  });
});

describe('prompt — blocked work', () => {
  it('covers BOTH the task route and the job route', () => {
    const out = buildBoardPrompt(
      [task({ kind: 'input', status: 'INPUT_REQUIRED' }), job({ kind: 'input', status: 'AWAITING_INPUT' })],
      'medium',
    );
    expect(out).toContain('sokosumi_get_task shows what was asked');
    expect(out).toContain('sokosumi_get_job_input_request gives the event_id');
  });

  it('keeps the anti-fabrication rule from the old input responder', () => {
    const out = buildBoardPrompt([job({ kind: 'input' })], 'high');
    expect(out).toContain('ONLY from a real source you can point to');
    expect(out).toContain('a fabricated answer is far worse than a paused job');
  });
});

describe('prompt — notification cooldown (inherited from urgent-interrupts)', () => {
  it('marks a quiet item and explains the rule', () => {
    const out = buildBoardPrompt([task({ quiet: true })], 'medium', { inCooldown: true });
    expect(out).toContain('Do NOT message the user about this one');
    expect(out).toContain("tonight's end-of-day report covers it");
  });

  it('says nothing about quiet items when none are held back', () => {
    const out = buildBoardPrompt([task()], 'medium', { inCooldown: false });
    expect(out).not.toContain('QUIET items');
  });

  it('still lets the agent override for something genuinely urgent', () => {
    const out = buildBoardPrompt([task({ quiet: true })], 'medium', { inCooldown: true });
    expect(out).toContain('you may message about that ONE item and say why');
  });
});

describe('prompt — sections scoped to the batch', () => {
  it('omits the finished section when nothing finished', () => {
    const out = buildBoardPrompt([task({ kind: 'input', status: 'INPUT_REQUIRED' })], 'medium');
    expect(out).not.toContain('TELL THE USER');
  });

  it('omits create_task unless a finished item is present', () => {
    expect(buildBoardPrompt([task()], 'medium')).toContain('sokosumi_create_task');
    expect(buildBoardPrompt([task({ kind: 'input' })], 'medium')).not.toContain('sokosumi_create_task');
  });

  it('always forbids starting jobs and spending credits', () => {
    for (const item of [task(), task({ kind: 'input' }), task({ kind: 'new' }), job()]) {
      expect(buildBoardPrompt([item], 'high')).toContain(
        'Do NOT start jobs (sokosumi_create_job) and do NOT spend credits',
      );
    }
  });
});

describe('prompt — the delegation defects stay fixed', () => {
  it('scopes decisions, and forbids producing a coworker deliverable', () => {
    const out = buildBoardPrompt([task()], 'high');
    expect(out).not.toContain('handle what you can yourself');
    expect(out).toContain("You do NOT produce a coworker's deliverable yourself");
  });

  it('has no absolute MUST-comment contradicting "silence beats noise"', () => {
    const out = buildBoardPrompt(
      [task({ kind: 'input' }), task({ id: 't2', kind: 'new' })],
      'medium',
    );
    expect(out).not.toContain('you MUST leave a comment');
    expect(out).toContain('silence beats noise');
    expect(out).toContain('beats a comment with no content');
  });
});

describe('stall escalation (input_stalled)', () => {
  it('outranks everything, including fresh blocked tasks', () => {
    const stalled = task({ kind: 'input_stalled' });
    expect(rankOf(stalled)).toBeLessThan(rankOf(task({ kind: 'input' })));
    expect(dedupKind(stalled)).toBe('task_input_stalled');
  });

  it('prompt names the stall and makes the user message non-optional', () => {
    const out = buildBoardPrompt([task({ kind: 'input_stalled' })], 'high');
    expect(out).toContain('STILL BLOCKED');
    expect(out).toContain('cooldown does not apply');
    expect(out).toContain('do NOT guess an answer');
  });

  it('does not leak the stalled section into ordinary batches', () => {
    const out = buildBoardPrompt([task({ kind: 'input' }), task({ id: 't9', kind: 'done' })], 'high');
    expect(out).not.toContain('STILL BLOCKED (12h+)');
  });
});
