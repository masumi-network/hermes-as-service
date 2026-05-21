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

export interface InstanceContext {
  instanceId: string;
  userId: string;
  env: SokosumiEnv | null;
  autonomyLevel: 'low' | 'medium' | 'high';
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
  const autonomyLevel =
    row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  return {
    ok: true,
    ctx: { instanceId: row.id, userId: row.userId, env, autonomyLevel },
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- MCP tool catalog ----------
// Each tool tagged with the minimum autonomy required:
//   read    — available at all autonomy levels
//   write   — requires medium or high
//   spend   — requires medium or high (Hermes asks first at medium, fires
//             autonomously at high). Costs Sokosumi credits.
type ToolAccess = 'read' | 'write' | 'spend';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  access: ToolAccess;
}

const TOOLS_ALL: ToolDef[] = [
  {
    access: 'read',
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
    access: 'read',
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
    access: 'read',
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
    access: 'read',
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
    access: 'read',
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
    access: 'read',
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
    access: 'read',
    name: 'sokosumi_get_credits',
    description:
      "Fetch the user's current Sokosumi credit balance. Use before suggesting expensive paid agent jobs.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    access: 'read',
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
  {
    access: 'read',
    name: 'sokosumi_list_coworkers',
    description:
      "List the user's whitelisted Sokosumi coworkers (id, slug, name, caption, capabilities). These are the AI personas — like Hannah, Demos, Elena — that actually DO the work. Tasks get assigned to coworkers; jobs run under their identity. Different from sokosumi_list_agents (which is the marketplace catalog). YOU (Hermes) are one of them, with slug=hermes — but never assign tasks to yourself; you're the coordinator, not the executor. Call this before sokosumi_create_task so you can pick the right coworker for the work (e.g., research → Hannah, project management → Elena, social media → Pheme).",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 30, max 100).' },
      },
    },
  },
  // ---------- write tools (medium + high autonomy) ----------
  {
    access: 'write',
    name: 'sokosumi_add_task_comment',
    description:
      "Post a comment on a Sokosumi task to add context, observations, or supporting info. Free (no credits). Use this when you have useful background (relevant emails, prior research, important context) the task creator might want to know. Don't comment unless you actually have substance to add.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id.' },
        comment: { type: 'string', description: 'Your comment, 1-3 short paragraphs.' },
      },
      required: ['task_id', 'comment'],
    },
  },
  {
    access: 'write',
    name: 'sokosumi_create_task',
    description:
      "Create a new task in the user's workspace and ASSIGN IT TO A COWORKER who will actually do the work. Free (only jobs run under the task cost credits). REQUIRED: coworker_id — call sokosumi_list_coworkers first to see who's available and pick the appropriate one based on the work (research → Hannah, project management → Elena, social media → Pheme, coding → Alex, etc.). NEVER assign a task to Hermes (you) — you're the coordinator. NEVER omit coworker_id — an unassigned task is dead on arrival. Tasks then live on the user's Sokosumi taskboard; the assigned coworker drives them through DRAFT → READY → RUNNING → COMPLETED via agent jobs over time.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name, concise.' },
        description: { type: 'string', description: 'Longer description of what needs to be done.' },
        coworker_id: {
          type: 'string',
          description: 'REQUIRED. The Sokosumi coworker who will do the work. Pick from sokosumi_list_coworkers. Must NOT be the Hermes coworker.',
        },
        status: {
          type: 'string',
          enum: ['DRAFT', 'READY'],
          description: 'Initial status. DRAFT for in-progress drafting, READY for finalized and ready for the coworker to pick up.',
        },
      },
      required: ['name', 'coworker_id'],
    },
  },
  {
    access: 'read',
    name: 'sokosumi_get_agent_input_schema',
    description:
      "Fetch the input schema an agent needs before kicking off a job. Always call this BEFORE sokosumi_create_job so you know what fields the agent requires.",
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'Agent id.' } },
      required: ['agent_id'],
    },
  },
  {
    access: 'spend',
    name: 'sokosumi_create_job',
    description:
      "Kick off a Sokosumi agent job. SPENDS CREDITS. Before calling: (1) fetch sokosumi_get_credits to know the balance, (2) fetch sokosumi_get_agent_input_schema to know required inputs, (3) verify the user's autonomy level allows it. At MEDIUM autonomy, you MUST ask the user for explicit confirmation in chat ('I'd like to run agent X for ~N credits — confirm?') and only call this tool after they reply affirmatively. At HIGH autonomy, you may fire autonomously but still warn if the cost exceeds 25% of the user's balance.",
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The Sokosumi agent to run.' },
        input_schema: {
          type: 'object',
          description: 'The input payload, matching the agent_input_schema you just fetched.',
        },
        task_id: {
          type: 'string',
          description: 'Optional task id to attach this job to.',
        },
      },
      required: ['agent_id', 'input_schema'],
    },
  },
  {
    access: 'write',
    name: 'sokosumi_provide_job_input',
    description:
      "Provide additional input for a job that's in AWAITING_INPUT state. First find the job via sokosumi_get_job, locate the awaiting-input event in its events[] array, use that event's id. Then submit inputData matching what the event requested.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id.' },
        event_id: { type: 'string', description: 'The awaiting-input event id.' },
        input_data: { type: 'object', description: 'Key-value input the event requested.' },
      },
      required: ['job_id', 'event_id', 'input_data'],
    },
  },
  {
    access: 'write',
    name: 'sokosumi_refund_job',
    description:
      "Request a refund for a FAILED job. Sokosumi processes the refund based on whether the failure was eligible. Use this when a job has clearly failed due to the agent or platform side (not user input).",
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id.' } },
      required: ['job_id'],
    },
  },
];

/**
 * Filter the tool catalog by the instance's autonomy level. Read tools
 * always exposed; write tools at medium + high; spend tools at medium +
 * high (medium is gated by SOUL.md rules at the prompt layer, not here).
 */
function toolsForAutonomy(level: 'low' | 'medium' | 'high'): ToolDef[] {
  if (level === 'low') return TOOLS_ALL.filter((t) => t.access === 'read');
  // medium + high get everything; gating between them is handled by SOUL.md
  // rules ("ask first" at medium, "go" at high).
  return TOOLS_ALL;
}

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
    const available = toolsForAutonomy(auth.ctx.autonomyLevel).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return rpcResult(id, { tools: available });
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

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: InstanceContext,
): Promise<string> {
  if (!SokosumiClient.isConfigured(ctx.env)) {
    return JSON.stringify({
      error: `Sokosumi env '${ctx.env ?? 'mainnet'}' not configured on the orchestrator`,
    });
  }

  // Autonomy enforcement: if the user is on LOW, refuse any write/spend
  // call even if Hermes somehow tries. tools/list already filtered them
  // out but this is belt-and-suspenders.
  const toolDef = TOOLS_ALL.find((t) => t.name === name);
  if (toolDef && toolDef.access !== 'read' && ctx.autonomyLevel === 'low') {
    return JSON.stringify({
      error: `Tool '${name}' is not available at autonomy level 'low'. Ask the user to raise their autonomy setting in Sokosumi if they want this action.`,
    });
  }

  // MEDIUM autonomy: write + spend tools don't execute. Instead, we
  // record a PendingConfirmation row and return a structured response so
  // Hermes can tell the user to approve in the Sokosumi UI's
  // confirmation box. Sokosumi posts /approve or /reject back to the
  // orchestrator; on approve, the orchestrator replays this same tool
  // call with the stored args and pushes the result to Hermes via the
  // outbox.
  if (toolDef && toolDef.access !== 'read' && ctx.autonomyLevel === 'medium') {
    const { createPendingConfirmation, summarizeToolCall } = await import('../confirmations/store.js');
    const summary = await summarizeToolCall(name, args, ctx);
    const pending = await createPendingConfirmation({
      instanceId: ctx.instanceId,
      userId: ctx.userId,
      toolName: name,
      toolArgs: args,
      summary,
    });
    return JSON.stringify({
      status: 'pending_confirmation',
      confirmation_id: pending.id,
      message: `User approval required. The Sokosumi UI is showing a confirmation box for this action with summary: "${summary}". Tell the user in chat what you're proposing in plain language and stop — do not retry this tool. When they approve or reject in the UI, you'll receive a follow-up message with the outcome.`,
    });
  }

  return executeTool(name, args, ctx);
}

/**
 * Executes a tool against Sokosumi WITHOUT autonomy gating. Reused by the
 * confirmation-approval flow (orchestrator-internal, no Hermes turn) so
 * we don't have to duplicate per-tool logic.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: InstanceContext,
): Promise<string> {
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

    case 'sokosumi_list_coworkers': {
      const limit = clampNumber(args['limit'], 30, 100);
      // Per-org delegation needed — iterate user's orgs.
      const orgs = await client.listOrganizations();
      const all: Array<{ orgId: string; orgName?: string; coworker: unknown }> = [];
      for (const org of orgs.slice(0, 5)) {
        try {
          const coworkers = await client
            .withOrganization(org.id)
            .listCoworkers({ scope: 'whitelisted', limit });
          for (const c of coworkers) all.push({ orgId: org.id, orgName: org.name, coworker: c });
        } catch {
          /* tolerate per-org failures */
        }
      }
      return JSON.stringify({ count: all.length, coworkers: all }, null, 2);
    }

    // ---------- write tools ----------

    case 'sokosumi_add_task_comment': {
      const taskId = String(args['task_id'] ?? '');
      const comment = String(args['comment'] ?? '');
      if (!taskId || !comment) throw new Error('missing required args: task_id, comment');
      // Try the user's first org; if it fails, iterate orgs to find the task.
      try {
        const result = await client.addTaskEvent(taskId, { comment });
        return JSON.stringify(result, null, 2);
      } catch {
        const orgs = await client.listOrganizations();
        for (const org of orgs) {
          try {
            const result = await client.withOrganization(org.id).addTaskEvent(taskId, { comment });
            return JSON.stringify({ orgId: org.id, result }, null, 2);
          } catch {
            /* try next */
          }
        }
        throw new Error(`task ${taskId} not found in any org`);
      }
    }

    case 'sokosumi_create_task': {
      const name = String(args['name'] ?? '');
      const coworkerId = String(args['coworker_id'] ?? '');
      const description = typeof args['description'] === 'string' ? (args['description'] as string) : undefined;
      const status = typeof args['status'] === 'string' ? (args['status'] as 'DRAFT' | 'READY') : undefined;

      if (!name) throw new Error('missing required arg: name');
      if (!coworkerId) {
        throw new Error(
          "missing required arg: coworker_id. Tasks must be assigned to a coworker who will do the work. Call sokosumi_list_coworkers first to see who's available, then pick the right one for this task (e.g., research → Hannah, project management → Elena). DO NOT assign tasks to Hermes (slug=hermes) — Hermes is the coordinator, not the executor.",
        );
      }

      // Find which org this coworker belongs to. We iterate user's orgs
      // looking for the coworker; create the task in the matching org.
      const orgs = await client.listOrganizations();
      if (orgs.length === 0) throw new Error('user has no orgs to create the task in');

      let targetOrgId: string | null = null;
      let coworkerSlug: string | undefined;
      let coworkerName: string | undefined;
      for (const org of orgs.slice(0, 5)) {
        try {
          const list = (await client.withOrganization(org.id).listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
            id?: string;
            slug?: string;
            name?: string;
          }>;
          const match = list.find((c) => c.id === coworkerId);
          if (match) {
            targetOrgId = org.id;
            coworkerSlug = match.slug;
            coworkerName = match.name;
            break;
          }
        } catch {
          /* try next org */
        }
      }
      if (!targetOrgId) {
        throw new Error(
          `coworker_id ${coworkerId} not found in any of the user's orgs. Call sokosumi_list_coworkers to see available coworkers.`,
        );
      }
      // Refuse self-assignment to the Hermes coworker — Hermes coordinates,
      // doesn't execute. Sokosumi may attribute jobs to Hermes if the user
      // explicitly chats with Hermes, but tasks shouldn't be dumped onto it.
      if (coworkerSlug === 'hermes') {
        throw new Error(
          `Refusing to assign task to coworker '${coworkerName}' (slug=hermes) — Hermes is the coordinator, not the executor. Pick a different coworker via sokosumi_list_coworkers based on what the task actually needs (research → Hannah, project management → Elena, social media → Pheme, etc.).`,
        );
      }

      const result = await client.withOrganization(targetOrgId).createTask({
        name,
        description,
        status,
        coworkerId,
      });
      return JSON.stringify(
        { orgId: targetOrgId, assignedTo: { id: coworkerId, slug: coworkerSlug, name: coworkerName }, task: result },
        null,
        2,
      );
    }

    case 'sokosumi_get_agent_input_schema': {
      const agentId = String(args['agent_id'] ?? '');
      if (!agentId) throw new Error('missing required arg: agent_id');
      const schema = await client.getAgentInputSchema(agentId);
      return JSON.stringify(schema, null, 2);
    }

    case 'sokosumi_create_job': {
      const agentId = String(args['agent_id'] ?? '');
      const inputSchema = args['input_schema'];
      const taskId = typeof args['task_id'] === 'string' ? (args['task_id'] as string) : undefined;
      if (!agentId || !inputSchema) {
        throw new Error('missing required args: agent_id, input_schema');
      }
      const orgs = await client.listOrganizations();
      if (orgs.length === 0) throw new Error('user has no orgs to create the job in');
      const result = await client
        .withOrganization(orgs[0]!.id)
        .createJob({ agentId, inputSchema, taskId });
      return JSON.stringify({ orgId: orgs[0]!.id, job: result }, null, 2);
    }

    case 'sokosumi_provide_job_input': {
      const jobId = String(args['job_id'] ?? '');
      const eventId = String(args['event_id'] ?? '');
      const inputData = args['input_data'];
      if (!jobId || !eventId || !inputData || typeof inputData !== 'object') {
        throw new Error('missing required args: job_id, event_id, input_data');
      }
      const result = await client.provideJobInput({
        jobId,
        eventId,
        inputData: inputData as Record<string, unknown>,
      });
      return JSON.stringify(result, null, 2);
    }

    case 'sokosumi_refund_job': {
      const jobId = String(args['job_id'] ?? '');
      if (!jobId) throw new Error('missing required arg: job_id');
      const result = await client.refundJob(jobId);
      return JSON.stringify(result, null, 2);
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
