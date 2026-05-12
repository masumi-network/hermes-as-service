import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, problemJson } from '../errors.js';
import {
  destroyInstance,
  getDecryptedApiServerKey,
  getInstance,
  provision,
  resumeInstance,
  setSecret,
  suspendInstance,
  touchActivity,
} from '../provision/provision.js';
import { logger } from '../logger.js';

const router = new Hono();

const provisionBody = z.object({
  userId: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).optional(),
  region: z.string().optional(),
});

const secretBody = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(8192),
});

router.post('/v1/instances', async (c) => {
  const json = await safeJson(c);
  const parsed = provisionBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(c, new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body'));
  }
  try {
    const view = await provision(parsed.data);
    return c.json({ instanceId: view.instanceId, status: view.status }, 202);
  } catch (err) {
    return mapError(c, err, parsed.data.userId);
  }
});

router.get('/v1/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  try {
    const view = await getInstance(userId);
    return c.json({
      status: view.status,
      endpointUrl: view.endpointUrl,
      lastActivityAt: view.lastActivityAt.toISOString(),
    });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/resume', async (c) => {
  const userId = c.req.param('userId');
  try {
    const view = await resumeInstance(userId);
    return c.json({ endpointUrl: view.endpointUrl, status: view.status });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/suspend', async (c) => {
  const userId = c.req.param('userId');
  try {
    const view = await suspendInstance(userId);
    return c.json({ status: view.status });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/secrets', async (c) => {
  const userId = c.req.param('userId');
  const json = await safeJson(c);
  const parsed = secretBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(
      c,
      new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body', userId),
    );
  }
  try {
    await setSecret(userId, parsed.data.key, parsed.data.value);
    return c.body(null, 204);
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.get('/v1/instances/:userId/key', async (c) => {
  const userId = c.req.param('userId');
  try {
    const apiServerKey = await getDecryptedApiServerKey(userId);
    await touchActivity(userId);
    return c.json({ apiServerKey });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.delete('/v1/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  try {
    await destroyInstance(userId);
    return c.body(null, 204);
  } catch (err) {
    return mapError(c, err, userId);
  }
});

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function mapError(c: Context, err: unknown, userId?: string) {
  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, userId }, 'instance_route_5xx');
    return problemJson(c, err);
  }
  logger.error({ err, userId }, 'instance_route_unhandled');
  return problemJson(
    c,
    new HttpError(500, 'internal_error', err instanceof Error ? err.message : 'Unknown error', userId),
  );
}

export { router as instancesRouter };
