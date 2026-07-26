import { describe, expect, it } from 'vitest';
import {
  JOB_PAYMENT_STATUSES,
  awaitingInputTimestamp,
  couldBeAwaitingInput,
  extractAwaitingInputEvent,
} from '../src/sokosumi/job-state.js';

/**
 * Regression guard for a silent total failure.
 *
 * The input-responder sweep ran every 5 minutes for months with `prompted=0`
 * on every single tick, because it tested
 *     job.status.toLowerCase() === 'awaiting_input'
 * against a field that only ever carries PAYMENT statuses. The predicate was
 * unsatisfiable, so a genuinely paused job could never have been found.
 *
 * These tests encode the two taxonomies so the mistake can't come back.
 */
describe('the status FIELD never carries lifecycle values', () => {
  it('awaiting_input is not a payment status', () => {
    // If this ever fails, Sokosumi changed its model and the sweeps can be
    // simplified back to a plain field check.
    expect(JOB_PAYMENT_STATUSES).not.toContain('awaiting_input');
    expect(JOB_PAYMENT_STATUSES).not.toContain('running');
  });

  it('rejects every real payment status as "not awaiting input" is NOT the test', () => {
    // couldBeAwaitingInput is a FREE pre-filter, not the answer. Terminal
    // payment states are definitive rejections...
    for (const s of ['completed', 'failed', 'refund_resolved', 'dispute_resolved']) {
      expect(couldBeAwaitingInput({ status: s })).toBe(false);
    }
    // ...but a non-terminal one must NOT be treated as proof of pausing.
    expect(couldBeAwaitingInput({ status: 'payment_pending' })).toBe(true);
  });
});

describe('couldBeAwaitingInput — free rejection of settled jobs', () => {
  it('rejects a settled job', () => {
    expect(couldBeAwaitingInput({ jobStatusSettled: true })).toBe(false);
  });

  it('rejects a job with a completedAt', () => {
    expect(couldBeAwaitingInput({ completedAt: '2026-02-24T22:15:15.397Z' })).toBe(false);
  });

  it('rejects the exact shape the ?status=AWAITING_INPUT bucket returns', () => {
    // Verbatim from production: a 5-month-old job that WAS awaiting input once.
    // The lifecycle filter still returns it; it is emphatically not paused now.
    expect(
      couldBeAwaitingInput({
        status: 'completed',
        completedAt: '2026-02-24T22:15:15.397Z',
        jobStatusSettled: true,
      }),
    ).toBe(false);
  });

  it('keeps a live candidate for confirmation', () => {
    expect(
      couldBeAwaitingInput({ status: 'payment_pending', completedAt: null, jobStatusSettled: false }),
    ).toBe(true);
    expect(couldBeAwaitingInput({})).toBe(true);
  });
});

describe('extractAwaitingInputEvent — the authoritative current-state check', () => {
  it('finds an open input request', () => {
    const ev = extractAwaitingInputEvent([
      { id: 'e1', type: 'INPUT_REQUEST', createdAt: '2026-07-26T10:00:00Z' },
    ]);
    expect(ev?.['id']).toBe('e1');
  });

  it('ignores an already-answered request', () => {
    expect(
      extractAwaitingInputEvent([
        { id: 'e1', type: 'INPUT_REQUEST', createdAt: '2026-07-26T10:00:00Z' },
        { id: 'e2', type: 'INPUT_PROVIDED', createdAt: '2026-07-26T10:05:00Z' },
      ]),
    ).toBeTruthy(); // the OPEN one is still returned...
    // ...but a log with only resolutions yields nothing.
    expect(
      extractAwaitingInputEvent([{ id: 'e2', type: 'INPUT_PROVIDED', createdAt: '2026-07-26T10:05:00Z' }]),
    ).toBeNull();
  });

  it('returns the newest open request when several exist', () => {
    const ev = extractAwaitingInputEvent([
      { id: 'old', type: 'INPUT_REQUEST', createdAt: '2026-07-20T10:00:00Z' },
      { id: 'new', type: 'INPUT_REQUEST', createdAt: '2026-07-26T10:00:00Z' },
    ]);
    expect(ev?.['id']).toBe('new');
  });

  it('is null for a job with no events at all', () => {
    expect(extractAwaitingInputEvent(undefined)).toBeNull();
    expect(extractAwaitingInputEvent([])).toBeNull();
    expect(extractAwaitingInputEvent([{ type: 'COMPLETED' }])).toBeNull();
  });
});

describe('awaitingInputTimestamp — watermark keys on the REQUEST', () => {
  it('prefers the event timestamp over the job row', () => {
    expect(
      awaitingInputTimestamp(
        { createdAt: '2026-07-26T10:00:00Z' },
        { updatedAt: '2026-07-01T00:00:00Z' },
      ),
    ).toBe('2026-07-26T10:00:00Z');
  });

  it('falls back to the job row when the event has no stamp', () => {
    expect(awaitingInputTimestamp({}, { updatedAt: '2026-07-01T00:00:00Z' })).toBe(
      '2026-07-01T00:00:00Z',
    );
  });

  it('is null when nothing has a timestamp (caller must skip)', () => {
    expect(awaitingInputTimestamp({}, {})).toBeNull();
  });
});
