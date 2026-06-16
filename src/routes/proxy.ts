import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { HttpError, notFound, problemJson, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';
import { subscribeProgress, type ProgressEvent } from './progress-bus.js';

const router = new Hono();

// Long-running agent turns (30+ tool calls, several minutes) blew through
// undici's default 5-minute headersTimeout: for a non-streaming request the
// agent doesn't send headers until the WHOLE turn is done, so a 5+ min loop
// surfaced to Sokosumi as "fetch failed: Headers Timeout Error". The fix is
// a dedicated dispatcher with both header- and body-timeout disabled (and a
// generous keep-alive) for the chat-completions proxy. The connect timeout
// stays short so genuine DNS/TLS failures still fail fast.
const CHAT_PROXY_AGENT = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
});

const SSE_KEEPALIVE_MS = 20_000;

interface OpenAIMessage {
  role: string;
  content: string | unknown[];
}

interface OpenAIRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
}

router.post('/v1/proxy/:userId/v1/chat/completions', async (c) => {
  const userId = c.req.param('userId');
  const t0 = Date.now();

  try {
    const row = await prisma.hermesInstance.findUnique({ where: { userId } });
    if (!row) return problemJson(c, notFound(userId));
    if (!row.endpointUrl) {
      return problemJson(
        c,
        new HttpError(409, 'no_endpoint', 'Instance has no endpoint yet', userId),
      );
    }

    const apiServerKey = await decryptSecret(row.apiServerKey);
    const bodyText = await c.req.text();

    let parsed: OpenAIRequest = {};
    try {
      parsed = JSON.parse(bodyText) as OpenAIRequest;
    } catch {
      // forward as-is even if not parseable; Hermes will reject it
    }

    const isStreaming = parsed.stream === true;
    const requestId = randomUUID();
    const lastUser = findLastByRole(parsed.messages, 'user');
    const lastSystem = findLastByRole(parsed.messages, 'system');

    // Persist the user message now so it's visible even if upstream hangs.
    if (lastUser) {
      await prisma.chatMessage.create({
        data: {
          instanceId: row.id,
          userId: row.userId,
          requestId,
          role: 'user',
          content: contentToText(lastUser.content),
          model: parsed.model,
        },
      });
    }
    if (lastSystem) {
      await prisma.chatMessage.create({
        data: {
          instanceId: row.id,
          userId: row.userId,
          requestId,
          role: 'system',
          content: contentToText(lastSystem.content),
          model: parsed.model,
        },
      });
    }

    // Bump activity + flip to running so suspend bookkeeping stays accurate.
    await prisma.hermesInstance.update({
      where: { id: row.id },
      data: { lastActivityAt: new Date(), status: 'running' },
    });

    const upstreamRes = await fetch(`${row.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiServerKey}`,
        'Content-Type': 'application/json',
        Accept: isStreaming ? 'text/event-stream' : 'application/json',
      },
      body: bodyText,
      // @ts-expect-error — undici dispatcher is valid on Node's fetch impl
      dispatcher: CHAT_PROXY_AGENT,
    });

    if (isStreaming && upstreamRes.body) {
      // Tee the stream: one branch goes to the client, the other is consumed
      // in the background to capture the assembled assistant response.
      const [toClient, toCapture] = upstreamRes.body.tee();
      void captureSseStream(toCapture, {
        instanceId: row.id,
        userId: row.userId,
        requestId,
        startedAt: t0,
        upstreamStatus: upstreamRes.status,
      }).catch((err) => logger.error({ err, userId, requestId }, 'sse_capture_failed'));

      // When the caller opts in (Sokosumi sends `X-Hermes-Progress: 1`), we
      // inject `event: hermes.status` frames so the UI can show what the
      // agent is doing mid-turn instead of a silent spinner. Otherwise we
      // fall back to the invisible keepalive (pure pass-through, safe for any
      // vanilla OpenAI client).
      const clientStream = wantsProgress(c)
        ? withProgressStream(toClient, {
            instanceId: row.id,
            startedAt: t0,
            signal: c.req.raw.signal,
          })
        : withSseKeepalive(toClient);

      return new Response(clientStream, {
        status: upstreamRes.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    // Non-streaming: read once, capture, return as-is.
    const respText = await upstreamRes.text();
    void captureNonStreaming(respText, {
      instanceId: row.id,
      userId: row.userId,
      requestId,
      startedAt: t0,
      upstreamStatus: upstreamRes.status,
    }).catch((err) => logger.error({ err, userId, requestId }, 'capture_failed'));

    const contentType = upstreamRes.headers.get('Content-Type') ?? 'application/json';
    return new Response(respText, {
      status: upstreamRes.status,
      headers: { 'Content-Type': contentType },
    });
  } catch (err) {
    logger.error({ err, userId }, 'proxy_error');
    if (err instanceof HttpError) return problemJson(c, err);
    return problemJson(
      c,
      upstream(userId, err instanceof Error ? err.message : 'proxy failed'),
    );
  }
});

interface CaptureCtx {
  instanceId: string;
  userId: string;
  requestId: string;
  startedAt: number;
  upstreamStatus: number;
}

async function captureNonStreaming(respText: string, ctx: CaptureCtx): Promise<void> {
  const latencyMs = Date.now() - ctx.startedAt;
  let role = 'assistant';
  let content = '';
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let finishReason: string | null = null;
  let errorMessage: string | null = null;

  try {
    const json = JSON.parse(respText) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
      error?: { message?: string };
    };
    if (json.error?.message) {
      errorMessage = json.error.message;
    }
    content = json.choices?.[0]?.message?.content ?? '';
    finishReason = json.choices?.[0]?.finish_reason ?? null;
    model = json.model ?? null;
    promptTokens = json.usage?.prompt_tokens ?? null;
    completionTokens = json.usage?.completion_tokens ?? null;
    totalTokens = json.usage?.total_tokens ?? null;
  } catch {
    content = respText.slice(0, 4000);
    errorMessage = 'unparseable_response';
  }

  if (ctx.upstreamStatus >= 400) {
    errorMessage = errorMessage ?? `upstream_${ctx.upstreamStatus}`;
  }

  await prisma.chatMessage.create({
    data: {
      instanceId: ctx.instanceId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      role,
      content,
      model: model ?? undefined,
      promptTokens: promptTokens ?? undefined,
      completionTokens: completionTokens ?? undefined,
      totalTokens: totalTokens ?? undefined,
      finishReason: finishReason ?? undefined,
      latencyMs,
      errorMessage: errorMessage ?? undefined,
    },
  });
  await recordEvent({
    userId: ctx.userId,
    instanceId: ctx.instanceId,
    event: errorMessage ? 'chat_failed' : 'chat_proxied',
    detail: { requestId: ctx.requestId, latencyMs, status: ctx.upstreamStatus, ...(errorMessage ? { errorMessage } : {}) },
  });
}

/**
 * Pass an SSE stream through unchanged, but inject `: ka\n\n` keepalive
 * comments every SSE_KEEPALIVE_MS during quiet stretches. Real agent turns
 * can sit silent for minutes between tool calls — without keepalive, an
 * intermediary (Railway edge, Sokosumi's load balancer, the browser) can
 * reap the idle connection and the user sees a hang. SSE comments are
 * protocol-legal no-ops the client ignores.
 *
 * The timer is reset every time we forward a real chunk, so the keepalive
 * never duplicates legitimate traffic.
 */
function withSseKeepalive(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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
          /* already closed */
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
        }, SSE_KEEPALIVE_MS);
      };
      armTimer();

      const reader = upstream.getReader();
      const pump = async (): Promise<void> => {
        try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(value);
              armTimer(); // reset so we don't ping right after a real chunk
            }
          }
        } catch (err) {
          logger.warn({ err }, 'sse_keepalive_upstream_error');
          try {
            controller.error(err);
          } catch {
            /* ignore */
          }
          stopTimer();
          closed = true;
          return;
        }
        safeClose();
      };
      void pump();
    },
    cancel(reason) {
      logger.info({ reason: String(reason) }, 'sse_keepalive_client_disconnected');
    },
  });
}

/** Opt-in flag: header `X-Hermes-Progress: 1` or query `?progress=1`. */
function wantsProgress(c: Context): boolean {
  const h = c.req.header('x-hermes-progress');
  if (h && h !== '0' && h.toLowerCase() !== 'false') return true;
  const q = c.req.query('progress');
  return !!q && q !== '0' && q.toLowerCase() !== 'false';
}

const SSE_FRAME_SEP = '\n\n';
// Safety cap so a stream that never emits a frame separator can't grow the
// buffer without bound. A real SSE frame is never this large; if we ever
// exceed it we flush the raw bytes and move on.
const MAX_FRAME_BUFFER = 1_000_000;

function statusFrame(event: ProgressEvent): Uint8Array {
  return new TextEncoder().encode(`event: hermes.status\ndata: ${JSON.stringify(event)}${SSE_FRAME_SEP}`);
}

/**
 * End offset (exclusive, including the separator) of the first COMPLETE SSE
 * frame in `buffer`, or null if none yet. The SSE spec permits LF, CRLF, or
 * CR line endings, so a blank-line frame boundary can be `\n\n`, `\r\n\r\n`,
 * or `\r\r` — we accept any. We slice the raw bytes (keeping the original
 * terminator) rather than rewriting framing.
 */
function nextFrameEnd(buffer: string): number | null {
  const m = buffer.match(/\r\n\r\n|\n\n|\r\r/);
  if (!m || m.index === undefined) return null;
  return m.index + m[0].length;
}

/** True if a complete SSE frame carries a non-empty assistant content delta. */
export function frameHasContent(frame: string): boolean {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

// Reasoning models (deepseek, minimax "mm") sometimes emit chain-of-thought
// wrapped in <think>…</think> or <mm:think>…</mm:think> INSIDE the assistant
// content delta when STREAMING — their non-streaming response is clean. We
// relay content verbatim, so without this the raw CoT + tags leak into the
// Sokosumi answer channel (and trip the UI into "answering" while CoT is still
// flowing). The structured reasoning chips are unaffected — they come from the
// separate reasoning/reasoning_content field, not from parsing content.
const THINK_OPEN = ['<think>', '<mm:think>'] as const;
const THINK_CLOSE = ['</think>', '</mm:think>'] as const;

/** Length of the longest suffix of `s` that is a PROPER prefix of some tag —
 *  i.e. the tail we must hold back because it could still grow into a tag on
 *  the next streamed piece (e.g. "<thi" before "nk>" arrives). */
function heldTagPrefixLen(s: string, tags: readonly string[]): number {
  const max = Math.min(s.length, Math.max(...tags.map((t) => t.length)) - 1);
  for (let len = max; len > 0; len--) {
    const suf = s.slice(s.length - len);
    if (tags.some((t) => t.length > suf.length && t.startsWith(suf))) return len;
  }
  return 0;
}

/**
 * Streaming-safe think-block stripper. Returns a `push(piece)` that strips
 * <think>/<mm:think> … </think>/</mm:think> blocks from a sequence of content
 * pieces, carrying a small `pending` buffer so a tag split across SSE frames
 * is still recognized. Stateful — make one per stream. Exported for tests.
 *
 * Edge at stream end: a trailing `pending` (an unresolved partial tag) is
 * dropped. It's at most a few chars and only ever a viable tag-prefix, so the
 * loss is negligible; an unterminated think block is correctly discarded.
 */
export function makeThinkFilter(): (piece: string) => string {
  let mode: 'pass' | 'inside' = 'pass';
  let pending = '';
  return (piece: string): string => {
    const input = pending + piece;
    pending = '';
    let out = '';
    let i = 0;
    while (i < input.length) {
      if (mode === 'pass') {
        let at = -1;
        let len = 0;
        for (const t of THINK_OPEN) {
          const idx = input.indexOf(t, i);
          if (idx !== -1 && (at === -1 || idx < at)) {
            at = idx;
            len = t.length;
          }
        }
        if (at !== -1) {
          out += input.slice(i, at);
          i = at + len;
          mode = 'inside';
        } else {
          const rest = input.slice(i);
          const held = heldTagPrefixLen(rest, THINK_OPEN);
          out += rest.slice(0, rest.length - held);
          pending = rest.slice(rest.length - held);
          break;
        }
      } else {
        let at = -1;
        let len = 0;
        for (const t of THINK_CLOSE) {
          const idx = input.indexOf(t, i);
          if (idx !== -1 && (at === -1 || idx < at)) {
            at = idx;
            len = t.length;
          }
        }
        if (at !== -1) {
          i = at + len;
          mode = 'pass';
        } else {
          const rest = input.slice(i);
          pending = rest.slice(rest.length - heldTagPrefixLen(rest, THINK_CLOSE));
          break;
        }
      }
    }
    return out;
  };
}

/**
 * Apply a think-filter to one COMPLETE SSE frame's assistant content delta,
 * preserving all framing (data: prefix, terminator). Returns the rewritten
 * frame, the original frame if nothing changed, or null if the frame carried
 * ONLY think content and is now empty (caller drops it). Non-content frames
 * (role, tool_calls, finish_reason, usage, [DONE]) pass through untouched.
 */
export function filterThinkFromFrame(
  frame: string,
  push: (piece: string) => string,
): string | null {
  const dataIdx = frame.indexOf('data:');
  if (dataIdx === -1) return frame;
  const lineStart = dataIdx + 'data:'.length;
  let lineEnd = frame.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = frame.length;
  const payload = frame.slice(lineStart, lineEnd).trim();
  if (!payload || payload === '[DONE]') return frame;
  let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }> };
  try {
    chunk = JSON.parse(payload);
  } catch {
    return frame;
  }
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (!delta || typeof delta.content !== 'string') return frame;
  const orig = delta.content;
  const filtered = push(orig);
  if (filtered === orig) return frame;
  const hasOtherDelta = Object.keys(delta).some((k) => k !== 'content');
  if (filtered === '' && !hasOtherDelta && choice?.finish_reason == null) return null;
  delta.content = filtered;
  const newPayload = JSON.stringify(chunk);
  const payloadIdx = frame.indexOf(payload, dataIdx);
  return frame.slice(0, payloadIdx) + newPayload + frame.slice(payloadIdx + payload.length);
}

/**
 * Forward the gateway SSE stream while injecting `event: hermes.status`
 * frames the UI renders as live progress:
 *   - an immediate `thinking` frame so the UI flips off "sending" at t=0;
 *   - `tool` frames from the progress bus as the agent calls tools;
 *   - a `working` heartbeat (carrying elapsedMs) during silent stretches,
 *     replacing the invisible `: ka` keepalive;
 *   - one `answering` frame when the final answer starts streaming.
 *
 * Frame-safety: bus/heartbeat callbacks fire asynchronously, so they could
 * otherwise land in the middle of a forwarded gateway frame and corrupt the
 * wire. We only ever enqueue COMPLETE frames — upstream bytes are buffered
 * and split on the SSE frame separator, and the frame-extraction block runs
 * synchronously (no await), so an async injection can only ever happen at a
 * frame boundary (while the reader is parked on the next read).
 */
export function withProgressStream(
  upstream: ReadableStream<Uint8Array>,
  opts: { instanceId: string; startedAt: number; keepaliveMs?: number; signal?: AbortSignal },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keepaliveMs = opts.keepaliveMs ?? SSE_KEEPALIVE_MS;
  let closed = false;
  let answering = false;
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  // Release timer + subscription + upstream reader exactly once. Called on
  // normal end, enqueue failure, error, client cancel, and request abort.
  const release = () => {
    if (closed) return;
    closed = true;
    stopTimer();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (reader) reader.cancel().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let buffer = '';
      // Per-stream think-block stripper (state carries across frames so a tag
      // split across deltas is still caught). One instance per stream.
      const thinkFilter = makeThinkFilter();

      const safeEnqueue = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
        } catch {
          release();
        }
      };
      const armTimer = () => {
        stopTimer();
        // Once the answer is streaming, its own tokens are the keepalive —
        // a `working` heartbeat then would wrongly flip the UI back out of
        // the answering state, so we stop heartbeating.
        if (closed || answering) return;
        timer = setInterval(() => {
          if (answering) {
            stopTimer();
            return;
          }
          safeEnqueue(
            statusFrame({ phase: 'working', elapsedMs: Date.now() - opts.startedAt, ts: Date.now() }),
          );
        }, keepaliveMs);
      };

      // Reap promptly if the client connection is aborted (a half-open or
      // stalled reader that never surfaces as a stream cancel()).
      if (opts.signal) {
        if (opts.signal.aborted) release();
        else opts.signal.addEventListener('abort', release, { once: true });
      }

      // Instant acknowledgement.
      safeEnqueue(statusFrame({ phase: 'thinking', elapsedMs: 0, ts: Date.now() }));
      // Live tool progress from the bus.
      unsubscribe = subscribeProgress(opts.instanceId, (e) => {
        safeEnqueue(statusFrame({ ...e, elapsedMs: Date.now() - opts.startedAt }));
      });
      armTimer();

      const r = upstream.getReader();
      reader = r;
      const pump = async (): Promise<void> => {
        try {
          while (!closed) {
            const { value, done } = await r.read();
            if (done) break;
            if (!value) continue;
            buffer += decoder.decode(value, { stream: true });
            // Synchronous block (no await): extract + enqueue every COMPLETE
            // frame, preserving its original terminator. Because nothing here
            // awaits, an async bus/heartbeat injection can only land between
            // complete frames, never mid-frame.
            let end: number | null;
            while ((end = nextFrameEnd(buffer)) !== null) {
              const rawFrame = buffer.slice(0, end);
              buffer = buffer.slice(end);
              // Strip any <think>/<mm:think> CoT before it reaches the client.
              const frame = filterThinkFromFrame(rawFrame, thinkFilter);
              if (frame === null) continue; // frame was entirely think content
              // Flip to "answering" on POST-strip content, so the UI doesn't
              // leave "thinking" the moment a (now-suppressed) think block opens.
              if (!answering && frameHasContent(frame)) {
                answering = true;
                stopTimer(); // content is now the keepalive
                safeEnqueue(
                  statusFrame({ phase: 'answering', elapsedMs: Date.now() - opts.startedAt, ts: Date.now() }),
                );
              }
              safeEnqueue(encoder.encode(frame));
            }
            // Bound memory if a separator never arrives (pathological frame).
            if (buffer.length > MAX_FRAME_BUFFER) {
              safeEnqueue(encoder.encode(buffer));
              buffer = '';
            }
            armTimer(); // reset heartbeat after real traffic (no-op once answering)
          }
          if (!closed && buffer.length > 0) safeEnqueue(encoder.encode(buffer));
        } catch (err) {
          logger.warn({ err }, 'progress_stream_upstream_error');
          release();
          try {
            controller.error(err);
          } catch {
            /* already closed/errored */
          }
          return;
        }
        release();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      void pump();
    },
    cancel(reason) {
      logger.info({ reason: String(reason) }, 'progress_stream_client_disconnected');
      release();
    },
  });
}

async function captureSseStream(
  stream: ReadableStream<Uint8Array>,
  ctx: CaptureCtx,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';
  let model: string | null = null;
  let finishReason: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let errorMessage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
            error?: { message?: string };
          };
          if (chunk.error?.message) errorMessage = chunk.error.message;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) assembled += delta;
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (chunk.model) model = chunk.model;
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
            totalTokens = chunk.usage.total_tokens ?? totalTokens;
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  } catch (err) {
    errorMessage = errorMessage ?? (err instanceof Error ? err.message : 'sse_read_failed');
  }

  if (ctx.upstreamStatus >= 400 && !errorMessage) {
    errorMessage = `upstream_${ctx.upstreamStatus}`;
  }

  await prisma.chatMessage.create({
    data: {
      instanceId: ctx.instanceId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      role: 'assistant',
      content: assembled,
      model: model ?? undefined,
      promptTokens: promptTokens ?? undefined,
      completionTokens: completionTokens ?? undefined,
      totalTokens: totalTokens ?? undefined,
      finishReason: finishReason ?? undefined,
      latencyMs: Date.now() - ctx.startedAt,
      errorMessage: errorMessage ?? undefined,
    },
  });
  await recordEvent({
    userId: ctx.userId,
    instanceId: ctx.instanceId,
    event: errorMessage ? 'chat_failed' : 'chat_proxied',
    detail: {
      requestId: ctx.requestId,
      latencyMs: Date.now() - ctx.startedAt,
      status: ctx.upstreamStatus,
      streaming: true,
      ...(errorMessage ? { errorMessage } : {}),
    },
  });
}

function findLastByRole(
  messages: OpenAIMessage[] | undefined,
  role: string,
): OpenAIMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return messages[i];
  }
  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'object' && p !== null) {
          const part = p as { type?: string; text?: string };
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .join('');
  }
  return JSON.stringify(content);
}

export { router as proxyRouter };
