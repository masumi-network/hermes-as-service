import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { authenticateInstanceBearer } from './instance-auth.js';

/**
 * Per-user Hindsight (long-term memory) MCP proxy.
 *
 * Hermes machines call here with their per-instance bearer; we forward to the
 * self-hosted Hindsight MCP server on the private network, attaching the
 * Hindsight auth token (held only in our Railway env). Same trust model as the
 * Composio proxy: the memory service's credentials never land on a machine.
 *
 * TENANCY — the important part. Hindsight supports "single-bank mode" where
 * the bank is bound by the URL path (`/mcp/{bank_id}/`), not by a tool
 * argument. We build that path from the AUTHENTICATED userId, so a machine
 * physically cannot address another user's memory: there is no bank_id
 * argument to tamper with, and the agent never learns any bank id but its own.
 *
 * Tool surface is restricted server-side on the Hindsight service itself
 * (HINDSIGHT_API_MCP_ENABLED_TOOLS=retain,recall,reflect), so bank management
 * tools are not exposed to agents at all.
 */
const router = new Hono();

/** Hindsight calls are memory ops (recall does hybrid retrieval; reflect runs
 *  an LLM turn). Generous but bounded — a hung call must not wedge an agent. */
const UPSTREAM_TIMEOUT_MS = 60_000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** JSON-RPC-shaped error so the MCP client surfaces it instead of hanging. */
function rpcUnavailable(message: string): Response {
  return jsonResponse(503, { jsonrpc: '2.0', error: { code: -32603, message } });
}

/**
 * Build the upstream single-bank MCP URL for a user. The trailing slash is
 * required by Hindsight's single-bank route (`/mcp/{bank_id}/`).
 */
export function hindsightBankUrl(baseUrl: string, userId: string, rest: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const suffix = rest ? `/${rest.replace(/^\//, '')}` : '';
  return `${base}/mcp/${encodeURIComponent(userId)}/${suffix.replace(/^\//, '')}`;
}

async function forward(c: Context): Promise<Response> {
  const cfg = loadConfig();
  if (!cfg.HINDSIGHT_MCP_URL.trim()) {
    return rpcUnavailable('Hindsight memory is not configured on this orchestrator.');
  }
  const instanceId = c.req.param('instanceId') ?? '';
  const auth = await authenticateInstanceBearer(instanceId, c.req.header('Authorization'), {
    decryptFailMessage: 'token decrypt failed',
  });
  if (!auth.ok) return jsonResponse(auth.status, { error: { message: auth.message } });

  // The bank is the AUTHENTICATED user — never anything the caller supplied.
  const upstreamUrl = hindsightBankUrl(
    cfg.HINDSIGHT_MCP_URL,
    auth.row.userId,
    c.req.param('rest') ?? '',
  );

  const method = c.req.method.toUpperCase();
  const headers: Record<string, string> = {};
  if (cfg.HINDSIGHT_MCP_TOKEN.trim()) {
    headers['Authorization'] = `Bearer ${cfg.HINDSIGHT_MCP_TOKEN.trim()}`;
  }
  // Pass through the MCP-relevant request headers only — never the machine's
  // own bearer, and never arbitrary client headers.
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
      { err, instanceId, ms: Date.now() - t0, timeout: isTimeout },
      'hindsight_proxy_upstream_failed',
    );
    return rpcUnavailable(
      isTimeout ? 'Memory service timed out.' : 'Memory service unreachable.',
    );
  }

  logger.info(
    { instanceId, method, status: upstream.status, ms: Date.now() - t0 },
    'hindsight_proxy_forwarded',
  );

  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'mcp-session-id']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }

  // NORMALIZE THE FRAMING. Hindsight (FastMCP) answers a JSON-RPC POST with an
  // SSE frame — `event: message\ndata: {...}` — even when we ask for plain
  // JSON (its middleware force-injects text/event-stream into Accept). The
  // Hermes gateway's MCP client does not parse that for request/response
  // calls: it saw HTTP 200 on tools/list and registered ZERO tools, silently.
  // Every other MCP server we expose (sokosumi) returns plain JSON, so we
  // unwrap here and hand the machine the shape it already handles.
  // GET/SSE streams are left alone — those are genuine event streams.
  const contentType = upstream.headers.get('content-type') ?? '';
  if (method === 'POST' && contentType.includes('text/event-stream')) {
    const raw = await upstream.text();
    const payload = extractSseJsonPayload(raw);
    if (payload) {
      outHeaders['content-type'] = 'application/json';
      return new Response(payload, { status: upstream.status, headers: outHeaders });
    }
    // Unparseable — hand back what we got rather than inventing a response.
    logger.warn({ instanceId, preview: raw.slice(0, 200) }, 'hindsight_sse_unwrap_failed');
    return new Response(raw, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

/**
 * Pull the JSON-RPC payload out of an SSE-framed response body. Returns the
 * LAST complete `data:` payload that parses as JSON (a JSON-RPC response is
 * normally a single `event: message`, but tolerate leading comments/pings and
 * multi-line data). Null when nothing parses.
 */
export function extractSseJsonPayload(body: string): string | null {
  let found: string | null = null;
  // Frames are separated by a blank line; within a frame, `data:` lines
  // concatenate (SSE spec joins them with \n).
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

router.all('/v1/hindsight/:instanceId/mcp', forward);
router.all('/v1/hindsight/:instanceId/mcp/:rest{.*}', forward);

export { router as hindsightMcpRouter };
