import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { FlyClient } from '../fly/client.js';
import { conflict, notFound, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';
import { loadConfig } from '../config.js';

/** Providers supported in the v1 integration set. Keep this list authoritative. */
export const SUPPORTED_PROVIDERS = [
  'gmail',
  'google_calendar',
  'outlook',
  'outlook_calendar',
] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(p: string): p is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

export interface AddIntegrationInput {
  userId: string;
  provider: Provider;
  /** Plaintext MCP HTTP URL (Composio per-user URL). Encrypted at rest. */
  mcpUrl: string;
  /** Plaintext bearer token, optional if auth is baked into the URL. */
  mcpToken?: string;
}

export interface IntegrationView {
  provider: string;
  status: string;
  connectedAt: Date | null;
  lastError: string | null;
}

/**
 * Connect an integration. Two paths:
 *
 *   1. Machine ready (status in {ready, infrastructure_ready, suspended}
 *      AND spriteId set) — persist + patchMachineEnv + restartMachine.
 *      Status: connecting → connected, or → error on failure.
 *
 *   2. Machine NOT ready (no instance row, no spriteId, or instance is
 *      provisioning/destroyed/error) — persist with status=pending and
 *      skip the Fly side entirely. The next provision pipeline bakes
 *      pending integrations into MCP_SERVERS_JSON at machine-create time
 *      and flips them to connected once the machine is started.
 *
 *      This is the path Sokosumi's UI uses: users click Connect Gmail on
 *      the onboarding screen BEFORE the Hermes machine is fully ready,
 *      and again on session-2 after we've destroyed the prior machine.
 *
 * Idempotent on (userId, provider) — re-adding the same provider replaces
 * the previous URL/token.
 *
 * If the user has no HermesInstance row yet, we throw 404 — Sokosumi must
 * still call POST /v1/instances first to materialize the row (cheap;
 * doesn't block on Fly).
 */
export async function addIntegration(input: AddIntegrationInput): Promise<IntegrationView> {
  const instance = await prisma.hermesInstance.findUnique({ where: { userId: input.userId } });
  if (!instance) throw notFound(input.userId);

  const encUrl = await encryptSecret(input.mcpUrl);
  const encToken = await encryptSecret(input.mcpToken ?? '');

  // First gate: DB state. If the instance is provisioning / destroyed / has
  // no spriteId, definitely queue.
  const dbSaysReady =
    instance.spriteId !== null &&
    instance.destroyedAt === null &&
    (instance.status === 'ready' ||
      instance.status === 'infrastructure_ready' ||
      instance.status === 'running' ||
      instance.status === 'suspended');

  // Second gate: Fly truth. Even if our DB thinks the machine is ready,
  // it could be mid-`replacing` (e.g. from a recent env patch) — in which
  // case we can't apply now. Skip the Fly check if the DB already says no.
  let machineReady = dbSaysReady;
  if (machineReady) {
    try {
      const fly = new FlyClient();
      const m = await fly.getMachine(instance.spriteName, instance.spriteId!);
      machineReady = m?.state === 'started';
    } catch (err) {
      logger.warn({ err, userId: input.userId }, 'fly_state_precheck_failed_queuing');
      machineReady = false;
    }
  }

  // Path 2: queue as pending. No Fly work.
  if (!machineReady) {
    const row = await prisma.integration.upsert({
      where: { userId_provider: { userId: input.userId, provider: input.provider } },
      create: {
        instanceId: instance.id,
        userId: input.userId,
        provider: input.provider,
        mcpUrl: encUrl,
        mcpToken: encToken,
        status: 'pending',
      },
      update: {
        mcpUrl: encUrl,
        mcpToken: encToken,
        status: 'pending',
        lastError: null,
        instanceId: instance.id,
      },
    });
    await recordEvent({
      userId: input.userId,
      instanceId: instance.id,
      event: 'integration_connecting',
      detail: { provider: input.provider, queued: true, reason: `instance.status=${instance.status}` },
    });
    return toView(row);
  }

  // Path 1: machine ready. Upsert in "connecting" and apply.
  const row = await prisma.integration.upsert({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
    create: {
      instanceId: instance.id,
      userId: input.userId,
      provider: input.provider,
      mcpUrl: encUrl,
      mcpToken: encToken,
      status: 'connecting',
    },
    update: {
      mcpUrl: encUrl,
      mcpToken: encToken,
      status: 'connecting',
      lastError: null,
      instanceId: instance.id,
    },
  });

  await recordEvent({
    userId: input.userId,
    instanceId: instance.id,
    event: 'integration_connecting',
    detail: { provider: input.provider },
  });

  try {
    const mcpJson = await buildMcpServersJsonForUser(input.userId);
    const fly = new FlyClient();
    // patchMachineEnv: Fly's machine-update endpoint replaces the machine
    // in-place to apply the new config. The machine transitions
    // `started → replacing → started` automatically; do NOT call restart
    // here (that was the source of the prior 412 / unsupported-state
    // errors — calling restart on a machine that's already restarting).
    await fly.patchMachineEnv(instance.spriteName, instance.spriteId!, {
      MCP_SERVERS_JSON: mcpJson,
    });
    // Wait for the replace to settle. 90s is generous; usually ~30s.
    await fly.waitForState(instance.spriteName, instance.spriteId!, 'started', 90);

    const updated = await prisma.integration.update({
      where: { id: row.id },
      data: { status: 'connected', connectedAt: new Date(), lastError: null },
    });
    await recordEvent({
      userId: input.userId,
      instanceId: instance.id,
      event: 'integration_connected',
      detail: { provider: input.provider },
    });
    return toView(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, userId: input.userId, provider: input.provider },
      'integration_apply_failed_queuing',
    );
    // Fall back to pending — next provision cycle will bake it in.
    // Sokosumi sees "pending" + lastError so they know it's queued not dead.
    const updated = await prisma.integration.update({
      where: { id: row.id },
      data: { status: 'pending', lastError: message.slice(0, 1000) },
    });
    await recordEvent({
      userId: input.userId,
      instanceId: instance.id,
      event: 'integration_failed',
      detail: { provider: input.provider, message: message.slice(0, 300), queued: true },
    });
    return toView(updated);
  }
}

export async function removeIntegration(userId: string, provider: string): Promise<void> {
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance) throw notFound(userId);

  await prisma.integration.deleteMany({ where: { userId, provider } });

  // Re-push the trimmed MCP env to the machine.
  if (instance.spriteId && (instance.status === 'ready' || instance.status === 'infrastructure_ready' || instance.status === 'running')) {
    const mcpJson = await buildMcpServersJsonForUser(userId);
    const fly = new FlyClient();
    try {
      await fly.patchMachineEnv(instance.spriteName, instance.spriteId, {
        MCP_SERVERS_JSON: mcpJson || '[]',
      });
      await fly.restartMachine(instance.spriteName, instance.spriteId);
    } catch (err) {
      logger.error(
        { err, userId, provider },
        'integration_remove_fly_patch_failed',
      );
      // We don't surface this — the integration is already deleted from our DB.
      // Worst case, the next restart from any other cause picks up the new env.
    }
  }

  await recordEvent({
    userId,
    instanceId: instance.id,
    event: 'integration_removed',
    detail: { provider },
  });
}

/**
 * Called by runFlyPipeline once the new machine has reached `started`.
 * Flips every pending/connecting integration to `connected`, because the
 * machine boots with MCP_SERVERS_JSON containing all of them. Idempotent.
 */
export async function markPendingIntegrationsConnected(userId: string): Promise<void> {
  await prisma.integration.updateMany({
    where: { userId, status: { in: ['pending', 'connecting'] } },
    data: { status: 'connected', connectedAt: new Date(), lastError: null },
  });
}

export async function listIntegrations(userId: string): Promise<IntegrationView[]> {
  const rows = await prisma.integration.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

/**
 * Build the JSON blob to set as MCP_SERVERS_JSON env on a Fly machine.
 * Composio's auth model: one org-wide API key (COMPOSIO_API_KEY) sent as
 * the `x-api-key` header on every MCP HTTP call. Per-user identity is
 * scoped via the `?user_id=` query param Composio already bakes into each
 * connection URL.
 *
 * Emits the array shape the hermes-user-launcher expects:
 *   [{ name, url, headers: { "x-api-key": "<key>", ... } }]
 *
 * Returns "[]" if the user has no connected integrations.
 */
export async function buildMcpServersJsonForUser(userId: string): Promise<string> {
  const rows = await prisma.integration.findMany({
    where: { userId, status: { in: ['connected', 'connecting', 'pending'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return '[]';

  const cfg = loadConfig();
  const composioKey = cfg.COMPOSIO_API_KEY;

  const entries: { name: string; url: string; headers: Record<string, string> }[] = [];
  for (const row of rows) {
    try {
      const url = await decryptSecret(row.mcpUrl);
      const headers: Record<string, string> = {};
      // Composio: x-api-key. Heuristic: if the URL points at any composio
      // host, attach the org key. Other brokers (future) would slot in here.
      if (composioKey && /(composio\.dev|composio\.ai)/i.test(url)) {
        headers['x-api-key'] = composioKey;
      }
      // Legacy: if Sokosumi passed a per-integration token (mcpToken) we
      // honor it as Authorization: Bearer for non-Composio brokers. For
      // Composio we ignore it — the org key wins.
      if (row.mcpToken) {
        const legacyToken = await decryptSecret(row.mcpToken);
        if (legacyToken && !headers['x-api-key']) {
          headers['Authorization'] = `Bearer ${legacyToken}`;
        }
      }
      entries.push({ name: row.provider, url, headers });
    } catch (err) {
      logger.error(
        { err, userId, provider: row.provider },
        'mcp_decrypt_failed_skipping_row',
      );
    }
  }
  return JSON.stringify(entries);
}

function toView(row: {
  provider: string;
  status: string;
  connectedAt: Date | null;
  lastError: string | null;
}): IntegrationView {
  return {
    provider: row.provider,
    status: row.status,
    connectedAt: row.connectedAt,
    lastError: row.lastError,
  };
}

// suppress unused warning for the import in some configs
void upstream;
