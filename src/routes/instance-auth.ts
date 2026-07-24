import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret, timingSafeEqualString } from '../crypto.js';

/**
 * Shared per-instance bearer auth for every machine-facing route (llm-proxy,
 * mcp-proxy, sokosumi-mcp, outbox, schedules). Replaces five hand-rolled
 * near-identical copies; the small per-route differences (decrypt-fail
 * message + optional log tag) are parameters so responses and logs stay
 * byte-identical per route.
 */

export interface InstanceAuthRow {
  id: string;
  userId: string;
  sokosumiEnv: string | null;
  autonomyLevel: string;
}

export type InstanceAuthResult =
  | { ok: true; row: InstanceAuthRow }
  | { ok: false; status: 401 | 404 | 500; message: string };

export async function authenticateInstanceBearer(
  instanceId: string | undefined,
  authHeader: string | undefined,
  opts: {
    /** 500-body message on decrypt failure ('decrypt failed' for sprite
     *  routes, 'token decrypt failed' for the proxies). */
    decryptFailMessage: string;
    /** When set, decrypt failures are logger.error'd under this tag (the
     *  sprite routes log; the proxies historically did not). */
    decryptFailLogTag?: string;
  },
): Promise<InstanceAuthResult> {
  if (!instanceId) return { ok: false, status: 401, message: 'missing instanceId' };
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, message: 'missing bearer' };
  }
  const bearer = authHeader.slice(7).trim();
  if (!bearer) return { ok: false, status: 401, message: 'empty bearer' };
  const row = await prisma.hermesInstance.findUnique({
    where: { id: instanceId },
    select: {
      id: true,
      userId: true,
      llmProxyToken: true,
      sokosumiEnv: true,
      autonomyLevel: true,
    },
  });
  if (!row || !row.llmProxyToken) {
    return { ok: false, status: 404, message: 'instance not found' };
  }
  let expected: string;
  try {
    expected = await decryptSecret(row.llmProxyToken);
  } catch (err) {
    if (opts.decryptFailLogTag) logger.error({ err }, opts.decryptFailLogTag);
    return { ok: false, status: 500, message: opts.decryptFailMessage };
  }
  if (!timingSafeEqualString(bearer, expected)) {
    return { ok: false, status: 401, message: 'bad bearer' };
  }
  return {
    ok: true,
    row: {
      id: row.id,
      userId: row.userId,
      sokosumiEnv: row.sokosumiEnv,
      autonomyLevel: row.autonomyLevel,
    },
  };
}
