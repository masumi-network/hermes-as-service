import { describe, expect, it } from 'vitest';
import {
  buildTaskboardPrompt,
  type BoardTask,
} from '../src/notifications/taskboard-assistant.js';

/**
 * The gap this closes: a task run by a coworker — off a schedule, or straight
 * out of the user's own chat with that coworker — produces no job the
 * orchestrator can see. followup-continuation and urgent.ts are both JOB-level,
 * and urgent.ts is the only sweep allowed to message the user about
 * completions. So coworker-run work fell through every net: the user was never
 * told it finished, and no follow-up was ever proposed.
 *
 * The taskboard is the one place that work IS visible, so finished tasks are
 * handled there now. The prompt is the behaviour, so it's what gets tested.
 */

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
  id: 't1',
  name: 'Weekly Masumi Release Report',
  description: 'Pull commits and summarise the week.',
  status: 'COMPLETED',
  orgId: null,
  kind: 'done',
  sortKey: '2026-07-26T16:00:00Z',
  ...over,
});

describe('finished tasks — the prompt', () => {
  const p = () => buildTaskboardPrompt([task()], 'medium');

  it('labels the task as finished and names who did it', () => {
    const out = buildTaskboardPrompt([task({ assignee: 'Bront' })], 'medium');
    expect(out).toContain('JUST FINISHED.');
    expect(out).toContain('Worked by: Bront.');
    expect(out).toContain('Weekly Masumi Release Report');
  });

  it('orders notify-then-follow-up, and makes notifying the default', () => {
    const out = p();
    const notifyAt = out.indexOf('TELL THE USER');
    const followAt = out.indexOf('THEN consider a follow-up');
    expect(notifyAt).toBeGreaterThan(-1);
    expect(followAt).toBeGreaterThan(notifyAt);
    expect(out).toContain('This is the default, not the exception');
  });

  it('requires memory BEFORE writing, and again for the follow-up', () => {
    const out = p();
    expect(out).toContain('START by reading your memory');
    expect(out).toContain('Search memory for what this task was FOR before writing');
    expect(out).toContain('Search memory and the recent conversation for a next step');
  });

  it('routes the completion news to CHAT, not a task comment', () => {
    const out = p();
    expect(out).toContain('TELL THE USER, in chat, via outbox-send');
    expect(out).toContain('NEVER put a message meant for the user in a task comment');
  });

  it('forbids inventing a follow-up and caps it at one per turn', () => {
    const out = p();
    expect(out).toContain('A completion is not a plan');
    expect(out).toContain('AT MOST ONE follow-up task this turn');
  });

  it('keeps the follow-up delegated — never self-assigned, never self-done', () => {
    const out = p();
    expect(out).toContain('Never assign it to yourself and never do the work yourself');
  });

  it('reports a failure honestly', () => {
    const out = buildTaskboardPrompt([task({ status: 'FAILED' })], 'medium');
    expect(out).toContain('Do not dress up a failure as progress');
  });

  it('explains the medium-autonomy card as the proposal mechanism', () => {
    expect(buildTaskboardPrompt([task()], 'medium')).toContain(
      'raises a confirmation card — that IS how you propose it to the user',
    );
    expect(buildTaskboardPrompt([task()], 'high')).toContain(
      'executes immediately, so only create a follow-up you are confident the user wants',
    );
  });

  it('unlocks create_task ONLY when a finished task is in the batch', () => {
    expect(buildTaskboardPrompt([task()], 'medium')).toContain('sokosumi_create_task');
    const noneDone = buildTaskboardPrompt([task({ kind: 'input', status: 'INPUT_REQUIRED' })], 'medium');
    expect(noneDone).not.toContain('sokosumi_create_task');
  });

  it('still forbids spending credits and starting jobs', () => {
    for (const kind of ['done', 'input', 'new'] as const) {
      const out = buildTaskboardPrompt([task({ kind })], 'high');
      expect(out).toContain('Do NOT start jobs (sokosumi_create_job) and do NOT spend credits');
    }
  });
});

describe('sections are scoped to the batch', () => {
  it('omits the finished-task section when nothing finished', () => {
    const out = buildTaskboardPrompt([task({ kind: 'input', status: 'INPUT_REQUIRED' })], 'medium');
    expect(out).not.toContain('TELL THE USER');
    expect(out).toContain('INPUT_REQUIRED task →');
  });

  it('omits the input section when nothing is blocked', () => {
    const out = buildTaskboardPrompt([task()], 'medium');
    expect(out).not.toContain('the coworker is blocked');
  });

  it('includes every section present in a mixed batch', () => {
    const out = buildTaskboardPrompt(
      [
        task({ id: 'a', kind: 'done' }),
        task({ id: 'b', kind: 'input', status: 'INPUT_REQUIRED' }),
        task({ id: 'c', kind: 'new', status: 'READY' }),
      ],
      'medium',
    );
    expect(out).toContain('TELL THE USER');
    expect(out).toContain('the coworker is blocked');
    expect(out).toContain('silence beats noise');
  });
});

describe('the two prompt defects this pass also fixed', () => {
  it('scopes "handle what you can yourself" to DECISIONS, not work', () => {
    // The unqualified phrasing fed the role inversion — Hermes doing a
    // coworker's job and then handing them a review task. It must not return.
    const out = buildTaskboardPrompt([task()], 'high');
    expect(out).not.toContain('handle what you can yourself');
    expect(out).toContain('decide what is yours to decide');
    expect(out).toContain("You do NOT produce a coworker's deliverable yourself");
  });

  it('drops the absolute MUST-comment that contradicted "silence beats noise"', () => {
    const out = buildTaskboardPrompt([task({ kind: 'input', status: 'INPUT_REQUIRED' })], 'medium');
    expect(out).not.toContain('you MUST leave a comment');
    expect(out).toContain('beats a comment with no content');
  });
});
