import { Hono } from 'hono';
import type { Context } from 'hono';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { decryptSecret } from '../crypto.js';
import { ensurePricingLoaded } from '../llm/pricing.js';
import { checkUserCap, recordLlmUsage } from '../llm/spend.js';
import { publishProgress, hasProgressSubscribers } from './progress-bus.js';
import { labelForBuiltinTool, summarizeResult } from './tool-labels.js';

const router = new Hono();

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ---------- in-memory per-instance rate limit ----------
const rateBuckets = new Map<string, number[]>();

function checkRate(instanceId: string, rpm: number): { ok: boolean; resetMs: number } {
  const now = Date.now();
  const windowStart = now - 60_000;
  let arr = rateBuckets.get(instanceId);
  if (!arr) {
    arr = [];
    rateBuckets.set(instanceId, arr);
  }
  while (arr.length > 0 && (arr[0] ?? 0) < windowStart) arr.shift();
  if (arr.length >= rpm) {
    return { ok: false, resetMs: (arr[0] ?? now) + 60_000 - now };
  }
  arr.push(now);
  return { ok: true, resetMs: 0 };
}

// ---------- auth ----------

interface AuthOk {
  ok: true;
  row: { id: string; userId: string };
}
interface AuthErr {
  ok: false;
  status: number;
  message: string;
}

async function authenticate(
  instanceId: string,
  authHeader: string | undefined,
): Promise<AuthOk | AuthErr> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'missing bearer' };
  }
  const bearer = authHeader.slice(7).trim();
  if (!bearer) return { ok: false, status: 401, message: 'empty bearer' };

  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || !row.llmProxyToken) {
    return { ok: false, status: 404, message: 'instance not found' };
  }
  let expected: string;
  try {
    expected = await decryptSecret(row.llmProxyToken);
  } catch {
    return { ok: false, status: 500, message: 'token decrypt failed' };
  }
  if (!timingSafeEqual(bearer, expected)) {
    return { ok: false, status: 401, message: 'bad bearer' };
  }
  return { ok: true, row: { id: row.id, userId: row.userId } };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- forwarding ----------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function forwardChatCompletions(c: Context): Promise<Response> {
  const instanceId = c.req.param('instanceId') ?? '';
  if (!instanceId) return jsonResponse(400, { error: { message: 'missing instanceId' } });

  const auth = await authenticate(instanceId, c.req.header('Authorization'));
  if (!auth.ok) return jsonResponse(auth.status, { error: { message: auth.message } });

  const cfg = loadConfig();
  const rate = checkRate(instanceId, cfg.LLM_RATE_LIMIT_RPM);
  if (!rate.ok) {
    return new Response(
      JSON.stringify({ error: { message: `rate limit exceeded (${cfg.LLM_RATE_LIMIT_RPM} rpm)` } }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(rate.resetMs / 1000)),
        },
      },
    );
  }

  // Per-user monthly spend cap (hard reject).
  await ensurePricingLoaded();
  const cap = await checkUserCap(auth.row.userId);
  if (!cap.allowed) {
    return jsonResponse(402, {
      error: {
        message: `monthly spend cap reached ($${cap.monthlySpendUsd.toFixed(4)} of $${cap.capUsd.toFixed(2)})`,
        code: 'monthly_cap_reached',
      },
    });
  }

  // Read + munge the request body. We inject `stream_options.include_usage`
  // for streaming so the final SSE chunk has usage data — without this we
  // can't bill streamed calls accurately.
  const bodyText = await c.req.text();
  let parsed: Record<string, unknown> = {};
  let parsedOk = true;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    parsedOk = false; // unparseable — forward the original bytes untouched
  }
  const isStreaming = parsed['stream'] === true;
  if (isStreaming) {
    const so = (parsed['stream_options'] as Record<string, unknown> | undefined) ?? {};
    so['include_usage'] = true;
    parsed['stream_options'] = so;
  }
  // Latency: let OpenRouter pick the fastest provider for this model unless
  // the caller already pinned routing. Additive — doesn't change the model.
  if (parsed['provider'] === undefined) {
    parsed['provider'] = { sort: 'throughput' };
  }
  // If the request contains image_url parts, swap the model to a
  // vision-capable one. MiMo (our default text model) returns
  // "No endpoints found that support image input" otherwise.
  if (hasImageContent(parsed)) {
    parsed['model'] = cfg.VISION_MODEL;
  }
  // If we couldn't parse the body, forward it verbatim rather than sending a
  // synthesized object with no model/messages (which OpenRouter would reject
  // with a confusing error that masks the caller's real mistake).
  const forwardedBody = parsedOk ? JSON.stringify(parsed) : bodyText;

  // Announce the just-completed tool round (if any) as tool_done chips,
  // derived from the trailing tool-result messages in this request.
  if (parsedOk) publishToolResults(auth.row.id, parsed);

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${cfg.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': cfg.ORCHESTRATOR_PUBLIC_URL,
    'X-Title': 'Hermes Orchestrator',
  };
  const accept = c.req.header('accept');
  if (accept) upstreamHeaders['Accept'] = accept;

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: forwardedBody,
    });
  } catch (err) {
    logger.error({ err, instanceId }, 'llm_proxy_upstream_failed');
    return jsonResponse(502, { error: { message: 'upstream fetch failed' } });
  }

  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'transfer-encoding']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }

  if (!isStreaming) {
    const respText = await upstream.text();
    void captureNonStreaming(respText, auth.row);
    return new Response(respText, { status: upstream.status, headers: outHeaders });
  }

  if (!upstream.body) {
    return new Response('', { status: upstream.status, headers: outHeaders });
  }
  const [toClient, toCapture] = upstream.body.tee();
  void captureSse(toCapture, auth.row).catch((err) =>
    logger.error({ err, instanceId }, 'llm_proxy_sse_capture_failed'),
  );
  return new Response(toClient, { status: upstream.status, headers: outHeaders });
}

/**
 * Publish a "tool" progress event for each tool call the agent decided to
 * make, so the chat proxy can surface it to the user mid-turn. Cheap no-op
 * when no chat stream is listening for this instance.
 */
function publishToolCalls(
  instanceId: string,
  calls: Array<{ name?: string; args?: string; id?: string }>,
): void {
  if (!hasProgressSubscribers(instanceId)) return;
  for (const call of calls) {
    if (!call.name) continue;
    const { label, detail } = labelForBuiltinTool(call.name, call.args);
    publishProgress(instanceId, {
      phase: 'tool',
      tool: call.name,
      ...(call.id ? { id: call.id } : {}),
      label,
      ...(detail ? { detail } : {}),
      ts: Date.now(),
    });
  }
}

/**
 * Every tool's result flows back into the NEXT LLM call as trailing
 * `role:"tool"` messages — so on each forwarded request we can announce the
 * just-completed round as `tool_done` chips (with a short result summary).
 * The trailing consecutive tool block is exactly one round's results, so no
 * cross-request dedup is needed. Covers built-in AND MCP tools uniformly.
 */
function publishToolResults(instanceId: string, parsed: Record<string, unknown>): void {
  if (!hasProgressSubscribers(instanceId)) return;
  for (const r of extractTrailingToolResults(parsed['messages'])) {
    publishProgress(instanceId, {
      phase: 'tool_done',
      ...(r.name ? { tool: r.name } : {}),
      ...(r.id ? { id: r.id } : {}),
      label: r.name ? labelForBuiltinTool(r.name).label : 'Tool finished',
      ...(r.summary ? { detail: r.summary } : {}),
      ts: Date.now(),
    });
  }
}

interface ToolResult {
  id?: string;
  name?: string;
  summary: string;
}

/**
 * Pure: from an OpenAI `messages` array, return the trailing run of tool
 * results (the most recent round), each labelled with its tool name (mapped
 * via tool_call_id from the assistant tool_calls) and a short summary.
 */
export function extractTrailingToolResults(messages: unknown): ToolResult[] {
  if (!Array.isArray(messages)) return [];
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: string; tool_calls?: { id?: string; function?: { name?: string } }[] };
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (typeof tc?.id === 'string' && typeof tc.function?.name === 'string') {
        idToName.set(tc.id, tc.function.name);
      }
    }
  }
  const trailing: { tool_call_id?: string; name?: string; content?: unknown }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && typeof m === 'object' ? (m as { role?: string }).role : undefined;
    if (role === 'tool' || role === 'function') {
      trailing.unshift(m as { tool_call_id?: string; name?: string; content?: unknown });
    } else {
      break;
    }
  }
  return trailing.map((m) => {
    const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
    const name = (id && idToName.get(id)) || (typeof m.name === 'string' ? m.name : undefined);
    return { id, name, summary: summarizeResult(m.content) };
  });
}

async function forwardGenericGet(c: Context, pathSuffix: string): Promise<Response> {
  const instanceId = c.req.param('instanceId') ?? '';
  if (!instanceId) return jsonResponse(400, { error: { message: 'missing instanceId' } });
  const auth = await authenticate(instanceId, c.req.header('Authorization'));
  if (!auth.ok) return jsonResponse(auth.status, { error: { message: auth.message } });

  const cfg = loadConfig();
  try {
    const upstream = await fetch(`${OPENROUTER_BASE}${pathSuffix}`, {
      headers: {
        Authorization: `Bearer ${cfg.OPENROUTER_API_KEY}`,
        'HTTP-Referer': cfg.ORCHESTRATOR_PUBLIC_URL,
        'X-Title': 'Hermes Orchestrator',
      },
    });
    const outHeaders: Record<string, string> = {};
    const ct = upstream.headers.get('content-type');
    if (ct) outHeaders['Content-Type'] = ct;
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    logger.error({ err, pathSuffix }, 'llm_proxy_upstream_failed');
    return jsonResponse(502, { error: { message: 'upstream fetch failed' } });
  }
}

function hasImageContent(parsed: Record<string, unknown>): boolean {
  const messages = parsed['messages'];
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const t = (part as { type?: string }).type;
      if (t === 'image_url' || t === 'input_image') return true;
    }
  }
  return false;
}

// ---------- usage capture ----------

interface InstanceRef {
  id: string;
  userId: string;
}

async function captureNonStreaming(respText: string, ref: InstanceRef): Promise<void> {
  try {
    const json = JSON.parse(respText) as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: {
        message?: { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
      }[];
    };
    const toolCalls = json.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      publishToolCalls(
        ref.id,
        toolCalls.map((tc) => ({ name: tc.function?.name, args: tc.function?.arguments, id: tc.id })),
      );
    }
    const promptTokens = json.usage?.prompt_tokens ?? 0;
    const completionTokens = json.usage?.completion_tokens ?? 0;
    if (promptTokens === 0 && completionTokens === 0) return;
    await recordLlmUsage({
      instanceId: ref.id,
      userId: ref.userId,
      model: json.model ?? 'unknown',
      promptTokens,
      completionTokens,
      streamed: false,
    });
  } catch (err) {
    logger.warn({ err }, 'llm_proxy_nonstreaming_parse_failed');
  }
}

async function captureSse(stream: ReadableStream<Uint8Array>, ref: InstanceRef): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let model = 'unknown';
  let promptTokens = 0;
  let completionTokens = 0;
  // Accumulate streamed tool_calls by index: name lands in the first delta
  // for an index, arguments stream in fragments across later deltas. We
  // flush one progress event per tool when the stream ends (the whole
  // tool-decision turn is short, so this is still well ahead of execution).
  const toolPartials = new Map<number, { name: string; args: string; id: string }>();

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
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          choices?: {
            delta?: {
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        };
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        }
        const deltaCalls = chunk.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(deltaCalls)) {
          for (const tc of deltaCalls) {
            const idx = tc.index ?? 0;
            const cur = toolPartials.get(idx) ?? { name: '', args: '', id: '' };
            // name/id normally arrive whole in the first delta; args stream in
            // fragments. Appending an empty/absent field is a no-op either way.
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolPartials.set(idx, cur);
          }
        }
      } catch {
        /* ignore malformed lines */
      }
    }
  }

  if (toolPartials.size > 0) {
    publishToolCalls(
      ref.id,
      [...toolPartials.values()].map((p) => ({ name: p.name, args: p.args, id: p.id })),
    );
  }

  if (promptTokens === 0 && completionTokens === 0) return;
  await recordLlmUsage({
    instanceId: ref.id,
    userId: ref.userId,
    model,
    promptTokens,
    completionTokens,
    streamed: true,
  });
}

// ---------- routes ----------

router.all('/v1/llm/:instanceId/chat/completions', (c) => forwardChatCompletions(c));
router.get('/v1/llm/:instanceId/models', (c) => forwardGenericGet(c, '/models'));
router.get('/v1/llm/:instanceId/models/:rest{.*}', (c) =>
  forwardGenericGet(c, `/models/${c.req.param('rest')}`),
);
router.get('/v1/llm/:instanceId/:rest{.*}', (c) =>
  forwardGenericGet(c, `/${c.req.param('rest')}`),
);

export { router as llmProxyRouter };
