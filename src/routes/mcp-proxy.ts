import { Hono } from 'hono';
import type { Context } from 'hono';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { decryptSecret } from '../crypto.js';

/**
 * Per-user MCP proxy.
 *
 * Hermes machines call here with a per-instance bearer; we look up the
 * integration's stored Composio URL, attach the org-wide COMPOSIO_API_KEY
 * (held only in our Railway env), and forward the request to Composio.
 * Streams responses back transparently (MCP streamable_http uses SSE for
 * tool-call responses).
 *
 * The point: the Composio API key never lands on a Hermes machine. The
 * only secret a Hermes user could exfiltrate via shell tools is their
 * own per-instance bearer, which is scoped to that one instance and
 * rotatable.
 */
const router = new Hono();

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function forward(c: Context): Promise<Response> {
  const instanceId = c.req.param('instanceId') ?? '';
  const provider = c.req.param('provider') ?? '';
  const rest = c.req.param('rest') ?? '';
  if (!instanceId || !provider) {
    return jsonResponse(400, { error: { message: 'missing instanceId or provider' } });
  }
  const auth = await authenticate(instanceId, c.req.header('Authorization'));
  if (!auth.ok) return jsonResponse(auth.status, { error: { message: auth.message } });

  const integration = await prisma.integration.findUnique({
    where: { userId_provider: { userId: auth.row.userId, provider } },
  });
  if (!integration) {
    return jsonResponse(404, { error: { message: `integration ${provider} not connected` } });
  }
  if (integration.status === 'disconnected') {
    return jsonResponse(410, { error: { message: `integration ${provider} disconnected` } });
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = await decryptSecret(integration.mcpUrl);
  } catch (err) {
    logger.error({ err, instanceId, provider }, 'mcp_proxy_decrypt_failed');
    return jsonResponse(500, { error: { message: 'integration url decrypt failed' } });
  }

  // Append any path suffix Hermes added (rare for MCP streamable_http, but
  // future-proof for transports that use sub-paths).
  if (rest) {
    upstreamUrl = `${upstreamUrl.replace(/\/$/, '')}/${rest}`;
  }
  // Preserve the original query string. Composio scopes per-user via
  // ?user_id=... in the URL, but if Hermes ever adds query params we want
  // those forwarded too. Merge: Hermes' query overrides upstream defaults.
  const inboundQuery = c.req.query();
  if (Object.keys(inboundQuery).length > 0) {
    const u = new URL(upstreamUrl);
    for (const [k, v] of Object.entries(inboundQuery)) u.searchParams.set(k, v);
    upstreamUrl = u.toString();
  }

  // Build upstream headers. Start clean — don't leak the per-instance
  // bearer or arbitrary headers from Hermes to Composio.
  const cfg = loadConfig();
  const upstreamHeaders: Record<string, string> = {};
  // Composio: x-api-key. Heuristic matches buildMcpServersJsonForUser.
  if (cfg.COMPOSIO_API_KEY && /(composio\.dev|composio\.ai)/i.test(upstreamUrl)) {
    upstreamHeaders['x-api-key'] = cfg.COMPOSIO_API_KEY;
  }
  // Pass through MCP-relevant headers.
  for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version']) {
    const v = c.req.header(h);
    if (v) upstreamHeaders[h] = v;
  }

  // Forward body for write methods. Read as text — MCP JSON-RPC payloads
  // are text, and string bodies don't hit the undici "detached ArrayBuffer"
  // bug on redirect-following (which Composio does internally between
  // regional endpoints).
  const method = c.req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const bodyText = hasBody ? await c.req.text() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyText,
    });
  } catch (err) {
    logger.error({ err, instanceId, provider }, 'mcp_proxy_upstream_failed');
    return jsonResponse(502, { error: { message: 'upstream fetch failed' } });
  }

  // Stream the response back. content-type matters (application/json vs
  // text/event-stream). mcp-session-id matters for stateful transports.
  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// Two route shapes: with and without a sub-path. Hermes will hit the bare
// URL we hand it; the wildcard form is defense for future MCP variants.
router.all('/v1/mcp/:instanceId/:provider', (c) => forward(c));
router.all('/v1/mcp/:instanceId/:provider/:rest{.*}', (c) => forward(c));

export { router as mcpProxyRouter };
