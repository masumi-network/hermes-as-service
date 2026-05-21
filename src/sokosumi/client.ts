import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

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
  constructor(
    private readonly userId: string,
    private readonly organizationId?: string,
  ) {}

  /** Returns true if SOKOSUMI_COWORKER_API_KEY is configured. Callers
   *  should gracefully skip if false (no-op the sync). */
  static isConfigured(): boolean {
    return Boolean(loadConfig().SOKOSUMI_COWORKER_API_KEY);
  }

  // ---------- tasks ----------

  async listTasks(opts: { limit?: number; scope?: 'workspace' | 'owned' } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 100));
    if (opts.scope) qs.set('scope', opts.scope);
    const body = await this.get<{ items?: unknown[]; tasks?: unknown[] }>(`/tasks?${qs}`);
    // Defensive: accept either {items} or {tasks} envelope shape — the spec
    // uses different keys on different endpoints.
    return body.items ?? body.tasks ?? [];
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
    const body = await this.get<{ items?: unknown[]; jobs?: unknown[] }>(`/jobs?${qs}`);
    return body.items ?? body.jobs ?? [];
  }

  async getJob(id: string): Promise<unknown> {
    return this.get(`/jobs/${encodeURIComponent(id)}`);
  }

  // ---------- conversations ----------

  async listConversations(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const body = await this.get<{ items?: unknown[]; conversations?: unknown[] }>(
      `/conversations?${qs}`,
    );
    return body.items ?? body.conversations ?? [];
  }

  async getConversationMessages(id: string, opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    const body = await this.get<{ items?: unknown[]; messages?: unknown[] }>(
      `/conversations/${encodeURIComponent(id)}/messages?${qs}`,
    );
    return body.items ?? body.messages ?? [];
  }

  // ---------- credits + meta ----------

  async getCredits(): Promise<unknown> {
    return this.get(`/users/${encodeURIComponent(this.userId)}/credits`);
  }

  async listAgents(opts: { limit?: number } = {}): Promise<unknown[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 50));
    const body = await this.get<{ items?: unknown[]; agents?: unknown[] }>(`/agents?${qs}`);
    return body.items ?? body.agents ?? [];
  }

  // ---------- internals ----------

  private async get<T>(path: string): Promise<T> {
    const cfg = loadConfig();
    const url = `${cfg.SOKOSUMI_API_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.SOKOSUMI_COWORKER_API_KEY}`,
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
export interface WorkspaceSnapshot {
  tasks: unknown[];
  completedJobs: unknown[];
  conversations: unknown[];
  credits: unknown | null;
  agents: unknown[];
  fetchedAt: string;
}

export async function fetchWorkspaceSnapshot(
  userId: string,
  organizationId?: string,
): Promise<WorkspaceSnapshot | null> {
  if (!SokosumiClient.isConfigured()) {
    logger.warn({ userId }, 'sokosumi_sync_skipped_no_api_key');
    return null;
  }
  const client = new SokosumiClient(userId, organizationId);

  const [tasks, completedJobs, conversations, credits, agents] = await Promise.all([
    client.listTasks({ limit: 100, scope: 'workspace' }).catch((err) => {
      logger.warn({ err, userId, endpoint: '/tasks' }, 'sokosumi_partial_failure');
      return [] as unknown[];
    }),
    client.listJobs({ status: 'COMPLETED', limit: 20 }).catch((err) => {
      logger.warn({ err, userId, endpoint: '/jobs' }, 'sokosumi_partial_failure');
      return [] as unknown[];
    }),
    client.listConversations({ limit: 5 }).catch((err) => {
      logger.warn({ err, userId, endpoint: '/conversations' }, 'sokosumi_partial_failure');
      return [] as unknown[];
    }),
    client.getCredits().catch((err) => {
      logger.warn({ err, userId, endpoint: '/credits' }, 'sokosumi_partial_failure');
      return null;
    }),
    client.listAgents({ limit: 50 }).catch((err) => {
      logger.warn({ err, userId, endpoint: '/agents' }, 'sokosumi_partial_failure');
      return [] as unknown[];
    }),
  ]);

  return {
    tasks,
    completedJobs,
    conversations,
    credits,
    agents,
    fetchedAt: new Date().toISOString(),
  };
}
