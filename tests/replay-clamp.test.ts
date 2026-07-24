import { describe, it, expect } from 'vitest';
import { clampReplayMessages } from '../src/routes/proxy.js';

const BIG = 'x'.repeat(20_000);

describe('clampReplayMessages', () => {
  it('trims oversized NON-final history messages and reports change', () => {
    const messages = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: BIG },
      { role: 'user', content: 'final turn' },
    ];
    expect(clampReplayMessages(messages)).toBe(true);
    expect((messages[1]!.content as string).length).toBeLessThan(8_200);
    expect(messages[1]!.content).toContain('[earlier message trimmed');
  });

  it('NEVER trims the final message, even when oversized', () => {
    const messages = [
      { role: 'assistant', content: 'short' },
      { role: 'user', content: BIG },
    ];
    expect(clampReplayMessages(messages)).toBe(false);
    expect((messages[1]!.content as string).length).toBe(20_000);
  });

  it('NEVER trims system messages (live instructions)', () => {
    const messages = [
      { role: 'system', content: BIG },
      { role: 'user', content: 'final' },
    ];
    expect(clampReplayMessages(messages)).toBe(false);
    expect((messages[0]!.content as string).length).toBe(20_000);
  });

  it('leaves multimodal array contents untouched', () => {
    const arr = [{ type: 'text', text: BIG }];
    const messages = [
      { role: 'user', content: arr },
      { role: 'user', content: 'final' },
    ];
    expect(clampReplayMessages(messages)).toBe(false);
    expect(messages[0]!.content).toBe(arr);
  });

  it('no-ops on single-message and undefined inputs', () => {
    expect(clampReplayMessages([{ role: 'user', content: BIG }])).toBe(false);
    expect(clampReplayMessages(undefined)).toBe(false);
  });

  it('under-limit messages pass through unchanged', () => {
    const messages = [
      { role: 'assistant', content: 'a'.repeat(7_999) },
      { role: 'user', content: 'final' },
    ];
    expect(clampReplayMessages(messages)).toBe(false);
  });
});
