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

  // Detect tools/list requests up front so we know to buffer + filter the
  // response when the integration is read-only.
  const isToolsList = isToolsListRequest(bodyText);
  const isReadOnly = integration.mode !== 'write'; // default to read

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

  const outHeaders: Record<string, string> = {};
  for (const h of ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }

  // Filter the tool catalog for read-only integrations. Buffer the body,
  // strip write-tools, return modified.
  if (isToolsList && isReadOnly) {
    const upstreamText = await upstream.text();
    const { body, action, logMeta } = handleToolsListResponse(
      upstreamText,
      upstream.status,
      provider,
    );
    const metaWithCtx = { instanceId, provider, ...logMeta };
    if (action === 'deferred') {
      logger.info(metaWithCtx, 'mcp_proxy_tools_list_deferred');
    } else if (action === 'unparseable') {
      logger.warn(metaWithCtx, 'mcp_proxy_tools_filter_failed_passthrough');
    }
    delete outHeaders['content-length'];
    return new Response(body, { status: upstream.status, headers: outHeaders });
  }

  // Default: stream response back unchanged.
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

/**
 * Pure response-handling logic for read-only tools/list responses,
 * extracted so we can unit-test it without mocking the whole proxy.
 *
 * Three legitimate response shapes from a streamable_http MCP server:
 *
 *   (a) HTTP 200 + JSON body — inline JSON-RPC response. Filter tools[].
 *   (b) HTTP 200 + text/event-stream body — `data: <json>` lines. Same.
 *   (c) HTTP 202 Accepted + empty body — server deferred the response to
 *       the SSE side channel. Pass through unchanged. (Composio takes
 *       this path on cold sessions; pre-fix we 502'd here, which made
 *       Hermes retry tools/list in a loop and time out inbox_scan.)
 *
 * Anything we can't parse, we pass through unchanged — a filter glitch
 * shouldn't kill Hermes' MCP session. OAuth scope on the Composio side
 * is the hard guarantee.
 */
export function handleToolsListResponse(
  upstreamText: string,
  upstreamStatus: number,
  provider: string,
): {
  body: string;
  action: 'filtered' | 'deferred' | 'unparseable';
  logMeta: Record<string, unknown>;
} {
  const isEmpty = upstreamText.length === 0 || upstreamText.trim().length === 0;
  const isAccepted = upstreamStatus === 202 || upstreamStatus === 204;
  if (isEmpty || isAccepted) {
    return {
      body: upstreamText,
      action: 'deferred',
      logMeta: { status: upstreamStatus, empty: isEmpty },
    };
  }
  try {
    const filtered = stripWriteTools(upstreamText, provider);
    return { body: filtered, action: 'filtered', logMeta: { status: upstreamStatus } };
  } catch (err) {
    return {
      body: upstreamText,
      action: 'unparseable',
      logMeta: {
        err,
        status: upstreamStatus,
        bodyHead: upstreamText.slice(0, 200),
      },
    };
  }
}

/**
 * Detect a JSON-RPC `tools/list` request. Returns true if the body parses
 * as JSON-RPC and method === 'tools/list'.
 */
function isToolsListRequest(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as { method?: string };
    return parsed?.method === 'tools/list';
  } catch {
    return false;
  }
}

/**
 * Verbs that imply state mutation. If a tool name contains any of these
 * (case-insensitive, surrounded by word boundaries / underscores), it's
 * stripped from the read-only catalog. Generic across providers — Composio
 * uses a consistent VERB-style naming convention.
 */
const WRITE_VERBS = [
  // mail / calendar
  'SEND',
  'CREATE',
  'UPDATE',
  'DELETE',
  'PATCH',
  'REPLY',
  'FORWARD',
  'MOVE',
  'IMPORT',
  'ARCHIVE',
  'TRASH',
  'REMOVE',
  'ADD',
  'INSERT',
  'WRITE',
  'EDIT',
  'CANCEL',
  'ACCEPT',
  'DECLINE',
  'RESPOND',
  'STAR',
  'UNSTAR',
  'LABEL',
  'UNLABEL',
  // v2 — comms / dev / notes / CRM / social
  'ASSIGN',
  'CLOSE',
  'MERGE',
  'APPEND',
  'INVITE',
  'UNINVITE',
  'FOLLOW',
  'UNFOLLOW',
  'MUTE',
  'UNMUTE',
  'BLOCK',
  'UNBLOCK',
  'RETWEET',
  'UPLOAD',
  'PUBLISH',
  'UNPUBLISH',
  'ENABLE',
  'DISABLE',
];
const WRITE_VERB_REGEX = new RegExp(`(^|_)(${WRITE_VERBS.join('|')})(_|$)`, 'i');

function isWriteToolName(name: string): boolean {
  return WRITE_VERB_REGEX.test(name);
}

/**
 * Parse upstream text (either bare JSON or SSE with one JSON event) and
 * strip write-tools from any embedded tools/list result. Returns the
 * re-serialized text in the same wire format. Throws on parse failure
 * (caller logs + 502s).
 */
function stripWriteTools(upstreamText: string, provider: string): string {
  // SSE form: typically a single `data: <json>` line (sometimes preceded
  // by `event: message`). Detect by looking for a `data:` prefix.
  const trimmed = upstreamText.trim();
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const lines = upstreamText.split('\n');
    const rebuilt: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const jsonPart = line.slice(5).trim();
        if (!jsonPart) {
          rebuilt.push(line);
          continue;
        }
        try {
          const obj = JSON.parse(jsonPart) as JsonRpcMessage;
          const filtered = filterToolsInJsonRpc(obj, provider);
          rebuilt.push(`data: ${JSON.stringify(filtered)}`);
        } catch {
          rebuilt.push(line);
        }
      } else {
        rebuilt.push(line);
      }
    }
    return rebuilt.join('\n');
  }

  // Plain JSON.
  const obj = JSON.parse(trimmed) as JsonRpcMessage;
  const filtered = filterToolsInJsonRpc(obj, provider);
  return JSON.stringify(filtered);
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { tools?: { name?: string }[] };
}

function filterToolsInJsonRpc(msg: JsonRpcMessage, provider: string): JsonRpcMessage {
  const tools = msg?.result?.tools;
  if (!Array.isArray(tools)) return msg;
  const kept: { name?: string }[] = [];
  let dropped = 0;
  for (const t of tools) {
    if (t?.name && isWriteToolName(t.name)) {
      dropped++;
      continue;
    }
    kept.push(t);
  }
  if (dropped > 0) {
    logger.info({ provider, kept: kept.length, dropped }, 'mcp_proxy_filtered_write_tools');
  }
  return {
    ...msg,
    result: { ...(msg.result ?? {}), tools: kept },
  };
}

// Two route shapes: with and without a sub-path. Hermes will hit the bare
// URL we hand it; the wildcard form is defense for future MCP variants.
router.all('/v1/mcp/:instanceId/:provider', (c) => forward(c));
router.all('/v1/mcp/:instanceId/:provider/:rest{.*}', (c) => forward(c));

export { router as mcpProxyRouter };
