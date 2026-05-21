import { Hono } from 'hono';
import type { Context } from 'hono';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';

/**
 * Per-instance Sokosumi MCP server.
 *
 * Auto-injected into every Hermes machine's MCP_SERVERS_JSON at provision
 * time (see integrations/manager.ts:buildMcpServersJsonForUser). Gives
 * Hermes 8 tools to query the user's Sokosumi workspace live mid-chat —
 * the cached snapshot in memory handles the digest, these tools handle
 * the drilldown.
 *
 * Auth model: same as the Composio proxy — Hermes presents the
 * per-instance bearer (llmProxyToken); we look up the instance; we use
 * the orchestrator's Sokosumi coworker API key (held in Railway env)
 * with delegation headers for the actual API calls. Sokosumi credentials
 * never land on a Hermes machine.
 *
 * Protocol: MCP streamable_http transport with JSON-RPC 2.0 messages.
 * Supports: initialize, tools/list, tools/call.
 */
const router = new Hono();

const MCP_PROTOCOL_VERSION = '2025-06-18';

interface InstanceContext {
  instanceId: string;
  userId: string;
  env: SokosumiEnv | null;
}

interface AuthOk {
  ok: true;
  ctx: InstanceContext;
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
  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  return { ok: true, ctx: { instanceId: row.id, userId: row.userId, env } };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- MCP tool catalog ----------

const TOOLS = [
  {
    name: 'sokosumi_list_tasks',
    description:
      "List the user's Sokosumi tasks across all orgs they belong to. Returns id, name, status, createdAt for each. Use this to discover what work the user has in flight. Filter by status (e.g. RUNNING, COMPLETED) or search by name substring.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional status filter (DRAFT, READY, INPUT_REQUIRED, RUNNING, COMPLETED, CANCELED).',
        },
        q: { type: 'string', description: 'Optional case-insensitive name substring filter.' },
        limit: { type: 'number', description: 'Max results (default 50, max 100).' },
      },
    },
  },
  {
    name: 'sokosumi_get_task',
    description:
      'Fetch a single Sokosumi task by id. Returns the full body: description, status, embedded jobs[], events[], coworker assignment. Use when the user references a specific task and you need the full context.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id (e.g. tsk_abc or a UUID).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sokosumi_list_jobs',
    description:
      "List the user's Sokosumi agent jobs across all orgs. Returns id, name, agentId, status, completedAt, short result snippet. Filter by status (COMPLETED for finished work) or agentId.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description:
            'Optional status filter (INITIATED, AWAITING_PAYMENT, AWAITING_INPUT, RUNNING, COMPLETED, FAILED).',
        },
        agent_id: { type: 'string', description: 'Optional Sokosumi agent id filter.' },
        limit: { type: 'number', description: 'Max results (default 30, max 100).' },
      },
    },
  },
  {
    name: 'sokosumi_get_job',
    description:
      "Fetch a single Sokosumi job by id and return its FULL markdown result text (no truncation). Use this when the user asks 'what was the result of X?' — gives you the complete output to summarize, quote, or act on.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sokosumi_get_job_files',
    description:
      'List file attachments on a Sokosumi job (id, filename, mimeType, size, downloadUrl). Use when a job produced artifacts the user may want to reference.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'sokosumi_list_conversations',
    description:
      "List the user's chat conversations with other Sokosumi coworkers (not with you). Returns id, title, coworker. Useful for cross-referencing what they've been discussing with other agents.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10, max 50).' },
      },
    },
  },
  {
    name: 'sokosumi_get_credits',
    description:
      "Fetch the user's current Sokosumi credit balance. Use before suggesting expensive paid agent jobs.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sokosumi_list_agents',
    description:
      'List Sokosumi agents available to the user (id, name, summary, price in credits). Use to suggest which agent fits a given task or recommend new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 50, max 100).' },
      },
    },
  },
];

// ---------- JSON-RPC dispatch ----------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null | undefined, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function handle(c: Context): Promise<Response> {
  const instanceId = c.req.param('instanceId') ?? '';
  if (!instanceId) {
    return rpcError(null, -32600, 'missing instanceId');
  }
  const auth = await authenticate(instanceId, c.req.header('Authorization'));
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: { message: auth.message } }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let req: JsonRpcRequest;
  try {
    req = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, 'parse error');
  }
  const { id, method, params } = req;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'sokosumi', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized') {
    // No-op; standard MCP lifecycle ping after initialize.
    return new Response('', { status: 204 });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = (params?.['name'] as string) ?? '';
    const args = (params?.['arguments'] as Record<string, unknown>) ?? {};
    try {
      const text = await callTool(toolName, args, auth.ctx);
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      logger.warn({ err, toolName, instanceId: auth.ctx.instanceId }, 'sokosumi_mcp_tool_failed');
      const message = err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: `tool error: ${message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: InstanceContext,
): Promise<string> {
  if (!SokosumiClient.isConfigured(ctx.env)) {
    return JSON.stringify({
      error: `Sokosumi env '${ctx.env ?? 'mainnet'}' not configured on the orchestrator`,
    });
  }

  const client = new SokosumiClient(ctx.userId, ctx.env);

  switch (name) {
    case 'sokosumi_list_tasks': {
      // Aggregate across orgs.
      const orgs = await client.listOrganizations();
      const status = typeof args['status'] === 'string' ? (args['status'] as string) : undefined;
      const q = typeof args['q'] === 'string' ? (args['q'] as string).toLowerCase() : undefined;
      const limit = clampNumber(args['limit'], 50, 100);
      const allTasks: Array<{ orgId: string; orgName?: string; task: unknown }> = [];
      for (const org of orgs.slice(0, 5)) {
        try {
          const tasks = await client.withOrganization(org.id).listTasks({ limit, scope: 'workspace' });
          for (const t of tasks) allTasks.push({ orgId: org.id, orgName: org.name, task: t });
        } catch {
          /* per-org failures are tolerated */
        }
      }
      let filtered = allTasks;
      if (status) {
        filtered = filtered.filter(
          (x) => (x.task as { status?: string })?.status?.toUpperCase() === status.toUpperCase(),
        );
      }
      if (q) {
        filtered = filtered.filter((x) =>
          ((x.task as { name?: string })?.name ?? '').toLowerCase().includes(q),
        );
      }
      return JSON.stringify({ count: filtered.length, tasks: filtered.slice(0, limit) }, null, 2);
    }

    case 'sokosumi_get_task': {
      const id = String(args['id'] ?? '');
      if (!id) throw new Error('missing required arg: id');
      // GET /tasks/:id needs an org context; try without first, fall back to iterating orgs.
      try {
        return JSON.stringify(await client.getTask(id), null, 2);
      } catch {
        const orgs = await client.listOrganizations();
        for (const org of orgs) {
          try {
            const task = await client.withOrganization(org.id).getTask(id);
            return JSON.stringify({ orgId: org.id, task }, null, 2);
          } catch {
            /* try next */
          }
        }
        throw new Error(`task ${id} not found in any org`);
      }
    }

    case 'sokosumi_list_jobs': {
      const orgs = await client.listOrganizations();
      const status = typeof args['status'] === 'string' ? (args['status'] as string) : undefined;
      const agentId = typeof args['agent_id'] === 'string' ? (args['agent_id'] as string) : undefined;
      const limit = clampNumber(args['limit'], 30, 100);
      const all: Array<unknown> = [];
      for (const org of orgs.slice(0, 5)) {
        try {
          const jobs = await client.withOrganization(org.id).listJobs({
            status: status as Parameters<SokosumiClient['listJobs']>[0] extends infer P
              ? P extends { status?: infer S }
                ? S
                : never
              : never,
            agentId,
            limit,
          });
          for (const j of jobs) all.push(j);
        } catch {
          /* tolerate per-org failure */
        }
      }
      return JSON.stringify({ count: all.length, jobs: all.slice(0, limit) }, null, 2);
    }

    case 'sokosumi_get_job': {
      const id = String(args['id'] ?? '');
      if (!id) throw new Error('missing required arg: id');
      const job = await client.getJob(id);
      // Full markdown result, no truncation — this is the explicit value-add
      // over the cached snapshot.
      return JSON.stringify(job, null, 2);
    }

    case 'sokosumi_get_job_files': {
      const id = String(args['id'] ?? '');
      if (!id) throw new Error('missing required arg: id');
      const files = await client.getJobFiles(id);
      return JSON.stringify({ count: files.length, files }, null, 2);
    }

    case 'sokosumi_list_conversations': {
      const limit = clampNumber(args['limit'], 10, 50);
      const convs = await client.listConversations({ limit });
      return JSON.stringify({ count: convs.length, conversations: convs }, null, 2);
    }

    case 'sokosumi_get_credits': {
      const credits = await client.getCredits();
      return JSON.stringify(credits, null, 2);
    }

    case 'sokosumi_list_agents': {
      const limit = clampNumber(args['limit'], 50, 100);
      const agents = await client.listAgents({ limit });
      return JSON.stringify({ count: agents.length, agents }, null, 2);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function clampNumber(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// Route — POST is the standard MCP transport. Also accept GET so a
// browser/curl probe doesn't 404.
router.all('/v1/sokosumi-mcp/:instanceId', (c) => handle(c));

export { router as sokosumiMcpRouter };
