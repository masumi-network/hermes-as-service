import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bug this exists to prevent, from a real session:
 *
 *   16:20:42  "run the weekly release report now"   → turn A, ran 8m 0s
 *   16:26:29  "what happened??"                     → turn B, ran 11m 50s
 *
 * B started while A was still running — 131 seconds of overlap on the same
 * instance. Neither turn could see the other, so the agent redid the entire
 * pipeline ("the previous session context is lost since this is a new turn"),
 * producing three CMS release entries for three different week ranges and a
 * pile of duplicate approval cards from a single user request.
 */

const load = async () => import('../src/routes/turn-guard.js');

beforeEach(async () => {
  vi.resetModules();
  const { resetTurnGuard } = await load();
  resetTurnGuard();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('acquireTurn', () => {
  it('lets the first turn through', async () => {
    const { acquireTurn } = await load();
    expect(acquireTurn('i1', { requestId: 'r1', prompt: 'run the report' })).toBeNull();
  });

  it('blocks a second turn on the same instance and reports the first', async () => {
    const { acquireTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'run the weekly release report now' });
    const busy = acquireTurn('i1', { requestId: 'r2', prompt: 'what happened??' });
    expect(busy).not.toBeNull();
    expect(busy!.requestId).toBe('r1');
    expect(busy!.prompt).toBe('run the weekly release report now');
  });

  it('does NOT block a different instance', async () => {
    const { acquireTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'a' });
    expect(acquireTurn('i2', { requestId: 'r2', prompt: 'b' })).toBeNull();
  });

  it('lets the next turn in after release', async () => {
    const { acquireTurn, releaseTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'a' });
    releaseTurn('i1', 'r1');
    expect(acquireTurn('i1', { requestId: 'r2', prompt: 'b' })).toBeNull();
  });

  it('ignores a release from a turn that does not own the slot', async () => {
    // A late release from a superseded turn must not free the live one.
    const { acquireTurn, releaseTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'a' });
    releaseTurn('i1', 'some-other-request');
    expect(acquireTurn('i1', { requestId: 'r2', prompt: 'b' })).not.toBeNull();
  });

  it('reclaims a slot stranded past the ceiling instead of wedging forever', async () => {
    vi.useFakeTimers();
    const { acquireTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'a' });
    vi.advanceTimersByTime(21 * 60_000);
    expect(acquireTurn('i1', { requestId: 'r2', prompt: 'b' })).toBeNull();
  });

  it('holds the slot for a long but legitimate turn', async () => {
    // Real turns have run 12 minutes; those must still block.
    vi.useFakeTimers();
    const { acquireTurn } = await load();
    acquireTurn('i1', { requestId: 'r1', prompt: 'a' });
    vi.advanceTimersByTime(12 * 60_000);
    expect(acquireTurn('i1', { requestId: 'r2', prompt: 'b' })).not.toBeNull();
  });
});

describe('busyMessage', () => {
  it('says what is running, for how long, and what it is doing now', async () => {
    const { busyMessage } = await load();
    const msg = busyMessage(
      { startedAt: Date.now() - 6 * 60_000, requestId: 'r1', prompt: 'run the weekly release report now' },
      'Searching the web — masumi-network commits',
    );
    expect(msg).toContain('run the weekly release report now');
    expect(msg).toContain('6 minutes');
    expect(msg).toContain('Searching the web');
    // And it must be explicit that the new message was NOT queued silently.
    expect(msg).toContain('send it again');
  });

  it('works when no progress is known', async () => {
    const { busyMessage } = await load();
    const msg = busyMessage({ startedAt: Date.now() - 30_000, requestId: 'r1', prompt: 'x' }, null);
    expect(msg).toContain('30 seconds');
    expect(msg).not.toContain('Right now');
  });
});

describe('busyResponse', () => {
  it('returns a normal JSON completion, not an error', async () => {
    const { busyResponse } = await load();
    const res = busyResponse('still working', false, 'xiaomi/mimo-v2.5-pro');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
      model: string;
    };
    expect(body.choices[0]!.message.content).toBe('still working');
    expect(body.choices[0]!.finish_reason).toBe('stop');
    expect(body.model).toBe('xiaomi/mimo-v2.5-pro');
  });

  it('returns a well-formed SSE stream when streaming was requested', async () => {
    const { busyResponse } = await load();
    const res = busyResponse('still working', true);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // Every data frame before [DONE] must parse as a chat.completion.chunk.
    const frames = text
      .split('\n\n')
      .map((f) => f.replace(/^data: /, '').trim())
      .filter((f) => f && f !== '[DONE]');
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(() => JSON.parse(f)).not.toThrow();
      expect(JSON.parse(f).object).toBe('chat.completion.chunk');
    }
    expect(frames.map((f) => JSON.parse(f).choices[0].delta.content ?? '').join('')).toBe(
      'still working',
    );
  });
});
