import { describe, it, expect } from 'vitest';
import { makeThinkFilter, filterThinkFromFrame } from '../src/routes/proxy.js';

// Feed a list of content pieces through one filter instance and return the
// concatenated visible output — models a streamed sequence of content deltas.
function run(pieces: string[]): string {
  const f = makeThinkFilter();
  return pieces.map((p) => f(p)).join('');
}

describe('makeThinkFilter — single-piece behavior', () => {
  it('passes through content with no think tags', () => {
    expect(run(['hello world'])).toBe('hello world');
  });

  it('strips a <think> block in one piece', () => {
    expect(run(['a<think>secret cot</think>b'])).toBe('ab');
  });

  it('strips a <mm:think> block in one piece', () => {
    expect(run(['a<mm:think>secret</mm:think>b'])).toBe('ab');
  });

  it('strips multiple think blocks', () => {
    expect(run(['a<think>1</think>b<think>2</think>c'])).toBe('abc');
  });

  it('drops an unterminated think block at end', () => {
    expect(run(['a<think>blah blah no close'])).toBe('a');
  });

  it('leaves a stray "<" that is not a tag', () => {
    expect(run(['a < b <= c'])).toBe('a < b <= c');
  });

  it('does not strip a near-miss like <thinkers>', () => {
    expect(run(['<thinkers> are people'])).toBe('<thinkers> are people');
  });
});

describe('makeThinkFilter — tags split across pieces (the streaming case)', () => {
  it('handles an opening tag split across pieces', () => {
    expect(run(['a<th', 'ink>secret', '</think>b'])).toBe('ab');
  });

  it('handles a closing tag split across pieces', () => {
    expect(run(['a<think>secret</thi', 'nk>b'])).toBe('ab');
  });

  it('handles <mm:think> split mid-tag', () => {
    expect(run(['x<mm:', 'think>cot</mm:think>y'])).toBe('xy');
  });

  it('handles a lone "<" carried then resolved as non-tag', () => {
    expect(run(['a<', 'b'])).toBe('a<b');
  });

  it('models a realistic streamed think block then answer', () => {
    expect(run(['<think>', 'Let me ', 'reason ', 'about it', '</think>', 'The answer is 42'])).toBe(
      'The answer is 42',
    );
  });

  it('emits content that shares a piece with the closing tag', () => {
    expect(run(['<think>cot', '</think>Hello'])).toBe('Hello');
  });

  it('emits content before an opening tag in the same piece', () => {
    expect(run(['Intro <think>cot</think> outro'])).toBe('Intro  outro');
  });
});

// ---- frame-level helper ----

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function delta(content: string, extra: Record<string, unknown> = {}) {
  return { choices: [{ index: 0, delta: { content, ...extra } }] };
}

describe('filterThinkFromFrame', () => {
  it('passes [DONE] through unchanged', () => {
    const f = makeThinkFilter();
    expect(filterThinkFromFrame('data: [DONE]\n\n', f)).toBe('data: [DONE]\n\n');
  });

  it('passes a role-only (no content) frame through unchanged', () => {
    const f = makeThinkFilter();
    const fr = frame({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
    expect(filterThinkFromFrame(fr, f)).toBe(fr);
  });

  it('passes a plain-content frame through unchanged (fast path)', () => {
    const f = makeThinkFilter();
    const fr = frame(delta('hello'));
    expect(filterThinkFromFrame(fr, f)).toBe(fr);
  });

  it('drops a frame whose content is entirely think (now empty)', () => {
    const f = makeThinkFilter();
    expect(filterThinkFromFrame(frame(delta('<think>cot</think>')), f)).toBeNull();
  });

  it('rewrites a frame, stripping the think portion but keeping the answer', () => {
    const f = makeThinkFilter();
    const out = filterThinkFromFrame(frame(delta('<think>cot</think>Answer')), f);
    expect(out).not.toBeNull();
    expect(out!.startsWith('data: ')).toBe(true);
    expect(out!.endsWith('\n\n')).toBe(true);
    const json = JSON.parse(out!.slice('data: '.length).trim());
    expect(json.choices[0].delta.content).toBe('Answer');
  });

  it('keeps an empty-content frame when it carries finish_reason', () => {
    const f = makeThinkFilter();
    const fr = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '<think>x</think>' }, finish_reason: 'stop' }] })}\n\n`;
    const out = filterThinkFromFrame(fr, f);
    expect(out).not.toBeNull();
    const json = JSON.parse(out!.slice('data: '.length).trim());
    expect(json.choices[0].delta.content).toBe('');
    expect(json.choices[0].finish_reason).toBe('stop');
  });

  it('strips a think block split across consecutive frames', () => {
    const f = makeThinkFilter();
    const frames = [
      frame(delta('Sure. ')),
      frame(delta('<think>I should ')),
      frame(delta('reason</thi')),
      frame(delta('nk>Here it is')),
    ];
    const visible = frames
      .map((fr) => filterThinkFromFrame(fr, f))
      .filter((x): x is string => x !== null)
      .map((fr) => JSON.parse(fr.slice('data: '.length).trim()).choices[0].delta.content)
      .join('');
    expect(visible).toBe('Sure. Here it is');
  });

  it('preserves CRLF framing', () => {
    const f = makeThinkFilter();
    const fr = `data: ${JSON.stringify(delta('hello'))}\r\n\r\n`;
    expect(filterThinkFromFrame(fr, f)).toBe(fr);
  });
});
