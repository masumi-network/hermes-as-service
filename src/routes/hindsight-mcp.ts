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

  // Stream the response through untouched (streamable_http answers POST with
  // either JSON or an SSE frame; both pass through fine).
  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'mcp-session-id']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

router.all('/v1/hindsight/:instanceId/mcp', forward);
router.all('/v1/hindsight/:instanceId/mcp/:rest{.*}', forward);

export { router as hindsightMcpRouter };
