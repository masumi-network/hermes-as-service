import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { FlyClient } from '../fly/client.js';
import { encryptSecret, decryptSecret, generateApiServerKey } from '../crypto.js';
import { conflict, notFound, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';
import { runReturningUserBoot } from './onboarding.js';
import { buildMcpServersJsonForUser, markPendingIntegrationsConnected } from '../integrations/manager.js';
import { purgeSokosumiMirror } from '../sokosumi/client.js';

export interface ProvisionInput {
  userId: string;
  /** Display name. Optional but recommended — enables research-intro + personalization. */
  name?: string;
  /** Email. Optional — same purpose as name. */
  email?: string;
  region?: string;
  /** Which Sokosumi backend (dev/preprod/mainnet) this user lives in. */
  sokosumiEnv?: 'development' | 'preprod' | 'mainnet';
  /** How much autonomy the agent gets ("low" | "medium" | "high"). */
  autonomyLevel?: 'low' | 'medium' | 'high';
  /** IANA timezone for user-facing recurring prompts. Defaults to UTC. */
  timezone?: string;
  /** Optional persona customization. All unset = default behavior. */
  personaName?: string;
  verbosity?: 'brief' | 'balanced' | 'detailed';
  tone?: 'professional' | 'friendly' | 'playful';
}

export interface InstanceView {
  instanceId: string;
  userId: string;
  status: string;
  endpointUrl: string | null;
  lastActivityAt: Date;
  onboardedAt: Date | null;
  welcomeMessage: string | null;
  welcomeKind: string | null;
  lastSokosumiSyncAt: Date | null;
  sokosumiEnv: string | null;
  autonomyLevel: string;
  timezone: string | null;
  role: string | null;
  company: string | null;
  personaName: string | null;
  verbosity: string | null;
  tone: string | null;
}

/**
 * Provision a per-user Hermes instance on Fly Machines (one Fly app per
 * user, one always-on machine inside each app). Idempotent: re-calls for
 * the same userId return the existing row without creating a new app.
 *
 * Returns immediately; the actual Fly API calls happen in a background
 * async pipeline. Poll GET /v1/instances/:userId for `status === "running"`.
 */
export async function provision(input: ProvisionInput): Promise<InstanceView> {
  const cfg = loadConfig();
  const existing = await prisma.hermesInstance.findUnique({ where: { userId: input.userId } });

  // Live row — return as-is (idempotent). Destroyed rows no longer exist
  // (destroy hard-deletes), so any row we find here is live.
  if (existing) {
    // A prior attempt that ERRORED (e.g. a Fly boot timeout) must be
    // retryable — otherwise re-POST just returns the stuck error row forever
    // and the user can never recover. Tear down the (possibly orphaned) old
    // app + row, then fall through to a fresh provision below.
    if (existing.status === 'error') {
      logger.info({ userId: input.userId, instanceId: existing.id }, 'reprovisioning_errored_instance');
      try {
        await new FlyClient().deleteApp(existing.spriteName);
      } catch (err) {
        logger.warn({ err, appName: existing.spriteName }, 'reprovision_cleanup_deleteapp_failed');
      }
      await prisma.hermesInstance.delete({ where: { id: existing.id } }).catch(() => {});
    } else {
      return toView(existing);
    }
  }

  const appName = generateAppName(input.userId);
  const region = input.region ?? cfg.FLY_REGION;
  const plaintextApiKey = await generateApiServerKey();
  const plaintextLlmToken = await generateApiServerKey();
  const encryptedApiKey = await encryptSecret(plaintextApiKey);
  const encryptedLlmToken = await encryptSecret(plaintextLlmToken);
  const encryptedOpenRouter = await encryptSecret(cfg.OPENROUTER_API_KEY);

  const row = await prisma.hermesInstance.create({
    data: {
      userId: input.userId,
      spriteName: appName,
      region,
      apiServerKey: encryptedApiKey,
      llmProxyToken: encryptedLlmToken,
      openRouterKey: encryptedOpenRouter,
      name: input.name?.slice(0, 200) ?? null,
      email: input.email?.slice(0, 254) ?? null,
      sokosumiEnv: input.sokosumiEnv ?? null,
      autonomyLevel: input.autonomyLevel ?? 'medium',
      timezone: input.timezone ?? null,
      personaName: input.personaName?.slice(0, 60) ?? null,
      verbosity: input.verbosity ?? null,
      tone: input.tone ?? null,
      status: 'provisioning',
    },
  });
  await recordEvent({
    userId: row.userId,
    instanceId: row.id,
    event: 'created',
    detail: { appName, region, host: 'fly' },
  });

  // Kick off async pipeline.
  void runFlyPipeline(row.id, plaintextApiKey, plaintextLlmToken).catch((err) => {
    logger.error({ err, userId: input.userId, instanceId: row.id }, 'provision_pipeline_failed');
  });

  return toView(row);
}

async function runFlyPipeline(
  instanceId: string,
  apiServerKey: string,
  llmProxyToken: string,
): Promise<void> {
  const cfg = loadConfig();
  const fly = new FlyClient();
  const row = await prisma.hermesInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const log = logger.child({ instanceId, userId: row.userId, appName: row.spriteName });

  try {
    log.info({ region: row.region }, 'creating fly app');
    await recordEvent({ userId: row.userId, instanceId, event: 'creating_sprite' });
    await fly.createApp(row.spriteName);

    log.info('allocating public IPs');
    await fly.ensurePublicIps(row.spriteName);

    log.info('creating volume');
    const volume = await fly.createVolume(row.spriteName, {
      name: 'hermes_data',
      region: row.region,
      size_gb: cfg.FLY_VOLUME_GB,
      encrypted: true,
    });
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { flyVolumeId: volume.id },
    });
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'sprite_created',
      detail: { volumeId: volume.id },
    });

    log.info({ image: cfg.FLY_MACHINE_IMAGE }, 'creating machine');
    const endpointUrl = `https://${row.spriteName}.fly.dev`;

    // Re-inject any existing integrations (returning users: their Composio
    // MCP URLs survive instance destroy because they're persisted by userId).
    const mcpServersJson = await buildMcpServersJsonForUser(row.userId);

    const machine = await fly.createMachine(row.spriteName, {
      region: row.region,
      config: {
        image: cfg.FLY_MACHINE_IMAGE,
        guest: {
          cpu_kind: cfg.FLY_CPU_KIND,
          cpus: cfg.FLY_CPUS,
          memory_mb: cfg.FLY_MEMORY_MB,
        },
        mounts: [{ volume: volume.id, path: '/opt/data' }],
        env: {
          // Hermes' API server
          API_SERVER_ENABLED: 'true',
          API_SERVER_HOST: '0.0.0.0',
          API_SERVER_PORT: '8642',
          API_SERVER_KEY: apiServerKey,
          API_SERVER_MODEL_NAME: 'hermes-agent',
          // LLM proxy (orchestrator-side; real OpenRouter key never lands here)
          OPENROUTER_API_KEY: llmProxyToken,
          OPENROUTER_BASE_URL: `${cfg.ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, '')}/v1/llm/${instanceId}`,
          // Hermes runtime
          HERMES_HOME: '/opt/data',
          TERMINAL_ENV: 'local',
          HERMES_QUIET: '1',
          GATEWAY_ALLOW_ALL_USERS: 'true',
          // Tools
          EXA_API_KEY: cfg.EXA_API_KEY,
          // MCP servers (Composio etc.) — empty array if user hasn't connected anything.
          // Hot-reloadable via patchMachineEnv + restart from integrations/manager.ts.
          MCP_SERVERS_JSON: mcpServersJson,
          // Bridge: cron output → orchestrator outbox (used by the
          // post_llm_call shell hook baked into the image)
          ORCHESTRATOR_BASE: cfg.ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, ''),
          INSTANCE_ID: instanceId,
          ORCHESTRATOR_OUTBOX_TOKEN: llmProxyToken,
        },
        services: [
          {
            ports: [
              { port: 443, handlers: ['tls', 'http'] },
              { port: 80, handlers: ['http'] },
            ],
            protocol: 'tcp',
            internal_port: 8642,
            // Always-on. Fly's default for new services is auto-stop after
            // a few minutes of idle traffic, which (a) breaks Hermes' built-in
            // cron and (b) makes /machines/:id/restart return 412 because
            // the machine ends up in `suspended` state. Pin everything to on.
            auto_stop_machines: 'off',
            auto_start_machines: false,
            min_machines_running: 1,
          },
        ],
        restart: { policy: 'always' },
      },
    });

    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: {
        spriteId: machine.id,
        endpointUrl,
        imageTag: cfg.FLY_MACHINE_IMAGE,
        imageRolledAt: new Date(),
      },
    });
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'service_registered',
      detail: { machineId: machine.id, endpointUrl, image: cfg.FLY_MACHINE_IMAGE },
    });

    log.info({ machineId: machine.id }, 'waiting for machine to reach started state');
    // 300s (not 180): a freshly-created Fly app must cold-pull the ~large
    // hermes-user image before the machine can reach 'started', which can
    // exceed 3 min. Too-tight a timeout marks a machine that IS coming up as
    // a failed provision.
    await fly.waitForState(row.spriteName, machine.id, 'started', 300);

    // Pending integrations baked into the machine's MCP_SERVERS_JSON above
    // are now live — flip them connected so Sokosumi sees green checkmarks.
    await markPendingIntegrationsConnected(row.userId);

    // Re-apply the user's installed marketplace skills onto this (possibly
    // fresh) machine. Idempotent + best-effort: makes skills survive a
    // destroy/re-create (the DB row is the source of truth) and retries any
    // install queued while the machine was down (setup-time picks included).
    try {
      const { replayInstalledSkills } = await import('../skills/manager.js');
      await replayInstalledSkills(instanceId);
    } catch (err) {
      log.warn({ err }, 'skills_replay_failed');
    }

    // Returning vs new user — decided by whether onboardedAt is set on this
    // HermesInstance row (which survives Fly destroy/re-create since the row
    // is keyed on userId, not Fly app id).
    const isReturning = row.onboardedAt !== null;
    if (isReturning) {
      log.info({ endpointUrl }, 'returning user: skipping onboarding screen');
      await prisma.hermesInstance.update({
        where: { id: instanceId },
        data: { status: 'ready', lastActivityAt: new Date(), errorMessage: null },
      });
      await recordEvent({
        userId: row.userId,
        instanceId,
        event: 'returning_user_resumed',
        detail: { endpointUrl },
      });
      // Push a short welcome-back message. Cheap path — no fresh research.
      setTimeout(() => {
        void runReturningUserBoot(instanceId).catch((err) =>
          log.error({ err }, 'returning_user_boot_failed'),
        );
      }, 8_000);
    } else {
      log.info({ endpointUrl }, 'new user: infrastructure ready, waiting for /onboard call');
      await prisma.hermesInstance.update({
        where: { id: instanceId },
        data: {
          status: 'infrastructure_ready',
          lastActivityAt: new Date(),
          errorMessage: null,
        },
      });
      await recordEvent({
        userId: row.userId,
        instanceId,
        event: 'infrastructure_ready',
        detail: { endpointUrl },
      });
    }
  } catch (err) {
    log.error({ err }, 'provision failed');
    const message = err instanceof Error ? err.message : String(err);
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { status: 'error', errorMessage: message },
    });
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'provision_failed',
      detail: { message },
    });
  }
}

export async function getInstance(userId: string): Promise<InstanceView> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  // Treat soft-deleted as not-found for the public API. The brief documents
  // 404 after DELETE; consumers should re-POST /v1/instances to revive.
  if (!row || row.destroyedAt) throw notFound(userId);
  return toView(row);
}

export async function resumeInstance(userId: string): Promise<InstanceView> {
  // On Fly always-on, "resume" is purely bookkeeping — the machine never
  // actually stops. We still expose this for spec compatibility with the
  // old Sprites flow that Sokosumi was integrating against.
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  if (row.status === 'provisioning' || row.status === 'error') {
    throw conflict(userId, `Cannot resume instance in status=${row.status}`);
  }
  const updated = await prisma.hermesInstance.update({
    where: { id: row.id },
    data: { status: 'running', lastActivityAt: new Date() },
  });
  await recordEvent({ userId: row.userId, instanceId: row.id, event: 'resumed' });
  return toView(updated);
}

export async function suspendInstance(userId: string): Promise<InstanceView> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  // Same: bookkeeping only on Fly always-on. The machine keeps running.
  const updated = await prisma.hermesInstance.update({
    where: { id: row.id },
    data: { status: 'suspended' },
  });
  await recordEvent({ userId: row.userId, instanceId: row.id, event: 'suspended' });
  return toView(updated);
}

/**
 * Hard-delete the instance: tear down Fly resources AND delete the DB
 * row + all cascading children (Integration, ScheduledTask, OutboxMessage,
 * ChatMessage, LlmUsage, PendingConfirmation; ProvisionEvent.instanceId
 * goes null). The next POST /v1/instances for the same userId is treated
 * as a brand-new user: full onboarding, full memory build, re-OAuth for
 * Gmail/Outlook/Calendar.
 *
 * Idempotent: destroying a userId that doesn't exist (already-destroyed
 * or never-provisioned) is a no-op.
 */
export async function destroyInstance(
  userId: string,
  opts: { purgeSokosumiMirror?: boolean } = {},
): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return; // idempotent — already gone
  // Audit the destroy BEFORE deleting the row so the ProvisionEvent
  // can still link to it (the FK is SetNull-on-delete, but recording
  // the event first means the instanceId is captured on the event row).
  await recordEvent({
    userId: row.userId,
    instanceId: row.id,
    event: 'destroyed',
    detail: { appName: row.spriteName },
  });
  if (row.spriteName) {
    try {
      // Deleting the app removes the machine + volume + DNS.
      await new FlyClient().deleteApp(row.spriteName);
    } catch (err) {
      logger.error({ err, userId, appName: row.spriteName }, 'fly_app_delete_failed');
      // Don't bail — we still want to nuke the DB state. A stale Fly
      // app is cheaper to leave behind than a stuck DB row.
    }
  }
  await prisma.hermesInstance.delete({ where: { id: row.id } });

  // Tell Sokosumi to purge its local mirror (chat history, assistant name, orb,
  // poll cursors). Skipped only when Sokosumi itself initiated the delete (it
  // cleans up on its own side). Best-effort + backgrounded so the destroy
  // response isn't blocked on the callback + its retries.
  if (opts.purgeSokosumiMirror !== false) {
    void purgeSokosumiMirror(row.userId, row.sokosumiEnv).catch(() => {});
  }
}

export async function setSecret(userId: string, key: string, value: string): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw conflict(userId, `Invalid secret key '${key}'; must match [A-Z_][A-Z0-9_]*`);
  }
  if (/^(API_SERVER_|HERMES_HOME$|OPENROUTER_API_KEY$|OPENROUTER_BASE_URL$|ORCHESTRATOR_)/.test(key)) {
    throw conflict(userId, `Reserved key '${key}'; orchestrator manages this internally`);
  }
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  if (row.status === 'provisioning') {
    throw conflict(userId, 'Instance still provisioning');
  }
  if (!row.spriteId) {
    throw conflict(userId, 'Instance has no machine id');
  }
  // TODO: hot-reload secrets on Fly via Machine env update API. For v1 the
  // image baked-in env vars are the source of truth and we'd need a
  // machine update + restart to push a new env. Punted until we have an
  // actual /secrets user.
  throw conflict(userId, 'Secret update on Fly hosts is not implemented yet');
}

export async function getDecryptedApiServerKey(userId: string): Promise<string> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  return decryptSecret(row.apiServerKey);
}

export async function touchActivity(userId: string): Promise<void> {
  await prisma.hermesInstance.updateMany({
    where: { userId },
    data: { lastActivityAt: new Date() },
  });
}

function generateAppName(userId: string): string {
  // Fly app names: lowercase letters, digits, hyphens. Max 30 chars.
  const safe = userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `hermes-${safe}-${suffix}`;
}

function toView(row: {
  id: string;
  userId: string;
  status: string;
  endpointUrl: string | null;
  lastActivityAt: Date;
  onboardedAt: Date | null;
  welcomeMessage: string | null;
  welcomeKind: string | null;
  lastSokosumiSyncAt: Date | null;
  sokosumiEnv: string | null;
  autonomyLevel: string;
  timezone: string | null;
  role: string | null;
  company: string | null;
  personaName: string | null;
  verbosity: string | null;
  tone: string | null;
}): InstanceView {
  return {
    instanceId: row.id,
    userId: row.userId,
    status: row.status,
    endpointUrl: row.endpointUrl,
    lastActivityAt: row.lastActivityAt,
    onboardedAt: row.onboardedAt,
    welcomeMessage: row.welcomeMessage,
    welcomeKind: row.welcomeKind,
    lastSokosumiSyncAt: row.lastSokosumiSyncAt,
    sokosumiEnv: row.sokosumiEnv,
    autonomyLevel: row.autonomyLevel,
    timezone: row.timezone,
    role: row.role,
    company: row.company,
    personaName: row.personaName,
    verbosity: row.verbosity,
    tone: row.tone,
  };
}
