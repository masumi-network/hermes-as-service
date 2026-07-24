import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { FlyClient } from '../fly/client.js';
import { MCP_TOOLS_VERSION } from '../routes/sokosumi-mcp.js';

/**
 * Capability roll — keep running machines' MCP tool sets current.
 *
 * The Hermes agent registers its MCP tools ONCE, when its gateway boots, and
 * never re-lists them live (confirmed against the pinned image: repeat
 * discovery short-circuits, and the keepalive's `list_tools()` result is
 * discarded). So a deploy that adds/removes/renames a Sokosumi-MCP tool is
 * invisible to already-running instances until their gateway restarts.
 *
 * Rather than make every user notice a stale toolset, we stamp each instance
 * with the tool-catalog version it last registered ({@link MCP_TOOLS_VERSION})
 * and, when a deploy moves that version, restart the stale machines WHILE THEY
 * ARE IDLE. A restart re-runs the launcher + gateway, which re-registers the
 * live catalog. Everything on the /opt/data volume (memory, skills, the
 * agent's own crons) survives a stop→start untouched.
 */

/** Retry window: after a failed roll, leave the instance alone this long. */
const ROLL_BACKOFF_MS = 15 * 60_000;

/**
 * Stamp an instance as running the current MCP tool catalog, and clear any
 * in-flight roll marker. Call at EVERY point where the orchestrator (re)boots
 * a machine's gateway — provision, sync-config, integration re-apply, and the
 * sweep's own restart — because the gateway re-registers the live catalog on
 * boot, so right afterwards the machine genuinely IS on this version. Skipping
 * a site is safe (the sweep would just roll it once more, idle-gated); calling
 * it wrongly is not, so only call it after a real gateway boot.
 */
export async function stampMcpToolsVersion(instanceId: string): Promise<void> {
  await prisma.hermesInstance
    .update({
      where: { id: instanceId },
      data: { mcpToolsVersion: MCP_TOOLS_VERSION, rollingAt: null },
    })
    .catch((err) => logger.warn({ err, instanceId }, 'mcp_tools_stamp_failed'));
}

export interface McpRollResult {
  scanned: number;
  rolled: number;
  failed: number;
}

/**
 * One sweep tick. Finds up to MCP_AUTO_ROLL_MAX_PER_TICK idle instances whose
 * registered tool version is stale and restarts them. Returns {scanned,
 * rolled, failed} for the cron runner's durable log.
 */
export async function runMcpToolsRollSweep(): Promise<McpRollResult> {
  const cfg = loadConfig();
  if (cfg.MCP_AUTO_ROLL_MAX_PER_TICK <= 0) return { scanned: 0, rolled: 0, failed: 0 };

  const idleCutoff = new Date(Date.now() - cfg.MCP_AUTO_ROLL_IDLE_MINUTES * 60_000);
  const backoffCutoff = new Date(Date.now() - ROLL_BACKOFF_MS);

  // A candidate is a live, idle machine holding a stale (or unknown) tool
  // version, not currently rolling / recently-failed, with no integration
  // mid-apply (that path restarts the machine on its own). Oldest-idle first.
  const candidates = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      spriteId: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
      lastActivityAt: { lt: idleCutoff },
      integrations: { none: { status: { in: ['connecting', 'pending'] } } },
      // Two independent OR-groups → AND them explicitly (a bare second `OR`
      // key would clobber the first).
      AND: [
        // Stale = NEVER stamped (null, e.g. every instance right after this
        // ships) OR stamped a different version. Note: `{ not: VERSION }`
        // alone would silently drop the null rows — SQL `NOT (col = v)` is
        // false for NULL — which is exactly the instances we most need to
        // roll, so the null branch is load-bearing.
        { OR: [{ mcpToolsVersion: null }, { mcpToolsVersion: { not: MCP_TOOLS_VERSION } }] },
        // Not currently rolling / not recently-failed (backoff).
        { OR: [{ rollingAt: null }, { rollingAt: { lt: backoffCutoff } }] },
      ],
    },
    orderBy: { lastActivityAt: 'asc' },
    take: cfg.MCP_AUTO_ROLL_MAX_PER_TICK,
    select: { id: true, userId: true, spriteName: true, spriteId: true },
  });

  if (candidates.length === 0) return { scanned: 0, rolled: 0, failed: 0 };

  const fly = new FlyClient();
  let rolled = 0;
  let failed = 0;
  for (const inst of candidates) {
    // Mark the roll in flight FIRST. Two jobs: it flips `transitioning` on so
    // the chat shows "applying your change…" instead of offering a chat to a
    // machine that's mid-restart, and — if restartMachine throws — it stays
    // set, backing this instance off for ROLL_BACKOFF_MS.
    await prisma.hermesInstance
      .update({ where: { id: inst.id }, data: { rollingAt: new Date() } })
      .catch(() => {});
    try {
      await fly.restartMachine(inst.spriteName, inst.spriteId!);
      // Mark it current so it isn't re-rolled. Deliberately DON'T clear
      // rollingAt: restartMachine only waits for Fly 'started' (the VM), but
      // the gateway + API keep booting for ~1-2 min after, and until they're
      // up the machine can't serve. Leaving rollingAt set keeps the
      // "applying your change…" banner over that boot tail (the transitioning
      // window ages it out); the staleness gate already excludes this
      // now-current instance, so a lingering rollingAt never re-triggers.
      await prisma.hermesInstance
        .update({ where: { id: inst.id }, data: { mcpToolsVersion: MCP_TOOLS_VERSION } })
        .catch((err) => logger.warn({ err, userId: inst.userId }, 'mcp_tools_stamp_failed'));
      rolled++;
      logger.info(
        { userId: inst.userId, version: MCP_TOOLS_VERSION },
        'mcp_tools_rolled',
      );
    } catch (err) {
      failed++;
      // Deliberately do NOT clear rollingAt: it backs off the retry and keeps
      // the banner up briefly, which is correct — the machine may be down.
      logger.warn({ err, userId: inst.userId }, 'mcp_tools_roll_failed');
    }
  }
  return { scanned: candidates.length, rolled, failed };
}
