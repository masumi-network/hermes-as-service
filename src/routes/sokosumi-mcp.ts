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

/**
 * Pull the pending awaiting-input event out of a job's events[]. Sokosumi has
 * no dedicated input-request endpoint — the question and the event id you must
 * answer both live in the job's event log. Defensive: the exact event shape
 * isn't guaranteed, so we match any event whose type/status mentions INPUT and
 * return the newest. Exported for unit tests.
 */
export function extractAwaitingInputEvent(events: unknown): Record<string, unknown> | null {
  if (!Array.isArray(events)) return null;
  // A job's event log keeps BOTH the open request and its later resolution
  // (e.g. type INPUT_REQUEST followed by INPUT_PROVIDED / INPUT_RESPONSE). Match
  // the OPEN request only — never an already-answered event, whose id is useless
  // to provide_job_input and would re-submit against a resolved event.
  const RESOLVED = /PROVIDED|RESPONSE|RECEIVED|RESOLVED|ANSWERED|SUBMITTED|COMPLETED|FULFILLED/;
  const matches = events.filter((e): e is Record<string, unknown> => {
    if (!e || typeof e !== 'object') return false;
    const o = e as Record<string, unknown>;
    const t = String(o['type'] ?? '').toUpperCase();
    const s = String(o['status'] ?? '').toUpperCase();
    if (!(t.includes('INPUT') || s.includes('INPUT'))) return false;
    if (RESOLVED.test(t) || RESOLVED.test(s)) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) =>
    String(b['createdAt'] ?? b['updatedAt'] ?? '').localeCompare(
      String(a['createdAt'] ?? a['updatedAt'] ?? ''),
    ),
  );
  return matches[0] ?? null;
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
    name: 'sokosumi_list_organizations',
    description:
      "List the organizations (shared workspaces) the user belongs to. Each Sokosumi user has a personal workspace plus zero or more organizations (their company, department, team). Tasks in an organization are shared with every member of that org. Returns id, name, and (when available) slug/role for each. Call this when the user asks about their team, when you need to know which workspaces to consider, or when distinguishing personal-vs-shared work matters.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    access: 'read',
    name: 'sokosumi_list_tasks',
    description:
      "List the user's Sokosumi tasks across all orgs they belong to. Returns id, name, status, createdAt for each. Use this to discover what work the user has in flight. Filter by status (e.g. RUNNING, COMPLETED) or search by name substring. With the user's granted workspace access this returns EVERY coworker's tasks in the workspace (not just yours), so it's your board-wide view for coordinating across coworkers — if it comes back access-limited, you're only seeing your own until the user approves your workspace access.",
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
    name: 'sokosumi_get_job_input_request',
    description:
      "For a job paused in AWAITING_INPUT, read the exact pending input request: the event_id you must answer plus the question/fields the agent is asking for. Call this BEFORE sokosumi_provide_job_input, then pass the returned event_id straight through (as event_id) with input_data matching the requested fields. Returns awaitingInput=false if the job isn't actually waiting.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: "Job id (from sokosumi_list_jobs or a task's jobs)." },
      },
      required: ['job_id'],
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
      "Fetch Sokosumi credit balances. CRITICAL: credits are scoped PER WORKSPACE — the user's personal workspace and each organization (e.g. 'utxo AG', 'Serviceplan Group') has its OWN separate balance. A job in Serviceplan Group cannot spend personal credits, and vice versa. Without organization_id this returns balances for personal AND every organization the user belongs to in one response — read the right one for your context. Pass organization_id to scope to a single workspace. Before any sokosumi_create_job, ALWAYS check the balance of the workspace the job will run in, not personal.",
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: {
          type: 'string',
          description:
            'Optional. If set, returns credits for that organization only. Omit to get personal + all orgs at once.',
        },
      },
    },
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
      "List the user's whitelisted Sokosumi coworkers (id, slug, name, caption, capabilities). These are the AI personas — like Hannah, Demos, Elena — that actually DO the work. Tasks get assigned to coworkers; jobs run under their identity. Different from sokosumi_list_agents (which is the marketplace catalog). YOU (Hermes) are NOT in this list — you are the first-party orchestrator, not a coworker, so never try to assign tasks to yourself; you coordinate, the coworkers execute. Call this before sokosumi_create_task so you can pick the right coworker for the work (e.g., research → Hannah, project management → Elena, social media → Pheme).",
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
      "Post a comment on ANY Sokosumi task you can access — including tasks owned by OTHER coworkers (with the user's granted workspace access). Free (no credits). Two main uses: (1) add useful context/background the task creator should know, and (2) ANSWER a coworker's question — when a coworker asks something in a task's events/comments, reply here to unblock them. Don't comment without substance. If it returns PARKED (task_parked) the task is frozen pending the user's approval; if it returns grant-required, the user must approve your workspace access first.",
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
      "Create a new task in a specific workspace and ASSIGN IT TO A COWORKER. FREE — tasks themselves cost zero credits and have NO upfront price; spending only happens later when jobs run under the task. Don't conflate this with sokosumi_create_job (which spends). REQUIRED: coworker_id — call sokosumi_list_coworkers first and pick by specialty (research → Hannah, project mgmt → Elena, social → Pheme, coding → Alex). NEVER assign to Hermes (you're the coordinator). STRONGLY RECOMMENDED: organization_id — coworkers like Hannah and Elena exist in MULTIPLE orgs (utxo AG, Serviceplan Group, etc.) and without organization_id the task lands in whichever org gets enumerated first, which is rarely what the user wants. Read organization_id from sokosumi_list_coworkers' output (each entry is tagged with orgId/orgName) or from sokosumi_list_organizations. When the user names a workspace (\"in utxo AG\", \"for Serviceplan\"), you MUST pass the matching organization_id. Tasks live on the user's board going DRAFT → READY → RUNNING → COMPLETED as the coworker drives jobs underneath.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name, concise.' },
        description: { type: 'string', description: 'Longer description of what needs to be done.' },
        coworker_id: {
          type: 'string',
          description: 'REQUIRED. The Sokosumi coworker who will do the work. Pick from sokosumi_list_coworkers. Must NOT be the Hermes coworker.',
        },
        organization_id: {
          type: ['string', 'null'],
          description: 'Workspace where the task lives. Pass an org id string to file in a shared organization (utxo AG, Serviceplan Group, etc.). Pass `null` (literal JSON null, not the string "null") for the user\'s personal workspace — useful when the work is private. REQUIRED whenever the user names a workspace, and whenever the chosen coworker exists in more than one org (almost always true for Hannah, Elena, Pheme, Alex). Match against orgId from sokosumi_list_coworkers or sokosumi_list_organizations. Omitting this entirely falls back to the first org that has the coworker, which is rarely what the user wants.',
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
      "Fetch the input schema AND the credit price for an agent. Always call this BEFORE sokosumi_create_job — the response tells you (a) exactly what fields the agent needs, and (b) how many credits the job will cost. The price is what makes job spending predictable (tasks don't have prices, jobs do). Use the price to apply cost rules before firing the job.",
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
      "Kick off a Sokosumi agent job. SPENDS CREDITS — and unlike tasks, the price IS known up front via sokosumi_get_agent_input_schema (which returns the per-job credit cost). Always before calling: (1) fetch sokosumi_get_credits for the current balance, (2) fetch sokosumi_get_agent_input_schema for the required inputs AND the credit price, (3) apply your autonomy's cost rules. At MEDIUM, the orchestrator intercepts the call and surfaces a confirmation box — surface the price to the user in chat too. At HIGH, fire autonomously if balance allows AND cost ≤ 25% of balance; refuse if balance would drop below 10 credits; ask first if cost > 25% of balance.",
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
    const t0 = Date.now();
    try {
      const text = await callTool(toolName, args, auth.ctx);
      logger.info(
        {
          toolName,
          instanceId: auth.ctx.instanceId,
          userId: auth.ctx.userId,
          autonomy: auth.ctx.autonomyLevel,
          ms: Date.now() - t0,
          bytes: text.length,
        },
        'sokosumi_mcp_tool_done',
      );
      return rpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      logger.warn(
        { err, toolName, instanceId: auth.ctx.instanceId, ms: Date.now() - t0 },
        'sokosumi_mcp_tool_failed',
      );
      const message = err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: `tool error: ${message}${grantErrorHint(message)}` }],
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
  if (!SokosumiClient.isConfigured(ctx.env, ctx.userId)) {
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
/**
 * Turn a Sokosumi vendor-workspace-grant 403 into guidance Hermes can act on.
 * Sokosumi (PR #3300) gates cross-coworker read/create/comment behind a
 * per-workspace "vendor grant" that a human must approve; the raw 403 body
 * carries an error `kind` we translate here. Appended to the tool-error text.
 */
function grantErrorHint(message: string): string {
  if (message.includes('grant_required')) {
    return ' — ACCESS PENDING: this reached beyond Hermes\' own tasks, so Sokosumi created a request for the user to approve Hermes\' workspace access. Tell the user to approve Hermes under Sokosumi settings → vendor/coworker access, then retry. Do NOT keep retrying blindly.';
  }
  if (message.includes('grant_denied')) {
    return ' — DENIED: the user declined Hermes\' workspace access here. Hermes cannot read/create/comment across other coworkers in this workspace until the user re-grants it. Do not retry; tell the user.';
  }
  if (message.includes('grant_revoked')) {
    return ' — REVOKED: the user revoked Hermes\' workspace access here. Hermes is locked out of cross-coworker actions until re-granted. Do not retry; tell the user.';
  }
  if (message.includes('task_parked')) {
    return ' — PARKED: this task is GRANT_PENDING, frozen until the user approves Hermes\' workspace access. It cannot be commented on, run, or modified yet. Tell the user to approve the pending grant.';
  }
  // Orchestrator-actor limits (Hermes is a first-party orchestrator, not a
  // coworker): it coordinates but doesn't run jobs or use marketplace chat.
  if (message.includes('marketplace conversations')) {
    return ' — Orchestrator can\'t read marketplace conversations. Skip it and coordinate via tasks + task comments instead.';
  }
  if (/\/jobs\b/.test(message) && message.includes('403')) {
    return ' — As the orchestrator you COORDINATE, you don\'t run jobs directly — jobs run under the assigned coworker. Instead of starting a job, create/assign a task to the right coworker (sokosumi_create_task, at READY) and let them run the jobs underneath.';
  }
  return '';
}

/**
 * If a just-created task came back parked (GRANT_PENDING), describe it so
 * Hermes tells the user to approve rather than assuming the coworker started.
 */
function createResultNote(result: unknown): string | undefined {
  const r = result as { status?: string } | null;
  if (r && typeof r === 'object' && r.status === 'GRANT_PENDING') {
    return 'PARKED (GRANT_PENDING): the task was created but is waiting on the user to approve Hermes\' workspace access before the coworker can pick it up. Tell the user to approve the pending grant in Sokosumi — it auto-starts once approved.';
  }
  return undefined;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: InstanceContext,
): Promise<string> {
  const client = new SokosumiClient(ctx.userId, ctx.env);

  switch (name) {
    case 'sokosumi_list_organizations': {
      const orgs = await client.listOrganizations();
      return JSON.stringify({ count: orgs.length, organizations: orgs }, null, 2);
    }

    case 'sokosumi_list_tasks': {
      // Aggregate across orgs in parallel — sequential per-org calls were
      // adding ~500–800ms per extra org for users with multiple workspaces.
      const orgs = await client.listOrganizations();
      const status = typeof args['status'] === 'string' ? (args['status'] as string) : undefined;
      const q = typeof args['q'] === 'string' ? (args['q'] as string).toLowerCase() : undefined;
      const limit = clampNumber(args['limit'], 50, 100);
      const allTasks: Array<{ orgId: string; orgName?: string; task: unknown }> = [];
      const settled = await Promise.allSettled(
        orgs.slice(0, 5).map((org) =>
          client.withOrganization(org.id).listTasks({ limit, scope: 'workspace' }).then((tasks) => ({ org, tasks })),
        ),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          for (const t of r.value.tasks) allTasks.push({ orgId: r.value.org.id, orgName: r.value.org.name, task: t });
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
      // GET /tasks/:id needs an org context; try without first, fall back to
      // racing all orgs in parallel — the first to resolve with a real task
      // wins, the others get cancelled by Promise.any logic.
      try {
        return JSON.stringify(await client.getTask(id), null, 2);
      } catch {
        const orgs = await client.listOrganizations();
        const attempts = orgs.map((org) =>
          client.withOrganization(org.id).getTask(id).then((task) => ({ orgId: org.id, task })),
        );
        try {
          const found = await Promise.any(attempts);
          return JSON.stringify(found, null, 2);
        } catch {
          throw new Error(`task ${id} not found in any org`);
        }
      }
    }

    case 'sokosumi_list_jobs': {
      const orgs = await client.listOrganizations();
      const status = typeof args['status'] === 'string' ? (args['status'] as string) : undefined;
      const agentId = typeof args['agent_id'] === 'string' ? (args['agent_id'] as string) : undefined;
      const limit = clampNumber(args['limit'], 30, 100);
      const all: Array<unknown> = [];
      const settled = await Promise.allSettled(
        orgs.slice(0, 5).map((org) =>
          client.withOrganization(org.id).listJobs({
            status: status as Parameters<SokosumiClient['listJobs']>[0] extends infer P
              ? P extends { status?: infer S }
                ? S
                : never
              : never,
            agentId,
            limit,
          }),
        ),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') for (const j of r.value) all.push(j);
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

    case 'sokosumi_get_job_input_request': {
      const jobId = String(args['job_id'] ?? args['id'] ?? '');
      if (!jobId) throw new Error('missing required arg: job_id');
      // No dedicated Sokosumi endpoint — the pending input request lives in the
      // job's events[] (the same array provide_job_input's event_id comes from).
      const job = (await client.getJob(jobId)) as {
        status?: string;
        events?: unknown;
      };
      const ev = extractAwaitingInputEvent(job?.events);
      return JSON.stringify(
        {
          jobId,
          jobStatus: job?.status ?? null,
          awaitingInput: !!ev,
          eventId: ev && typeof ev['id'] === 'string' ? ev['id'] : null,
          request: ev,
          hint: ev
            ? 'Pass eventId as event_id to sokosumi_provide_job_input, with input_data matching the requested fields.'
            : 'Job is not awaiting input (no awaiting-input event found).',
        },
        null,
        2,
      );
    }

    case 'sokosumi_list_conversations': {
      const limit = clampNumber(args['limit'], 10, 50);
      const convs = await client.listConversations({ limit });
      return JSON.stringify({ count: convs.length, conversations: convs }, null, 2);
    }

    case 'sokosumi_get_credits': {
      const orgIdArg = typeof args['organization_id'] === 'string' ? (args['organization_id'] as string) : undefined;
      if (orgIdArg) {
        const credits = await client.withOrganization(orgIdArg).getCredits();
        return JSON.stringify({ scope: 'organization', organizationId: orgIdArg, credits }, null, 2);
      }
      // Default: personal + every org the user belongs to. Surfacing them
      // all in one shot is the whole point of this tool — agents kept
      // checking personal balance before a job that runs in an org.
      const personalResult = await client.getCredits().then(
        (credits) => ({ ok: true, credits }) as const,
        (err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }) as const,
      );
      const orgs = await client.listOrganizations();
      const settled = await Promise.allSettled(
        orgs.slice(0, 10).map((org) =>
          client
            .withOrganization(org.id)
            .getCredits()
            .then((credits) => ({ org, credits })),
        ),
      );
      const orgsCredits: Array<{ orgId: string; orgName?: string; credits: unknown }> = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          orgsCredits.push({ orgId: r.value.org.id, orgName: r.value.org.name, credits: r.value.credits });
        }
      }
      return JSON.stringify(
        {
          scope: 'all',
          note: 'Credits are per-workspace. Use the balance of the workspace the job will run in — NOT personal — when deciding affordability.',
          personal: personalResult,
          organizations: orgsCredits,
        },
        null,
        2,
      );
    }

    case 'sokosumi_list_agents': {
      const limit = clampNumber(args['limit'], 50, 100);
      const agents = await client.listAgents({ limit });
      return JSON.stringify({ count: agents.length, agents }, null, 2);
    }

    case 'sokosumi_list_coworkers': {
      const limit = clampNumber(args['limit'], 30, 100);
      // Per-org delegation needed — fan out across the user's orgs in parallel.
      const orgs = await client.listOrganizations();
      const all: Array<{ orgId: string; orgName?: string; coworker: unknown }> = [];
      const settled = await Promise.allSettled(
        orgs.slice(0, 5).map((org) =>
          client
            .withOrganization(org.id)
            .listCoworkers({ scope: 'whitelisted', limit })
            .then((coworkers) => ({ org, coworkers })),
        ),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          for (const c of r.value.coworkers) {
            all.push({ orgId: r.value.org.id, orgName: r.value.org.name, coworker: c });
          }
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
      // Three-way: string = a specific org, null = personal scope (no org),
      // undefined = neither specified, fall back to legacy iterate-orgs.
      const rawOrgArg = args['organization_id'];
      const isPersonalScope = rawOrgArg === null;
      const organizationIdArg = typeof rawOrgArg === 'string' ? rawOrgArg : undefined;
      const description = typeof args['description'] === 'string' ? (args['description'] as string) : undefined;
      // Default to READY so the task is visible + startable. DRAFT tasks are
      // invisible to coworkers (Hermes included) after creation, so only use
      // DRAFT when the user explicitly wants a not-yet-started draft.
      const status: 'DRAFT' | 'READY' = args['status'] === 'DRAFT' ? 'DRAFT' : 'READY';

      if (!name) throw new Error('missing required arg: name');
      if (!coworkerId) {
        throw new Error(
          "missing required arg: coworker_id. Tasks must be assigned to a coworker who will do the work. Call sokosumi_list_coworkers first to see who's available, then pick the right one for this task (e.g., research → Hannah, project management → Elena). DO NOT assign tasks to Hermes (slug=hermes) — Hermes is the coordinator, not the executor.",
        );
      }

      // Personal-scope path — explicit null override from Sokosumi's UI
      // dropdown ("Personal" selected). Creates the task without any
      // X-Delegation-Organization-Id header, which Sokosumi treats as
      // the user's private workspace. Coworkers exist in personal scope
      // too (Hannah, Elena, etc.), so we validate the coworker is
      // whitelisted there before firing.
      if (isPersonalScope) {
        const personalCoworkers = (await client.listCoworkers({
          scope: 'whitelisted',
          limit: 50,
        })) as Array<{ id?: string; slug?: string; name?: string }>;
        const match = personalCoworkers.find((c) => c.id === coworkerId);
        if (!match) {
          throw new Error(
            `coworker_id ${coworkerId} is not whitelisted in the user's personal workspace. Call sokosumi_list_coworkers (without organization_id) to see who's available there, or pick an organization to file the task under.`,
          );
        }
        if (match.slug === 'hermes') {
          throw new Error(
            `Refusing to assign task to coworker '${match.name ?? 'Hermes'}' (slug=hermes) — Hermes is the coordinator, not the executor. Pick a different coworker.`,
          );
        }
        const result = await client.createTask({ name, description, status, coworkerId });
        const note = createResultNote(result);
        return JSON.stringify(
          {
            orgId: null,
            scope: 'personal',
            assignedTo: { id: coworkerId, slug: match.slug, name: match.name },
            task: result,
            ...(note ? { note } : {}),
          },
          null,
          2,
        );
      }

      const orgs = await client.listOrganizations();
      if (orgs.length === 0) throw new Error('user has no orgs to create the task in');

      let targetOrgId: string | null = null;
      let coworkerSlug: string | undefined;
      let coworkerName: string | undefined;

      if (organizationIdArg) {
        // Caller specified the org. Validate the coworker exists there
        // before committing — wrong org + valid coworker would silently
        // land the task somewhere else if we skipped this check.
        const targetOrg = orgs.find((o) => o.id === organizationIdArg);
        if (!targetOrg) {
          const known = orgs.map((o) => `${o.name ?? '?'} (${o.id})`).join(', ');
          throw new Error(
            `organization_id ${organizationIdArg} is not one of the user's orgs. The user belongs to: ${known}. Pick one and retry.`,
          );
        }
        try {
          const list = (await client
            .withOrganization(targetOrg.id)
            .listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
            id?: string;
            slug?: string;
            name?: string;
          }>;
          const match = list.find((c) => c.id === coworkerId);
          if (!match) {
            throw new Error(
              `coworker_id ${coworkerId} is not whitelisted in organization "${targetOrg.name ?? targetOrg.id}". Call sokosumi_list_coworkers and pick a coworker that exists in that org.`,
            );
          }
          targetOrgId = targetOrg.id;
          coworkerSlug = match.slug;
          coworkerName = match.name;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('coworker_id ')) throw err;
          throw new Error(
            `failed to verify coworker ${coworkerId} in org ${organizationIdArg}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        // Legacy fallback: iterate orgs, take the first match. Hermes is
        // strongly nudged in the tool description NOT to rely on this —
        // it produces wrong-org tasks for users with multi-org coworkers.
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
      const note = createResultNote(result);
      return JSON.stringify(
        {
          orgId: targetOrgId,
          assignedTo: { id: coworkerId, slug: coworkerSlug, name: coworkerName },
          task: result,
          ...(note ? { note } : {}),
        },
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
