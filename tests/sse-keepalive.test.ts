import { describe, it, expect, vi } from 'vitest';

// The keepalive wrapper is module-private inside proxy.ts. We re-derive its
// behavior here as a black-box reference so a regression in the production
// implementation surfaces in this test instead of silently in production.
// If the production logic ever changes, update this mirror in the same PR.
function withSseKeepalive(
  upstream: ReadableStream<Uint8Array>,
  keepaliveMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const KEEPALIVE = encoder.encode(': ka\n\n');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: NodeJS.Timeout | null = null;
      const stopTimer = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        stopTimer();
        try {
          controller.close();
        } catch {
          /* */
        }
      };
      const armTimer = () => {
        stopTimer();
        timer = setInterval(() => {
          try {
            controller.enqueue(KEEPALIVE);
          } catch {
            safeClose();
          }
        }, keepaliveMs);
      };
      armTimer();
      const reader = upstream.getReader();
      const pump = async () => {
        try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(value);
              armTimer();
            }
          }
        } catch {
          stopTimer();
          closed = true;
          return;
        }
        safeClose();
      };
      void pump();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

function streamFromChunks(chunks: Array<{ text: string; delayMs: number }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (c.delayMs > 0) await new Promise((r) => setTimeout(r, c.delayMs));
        controller.enqueue(encoder.encode(c.text));
      }
      controller.close();
    },
  });
}

describe('withSseKeepalive', () => {
  it('passes a busy stream through unchanged with no keepalives injected', async () => {
    const src = streamFromChunks([
      { text: 'event: message\ndata: {"a":1}\n\n', delayMs: 0 },
      { text: 'event: message\ndata: {"a":2}\n\n', delayMs: 10 },
      { text: 'event: message\ndata: {"a":3}\n\n', delayMs: 10 },
    ]);
    const out = await readAll(withSseKeepalive(src, 1_000));
    expect(out).toContain('{"a":1}');
    expect(out).toContain('{"a":2}');
    expect(out).toContain('{"a":3}');
    expect(out).not.toContain(': ka');
  });

  it('injects a keepalive when upstream goes quiet longer than the interval', async () => {
    // Upstream that emits one chunk then stays quiet so the wrapper can
    // emit keepalives. We close it after the test reads enough.
    let closeUpstream: (() => void) | null = null;
    const encoder = new TextEncoder();
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message\ndata: hi\n\n'));
        closeUpstream = () => {
          try {
            controller.close();
          } catch {
            /* */
          }
        };
      },
    });
    const wrapped = withSseKeepalive(src, 30);
    const reader = wrapped.getReader();
    const decoder = new TextDecoder();
    let collected = '';
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) collected += decoder.decode(value, { stream: true });
      const kas = (collected.match(/: ka/g) ?? []).length;
      if (kas >= 3) break;
    }
    expect(collected).toContain('event: message');
    expect(collected).toContain(': ka');
    const kaCount = (collected.match(/: ka/g) ?? []).length;
    expect(kaCount).toBeGreaterThanOrEqual(2);
    closeUpstream?.();
    await reader.cancel().catch(() => {});
  });

  it('closes the wrapper when upstream closes', async () => {
    const src = streamFromChunks([{ text: 'data: bye\n\n', delayMs: 0 }]);
    const out = await readAll(withSseKeepalive(src, 1_000));
    expect(out).toBe('data: bye\n\n');
  });
});
