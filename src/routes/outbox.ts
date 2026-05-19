import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { decryptSecret } from '../crypto.js';
import { logger } from '../logger.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ============================================================================
// Sokosumi-callable: GET /v1/instances/:userId/inbox  and  POST .../inbox/ack
// ============================================================================

const sokosumi = new Hono();

sokosumi.get('/v1/instances/:userId/inbox', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({
    where: { userId },
    select: { id: true, status: true, destroyedAt: true },
  });
  if (!row || row.destroyedAt) return c.json({ error: { message: 'instance not found' } }, 404);

  // No lifecycle gate — outbox messages should always be readable.
  // Sokosumi may poll the inbox before the chat opens (to surface the
  // research_intro message) and after onboarding has partially failed
  // (the fallback welcome lands here). Returning 409 with {status} for
  // anything other than the legacy 'running' value was a regression from
  // onboarding v2's status rename ('running' → 'ready').

  const since = c.req.query('since');
  let sinceDate: Date | null = null;
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return c.json({ error: { message: 'invalid since timestamp' } }, 400);
    }
    sinceDate = d;
  }

  const requestedLimit = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  // Fetch limit+1 so we can compute hasMore without a separate count.
  const rows = await prisma.outboxMessage.findMany({
    where: {
      instanceId: row.id,
      ...(sinceDate ? { createdAt: { gt: sinceDate } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  c.header('Cache-Control', 'no-store');
  return c.json({
    messages: slice.map((r) => ({
      id: formatPublicId(r.id),
      content: r.content,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
    })),
    hasMore,
  });
});

const ackBody = z.object({
  messageIds: z.array(z.string().min(1).max(64)).max(MAX_LIMIT),
});

sokosumi.post('/v1/instances/:userId/inbox/ack', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);

  const raw = await safeJson(c);
  const parsed = ackBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  if (parsed.data.messageIds.length === 0) {
    return c.body(null, 204);
  }
  // Strip the "msg_" prefix that the public id surfaces. Both forms accepted.
  const ids = parsed.data.messageIds.map(parsePublicId);
  await prisma.outboxMessage.deleteMany({
    where: { instanceId: row.id, id: { in: ids } },
  });
  return c.body(null, 204);
});

// ============================================================================
// Sprite-callable: POST /v1/llm/:instanceId/outbox  (per-instance bearer auth)
// ============================================================================

const sprite = new Hono();

const enqueueBody = z.object({
  content: z.string().min(1).max(128 * 1024), // server-side clip to 32 KB
  kind: z.string().min(1).max(64).optional(),
});

sprite.post('/v1/llm/:instanceId/outbox', async (c) => {
  const auth = await authenticateSprite(c);
  if (!auth.ok) return c.json({ error: { message: auth.message } }, auth.status);
  const raw = await safeJson(c);
  const parsed = enqueueBody.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  try {
    const result = await enqueueOutboxMessage({
      instanceId: auth.row.id,
      userId: auth.row.userId,
      content: parsed.data.content,
      kind: parsed.data.kind,
    });
    return c.json(
      {
        id: formatPublicId(result.id),
        createdAt: result.createdAt.toISOString(),
        truncated: result.truncated,
      },
      201,
    );
  } catch (err) {
    logger.error({ err, userId: auth.row.userId }, 'outbox_enqueue_failed');
    return c.json({ error: { message: 'enqueue failed' } }, 500);
  }
});

// ============================================================================
// helpers
// ============================================================================

function formatPublicId(internalId: string): string {
  return `msg_${internalId}`;
}

function parsePublicId(publicId: string): string {
  return publicId.startsWith('msg_') ? publicId.slice(4) : publicId;
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

interface AuthOk {
  ok: true;
  row: { id: string; userId: string };
}
interface AuthErr {
  ok: false;
  status: 401 | 404 | 500;
  message: string;
}

async function authenticateSprite(c: Context): Promise<AuthOk | AuthErr> {
  const instanceId = c.req.param('instanceId') ?? '';
  if (!instanceId) return { ok: false, status: 401, message: 'missing instanceId' };
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return { ok: false, status: 401, message: 'missing bearer' };
  const bearer = header.slice(7).trim();
  if (!bearer) return { ok: false, status: 401, message: 'empty bearer' };
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || !row.llmProxyToken) return { ok: false, status: 404, message: 'instance not found' };
  let expected: string;
  try {
    expected = await decryptSecret(row.llmProxyToken);
  } catch (err) {
    logger.error({ err }, 'outbox_auth_decrypt_failed');
    return { ok: false, status: 500, message: 'decrypt failed' };
  }
  if (bearer !== expected) return { ok: false, status: 401, message: 'bad bearer' };
  return { ok: true, row: { id: row.id, userId: row.userId } };
}

export { sokosumi as outboxSokosumiRouter, sprite as outboxSpriteRouter };
