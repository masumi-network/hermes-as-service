import { describe, expect, it } from 'vitest';
import { isCronNoOp } from '../src/routes/outbox.js';

describe('isCronNoOp — background-cron no-op suppression', () => {
  it('drops the exact message the user saw leak (narration + trailing "ok")', () => {
    const leaked =
      'No jobs in AWAITING_INPUT or INPUT_REQUIRED status, and no tasks in ' +
      'RUNNING, AWAITING_INPUT, or INPUT_REQUIRED status. Nothing stuck.\n\nok';
    expect(isCronNoOp(leaked, 'task_result')).toBe(true);
  });

  it('drops bare sentinels and bracketed markers', () => {
    for (const s of ['ok', 'OK', 'done', '[SILENT]', '[silent]', 'none', 'n/a', 'nothing to report']) {
      expect(isCronNoOp(s, 'task_result'), s).toBe(true);
    }
  });

  it('drops narration that ends in a bracketed marker anywhere', () => {
    expect(isCronNoOp('Checked all workspaces, all balances above 25. [SILENT]', 'task_result')).toBe(true);
    expect(isCronNoOp('I could not read balances — no action taken.', 'task_result')).toBe(true);
  });

  it('KEEPS genuine notifications (a real stuck-job reminder)', () => {
    const real =
      'Heads up: job "Cardano Ecosystem Analysis" (Hannah) has been waiting on ' +
      'your input for 26h — it needs the target date range to continue.';
    expect(isCronNoOp(real, 'task_result')).toBe(false);
  });

  it('KEEPS a real low-credits warning even though it is a housekeeping cron', () => {
    const real = 'Your "utxo AG" workspace is down to 12 credits — the last job (Deepfake Detector) spent 40.';
    expect(isCronNoOp(real, 'task_result')).toBe(false);
  });

  it('NEVER suppresses a digest kind, even if it somehow ends oddly', () => {
    // A daily brief must always surface; guard against a pathological ending.
    expect(isCronNoOp('Your Monday brief:\n- 3 open tasks\n- ok', 'daily_brief')).toBe(false);
    expect(isCronNoOp('ok', 'daily_suggestions')).toBe(false);
  });

  it('treats empty/whitespace content as a no-op', () => {
    expect(isCronNoOp('', 'task_result')).toBe(true);
    expect(isCronNoOp('   \n  ', undefined)).toBe(true);
  });

  it('does not false-drop a message that merely contains the word ok mid-sentence', () => {
    expect(isCronNoOp('Everything looks ok, but 2 jobs need your input — see below.', 'task_result')).toBe(false);
  });
});
