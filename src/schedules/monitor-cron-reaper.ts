import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { propagateCronRemovalToMachine } from './native-prompts.js';

/**
 * Reap agent-created MONITOR crons whose subject is finished.
 *
 * The agent likes to create high-frequency polling crons for a single task
 * ("check task X every 15 minutes, up to 4 checks") — but a native cron has
 * no run counter unless it was created with --repeat, and the agent never
 * passes it. Observed in production: `monitor-x402-aioncardano-post` on an
 * every-15-minutes schedule, still waking Albina's machine ~96x/day, days
 * after the task it watched COMPLETED. Each firing is a full agent turn:
 * tokens, a machine wake, and a slot the turn-lease could have given to
 * real work.
 *
 * This sweep DISABLES (not deletes — reversible, visible in admin) any
 * user-created cron that (a) looks like a single-task monitor and (b) whose
 * every referenced task is terminal. Conservative on purpose:
 *   - only mirrors of MACHINE crons (kind='user') are considered;
 *   - it must reference at least one task id — no ids, no reaping;
 *   - EVERY referenced task must resolve AND be terminal; one lookup miss
 *     (permission blip, cross-env id) and the cron is left alone;
 *   - capped per tick so a bug here can't strafe a user's schedule list.
 *
 * Prevention lives in SOUL.md ("use --repeat, or rely on the board watcher");
 * this is the backstop for the crons that slip through anyway.
 */

const TERMINAL = new Set(['completed', 'canceled', 'cancelled', 'failed']);
const MAX_REAPS_PER_TICK = 5;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Every-N-minutes for N ≤ 30 — the polling shape. Slower crons (hourly,
 *  daily) are routines, not monitors, even when they mention a task id. */
const HIGH_FREQ_RE = /^\*\/([0-9]{1,2}) \* \* \* \*$/;

export function looksLikeMonitor(name: string, cronExpr: string, prompt: string | null): boolean {
  if (name.toLowerCase().startsWith('monitor-')) return true;
  const m = HIGH_FREQ_RE.exec(cronExpr.trim());
  if (!m) return false;
  const n = Number(m[1]);
  // match(), not test(): UUID_RE carries /g, and test() on a /g regex is
  // stateful (lastIndex persists across calls, silently skipping matches).
  return n > 0 && n <= 30 && !!prompt && (prompt.match(UUID_RE) ?? []).length > 0;
}

/** Resolve a task's status across the personal workspace and every org the
 *  user belongs to. Returns null when the task can't be found anywhere. */
async function resolveTaskStatus(client: SokosumiClient, taskId: string): Promise<string | null> {
  const read = (c: SokosumiClient): Promise<string | null> =>
    c
      .getTask(taskId)
      .then((t) => ((t as { status?: string } | null)?.status ?? '').toLowerCase() || null)
      .catch(() => null);
  const direct = await read(client);
  if (direct) return direct;
  const orgs = await client.listWorkspaceScopes().catch(() => []);
  for (const org of orgs) {
    if (!org.id) continue; // personal already tried
    const status = await read(client.withOrganization(org.id));
    if (status) return status;
  }
  return null;
}

export async function reapFinishedMonitorCrons(): Promise<{ scanned: number; reaped: number }> {
  const rows = await prisma.scheduledTask.findMany({
    where: { kind: 'user', enabled: true },
    select: {
      id: true,
      instanceId: true,
      userId: true,
      name: true,
      cronExpr: true,
      prompt: true,
      instance: { select: { status: true, destroyedAt: true, sokosumiEnv: true, userId: true } },
    },
    take: 200,
  });

  let reaped = 0;
  let scanned = 0;
  for (const row of rows) {
    if (reaped >= MAX_REAPS_PER_TICK) break;
    const inst = row.instance;
    if (!inst || inst.destroyedAt) continue;
    if (!['ready', 'running', 'suspended'].includes(inst.status)) continue;
    if (!looksLikeMonitor(row.name, row.cronExpr, row.prompt)) continue;
    scanned++;

    const ids = Array.from(new Set(`${row.name} ${row.prompt ?? ''}`.match(UUID_RE) ?? []));
    if (ids.length === 0) continue;

    const env: SokosumiEnv | null = isValidSokosumiEnv(inst.sokosumiEnv) ? inst.sokosumiEnv : null;
    if (!SokosumiClient.isConfigured(env, inst.userId)) continue;
    const client = new SokosumiClient(inst.userId, env);

    let allTerminal = true;
    for (const id of ids) {
      const status = await resolveTaskStatus(client, id);
      if (!status || !TERMINAL.has(status)) {
        allTerminal = false;
        break;
      }
    }
    if (!allTerminal) continue;

    // Disable the machine cron FIRST — it is the real scheduler; the mirror
    // row gates nothing. If propagation fails, leave the mirror enabled so
    // the admin still shows the truth and the next tick retries.
    const propagated = await propagateCronRemovalToMachine(row.instanceId, row.name).catch(
      () => false,
    );
    if (!propagated) {
      logger.warn({ name: row.name, userId: row.userId }, 'monitor_reap_propagation_failed');
      continue;
    }
    await prisma.scheduledTask.update({
      where: { id: row.id },
      data: {
        enabled: false,
        lastError: `auto-disabled ${new Date().toISOString()}: monitor for terminal task(s) ${ids.join(', ')}`,
      },
    });
    reaped++;
    logger.info(
      { name: row.name, userId: row.userId, tasks: ids },
      'monitor_cron_reaped_terminal_task',
    );
  }

  if (scanned > 0 || reaped > 0) {
    logger.info({ scanned, reaped }, 'monitor_cron_reaper_done');
  }
  return { scanned, reaped };
}
