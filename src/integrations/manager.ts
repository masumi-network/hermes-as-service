import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { FlyClient } from '../fly/client.js';
import { conflict, notFound, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';

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
 * Connect an integration: persist (encrypted) + push the new MCP_SERVERS_JSON
 * blob into the Fly machine and restart it so Hermes picks up the new
 * mcp_servers entry on next boot.
 *
 * Idempotent on (userId, provider) — re-adding the same provider replaces
 * the previous URL/token.
 *
 * Returns the integration row view. Status starts at "connecting" and flips
 * to "connected" once the machine restart completes. On any error the row
 * is left at status="failed" with lastError populated.
 */
export async function addIntegration(input: AddIntegrationInput): Promise<IntegrationView> {
  const instance = await prisma.hermesInstance.findUnique({ where: { userId: input.userId } });
  if (!instance) throw notFound(input.userId);
  if (instance.status === 'provisioning' || instance.status === 'error') {
    throw conflict(input.userId, `Instance not ready for integration (status=${instance.status})`);
  }
  if (!instance.spriteId) {
    throw conflict(input.userId, 'Instance has no machine yet');
  }

  const encUrl = await encryptSecret(input.mcpUrl);
  const encToken = await encryptSecret(input.mcpToken ?? '');

  // Upsert the row in "connecting" status. The Fly restart is the gating
  // operation; we'll flip to "connected" once it returns.
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

  // Push to Fly + restart. Failures mark the row as failed but don't
  // tear down the instance.
  try {
    const mcpJson = await buildMcpServersJsonForUser(input.userId);
    const fly = new FlyClient();
    await fly.patchMachineEnv(instance.spriteName, instance.spriteId, {
      MCP_SERVERS_JSON: mcpJson,
    });
    await fly.restartMachine(instance.spriteName, instance.spriteId);
    await fly.waitForState(instance.spriteName, instance.spriteId, 'started', 60);

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
      'integration_apply_failed',
    );
    const updated = await prisma.integration.update({
      where: { id: row.id },
      data: { status: 'failed', lastError: message.slice(0, 1000) },
    });
    await recordEvent({
      userId: input.userId,
      instanceId: instance.id,
      event: 'integration_failed',
      detail: { provider: input.provider, message: message.slice(0, 300) },
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

export async function listIntegrations(userId: string): Promise<IntegrationView[]> {
  const rows = await prisma.integration.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toView);
}

/**
 * Build the JSON blob to set as MCP_SERVERS_JSON env on a Fly machine.
 * Decrypts URL + token per integration and emits the array shape the
 * hermes-user-launcher expects:
 *   [{ name, url, token }]
 *
 * Returns "[]" if the user has no connected integrations.
 */
export async function buildMcpServersJsonForUser(userId: string): Promise<string> {
  const rows = await prisma.integration.findMany({
    where: { userId, status: { in: ['connected', 'connecting'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return '[]';

  const entries: { name: string; url: string; token: string }[] = [];
  for (const row of rows) {
    try {
      const url = await decryptSecret(row.mcpUrl);
      const token = row.mcpToken ? await decryptSecret(row.mcpToken) : '';
      entries.push({ name: row.provider, url, token });
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
