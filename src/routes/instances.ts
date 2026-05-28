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
  /** Which Sokosumi backend this user lives in. Routes the sokosumi_sync
   *  step to the right API base + coworker key. Defaults to "mainnet"
   *  if omitted. */
  /** Which Sokosumi backend this user lives in. Sokosumi UI MUST pass
   *  the env it's actually running on — preprod UI sends "preprod",
   *  mainnet UI sends "mainnet", dev UI sends "development". Mismatches
   *  get caught downstream when getSokosumiConfig(env) returns null
   *  ("env not configured") rather than silently routed. */
  sokosumiEnv: z.enum(['development', 'preprod', 'mainnet']).optional(),
  /** How much autonomy the agent gets on this user's workspace.
   *  low    — read only
   *  medium — can do anything but always asks first (Hermes-side gating)
   *  high   — fully autonomous, including background task creation
   *  Defaults to "medium". */
  autonomyLevel: z.enum(['low', 'medium', 'high']).optional(),
  /** IANA timezone (e.g. "America/New_York"). Drives the cron expressions
   *  for user-facing recurring prompts (morning-brief, weekly-wrap, etc.).
   *  Defaults to UTC when omitted. */
  timezone: z.string().min(1).max(80).optional(),
  /** Optional persona customization (all opt-in; unset = default voice).
   *  Shapes the agent's voice only — never its accuracy, structure, or
   *  cost-gating, and never artifacts that leave the user. */
  personaName: z.string().min(1).max(60).optional(),
  verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
  tone: z.enum(['professional', 'friendly', 'playful']).optional(),
});

const patchInstanceBody = z.object({
  autonomyLevel: z.enum(['low', 'medium', 'high']).optional(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).optional(),
  timezone: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(64).optional(),
  company: z.string().min(1).max(120).optional(),
  /** Persona controls — see provisionBody. Pass empty string to clear a
   *  field back to default; omit to leave unchanged. */
  personaName: z.string().max(60).optional(),
  verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
  tone: z.enum(['professional', 'friendly', 'playful']).optional(),
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
  /** Free-form user role/title (e.g. "Founder / CEO"). ≤64 chars.
   *  Persisted on the instance + fed into research/welcome prompts. */
  role: z.string().min(1).max(64).optional(),
  /** Company name the user works at. ≤120 chars. */
  company: z.string().min(1).max(120).optional(),
  /** Optional persona controls — see provisionBody. */
  personaName: z.string().min(1).max(60).optional(),
  verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
  tone: z.enum(['professional', 'friendly', 'playful']).optional(),
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

router.patch('/v1/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  const json = await safeJson(c);
  const parsed = patchInstanceBody.safeParse(json);
  if (!parsed.success) {
    return problemJson(
      c,
      new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body', userId),
    );
  }
  try {
    const row = await prisma.hermesInstance.findUnique({ where: { userId } });
    if (!row || row.destroyedAt) throw notFound(userId);
    const autonomyChanged =
      parsed.data.autonomyLevel !== undefined && parsed.data.autonomyLevel !== row.autonomyLevel;
    const timezoneChanged =
      parsed.data.timezone !== undefined && parsed.data.timezone !== row.timezone;
    // Persona: empty string clears a field back to default (null); a value
    // sets it; omitted leaves it unchanged.
    const normPersona = (v: string | undefined): string | null | undefined =>
      v === undefined ? undefined : v.trim() === '' ? null : v.trim().slice(0, 60);
    const personaName = normPersona(parsed.data.personaName);
    const personaChanged =
      (personaName !== undefined && personaName !== row.personaName) ||
      (parsed.data.verbosity !== undefined && parsed.data.verbosity !== row.verbosity) ||
      (parsed.data.tone !== undefined && parsed.data.tone !== row.tone);
    const updated = await prisma.hermesInstance.update({
      where: { id: row.id },
      data: {
        ...(parsed.data.autonomyLevel ? { autonomyLevel: parsed.data.autonomyLevel } : {}),
        ...(parsed.data.name ? { name: parsed.data.name.slice(0, 200) } : {}),
        ...(parsed.data.email ? { email: parsed.data.email.slice(0, 254) } : {}),
        ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
        ...(parsed.data.role !== undefined ? { role: parsed.data.role.slice(0, 64) } : {}),
        ...(parsed.data.company !== undefined ? { company: parsed.data.company.slice(0, 120) } : {}),
        ...(personaName !== undefined ? { personaName } : {}),
        ...(parsed.data.verbosity !== undefined ? { verbosity: parsed.data.verbosity } : {}),
        ...(parsed.data.tone !== undefined ? { tone: parsed.data.tone } : {}),
      },
    });

    if (autonomyChanged || timezoneChanged) {
      // Re-sync system schedules so high-only rows appear/disappear and
      // local-time crons rebind to the new timezone.
      try {
        const integrations = await prisma.integration.findMany({
          where: { instanceId: row.id, status: 'connected' },
          select: { provider: true },
        });
        const providers = new Set(integrations.map((i) => i.provider));
        const hasMailOrCalendar =
          providers.has('gmail') ||
          providers.has('outlook') ||
          providers.has('google_calendar') ||
          providers.has('outlook_calendar');
        const autonomy =
          updated.autonomyLevel === 'low' || updated.autonomyLevel === 'high'
            ? updated.autonomyLevel
            : 'medium';
        const { syncSystemSchedules } = await import('../schedules/system-schedules.js');
        await syncSystemSchedules({
          instanceId: row.id,
          userId: row.userId,
          autonomy: autonomy as 'low' | 'medium' | 'high',
          timezone: updated.timezone ?? 'UTC',
          sokosumiConfigured: true,
          hasMailOrCalendar,
        });
      } catch (err) {
        logger.warn({ err, userId }, 'patch_instance_resync_schedules_failed');
      }

      if (autonomyChanged) {
        // Best-effort nudge so Hermes' memory tracks the new contract.
        // Fire-and-forget; the DB row is the source of truth either way.
        void notifyAutonomyChanged(row.id, updated.autonomyLevel).catch((err) =>
          logger.warn({ err, userId }, 'autonomy_memory_nudge_failed'),
        );
      }
    }

    if (personaChanged) {
      // Fire-and-forget: push the new persona to the live agent's memory
      // so the voice changes immediately, not just on the next reboot.
      void notifyPersonaChanged(row.id).catch((err) =>
        logger.warn({ err, userId }, 'persona_memory_nudge_failed'),
      );
    }

    return c.json({
      autonomyLevel: updated.autonomyLevel,
      name: updated.name,
      email: updated.email,
      timezone: updated.timezone,
      personaName: updated.personaName,
      verbosity: updated.verbosity,
      tone: updated.tone,
    });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

async function notifyPersonaChanged(instanceId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || !row.endpointUrl) return;
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') return;
  const { decryptSecret } = await import('../crypto.js');
  const { buildPersonaDirective } = await import('../provision/profile.js');
  const apiKey = await decryptSecret(row.apiServerKey);
  const directive = buildPersonaDirective({
    personaName: row.personaName,
    verbosity: row.verbosity,
    tone: row.tone,
  });
  // When the user cleared everything, directive is '' — tell the agent to
  // drop its persona overrides and revert to default voice.
  const prompt = directive
    ? `Internal — your reply is discarded. The user updated your persona settings. ${directive}\n\nReply only "ok".`
    : `Internal — your reply is discarded. The user cleared your custom persona settings. Remove the memory key user.persona and revert to your default name and default voice (balanced length, friendly-professional tone). Reply only "ok".`;
  await fetch(`${row.endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function notifyAutonomyChanged(instanceId: string, newLevel: string): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || !row.endpointUrl) return;
  const { decryptSecret } = await import('../crypto.js');
  const apiKey = await decryptSecret(row.apiServerKey);
  const prompt = `Internal — your reply is discarded. Your autonomy level has changed to "${newLevel}". Update your memory with this fact. At low you may only read; at medium your write/spend tool calls are intercepted by the orchestrator and require user approval before executing; at high you may act autonomously while respecting the cost rules in your SOUL. Reply only "ok".`;
  await fetch(`${row.endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

router.get('/v1/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  try {
    const view = await getInstance(userId);
    const integrations = await listIntegrations(userId);
    const { listPendingConfirmations } = await import('../confirmations/store.js');
    const pendingConfirmations = await listPendingConfirmations(view.instanceId);
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
      lastSokosumiSyncAt: view.lastSokosumiSyncAt?.toISOString() ?? null,
      sokosumiEnv: view.sokosumiEnv,
      autonomyLevel: view.autonomyLevel,
      timezone: view.timezone,
      role: view.role,
      company: view.company,
      personaName: view.personaName,
      verbosity: view.verbosity,
      tone: view.tone,
      transitioning,
      integrations: integrations.map((i) => ({
        provider: i.provider,
        status: i.status,
        mode: i.mode,
        connectedAt: i.connectedAt?.toISOString() ?? null,
        lastError: i.lastError,
      })),
      pendingConfirmations,
    });
  } catch (err) {
    return mapError(c, err, userId);
  }
});

router.post('/v1/instances/:userId/integrations', async (c) => {
  const userId = c.req.param('userId');
  const json = await safeJson(c);
  // Log the inbound attempt BEFORE validation so when a user reports
  // "Sokosumi showed an unknown connection error" we can tell whether
  // the POST even reached us (and with what shape) vs. fell over upstream
  // in the Composio popup / Sokosumi /finalize path. Redact mcpToken; the
  // URL host is useful but the full URL can carry user_id-style scoping.
  const inboundShape = (() => {
    if (!json || typeof json !== 'object') return { shape: 'non-object' as const };
    const j = json as Record<string, unknown>;
    let host: string | null = null;
    if (typeof j.mcpUrl === 'string') {
      try { host = new URL(j.mcpUrl).host; } catch { host = 'malformed-url'; }
    }
    return {
      provider: j.provider,
      hasMcpUrl: typeof j.mcpUrl === 'string' && j.mcpUrl.length > 0,
      mcpUrlHost: host,
      hasMcpToken: typeof j.mcpToken === 'string' && j.mcpToken.length > 0,
      mode: j.mode,
    };
  })();
  logger.info({ userId, inbound: inboundShape }, 'integration_post_inbound');

  const parsed = integrationBody.safeParse(json);
  if (!parsed.success) {
    logger.warn(
      { userId, inbound: inboundShape, issue: parsed.error.issues[0]?.message },
      'integration_post_rejected_invalid_body',
    );
    return problemJson(
      c,
      new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'invalid body', userId),
    );
  }
  if (!isSupportedProvider(parsed.data.provider)) {
    logger.warn(
      { userId, provider: parsed.data.provider },
      'integration_post_rejected_unsupported_provider',
    );
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

    // Patch name/email/role/company + persona if provided.
    if (
      parsed.data.name ||
      parsed.data.email ||
      parsed.data.role ||
      parsed.data.company ||
      parsed.data.personaName ||
      parsed.data.verbosity ||
      parsed.data.tone
    ) {
      await prisma.hermesInstance.update({
        where: { id: row.id },
        data: {
          name: parsed.data.name?.slice(0, 200) ?? row.name,
          email: parsed.data.email?.slice(0, 254) ?? row.email,
          role: parsed.data.role?.slice(0, 64) ?? row.role,
          company: parsed.data.company?.slice(0, 120) ?? row.company,
          personaName: parsed.data.personaName?.slice(0, 60) ?? row.personaName,
          verbosity: parsed.data.verbosity ?? row.verbosity,
          tone: parsed.data.tone ?? row.tone,
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
