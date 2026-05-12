import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { HttpError, notFound, problemJson, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';

const router = new Hono();

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
    });

    if (isStreaming && upstreamRes.body) {
      // Tee the stream: one branch goes to the client unchanged, the other
      // is consumed in the background to capture the assembled assistant
      // response.
      const [toClient, toCapture] = upstreamRes.body.tee();
      void captureSseStream(toCapture, {
        instanceId: row.id,
        userId: row.userId,
        requestId,
        startedAt: t0,
        upstreamStatus: upstreamRes.status,
      }).catch((err) => logger.error({ err, userId, requestId }, 'sse_capture_failed'));

      return new Response(toClient, {
        status: upstreamRes.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
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
