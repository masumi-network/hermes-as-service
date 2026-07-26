import { logger } from '../logger.js';
import { SokosumiClient } from '../sokosumi/client.js';
import type { SokosumiEnv } from '../config.js';

/**
 * Resolves Sokosumi ids to human names for confirmation-card summaries.
 *
 * Cards used to read:
 *   Create a new task "X" and assign it to coworker 019ed9d2-6cb0-778b-…
 * A user approving that has no idea who they are assigning work to. Now it
 * reads "…assign it to Bront (research)". Same for the workspace, which
 * matters because the personal workspace and an org workspace bill
 * differently.
 *
 * Every lookup is best-effort and CANNOT throw: a naming failure must never
 * block a confirmation from being raised. On any error we fall back to the
 * raw id, which is what the card showed before.
 */

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; name: string }>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.name;
}

function cacheSet(key: string, name: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, { at: Date.now(), name });
}

interface Ctx {
  userId: string;
  env: SokosumiEnv | null;
}

/** "Bront (Engineering)" for a coworker id, or the raw id if unresolvable. */
export async function coworkerName(id: string, ctx: Ctx): Promise<string> {
  if (!id) return '(unspecified)';
  const key = `cw:${ctx.userId}:${ctx.env ?? 'mainnet'}:${id}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const client = new SokosumiClient(ctx.userId, ctx.env);
    // Coworkers are whitelisted per workspace but identical across them, so
    // the personal workspace is enough to name one.
    const list = (await client.listCoworkers({ scope: 'whitelisted', limit: 100 })) as Array<{
      id?: string;
      name?: string;
      caption?: string;
    }>;
    for (const c of list) {
      if (!c.id || !c.name) continue;
      const label = c.caption ? `${c.name} (${c.caption})` : c.name;
      cacheSet(`cw:${ctx.userId}:${ctx.env ?? 'mainnet'}:${c.id}`, label);
    }
    return cacheGet(key) ?? id;
  } catch (err) {
    logger.debug({ err, id }, 'confirmation_coworker_name_failed');
    return id;
  }
}

/** "utxo AG" for an org id; "your personal workspace" for null/absent. */
export async function workspaceName(
  organizationId: string | null | undefined,
  ctx: Ctx,
): Promise<string> {
  if (!organizationId) return 'your personal workspace';
  const key = `ws:${ctx.userId}:${ctx.env ?? 'mainnet'}:${organizationId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const client = new SokosumiClient(ctx.userId, ctx.env);
    // listWorkspaceScopes is itself cached in the client.
    for (const scope of await client.listWorkspaceScopes()) {
      if (scope.id && scope.name) {
        cacheSet(`ws:${ctx.userId}:${ctx.env ?? 'mainnet'}:${scope.id}`, scope.name);
      }
    }
    return cacheGet(key) ?? organizationId;
  } catch (err) {
    logger.debug({ err, organizationId }, 'confirmation_workspace_name_failed');
    return organizationId;
  }
}

/** The task's title for a task id, or the raw id if unresolvable. */
export async function taskName(id: string, ctx: Ctx): Promise<string> {
  if (!id) return '(unspecified)';
  const key = `tk:${ctx.userId}:${ctx.env ?? 'mainnet'}:${id}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const client = new SokosumiClient(ctx.userId, ctx.env);
    const task = (await client.getTask(id)) as { name?: string } | null;
    if (task?.name) {
      cacheSet(key, task.name);
      return task.name;
    }
  } catch (err) {
    logger.debug({ err, id }, 'confirmation_task_name_failed');
  }
  return id;
}

/** Test seam — resets memoized names. */
export function clearNameCache(): void {
  cache.clear();
}
