import { getSokosumiConfig, type SokosumiEnv } from '../config.js';
import { logger } from '../logger.js';
import { extractAwaitingInputEvent, type JobLifecycleStatus } from './job-state.js';

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
 * Auth model: per-env key held in Railway env — the orchestrator SERVICE
 * token when configured, else the legacy coworker key — plus
 * `X-Context-User-Id` (canonical) / `X-Delegation-User-Id` (legacy) headers
 * that scope each call to a specific end user. No per-user OAuth needed.
 *
 * Used by:
 *   - sokosumi_sync onboarding step (pulls workspace state into Hermes memory)
 *   - daily recurring sync (refreshes memory once/day per user)
 *   - the sokosumi-mcp tool route (reads AND writes: create task, comment,
 *     set status, create job, provide input — autonomy-gated upstream)
 */

/**
 * A workspace the orchestrator can read. `id: null` is the user's personal
 * workspace — reachable with no org header and always present; org entries
 * come from listOrganizations (reopened to the orchestrator by #3408).
 */
export interface WorkspaceScope {
  id: string | null;
  name?: string;
  slug?: string;
}

/**
 * How two tasks relate. Verified against Sokosumi's OpenAPI spec
 * (components.schemas.TaskLinkRelation) — these six, exactly.
 *
 * The relation reads FROM the task you call the endpoint on TO the peer:
 * creating a link on task A with relation 'parent' and toTaskId B means
 * "A's parent is B".
 */
export const TASK_LINK_RELATIONS = [
  'related',
  'blocks',
  'blocked_by',
  'parent',
  'child',
  'duplicate',
] as const;
export type TaskLinkRelation = (typeof TASK_LINK_RELATIONS)[number];

/** A link as Sokosumi returns it — the peer's name and status come embedded,
 *  so listing links needs no second fetch per peer. */
export interface TaskLink {
  id: string;
  relation: TaskLinkRelation;
  note?: string | null;
  createdAt?: string;
  peerTask?: { id: string; name?: string; status?: string; archivedAt?: string | null };
}

/**
 * True when a request failed because it hit `/v1/users/{id}/*`, which
 * Sokosumi #3394 ("block coworker impersonation via user context") made
 * session-only: `requireAccessToTargetUserData` now calls
 * `requireUserAuthContext`. Sokosumi PR #3408 reopened these paths to the
 * orchestrator service token + X-Context-User-Id, so this now fires only on an
 * env where #3408 isn't deployed — there we degrade instead of throwing.
 */
function isUserPathForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('403') && msg.includes('User authentication required');
}

/** Run `fn` over `items` with bounded concurrency, results in input order.
 *  Lets a fan-out cover ALL of a user's workspaces without unbounded
 *  parallelism. Rejections propagate — callers wanting best-effort catch
 *  inside `fn`. */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Org membership changes about never, but every sweep tick re-enumerated it —
 * two `listWorkspaceScopes()` calls per 5-minute tick per user, forever. Cached
 * per (userId, env) with a short TTL: still picks up a new org within minutes,
 * costs nothing in the 99.9% case. Negative results are NOT cached, so a
 * transient failure that degrades to "personal only" can't stick.
 */
const SCOPE_CACHE_TTL_MS = 15 * 60_000;
/** One small entry per active user; bounded so the map can't grow unbounded
 *  in a long-lived process. */
const SCOPE_CACHE_MAX = 2000;
const scopeCache = new Map<string, { at: number; scopes: WorkspaceScope[] }>();

/**
 * Safety margin on watermark-based pagination early-stop. Sokosumi orders
 * newest-first, but the sort key isn't guaranteed to be the same field we
 * compare on, and the tail of a listing was observed to be slightly
 * non-monotonic. A day of slack makes the optimization free of correctness
 * risk: the sweeps' own watermarks are hours old, so a stale page still stops
 * pagination, while anything remotely near the cutoff is still fetched.
 */
const PAGINATION_CUTOFF_SLACK_MS = 24 * 60 * 60_000;

/** Newest timestamp on a page — max over every stamp field an item might
 *  carry, so the early-stop can't be fooled by a missing `updatedAt`. */
function newestStamp(items: unknown[]): number {
  let newest = -Infinity;
  for (const item of items) {
    if (!item || typeof item !== 'object') return Infinity; // unknown shape → never stop
    const o = item as Record<string, unknown>;
    for (const key of ['updatedAt', 'createdAt', 'completedAt']) {
      const v = o[key];
      if (typeof v !== 'string' || !v) continue;
      const t = new Date(v).getTime();
      if (!isNaN(t) && t > newest) newest = t;
    }
  }
  // A page with no parseable stamps must not trigger a stop.
  return newest === -Infinity ? Infinity : newest;
}

/** Drop cached scopes — call after anything that can change org membership. */
export function invalidateWorkspaceScopeCache(userId?: string): void {
  if (!userId) {
    scopeCache.clear();
    return;
  }
  for (const key of scopeCache.keys()) {
    if (key.startsWith(`${userId}::`)) scopeCache.delete(key);
  }
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
    return this.listArray(`/tasks?${qs}`, 'tasks');
  }

  // ---------- jobs ----------

  /** One page of jobs. `status` is the LIFECYCLE filter (ever-in-state), which
   *  is NOT the `status` field on the returned items — see ./job-state.ts. */
  async listJobs(opts: {
    status?: JobLifecycleStatus;
    agentId?: string;
    limit?: number;
    scope?: 'workspace' | 'owned';
  } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.agentId) qs.set('agentId', opts.agentId);
    qs.set('limit', String(opts.limit ?? 50));
    if (opts.scope) qs.set('scope', opts.scope);
    return this.listArray(`/jobs?${qs}`, 'jobs');
  }

  /** ALL tasks in this workspace, paginated (bounded). Use for completeness
   *  (sweeps, board-wide views) — a single page can miss a blocked task that
   *  never bumps its updatedAt to resurface. */
  async listAllTasks(
    opts: {
      scope?: 'workspace' | 'owned';
      status?: string;
      limit?: number;
      maxItems?: number;
      /** Stop paging once a whole page predates this. See paginateAll. */
      stopWhenOlderThan?: Date;
    } = {},
  ): Promise<{ items: unknown[]; total: number; truncated: boolean; pages: number }> {
    const qs = new URLSearchParams();
    if (opts.scope) qs.set('scope', opts.scope);
    if (opts.status) qs.set('status', opts.status);
    qs.set('limit', String(opts.limit ?? 100));
    return this.paginateAll(`/tasks?${qs}`, {
      maxItems: opts.maxItems ?? 1000,
      ...(opts.stopWhenOlderThan ? { stopWhenOlderThan: opts.stopWhenOlderThan } : {}),
    });
  }

  /**
   * ALL jobs in this workspace, paginated (bounded).
   *
   * `status` is Sokosumi's LIFECYCLE filter — it selects jobs that have EVER
   * been in that state, not jobs currently in it, and it does NOT correspond
   * to the `status` field on the returned items (that one is payment state).
   * See ./job-state.ts before using either. Good for narrowing a candidate
   * set; never sufficient on its own to decide current state.
   */
  async listAllJobs(
    opts: {
      status?: JobLifecycleStatus;
      agentId?: string;
      limit?: number;
      maxItems?: number;
      /** Stop paging once a whole page predates this. See paginateAll. */
      stopWhenOlderThan?: Date;
    } = {},
  ): Promise<{ items: unknown[]; total: number; truncated: boolean; pages: number }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.agentId) qs.set('agentId', opts.agentId);
    qs.set('limit', String(opts.limit ?? 100));
    return this.paginateAll(`/jobs?${qs}`, {
      maxItems: opts.maxItems ?? 1000,
      ...(opts.stopWhenOlderThan ? { stopWhenOlderThan: opts.stopWhenOlderThan } : {}),
    });
  }

  /**
   * Is this job awaiting input RIGHT NOW, and on which event?
   *
   * The only authoritative answer — `?status=AWAITING_INPUT` and the `status`
   * field both fail to answer it (see ./job-state.ts). Costs one GET, so call
   * it only for candidates that survived the free `couldBeAwaitingInput`
   * filter. Returns the open request event, or null.
   */
  async getPendingInputRequest(jobId: string): Promise<Record<string, unknown> | null> {
    const job = (await this.getJob(jobId)) as { events?: unknown } | null;
    return extractAwaitingInputEvent(job?.events ?? null);
  }

  async getJob(id: string): Promise<unknown> {
    // Sokosumi wraps single-resource responses in {data: ...}.
    return unwrapData(await this.get<unknown>(`/jobs/${encodeURIComponent(id)}`));
  }

  async getTask(id: string): Promise<unknown> {
    return unwrapData(await this.get<unknown>(`/tasks/${encodeURIComponent(id)}`));
  }

  async getJobFiles(id: string): Promise<unknown[]> {
    return this.listArray(`/jobs/${encodeURIComponent(id)}/files`, 'files');
  }

  async getAgentInputSchema(agentId: string): Promise<unknown> {
    return unwrapData(
      await this.get<unknown>(`/agents/${encodeURIComponent(agentId)}/input-schema`),
    );
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

  // ---------- task links ----------

  /**
   * Links between this task and others. The response embeds the peer task's
   * name and status, so reading links needs no follow-up fetch.
   */
  async listTaskLinks(taskId: string): Promise<TaskLink[]> {
    const body = await this.get<{ data?: TaskLink[]; items?: TaskLink[]; links?: TaskLink[] }>(
      `/tasks/${encodeURIComponent(taskId)}/links`,
    );
    return body.data ?? body.items ?? body.links ?? [];
  }

  /**
   * Link two tasks. Free and reversible, like a comment.
   *
   * `relation` reads from THIS task to the peer: linking A with
   * relation 'parent' means "A's parent is B" — so a follow-up task naming
   * the work it came out of uses 'parent' on the follow-up.
   */
  async createTaskLink(
    taskId: string,
    args: { toTaskId: string; relation: TaskLinkRelation; note?: string | null },
  ): Promise<unknown> {
    return unwrapData(await this.post(`/tasks/${encodeURIComponent(taskId)}/links`, args));
  }

  async deleteTaskLink(taskId: string, linkId: string): Promise<unknown> {
    return unwrapData(
      await this.del(`/tasks/${encodeURIComponent(taskId)}/links/${encodeURIComponent(linkId)}`),
    );
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

  private async del<T>(path: string): Promise<T> {
    const sokoCfg = getSokosumiConfig(this.env);
    if (!sokoCfg) {
      throw new Error(`Sokosumi env '${this.env ?? 'mainnet'}' not configured`);
    }
    const url = `${sokoCfg.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${sokoCfg.apiKey}`,
      'X-Delegation-User-Id': this.userId,
      'X-Context-User-Id': this.userId,
      Accept: 'application/json',
    };
    if (this.organizationId) {
      headers['X-Delegation-Organization-Id'] = this.organizationId;
      headers['X-Context-Organization-Id'] = this.organizationId;
    }
    const t0 = Date.now();
    const res = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(30_000) });
    logger.info(
      { method: 'DELETE', path, ms: Date.now() - t0, status: res.status, env: this.env ?? 'mainnet' },
      'sokosumi_http',
    );
    if (!res.ok) {
      const respBody = await res.text().catch(() => '');
      throw new Error(`sokosumi DELETE ${path} → ${res.status}: ${respBody.slice(0, 300)}`);
    }
    // 204 has no body.
    const text = await res.text();
    return (text ? JSON.parse(text) : { deleted: true }) as T;
  }

  // ---------- conversations ----------

  async listConversations(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    return this.listArray(`/conversations?${qs}`, 'conversations');
  }

  // ---------- credits + meta ----------

  /**
   * Personal-workspace credits: subscription plan + balance (subscription
   * `credits` {total,remaining,used} plus `extra` credit buckets). Readable
   * again via orch+ctx since Sokosumi PR #3408, which reopened `/users/{id}/*`
   * to the service token + X-Context-User-Id. The 403 branch is kept as a
   * safety net for any env where #3408 isn't deployed yet — there we return
   * null so a snapshot/tool degrades instead of throwing.
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

  /** The user's notifications (newest first), one cursor page. */
  async listNotifications(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: unknown[]; nextCursor: string | null; total: number }> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 20));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    return this.getListPage(`/notifications?${qs}`);
  }

  /** Count of unread notifications. */
  async getUnreadNotificationCount(): Promise<number> {
    const body = await this.get<{ data?: { count?: number }; count?: number }>(
      '/notifications/unread-count',
    );
    return body.data?.count ?? body.count ?? 0;
  }

  /** The user's recent activity history (tasks/jobs), newest first, one page. */
  async getHistory(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: unknown[]; nextCursor: string | null; total: number }> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 20));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    return this.getListPage(`/history?${qs}`);
  }

  async listAgents(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 50));
    return this.listArray(`/agents?${qs}`, 'agents');
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
    return this.listArray(`/coworkers?${qs}`, 'coworkers');
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
      // Page through ALL orgs — a many-org user would otherwise lose orgs past
      // page 1, silently collapsing every downstream workspace fan-out.
      const { items } = await this.paginateAll<{ id: string; name?: string; slug?: string }>(
        `/users/${encodeURIComponent(this.userId)}/organizations`,
        { maxItems: 200 },
      );
      return items;
    } catch (err) {
      // Readable again via orch+ctx since Sokosumi PR #3408. The 403 branch is
      // a safety net for any env where #3408 isn't deployed: degrade to "no
      // orgs" instead of throwing — callers still sweep the personal workspace
      // via listWorkspaceScopes(), which is always reachable.
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
    const key = `${this.userId}::${this.env ?? 'mainnet'}`;
    const hit = scopeCache.get(key);
    if (hit && Date.now() - hit.at < SCOPE_CACHE_TTL_MS) return hit.scopes;

    const orgs = await this.listOrganizations();
    const scopes: WorkspaceScope[] = [{ id: null, name: 'Personal' }, ...orgs];
    // Don't cache a degraded "personal only" answer produced by a swallowed
    // 403 — it would pin the user to one workspace for the whole TTL.
    if (orgs.length > 0) {
      // Bound growth: sweep expired entries before inserting into a full map.
      if (scopeCache.size >= SCOPE_CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of scopeCache) {
          if (now - v.at >= SCOPE_CACHE_TTL_MS) scopeCache.delete(k);
        }
        // Still full (every entry fresh) — drop the oldest insertion.
        if (scopeCache.size >= SCOPE_CACHE_MAX) {
          const oldest = scopeCache.keys().next().value;
          if (oldest !== undefined) scopeCache.delete(oldest);
        }
      }
      scopeCache.set(key, { at: Date.now(), scopes });
    }
    return scopes;
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

  /** Single-page list unwrap shared by the plain list methods. Precedence is
   *  items → endpoint key → data (deliberately different from getListPage's
   *  data-first order — these methods pre-date it and callers depend on it). */
  private async listArray(
    path: string,
    key: 'tasks' | 'jobs' | 'files' | 'conversations' | 'agents' | 'coworkers',
  ): Promise<unknown[]> {
    const body = await this.get<Record<string, unknown[] | undefined>>(path);
    return body['items'] ?? body[key] ?? body['data'] ?? [];
  }

  /** One page of a cursor-paginated Sokosumi list. Reads the items array
   *  (under whichever key the endpoint uses) plus meta.pagination. */
  private async getListPage<T>(
    path: string,
  ): Promise<{ items: T[]; nextCursor: string | null; total: number }> {
    const body = await this.get<{
      data?: T[];
      items?: T[];
      tasks?: T[];
      jobs?: T[];
      agents?: T[];
      coworkers?: T[];
      conversations?: T[];
      messages?: T[];
      files?: T[];
      meta?: { pagination?: { nextCursor?: string | null; total?: number } };
    }>(path);
    const items =
      body.data ??
      body.items ??
      body.tasks ??
      body.jobs ??
      body.agents ??
      body.coworkers ??
      body.conversations ??
      body.messages ??
      body.files ??
      [];
    const p = body.meta?.pagination;
    return { items, nextCursor: p?.nextCursor ?? null, total: p?.total ?? items.length };
  }

  /** Follow `meta.pagination.nextCursor` until exhausted, bounded by maxItems /
   *  maxPages so an unbounded feed can't run away. `basePath` may already carry
   *  query params. Returns accumulated items, the API's reported total, and
   *  whether the bound cut it short (truncated). */
  protected async paginateAll<T>(
    basePath: string,
    opts: { maxItems?: number; maxPages?: number; stopWhenOlderThan?: Date } = {},
  ): Promise<{ items: T[]; total: number; truncated: boolean; pages: number }> {
    const maxItems = opts.maxItems ?? 500;
    const maxPages = opts.maxPages ?? 25;
    const cutoff = opts.stopWhenOlderThan
      ? opts.stopWhenOlderThan.getTime() - PAGINATION_CUTOFF_SLACK_MS
      : null;
    const sep = basePath.includes('?') ? '&' : '?';
    const items: T[] = [];
    let cursor: string | null = null;
    let total = 0;
    let pages = 0;
    do {
      const path: string = cursor
        ? `${basePath}${sep}cursor=${encodeURIComponent(cursor)}`
        : basePath;
      const page: { items: T[]; nextCursor: string | null; total: number } =
        await this.getListPage<T>(path);
      items.push(...page.items);
      total = page.total;
      cursor = page.nextCursor;
      pages += 1;
      // Watermark early-stop. Both /jobs and /tasks page newest-first, so once
      // an ENTIRE page predates the caller's cutoff, every later page does too.
      // Keyed on the page MAXIMUM (not its last item) because ordering isn't
      // strictly monotonic within a page, and carries a slack margin on top.
      if (cutoff !== null && page.items.length > 0 && newestStamp(page.items) < cutoff) {
        return { items, total, truncated: false, pages };
      }
    } while (cursor && pages < maxPages && items.length < maxItems);
    return { items, total, truncated: Boolean(cursor), pages };
  }
}

/**
 * Pull a compact workspace snapshot for a single user. Used by both the
 * onboarding sync step and the daily recurring sync. Returns null if the
 * Sokosumi API isn't configured (so callers can graceful-skip).
 *
 * Throttle / quota concerns: bounded fan-out — up to 5 workspaces in flight
 * (mapLimit), each making 3 list calls plus up to 10 task-detail calls, plus
 * 2 user-level calls. Sokosumi is the source of truth and will rate-limit if
 * needed; we just propagate.
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
  /** Credits live on the workspace's OWNER — the user for the personal
   *  workspace, the owning org for an org workspace. getCredits() reads only
   *  the personal balance (the /users/{id}/credits endpoint is user-scoped;
   *  org wallet balances aren't exposed to the orchestrator — judge org
   *  spends by job price). */
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

  // Every workspace we can read, personal first. Org enumeration works again
  // via orch+ctx (Sokosumi PR #3408), so this spans the personal workspace
  // PLUS every org the user belongs to. Never let an empty org list collapse
  // the sweep to nothing.
  const scopes = await baseClient.listWorkspaceScopes().catch((err) => {
    logger.warn({ err, userId }, 'sokosumi_list_orgs_failed');
    return [{ id: null, name: 'Personal' }] as WorkspaceScope[];
  });

  // Per-workspace pulls — tasks, completed jobs, coworkers. Fan out over ALL
  // scopes with bounded concurrency (was capped at 5, silently dropping orgs
  // for many-org users). NOTE: marketplace conversations are NOT pulled — the
  // first-party orchestrator actor always gets 403 on /conversations, so the
  // fetch was pure daily log noise; the snapshot's conversations field stays
  // empty by construction.
  const orgWorkspaces = await mapLimit(scopes, 5, async (org) => {
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
  });

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
