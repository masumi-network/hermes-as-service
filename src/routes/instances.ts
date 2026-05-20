import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError, problemJson, conflict, notFound } from '../errors.js';
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
import { runOnboarding } from '../provision/onboarding.js';
import {
  addIntegration,
  isSupportedProvider,
  listIntegrations,
  removeIntegration,
  SUPPORTED_PROVIDERS,
} from '../integrations/manager.js';
import { prisma } from '../db.js';
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

const integrationBody = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS),
  mcpUrl: z.string().url().max(2000),
  mcpToken: z.string().max(2000).optional(),
  /** "read" (default — safe) or "write". When "read", our MCP proxy strips
   *  write-tools (SEND_*, CREATE_*, etc.) from Hermes' tool catalog. */
  mode: z.enum(['read', 'write']).optional(),
});

const onboardBody = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).optional(),
  researchDepth: z.enum(['light', 'deep']).optional(),
});

router.post('/v1/instances', async (c) => {
  const json = await safeJson(c);
  const parsed = provisionBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(c, new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body'));
  }
  try {
    const view = await provision(parsed.data);
    return c.json(
      {
        instanceId: view.instanceId,
        status: view.status,
        onboardedAt: view.onboardedAt?.toISOString() ?? null,
      },
      202,
    );
  } catch (err) {
    return mapError(c, err, parsed.data.userId);
  }
});

router.get('/v1/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  try {
    const view = await getInstance(userId);
    const integrations = await listIntegrations(userId);
    // `transitioning: true` when any integration is mid-apply OR the
    // instance lifecycle is itself unsettled. Sokosumi gates the
    // "Hermes is applying your change…" banner on this so the chat is
    // never offered while a Fly machine replace is in progress.
    const transitioning =
      integrations.some((i) => i.status === 'connecting' || i.status === 'pending') ||
      view.status === 'provisioning' ||
      view.status === 'onboarding';
    return c.json({
      instanceId: view.instanceId,
      userId: view.userId,
      status: view.status,
      endpointUrl: view.endpointUrl,
      lastActivityAt: view.lastActivityAt.toISOString(),
      onboardedAt: view.onboardedAt?.toISOString() ?? null,
      welcomeMessage: view.welcomeMessage,
      welcomeKind: view.welcomeKind,
      transitioning,
      integrations: integrations.map((i) => ({
        provider: i.provider,
        status: i.status,
        mode: i.mode,
        connectedAt: i.connectedAt?.toISOString() ?? null,
        lastError: i.lastError,
      })),
    });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/integrations', async (c) => {
  const userId = c.req.param('userId');
  const json = await safeJson(c);
  const parsed = integrationBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(
      c,
      new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body', userId),
    );
  }
  if (!isSupportedProvider(parsed.data.provider)) {
    return problemJson(
      c,
      new HttpError(400, 'unsupported_provider', `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`, userId),
    );
  }
  try {
    const view = await addIntegration({
      userId,
      provider: parsed.data.provider,
      mcpUrl: parsed.data.mcpUrl,
      mcpToken: parsed.data.mcpToken,
      mode: parsed.data.mode,
    });
    return c.json(
      {
        provider: view.provider,
        status: view.status,
        mode: view.mode,
        connectedAt: view.connectedAt?.toISOString() ?? null,
        lastError: view.lastError,
      },
      202,
    );
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.delete('/v1/instances/:userId/integrations/:provider', async (c) => {
  const userId = c.req.param('userId');
  const provider = c.req.param('provider');
  try {
    await removeIntegration(userId, provider);
    return c.body(null, 204);
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.get('/v1/instances/:userId/integrations', async (c) => {
  const userId = c.req.param('userId');
  try {
    const list = await listIntegrations(userId);
    return c.json({
      integrations: list.map((i) => ({
        provider: i.provider,
        status: i.status,
        mode: i.mode,
        connectedAt: i.connectedAt?.toISOString() ?? null,
        lastError: i.lastError,
      })),
    });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/onboard', async (c) => {
  const userId = c.req.param('userId');
  const json = await safeJson(c);
  const parsed = onboardBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(
      c,
      new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body', userId),
    );
  }
  try {
    const row = await prisma.hermesInstance.findUnique({ where: { userId } });
    if (!row) throw notFound(userId);
    if (row.destroyedAt) throw conflict(userId, 'Instance is destroyed; re-create via POST /v1/instances first');
    if (row.status !== 'infrastructure_ready') {
      // Allow onboarding even from 'onboarding' if the previous run errored,
      // but block other states.
      if (row.status === 'ready' && row.onboardedAt) {
        return c.json({ status: 'ready', onboardedAt: row.onboardedAt.toISOString() });
      }
      throw conflict(
        userId,
        `Instance not ready for onboarding (status=${row.status}). Wait for status=infrastructure_ready.`,
      );
    }

    // Patch name/email if provided.
    if (parsed.data.name || parsed.data.email) {
      await prisma.hermesInstance.update({
        where: { id: row.id },
        data: {
          name: parsed.data.name?.slice(0, 200) ?? row.name,
          email: parsed.data.email?.slice(0, 254) ?? row.email,
        },
      });
    }

    // Kick off onboarding async. Status flips to "onboarding" inside.
    void runOnboarding(row.id, { researchDepth: parsed.data.researchDepth }).catch((err) =>
      logger.error({ err, userId, instanceId: row.id }, 'onboarding_failed'),
    );

    return c.json({ status: 'onboarding' }, 202);
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.get('/v1/instances/:userId/onboarding', async (c) => {
  const userId = c.req.param('userId');
  try {
    const row = await prisma.hermesInstance.findUnique({
      where: { userId },
      select: { status: true, onboardingSteps: true, onboardedAt: true },
    });
    if (!row) throw notFound(userId);
    const steps = (row.onboardingSteps as unknown[] | null) ?? [];
    const etaSeconds = estimateEta(steps as { status: string }[]);
    return c.json({
      status: row.status,
      onboardedAt: row.onboardedAt?.toISOString() ?? null,
      steps,
      etaSeconds,
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

/**
 * Crude ETA: ~25s per remaining running/pending step. Sokosumi just renders
 * "About N seconds remaining" — we don't need second-level accuracy.
 */
function estimateEta(steps: { status: string }[]): number {
  const remaining = steps.filter((s) => s.status === 'pending' || s.status === 'running').length;
  return remaining * 25;
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
