import { describe, it, expect } from 'vitest';
import { withProgressStream, frameHasContent } from '../src/routes/proxy.js';
import { publishProgress, _subscriberCount } from '../src/routes/progress-bus.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A manually-driven upstream SSE stream. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(enc.encode(text)),
    close: () => {
      try {
        controller.close();
      } catch {
        /* */
      }
    },
  };
}

/** Drain a stream to a single decoded string. */
function drain(stream: ReadableStream<Uint8Array>): { done: Promise<string>; chunks: string[] } {
  const chunks: string[] = [];
  const done = (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(dec.decode(value));
    }
    return chunks.join('');
  })();
  return { done, chunks };
}

describe('frameHasContent', () => {
  it('detects a non-empty content delta', () => {
    expect(frameHasContent('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe(true);
  });
  it('ignores empty/role/[DONE]/keepalive frames', () => {
    expect(frameHasContent('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toBe(false);
    expect(frameHasContent('data: {"choices":[{"delta":{"content":""}}]}')).toBe(false);
    expect(frameHasContent('data: [DONE]')).toBe(false);
    expect(frameHasContent(': ka')).toBe(false);
  });
});

describe('withProgressStream', () => {
  it('emits an immediate thinking frame before any upstream data', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 't1', startedAt: Date.now() }));
    await sleep(10);
    u.close();
    const out = await done;
    expect(out).toContain('event: hermes.status');
    expect(out).toContain('"phase":"thinking"');
    expect(out.indexOf('thinking')).toBeGreaterThanOrEqual(0);
  });

  it('forwards content frames intact and emits a single answering frame', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 't2', startedAt: Date.now() }));
    await sleep(5);
    u.push('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    u.push('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    await sleep(5);
    u.close();
    const out = await done;
    expect(out).toContain('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    expect(out).toContain('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    // answering appears exactly once
    expect(out.match(/"phase":"answering"/g) ?? []).toHaveLength(1);
    // answering precedes the first content frame on the wire
    expect(out.indexOf('"phase":"answering"')).toBeLessThan(out.indexOf('"content":"Hello"'));
  });

  it('injects bus tool events as hermes.status frames', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 't3', startedAt: Date.now() }));
    await sleep(5);
    publishProgress('t3', { phase: 'tool', tool: 'web_search', label: 'Searching the web', ts: 1 });
    await sleep(5);
    u.close();
    const out = await done;
    expect(out).toContain('"phase":"tool"');
    expect(out).toContain('Searching the web');
    expect(out).toContain('"elapsedMs"'); // proxy stamps elapsed on egress
  });

  it('NEVER splits a gateway frame when a bus event fires mid-frame', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 't4', startedAt: Date.now() }));
    await sleep(5);
    // Push the first half of a content frame (no frame separator yet).
    u.push('data: {"choices":[{"delta":{"content":"hel');
    await sleep(5);
    // Fire a bus event while the frame is incomplete in the buffer.
    publishProgress('t4', { phase: 'tool', label: 'MIDFRAME', ts: 1 });
    await sleep(5);
    // Complete the frame.
    u.push('lo"}}]}\n\n');
    await sleep(5);
    u.close();
    const out = await done;
    // The content frame is contiguous and intact.
    expect(out).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    // The injected frame landed BEFORE the completed content frame, not inside it.
    expect(out.indexOf('MIDFRAME')).toBeLessThan(out.indexOf('"content":"hello"'));
    // No corruption: "hel" never appears immediately followed by an injected event.
    expect(out).not.toMatch(/"content":"hel(?!lo)/);
  });

  it('handles CRLF (\\r\\n\\r\\n) frame separators without buffering the whole turn', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 'crlf', startedAt: Date.now() }));
    await sleep(5);
    u.push('data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n');
    u.push('data: {"choices":[{"delta":{"content":"!"}}]}\r\n\r\n');
    await sleep(5);
    u.close();
    const out = await done;
    expect(out).toContain('data: {"choices":[{"delta":{"content":"Hi"}}]}\r\n\r\n');
    expect(out.match(/"phase":"answering"/g) ?? []).toHaveLength(1);
  });

  it('stops working heartbeats once answering has started', async () => {
    const u = manualStream();
    const { done } = drain(
      withProgressStream(u.stream, { instanceId: 'hb2', startedAt: Date.now(), keepaliveMs: 20 }),
    );
    await sleep(5);
    u.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'); // answering flips
    await sleep(90); // ~4 intervals would fire if the heartbeat kept running
    u.close();
    const out = await done;
    const answeringIdx = out.indexOf('"phase":"answering"');
    expect(answeringIdx).toBeGreaterThanOrEqual(0);
    expect(out.slice(answeringIdx)).not.toContain('"phase":"working"');
  });

  it('releases the subscription when the request signal aborts', async () => {
    const u = manualStream();
    const ac = new AbortController();
    const wrapped = withProgressStream(u.stream, {
      instanceId: 'ab1',
      startedAt: Date.now(),
      signal: ac.signal,
    });
    const reader = wrapped.getReader();
    await reader.read(); // thinking
    expect(_subscriberCount('ab1')).toBe(1);
    ac.abort();
    await sleep(10);
    expect(_subscriberCount('ab1')).toBe(0);
    await reader.cancel().catch(() => {});
  });

  it('emits working heartbeats during silence and stops on real traffic', async () => {
    const u = manualStream();
    const { done } = drain(
      withProgressStream(u.stream, { instanceId: 't5', startedAt: Date.now(), keepaliveMs: 20 }),
    );
    await sleep(75); // ~3 heartbeats
    u.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
    await sleep(10);
    u.close();
    const out = await done;
    expect((out.match(/"phase":"working"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('releases the bus subscription when the client cancels', async () => {
    const u = manualStream();
    const wrapped = withProgressStream(u.stream, { instanceId: 't6', startedAt: Date.now() });
    const reader = wrapped.getReader();
    await reader.read(); // thinking frame
    expect(_subscriberCount('t6')).toBe(1);
    await reader.cancel();
    await sleep(10);
    expect(_subscriberCount('t6')).toBe(0);
  });

  it('releases the subscription when upstream ends normally', async () => {
    const u = manualStream();
    const { done } = drain(withProgressStream(u.stream, { instanceId: 't7', startedAt: Date.now() }));
    await sleep(5);
    u.close();
    await done;
    await sleep(5);
    expect(_subscriberCount('t7')).toBe(0);
  });
});
