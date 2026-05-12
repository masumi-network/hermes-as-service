import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { FlyClient } from '../fly/client.js';
import { encryptSecret, decryptSecret, generateApiServerKey } from '../crypto.js';
import { conflict, notFound, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';
import { runOnboarding } from './onboarding.js';

export interface ProvisionInput {
  userId: string;
  /** Display name. Optional but recommended — enables research-intro + personalization. */
  name?: string;
  /** Email. Optional — same purpose as name. */
  email?: string;
  region?: string;
}

export interface InstanceView {
  instanceId: string;
  userId: string;
  status: string;
  endpointUrl: string | null;
  lastActivityAt: Date;
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
  if (existing) return toView(existing);

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
            // Always-on: no auto-stop. The whole point of moving off Sprites.
          },
        ],
        restart: { policy: 'always' },
      },
    });

    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { spriteId: machine.id, endpointUrl },
    });
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'service_registered',
      detail: { machineId: machine.id, endpointUrl },
    });

    log.info({ machineId: machine.id }, 'waiting for machine to reach started state');
    await fly.waitForState(row.spriteName, machine.id, 'started', 180);

    log.info({ endpointUrl }, 'instance ready');
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { status: 'running', lastActivityAt: new Date(), errorMessage: null },
    });
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'ready',
      detail: { endpointUrl },
    });

    // Onboarding: welcome message + boot prompt that sets up research +
    // daily cron. Runs after status flips to running so a slow Hermes
    // boot or research call doesn't keep the provision in "provisioning".
    // Wait a few seconds for Hermes' API server to actually be listening
    // (machine "started" doesn't mean Python is fully up).
    setTimeout(() => {
      void runOnboarding(instanceId).catch((err) =>
        log.error({ err }, 'onboarding_failed'),
      );
    }, 15_000);
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
  if (!row) throw notFound(userId);
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

export async function destroyInstance(userId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  const fly = new FlyClient();
  try {
    // Deleting the app removes the machine + volume + DNS.
    await fly.deleteApp(row.spriteName);
  } catch (err) {
    logger.error({ err, userId, appName: row.spriteName }, 'fly_app_delete_failed');
  }
  await recordEvent({ userId: row.userId, instanceId: row.id, event: 'destroyed' });
  await prisma.hermesInstance.delete({ where: { id: row.id } });
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
}): InstanceView {
  return {
    instanceId: row.id,
    userId: row.userId,
    status: row.status,
    endpointUrl: row.endpointUrl,
    lastActivityAt: row.lastActivityAt,
  };
}

// Re-export the install-skills script content so sync-config can still
// reference it (even though it's now a no-op on Fly — image bakes skills).
// Kept as an empty placeholder so the existing import chain doesn't break.
export const INSTALL_SKILLS_SCRIPT = '#!/usr/bin/env bash\n# Skills are baked into the image on Fly; this is a no-op.\nexit 0\n';
