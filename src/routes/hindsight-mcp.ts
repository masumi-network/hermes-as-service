import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { authenticateInstanceBearer } from './instance-auth.js';

/**
 * Per-user Hindsight proxy — the transport for Hermes' NATIVE hindsight
 * memory provider (mode `local_external`).
 *
 * The plugin on each machine is pointed at
 * `${ORCHESTRATOR_PUBLIC_URL}/v1/hindsight/{instanceId}` as its `api_url`
 * and authenticates with that instance's own bearer. We forward to the
 * self-hosted Hindsight server on the private network, attaching the real
 * Hindsight credential — which never lands on a machine. Same trust model as
 * the Composio + Sokosumi proxies.
 *
 * TENANCY: Hindsight addresses a memory bank as a path segment
 * (`.../banks/{bank_id}/...`). We REWRITE that segment to the AUTHENTICATED
 * userId on every request, so a machine cannot read or write another user's
 * memory even if its local config were tampered with.
 */
const router = new Hono();

/** Memory ops are prefetch-blocking on the agent's turn; bounded but generous
 *  (reflect runs an LLM pass server-side). */
const UPSTREAM_TIMEOUT_MS = 60_000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Force the bank segment to `userId` wherever it appears.
 * `/v1/default/banks/<anything>/memories` → `/v1/default/banks/<userId>/memories`
 * Also covers the MCP single-bank form `/mcp/<anything>/`.
 * Exported for tests — this is the isolation guarantee.
 */
export function forceBankPath(path: string, userId: string): string {
  const safe = encodeURIComponent(userId);
  return path
    .replace(/\/banks\/[^/]+/g, `/banks/${safe}`)
    .replace(/^\/mcp\/[^/]+/, `/mcp/${safe}`);
}

/**
 * Pull the JSON-RPC/JSON payload out of an SSE-framed body. FastMCP answers
 * POSTs with `event: message\ndata: {...}` even when plain JSON was requested;
 * clients that expect JSON see a 200 and parse nothing. Returns the LAST
 * parseable `data:` payload, or null.
 */
export function extractSseJsonPayload(body: string): string | null {
  let found: string | null = null;
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n').trim();
    if (!joined || joined === '[DONE]') continue;
    try {
      JSON.parse(joined);
      found = joined;
    } catch {
      /* not this frame */
    }
  }
  return found;
}

async function forward(c: Context): Promise<Response> {
  const cfg = loadConfig();
  const base = cfg.HINDSIGHT_MCP_URL.trim();
  if (!base) {
    return jsonResponse(503, { error: { message: 'Hindsight memory is not configured.' } });
  }
  const instanceId = c.req.param('instanceId') ?? '';
  // The provider SDK may send its key as a bearer or as x-api-key.
  const bearer = c.req.header('Authorization') ?? `Bearer ${c.req.header('x-api-key') ?? ''}`;
  const auth = await authenticateInstanceBearer(instanceId, bearer, {
    decryptFailMessage: 'token decrypt failed',
  });
  if (!auth.ok) return jsonResponse(auth.status, { error: { message: auth.message } });

  const rest = c.req.param('rest') ?? '';
  const url = new URL(c.req.url);
  const upstreamPath = forceBankPath(`/${rest}`.replace(/\/+/g, '/'), auth.row.userId);
  const upstreamUrl = `${base.replace(/\/$/, '')}${upstreamPath}${url.search}`;

  const method = c.req.method.toUpperCase();
  const headers: Record<string, string> = {};
  if (cfg.HINDSIGHT_MCP_TOKEN.trim()) {
    headers['Authorization'] = `Bearer ${cfg.HINDSIGHT_MCP_TOKEN.trim()}`;
  }
  for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version']) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const bodyText = hasBody ? await c.req.text() : undefined;

  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    logger.warn(
      { err, instanceId, path: upstreamPath, timeout: isTimeout },
      'hindsight_proxy_upstream_failed',
    );
    return jsonResponse(503, {
      error: { message: isTimeout ? 'Memory service timed out.' : 'Memory service unreachable.' },
    });
  }

  logger.info(
    { instanceId, method, path: upstreamPath, status: upstream.status, ms: Date.now() - t0 },
    'hindsight_proxy_forwarded',
  );

  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'mcp-session-id']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }

  // Normalize SSE-framed POST replies to plain JSON (see extractSseJsonPayload).
  const contentType = upstream.headers.get('content-type') ?? '';
  if (method === 'POST' && contentType.includes('text/event-stream')) {
    const raw = await upstream.text();
    const payload = extractSseJsonPayload(raw);
    if (payload) {
      outHeaders['content-type'] = 'application/json';
      return new Response(payload, { status: upstream.status, headers: outHeaders });
    }
    logger.warn({ instanceId, preview: raw.slice(0, 200) }, 'hindsight_sse_unwrap_failed');
    return new Response(raw, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

router.all('/v1/hindsight/:instanceId', forward);
router.all('/v1/hindsight/:instanceId/:rest{.*}', forward);

export { router as hindsightMcpRouter };
