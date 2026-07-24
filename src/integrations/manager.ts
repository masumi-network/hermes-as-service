import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { FlyClient } from '../fly/client.js';
import { conflict, notFound, upstream } from '../errors.js';
import { recordEvent } from '../audit.js';
import { loadConfig } from '../config.js';

/** Providers supported in the integration set. Keep this list authoritative.
 *  v1 (mail/calendar) + v2 batch (comms / dev / notes / CRM / social).
 *  Adding a new provider here: also update providerToolLabel() in onboarding.ts
 *  and verify the write-verb regex in mcp-proxy.ts covers its tool names. */
export const SUPPORTED_PROVIDERS = [
  // v1 — mail + calendar (always read-only by default)
  'gmail',
  'google_calendar',
  'outlook',
  'outlook_calendar',
  // v2 — comms / dev / notes / CRM / social
  'slack',
  'linear',
  'github',
  'notion',
  'hubspot',
  'twitter',
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
  /** "read" (default) or "write". See Integration.mode in schema. */
  mode?: 'read' | 'write';
}

export interface IntegrationView {
  provider: string;
  status: string;
  mode: string;
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
  const mode = input.mode ?? 'read';
  if (!machineReady) {
    const row = await prisma.integration.upsert({
      where: { userId_provider: { userId: input.userId, provider: input.provider } },
      create: {
        instanceId: instance.id,
        userId: input.userId,
        provider: input.provider,
        mcpUrl: encUrl,
        mcpToken: encToken,
        mode,
        status: 'pending',
      },
      update: {
        mcpUrl: encUrl,
        mcpToken: encToken,
        mode,
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

  // O4 short-circuit: if there's already a connected row with the same
  // URL + mode, this POST is a no-op (Sokosumi retry, double-click).
  // Skip the patch+restart cycle entirely.
  const existing = await prisma.integration.findUnique({
    where: { userId_provider: { userId: input.userId, provider: input.provider } },
  });
  if (existing && existing.status === 'connected' && existing.mode === mode) {
    try {
      const existingUrlPlain = await decryptSecret(existing.mcpUrl);
      if (existingUrlPlain === input.mcpUrl) {
        logger.info(
          { userId: input.userId, provider: input.provider },
          'integration_noop_skip',
        );
        return toView(existing);
      }
    } catch {
      // Decrypt failure → treat as if no match, fall through.
    }
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
      mode,
      status: 'connecting',
    },
    update: {
      mcpUrl: encUrl,
      mcpToken: encToken,
      mode,
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

    // The restart also re-registered the current MCP tool catalog — stamp it
    // so the capability-roll sweep doesn't bounce this machine a second time.
    try {
      const { stampMcpToolsVersion } = await import('../provision/mcp-tools-roll.js');
      await stampMcpToolsVersion(instance.id);
    } catch {
      /* best-effort — a missed stamp just costs one redundant idle roll */
    }

    const updated = await prisma.integration.update({
      where: { id: row.id },
      data: { status: 'connected', connectedAt: new Date(), lastError: null },
    });
    // Any OTHER integrations that were stuck in 'pending' (because a prior
    // rapid-fire connect raced with this machine restart) physically live
    // in the new machine's MCP_SERVERS_JSON now — reconcile their status.
    await markPendingIntegrationsConnected(input.userId);
    await recordEvent({
      userId: input.userId,
      instanceId: instance.id,
      event: 'integration_connected',
      detail: { provider: input.provider },
    });
    // Fire-and-forget: tell the agent its memory needs to drop any
    // "<provider> isn't connected" note. The POST has already returned
    // to Sokosumi — this just runs in the background. See
    // notifyIntegrationConnected for the rationale.
    void (async () => {
      try {
        const { notifyIntegrationConnected } = await import('./notify-connected.js');
        await notifyIntegrationConnected(instance.id, input.provider);
      } catch (err) {
        logger.warn({ err, userId: input.userId, provider: input.provider }, 'integration_notify_threw');
      }
    })();
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
      // patchMachineEnv already triggers Fly's replace+restart. Wait for
      // settle, then reconcile any pending integrations.
      await fly.waitForState(instance.spriteName, instance.spriteId, 'started', 90);
      await markPendingIntegrationsConnected(userId);
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
 *
 * The Hermes machine receives ONLY orchestrator-proxy URLs — never the
 * real Composio URLs and never the COMPOSIO_API_KEY. Hermes authenticates
 * to the orchestrator with its per-instance bearer (llmProxyToken, same
 * one the LLM proxy and outbox endpoint use). The orchestrator looks up
 * the actual Composio URL per request, attaches x-api-key server-side,
 * forwards to Composio, streams the response back.
 *
 * Why this matters: if a user runs Hermes' shell tool and `cat`s
 * /opt/data/config.yaml, the worst they extract is their own per-instance
 * bearer — which only works for their own instance and is rotatable. The
 * Composio org-wide key stays in our Railway env.
 *
 * Emits the array shape the hermes-user-launcher expects:
 *   [{ name, url: <orchestrator-proxy>, headers: { Authorization: "Bearer <token>" } }]
 *
 * Returns "[]" if the user has no connected integrations.
 */
export async function buildMcpServersJsonForUser(userId: string): Promise<string> {
  // Need the instanceId + plaintext per-instance bearer to build the
  // proxy URL + auth header the Fly machine will use to call us.
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || !instance.llmProxyToken) {
    logger.warn({ userId }, 'mcp_build_no_instance_or_token');
    return '[]';
  }
  let proxyToken: string;
  try {
    proxyToken = await decryptSecret(instance.llmProxyToken);
  } catch (err) {
    logger.error({ err, userId }, 'mcp_build_token_decrypt_failed');
    return '[]';
  }

  const rows = await prisma.integration.findMany({
    where: { userId, status: { in: ['connected', 'connecting', 'pending'] } },
    orderBy: { createdAt: 'asc' },
  });

  const cfg = loadConfig();
  const base = cfg.ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, '');

  const entries: { name: string; url: string; headers: Record<string, string> }[] = [];
  for (const row of rows) {
    entries.push({
      name: row.provider,
      url: `${base}/v1/mcp/${instance.id}/${row.provider}`,
      headers: { Authorization: `Bearer ${proxyToken}` },
    });
  }
  // Always-on: the Sokosumi MCP server is auto-injected. Gives Hermes
  // 8 live-query tools (list_tasks, get_task, get_job with full result,
  // etc.). Hermes connects whether or not the user has Composio
  // integrations — Sokosumi is the user's home, not a third-party app.
  // The MCP server itself graceful-degrades if SOKOSUMI_COWORKER_API_KEY_*
  // isn't configured for the instance's env (tool calls return an error
  // string Hermes can surface).
  entries.push({
    name: 'sokosumi',
    url: `${base}/v1/sokosumi-mcp/${instance.id}`,
    headers: { Authorization: `Bearer ${proxyToken}` },
  });
  return JSON.stringify(entries);
}

function toView(row: {
  provider: string;
  status: string;
  mode: string;
  connectedAt: Date | null;
  lastError: string | null;
}): IntegrationView {
  return {
    provider: row.provider,
    status: row.status,
    mode: row.mode,
    connectedAt: row.connectedAt,
    lastError: row.lastError,
  };
}

// suppress unused warning for the import in some configs
void upstream;
