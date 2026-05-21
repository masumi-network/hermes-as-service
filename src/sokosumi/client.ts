import { getSokosumiConfig, type SokosumiEnv } from '../config.js';
import { logger } from '../logger.js';

/**
 * Test-fixture overrides: when a user provisions via Sokosumi's local-dev
 * environment, their userId belongs to a local DB that doesn't exist in
 * preprod or mainnet. To run an end-to-end sokosumi_sync test against
 * preprod or mainnet, we need to substitute the delegation userId.
 *
 * Keys = Sokosumi-sent userId (from POST /v1/instances). Values = per-env
 * userId to actually use as X-Delegation-User-Id when calling Sokosumi
 * APIs. Only Sokosumi calls are affected — instance routing, inbox
 * endpoints, etc. still use the original userId.
 *
 * Strictly for known test fixtures. Real users should use a userId that
 * exists in the env they declare.
 */
const SOKOSUMI_USERID_OVERRIDES: Record<string, Partial<Record<SokosumiEnv, string>>> = {
  // Patrick — local-dev Sokosumi userId → real preprod userId (patrick@nmkr.io)
  '019e1de5-1c27-711b-9918-da5b601d48b1': {
    preprod: '993Sp1dOvyn4CFCEHIQPu1vn4ZVI0Dh4',
  },
};

function resolveSokosumiUserId(userId: string, env: SokosumiEnv | null | undefined): string {
  const map = SOKOSUMI_USERID_OVERRIDES[userId];
  if (!map) return userId;
  const effective: SokosumiEnv = env ?? 'mainnet';
  return map[effective] ?? userId;
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
export class SokosumiClient {
  private readonly userId: string;
  constructor(
    rawUserId: string,
    private readonly env: SokosumiEnv | null | undefined,
    private readonly organizationId?: string,
  ) {
    this.userId = resolveSokosumiUserId(rawUserId, env);
    if (this.userId !== rawUserId) {
      logger.info(
        { rawUserId, effectiveUserId: this.userId, env },
        'sokosumi_userid_override_applied',
      );
    }
  }

  /** Returns true if a coworker API key + base URL are configured for the
   *  given env. Callers should gracefully skip if false. */
  static isConfigured(env: SokosumiEnv | null | undefined): boolean {
    return Boolean(getSokosumiConfig(env));
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
    return this.get(`/jobs/${encodeURIComponent(id)}`);
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

  async getCredits(): Promise<unknown> {
    return this.get(`/users/${encodeURIComponent(this.userId)}/credits`);
  }

  async listAgents(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 50));
    const body = await this.get<{ items?: unknown[]; agents?: unknown[]; data?: unknown[] }>(
      `/agents?${qs}`,
    );
    return body.items ?? body.agents ?? body.data ?? [];
  }

  // ---------- organizations ----------

  /**
   * List every organization this user belongs to. Sokosumi users live
   * across multiple orgs but Hermes is per-user (not per-org), so we
   * iterate orgs and aggregate workspace data into a single Hermes
   * memory.
   */
  async listOrganizations(): Promise<Array<{ id: string; name?: string; slug?: string }>> {
    const body = await this.get<{ data?: Array<{ id: string; name?: string; slug?: string }> }>(
      `/users/${encodeURIComponent(this.userId)}/organizations`,
    );
    return body.data ?? [];
  }

  /** Withdraws an org-context-bound copy of this client. Subsequent calls
   *  attach `X-Delegation-Organization-Id`. */
  withOrganization(organizationId: string): SokosumiClient {
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
      Accept: 'application/json',
    };
    if (this.organizationId) {
      headers['X-Delegation-Organization-Id'] = this.organizationId;
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
    });
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
  organization: { id: string; name?: string; slug?: string };
  tasks: unknown[];
  completedJobs: unknown[];
  conversations: unknown[];
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
  if (!SokosumiClient.isConfigured(env)) {
    logger.warn({ userId, env: env ?? '(default mainnet)' }, 'sokosumi_sync_skipped_no_api_key');
    return null;
  }
  const baseClient = new SokosumiClient(userId, env);

  // First: list the user's orgs. Without this we can't pull org-scoped data.
  const orgs = await baseClient.listOrganizations().catch((err) => {
    logger.warn({ err, userId }, 'sokosumi_list_orgs_failed');
    return [] as Array<{ id: string; name?: string; slug?: string }>;
  });

  // Per-org pulls — tasks, completed jobs, conversations. Run in parallel
  // across orgs (typically 1–3 per user). Cap so we don't fan out badly
  // for users with many orgs.
  const orgsToFetch = orgs.slice(0, 5);
  const orgWorkspaces = await Promise.all(
    orgsToFetch.map(async (org) => {
      const orgClient = baseClient.withOrganization(org.id);
      const [tasks, completedJobs, conversations] = await Promise.all([
        orgClient.listTasks({ limit: 50, scope: 'workspace' }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/tasks' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
        orgClient.listJobs({ status: 'COMPLETED', limit: 15 }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/jobs' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
        orgClient.listConversations({ limit: 5 }).catch((err) => {
          logger.warn({ err, userId, orgId: org.id, endpoint: '/conversations' }, 'sokosumi_partial_failure');
          return [] as unknown[];
        }),
      ]);
      return { organization: org, tasks, completedJobs, conversations };
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
