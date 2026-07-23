import { getSokosumiConfig, type SokosumiEnv } from '../config.js';
import { logger } from '../logger.js';

/**
 * Test-fixture overrides: when a user provisions via Sokosumi's local-dev
 * environment, their userId belongs to a local DB that doesn't exist in
 * preprod or mainnet. To run an end-to-end sokosumi_sync test against
 * preprod or mainnet, we substitute BOTH the delegation userId AND the
 * env so every Sokosumi call is rerouted, not just the X-Delegation-User-Id
 * header. Other paths (instance row, integrations, inbox endpoints) still
 * use the original userId — only the SokosumiClient sees the redirect.
 *
 * Per-incoming-env mapping. Use the wildcard `*` to redirect from any
 * incoming env (e.g. when Sokosumi's UI provisioned the user on `development`
 * but we want every call to land in `preprod`).
 *
 * Strictly for known test fixtures. Real users should use a userId that
 * exists in the env they declare.
 */
type SokosumiTarget = { userId: string; env?: SokosumiEnv };
const SOKOSUMI_OVERRIDES: Record<
  string,
  Partial<Record<SokosumiEnv | '*', SokosumiTarget>>
> = {
  // Patrick (patrick@nmkr.io). Sokosumi's dev UI mints userId
  // `019e1de5-...`; every Sokosumi call from this user should land in
  // preprod under his real userId regardless of which env Sokosumi UI
  // provisioned the orchestrator with.
  '019e1de5-1c27-711b-9918-da5b601d48b1': {
    '*': { userId: '993Sp1dOvyn4CFCEHIQPu1vn4ZVI0Dh4', env: 'preprod' },
  },
};

/**
 * Sokosumi's v1 API wraps single-resource responses in {data: ...}. We
 * unwrap consistently so downstream consumers (orchestrator outbox →
 * Sokosumi UI parsers) see `id` at the top level. Mirrors the existing
 * unwrap in getJob; centralised here to avoid drift across endpoints.
 */
export function unwrapData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export function resolveSokosumiTarget(
  rawUserId: string,
  rawEnv: SokosumiEnv | null | undefined,
): { userId: string; env: SokosumiEnv | null | undefined } {
  const map = SOKOSUMI_OVERRIDES[rawUserId];
  if (!map) return { userId: rawUserId, env: rawEnv };
  const incoming: SokosumiEnv = rawEnv ?? 'mainnet';
  const target = map[incoming] ?? map['*'];
  if (!target) return { userId: rawUserId, env: rawEnv };
  return { userId: target.userId, env: target.env ?? rawEnv };
}

/**
 * Purge Sokosumi's local mirror of a Hermes instance (chat history, assistant
 * name, orb avatar, poll cursors) after an orchestrator-side destroy.
 *
 * Sokosumi no longer infers deletion from a 404 (one wrong 404 would wipe a
 * user's history), so we must tell it explicitly whenever WE delete an instance
 * through a path that isn't a request from Sokosumi itself (admin/manual, test
 * cleanup, future GC/expiry). Sokosumi-initiated deletes clean up on their side.
 *
 * Contract (Sokosumi #3371 — per-user hermes instance as orchestrator):
 * POST {base}/v1/orchestrators/me/purge, auth = the orchestrator SERVICE
 * token (Bearer), JSON body {userId}, NO X-Context headers, env-routed.
 * 200 → {purged:true,userId} (archives the per-user orchestrator row);
 * 503 is explicitly retry-safe.
 *
 * Best-effort: never throws into the destroy caller. Needs the service token
 * for the instance's env (coworker keys are rejected) — logs + skips otherwise.
 */
export async function purgeSokosumiMirror(
  rawUserId: string,
  rawEnv: string | null | undefined,
): Promise<void> {
  const { userId, env } = resolveSokosumiTarget(rawUserId, rawEnv as SokosumiEnv | null | undefined);
  const cfg = getSokosumiConfig(env);
  if (!cfg) {
    logger.warn({ userId, env: env ?? 'mainnet' }, 'sokosumi_purge_skipped_unconfigured');
    return;
  }
  if (cfg.actor !== 'orchestrator') {
    // The purge endpoint rejects coworker keys — it needs the service token.
    logger.warn({ userId, env: env ?? 'mainnet' }, 'sokosumi_purge_skipped_no_orch_key');
    return;
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/orchestrators/me/purge`;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        // The user is identified by the BODY now, not the path.
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        logger.info({ userId, env: env ?? 'mainnet', attempt }, 'sokosumi_mirror_purged');
        return;
      }
      const body = await res.text().catch(() => '');
      if (res.status < 500) {
        // 4xx (e.g. 403 wrong-key, 400) is not retryable — log and stop.
        logger.warn(
          { userId, status: res.status, body: body.slice(0, 200) },
          'sokosumi_purge_rejected',
        );
        return;
      }
      logger.warn({ userId, status: res.status, attempt }, 'sokosumi_purge_5xx_retrying');
    } catch (err) {
      logger.warn({ err, userId, attempt }, 'sokosumi_purge_error_retrying');
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 1000)); // 1s, 2s backoff
    }
  }
  logger.error({ userId, env: env ?? 'mainnet' }, 'sokosumi_purge_failed_after_retries');
}

/**
 * Thin client for Sokosumi's v1 API.
 *
 * Auth model: one org-wide coworker API key (held in Railway env), plus
 * `X-Delegation-User-Id` header that scopes each call to a specific end
 * user. No per-user OAuth needed.
 *
 * Used by:
 *   - sokosumi_sync onboarding step (pulls workspace state into Hermes memory)
 *   - daily recurring sync (refreshes memory once/day per user)
 *
 * Methods only cover the read endpoints we actually use. Write endpoints
 * (POST /tasks, POST /agents/:id/jobs, etc.) intentionally absent — those
 * land in Phase C with a user-consent flow.
 */

/**
 * A workspace the orchestrator can read. `id: null` is the user's personal
 * workspace — reachable with no org header, and the only scope guaranteed to
 * survive the loss of org enumeration (Sokosumi #3394).
 */
export interface WorkspaceScope {
  id: string | null;
  name?: string;
  slug?: string;
}

/**
 * True when a request failed because it hit `/v1/users/{id}/*`, which
 * Sokosumi #3394 ("block coworker impersonation via user context") made
 * session-only: `requireAccessToTargetUserData` now calls
 * `requireUserAuthContext`, so our orchestrator service token is rejected
 * regardless of the context headers. Not our bug and not fixable from here —
 * org enumeration and credits are simply gone until Sokosumi reopens them.
 */
function isUserPathForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('403') && msg.includes('User authentication required');
}

export class SokosumiClient {
  private readonly userId: string;
  private readonly env: SokosumiEnv | null | undefined;
  constructor(
    rawUserId: string,
    rawEnv: SokosumiEnv | null | undefined,
    private readonly organizationId?: string,
  ) {
    const resolved = resolveSokosumiTarget(rawUserId, rawEnv);
    this.userId = resolved.userId;
    this.env = resolved.env;
    if (this.userId !== rawUserId || this.env !== rawEnv) {
      logger.info(
        {
          rawUserId,
          rawEnv,
          effectiveUserId: this.userId,
          effectiveEnv: this.env,
        },
        'sokosumi_override_applied',
      );
    }
  }

  /** Returns true if a coworker API key + base URL are configured for the
   *  given user + env combo (after applying any per-user overrides).
   *  Callers should pass the same userId they'll later instantiate the
   *  client with, since the override can redirect env. */
  static isConfigured(
    env: SokosumiEnv | null | undefined,
    userId?: string,
  ): boolean {
    const effectiveEnv = userId ? resolveSokosumiTarget(userId, env).env : env;
    return Boolean(getSokosumiConfig(effectiveEnv));
  }

  // ---------- tasks ----------

  async listTasks(opts: { limit?: number; scope?: 'workspace' | 'owned' } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 100));
    if (opts.scope) qs.set('scope', opts.scope);
    const body = await this.get<{ items?: unknown[]; tasks?: unknown[]; data?: unknown[] }>(
      `/tasks?${qs}`,
    );
    return body.items ?? body.tasks ?? body.data ?? [];
  }

  // ---------- jobs ----------

  async listJobs(opts: {
    status?: 'INITIATED' | 'AWAITING_PAYMENT' | 'AWAITING_INPUT' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    agentId?: string;
    limit?: number;
    scope?: 'workspace' | 'owned';
  } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.agentId) qs.set('agentId', opts.agentId);
    qs.set('limit', String(opts.limit ?? 50));
    if (opts.scope) qs.set('scope', opts.scope);
    const body = await this.get<{ items?: unknown[]; jobs?: unknown[]; data?: unknown[] }>(
      `/jobs?${qs}`,
    );
    return body.items ?? body.jobs ?? body.data ?? [];
  }

  async getJob(id: string): Promise<unknown> {
    const body = await this.get<{ data?: unknown } | unknown>(
      `/jobs/${encodeURIComponent(id)}`,
    );
    // Sokosumi wraps single-resource responses in {data: ...}.
    if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
      return (body as { data: unknown }).data;
    }
    return body;
  }

  async getTask(id: string): Promise<unknown> {
    const body = await this.get<{ data?: unknown } | unknown>(
      `/tasks/${encodeURIComponent(id)}`,
    );
    if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
      return (body as { data: unknown }).data;
    }
    return body;
  }

  async getJobFiles(id: string): Promise<unknown[]> {
    const body = await this.get<{ items?: unknown[]; files?: unknown[]; data?: unknown[] }>(
      `/jobs/${encodeURIComponent(id)}/files`,
    );
    return body.items ?? body.files ?? body.data ?? [];
  }

  async getAgentInputSchema(agentId: string): Promise<unknown> {
    const body = await this.get<{ data?: unknown } | unknown>(
      `/agents/${encodeURIComponent(agentId)}/input-schema`,
    );
    if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
      return (body as { data: unknown }).data;
    }
    return body;
  }

  // ---------- writes ----------

  /**
   * Post a comment (and/or status transition) on a task. Sokosumi calls
   * these "events" — same row holds both. Hermes uses this for the
   * task-augmentation flow (HIGH autonomy) and ad-hoc commenting.
   */
  async addTaskEvent(taskId: string, args: { status?: string; comment?: string }): Promise<unknown> {
    return unwrapData(await this.post(`/tasks/${encodeURIComponent(taskId)}/events`, args));
  }

  /** Create a new task. Free — only the jobs spawned under it cost credits.
   *  Sokosumi wraps POST /tasks responses in {data: {...}} like most v1
   *  endpoints. We unwrap so downstream consumers (orchestrator outbox →
   *  Sokosumi UI TaskCard parser) see `id` at the top level instead of
   *  `data.id`. Without this unwrap the UI rendered /tasks/undefined → 404. */
  async createTask(args: {
    name: string;
    description?: string | null;
    coworkerId?: string | null;
    status?: 'DRAFT' | 'READY';
  }): Promise<unknown> {
    return unwrapData(await this.post('/tasks', args));
  }

  /**
   * Kick off an agent job. COSTS CREDITS. Caller (Hermes) is responsible
   * for cost-awareness checks per SOUL.md rules — orchestrator does not
   * enforce a hard cap here.
   *
   * Always goes through POST /agents/:id/jobs. The task-scoped route
   * (POST /tasks/:id/jobs) is `requireCoworkerAuthContext` — coworkers only,
   * deliberately, pending per-coworker delegation authz (SOK-554) — so as an
   * orchestrator actor we get a flat 403 there. taskId is kept for logging /
   * caller ergonomics; it does not change the endpoint.
   */
  async createJob(args: {
    agentId: string;
    inputSchema: unknown;
    taskId?: string | null;
    identifierFromPurchaser?: string;
  }): Promise<unknown> {
    const body = await this.post(`/agents/${encodeURIComponent(args.agentId)}/jobs`, {
      inputSchema: args.inputSchema,
      identifierFromPurchaser: args.identifierFromPurchaser,
    });
    return unwrapData(body);
  }

  /**
   * Provide input for a job in AWAITING_INPUT state. The eventId refers
   * to the specific input-request event on the job (Hermes can find it
   * via getJob → events array → find the awaiting-input event).
   */
  async provideJobInput(args: {
    jobId: string;
    eventId: string;
    inputData: Record<string, unknown>;
  }): Promise<unknown> {
    return unwrapData(
      await this.post(`/jobs/${encodeURIComponent(args.jobId)}/inputs`, {
        eventId: args.eventId,
        inputData: args.inputData,
      }),
    );
  }

  /** Refund a FAILED job. */
  async refundJob(jobId: string): Promise<unknown> {
    return unwrapData(await this.post(`/jobs/${encodeURIComponent(jobId)}/refund`, {}));
  }

  // ---------- internal: POST helper ----------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const sokoCfg = getSokosumiConfig(this.env);
    if (!sokoCfg) {
      throw new Error(`Sokosumi env '${this.env ?? 'mainnet'}' not configured`);
    }
    const url = `${sokoCfg.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${sokoCfg.apiKey}`,
      'X-Delegation-User-Id': this.userId,
      // Canonical header as of Sokosumi PR #3300 (vendor grants). Legacy
      // X-Delegation-* still accepted; sending both is safe on any env.
      'X-Context-User-Id': this.userId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.organizationId) {
      headers['X-Delegation-Organization-Id'] = this.organizationId;
      headers['X-Context-Organization-Id'] = this.organizationId;
    }
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    logger.info({ method: 'POST', path, ms, status: res.status, env: this.env ?? 'mainnet' }, 'sokosumi_http');
    if (!res.ok) {
      const respBody = await res.text().catch(() => '');
      // Sokosumi #3371 attributes every task write to the user's own
      // Orchestrator row. If that row is missing or archived, auth still
      // succeeds but the write 400s — and we cannot create or unarchive it
      // (the provisioning route is user-session only). Translate it into
      // something the assistant can actually relay to the user.
      if (res.status === 400 && respBody.includes('orchestrator instance')) {
        throw new Error(
          `sokosumi POST ${path} → 400: this user has no active assistant instance in Sokosumi. ` +
            'They need to (re)activate their Personal Assistant in Sokosumi before it can create ' +
            `tasks or post comments. (raw: ${respBody.slice(0, 200)})`,
        );
      }
      throw new Error(`sokosumi POST ${path} → ${res.status}: ${respBody.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  // ---------- conversations ----------

  async listConversations(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const body = await this.get<{ items?: unknown[]; conversations?: unknown[]; data?: unknown[] }>(
      `/conversations?${qs}`,
    );
    return body.items ?? body.conversations ?? body.data ?? [];
  }

  async getConversationMessages(id: string, opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const body = await this.get<{ items?: unknown[]; messages?: unknown[]; data?: unknown[] }>(
      `/conversations/${encodeURIComponent(id)}/messages?${qs}`,
    );
    return body.items ?? body.messages ?? body.data ?? [];
  }

  // ---------- credits + meta ----------

  /**
   * Credits. UNAVAILABLE to the orchestrator actor since Sokosumi #3394 —
   * `/users/{id}/*` is session-only (`requireUserAuthContext`), so we get a
   * 403 no matter what context we send. Returns null rather than throwing so
   * a snapshot/tool doesn't die over a field we simply can't read anymore.
   */
  async getCredits(): Promise<unknown> {
    return this.get(`/users/${encodeURIComponent(this.userId)}/credits`).catch((err) => {
      if (isUserPathForbidden(err)) {
        logger.debug({ userId: this.userId }, 'sokosumi_credits_unavailable_session_only');
        return null;
      }
      throw err;
    });
  }

  async listAgents(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 50));
    const body = await this.get<{ items?: unknown[]; agents?: unknown[]; data?: unknown[] }>(
      `/agents?${qs}`,
    );
    return body.items ?? body.agents ?? body.data ?? [];
  }

  /**
   * List coworkers — the user-facing AI personas (Hannah, Elena, Demos,
   * etc.) that actually DO the work. Different from agents (the
   * underlying marketplace agent types). Tasks are assigned to coworkers;
   * Hermes is one of them but should never assign tasks to itself.
   *
   * Defaults to whitelisted scope (the user's actively enabled coworkers).
   */
  async listCoworkers(opts: { scope?: 'all' | 'whitelisted' | 'archived'; limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.scope) qs.set('scope', opts.scope);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const body = await this.get<{ items?: unknown[]; coworkers?: unknown[]; data?: unknown[] }>(
      `/coworkers?${qs}`,
    );
    return body.items ?? body.coworkers ?? body.data ?? [];
  }

  // ---------- organizations ----------

  /**
   * List every organization this user belongs to. Sokosumi users live
   * across multiple orgs but Hermes is per-user (not per-org), so we
   * iterate orgs and aggregate workspace data into a single Hermes
   * memory.
   */
  async listOrganizations(): Promise<Array<{ id: string; name?: string; slug?: string }>> {
    try {
      const body = await this.get<{ data?: Array<{ id: string; name?: string; slug?: string }> }>(
        `/users/${encodeURIComponent(this.userId)}/organizations`,
      );
      return body.data ?? [];
    } catch (err) {
      // Sokosumi #3394 made `/users/{id}/*` session-only, so the orchestrator
      // can no longer enumerate orgs. Degrade to "no orgs" instead of
      // throwing — callers sweep the personal workspace via
      // listWorkspaceScopes(), which is always reachable.
      if (isUserPathForbidden(err)) {
        logger.debug({ userId: this.userId }, 'sokosumi_org_enumeration_unavailable');
        return [];
      }
      throw err;
    }
  }

  /**
   * Every workspace we can actually read, personal first.
   *
   * The personal workspace needs no org header at all — Sokosumi's workspace
   * middleware upserts `(userId, null)` for the context user — so it survives
   * the loss of org enumeration. Org entries are a best-effort bonus.
   *
   * Use this instead of listOrganizations() anywhere you fan out over
   * workspaces; an empty org list must never mean "read nothing".
   */
  async listWorkspaceScopes(): Promise<WorkspaceScope[]> {
    const orgs = await this.listOrganizations();
    return [{ id: null, name: 'Personal' }, ...orgs];
  }

  /** Withdraws an org-context-bound copy of this client. Subsequent calls
   *  attach `X-Delegation-Organization-Id`. `null` = the personal workspace,
   *  which is this client unchanged (no org header). */
  withOrganization(organizationId: string | null): SokosumiClient {
    if (!organizationId) return this;
    return new SokosumiClient(this.userId, this.env, organizationId);
  }

  // ---------- internals ----------

  private async get<T>(path: string): Promise<T> {
    const sokoCfg = getSokosumiConfig(this.env);
    if (!sokoCfg) {
      throw new Error(`Sokosumi env '${this.env ?? 'mainnet'}' not configured`);
    }
    const url = `${sokoCfg.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${sokoCfg.apiKey}`,
      'X-Delegation-User-Id': this.userId,
      // Canonical header as of Sokosumi PR #3300 (vendor grants). Legacy
      // X-Delegation-* still accepted; sending both is safe on any env.
      'X-Context-User-Id': this.userId,
      Accept: 'application/json',
    };
    if (this.organizationId) {
      headers['X-Delegation-Organization-Id'] = this.organizationId;
      headers['X-Context-Organization-Id'] = this.organizationId;
    }
    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const ms = Date.now() - t0;
    logger.info({ method: 'GET', path, ms, status: res.status, env: this.env ?? 'mainnet' }, 'sokosumi_http');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`sokosumi GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Pull a compact workspace snapshot for a single user. Used by both the
 * onboarding sync step and the daily recurring sync. Returns null if the
 * Sokosumi API isn't configured (so callers can graceful-skip).
 *
 * Throttle / quota concerns: we make 5 parallel requests per user. Sokosumi
 * is the source of truth and will rate-limit if needed; we just propagate.
 */
/**
 * A Sokosumi user can belong to multiple organizations. Tasks, jobs, and
 * conversations are org-scoped; the user's credits + the global agent
 * catalog are not. Hermes is per-user, so we aggregate across every org
 * the user is a member of.
 */
export interface OrgWorkspace {
  /** `id: null` = the user's personal workspace. */
  organization: WorkspaceScope;
  tasks: unknown[];
  completedJobs: unknown[];
  conversations: unknown[];
  /** Whitelisted coworkers in this org — the personas that actually do
   *  the work. Hermes uses this list when assigning new tasks. */
  coworkers: unknown[];
}

export interface WorkspaceSnapshot {
  /** One entry per org the user belongs to. May be empty for users with
   *  no org memberships. */
  organizations: OrgWorkspace[];
  /** Credits are user-level, not org-scoped. */
  credits: unknown | null;
  /** Global agent catalog — same for every user. */
  agents: unknown[];
  fetchedAt: string;
}

export async function fetchWorkspaceSnapshot(
  userId: string,
  env: SokosumiEnv | null | undefined,
): Promise<WorkspaceSnapshot | null> {
  if (!SokosumiClient.isConfigured(env, userId)) {
    logger.warn({ userId, env: env ?? '(default mainnet)' }, 'sokosumi_sync_skipped_no_api_key');
    return null;
  }
  const baseClient = new SokosumiClient(userId, env);

  // Every workspace we can read, personal first. Org enumeration 403s since
  // Sokosumi #3394, so this is usually just the personal workspace — which is
  // exactly where a per-user assistant's tasks live. Never let an empty org
  // list collapse the sweep to nothing.
  const scopes = await baseClient.listWorkspaceScopes().catch((err) => {
    logger.warn({ err, userId }, 'sokosumi_list_orgs_failed');
    return [{ id: null, name: 'Personal' }] as WorkspaceScope[];
  });

  // Per-workspace pulls — tasks, completed jobs, coworkers. Run in parallel
  // (typically 1–3 per user). Cap so we don't fan out badly for users with
  // many orgs. NOTE: marketplace conversations are NOT pulled — the
  // first-party orchestrator actor always gets 403 on /conversations, so the
  // fetch was pure daily log noise; the snapshot's conversations field stays
  // empty by construction.
  const orgsToFetch = scopes.slice(0, 5);
  const orgWorkspaces = await Promise.all(
    orgsToFetch.map(async (org) => {
      const orgClient = baseClient.withOrganization(org.id);
      const [tasks, completedJobs, coworkers] = await Promise.all([
        orgClient.listTasks({ limit: 50, scope: 'workspace' }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/tasks' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
        orgClient.listJobs({ status: 'COMPLETED', limit: 15 }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/jobs' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
        orgClient.listCoworkers({ scope: 'whitelisted', limit: 30 }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/coworkers' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
      ]);
      const conversations: unknown[] = [];

      // Enrich top-10 most recent tasks with full body (description, events,
      // linked jobs). The list endpoint returns TaskListItem (summary only);
      // GET /tasks/{id} returns Task (description + events + jobs). 10
      // parallel calls per org, capped.
      const taskIds = (tasks as Array<{ id?: string; createdAt?: string }>)
        .slice(0, 10)
        .map((t) => t.id)
        .filter((id): id is string => typeof id === 'string');
      const enrichedTasks = await Promise.all(
        taskIds.map((id) =>
          orgClient.getTask(id).catch((err) => {
            logger.warn({ err, userId, orgId: org.id, taskId: id }, 'sokosumi_task_detail_failure');
            return null;
          }),
        ),
      );
      const tasksWithDetail = enrichedTasks.filter((t): t is object => t !== null);

      return {
        organization: org,
        tasks: tasksWithDetail.length > 0 ? tasksWithDetail : tasks,
        completedJobs,
        conversations,
        coworkers,
      };
    }),
  );

  // User-level pulls.
  const [credits, agents] = await Promise.all([
    baseClient.getCredits().catch((err) => {
      logger.warn({ err, userId, endpoint: '/credits' }, 'sokosumi_partial_failure');
      return null;
    }),
    baseClient.listAgents({ limit: 50 }).catch((err) => {
      logger.warn({ err, userId, endpoint: '/agents' }, 'sokosumi_partial_failure');
      return [] as unknown[];
    }),
  ]);

  return {
    organizations: orgWorkspaces,
    credits,
    agents,
    fetchedAt: new Date().toISOString(),
  };
}
