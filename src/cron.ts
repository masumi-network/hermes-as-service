import cron from 'node-cron';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { runSokosumiDailySweep } from './sokosumi/sync.js';
import { runInboxRefreshSweep } from './inbox/refresh.js';
import { runBoardSweep } from './notifications/board-sweep.js';
import { runEodReportSweep } from './eod-report/sweep.js';
import { runPoolReplenishSweep, schedulePoolReplenishSoon } from './provision/pool.js';
import { runNativePromptReconcilerSweep } from './schedules/native-prompts.js';
import { reapFinishedMonitorCrons } from './schedules/monitor-cron-reaper.js';
import { runMcpToolsRollSweep } from './provision/mcp-tools-roll.js';
import { freshenSweepMirrors } from './schedules/system-schedules.js';

const registered = new Map<string, cron.ScheduledTask>();

/** In-memory tick registry surfaced on the admin Crons page: liveness +
 * last result per cron, without a DB row per idle tick. Resets on deploy. */
export interface CronInfo {
  name: string;
  expr: string;
  lastTickAt: Date | null;
  lastOk: boolean | null;
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
}
const registry = new Map<string, CronInfo>();

export function getCronRegistry(): CronInfo[] {
  return Array.from(registry.values());
}

/** Pull the standard {scanned, <acted>} shape out of a sweep's return value. */
function tickCounts(result: unknown): { scanned: number; acted: number } {
  if (!result || typeof result !== 'object') return { scanned: 0, acted: 0 };
  const obj = result as Record<string, unknown>;
  const scanned = typeof obj['scanned'] === 'number' ? obj['scanned'] : 0;
  const acted = Object.entries(obj)
    .filter(([k, v]) => k !== 'scanned' && typeof v === 'number')
    .reduce((sum, [, v]) => sum + (v as number), 0);
  return { scanned, acted };
}

/**
 * Register a cron with the shared guard rails every sweep needs:
 * once-only registration, a try/catch so a transient error can never
 * become an unhandled rejection (node-cron does not await or catch),
 * a durable SweepRun row for every NON-IDLE tick (admin Crons page),
 * and a best-effort freshen of the sweep's per-instance mirror rows so
 * the Sokosumi settings panel shows truthful last/next-run times.
 */
function register(
  name: string,
  expr: string,
  run: () => Promise<unknown>,
  mirrorSlug?: Parameters<typeof freshenSweepMirrors>[0],
): void {
  if (registered.has(name)) return;
  const info: CronInfo = { name, expr, lastTickAt: null, lastOk: null, lastResult: null, lastError: null };
  registry.set(name, info);
  registered.set(
    name,
    cron.schedule(
      expr,
      async () => {
        const t0 = Date.now();
        let ok = false;
        let result: unknown;
        let errMsg: string | null = null;
        try {
          result = await run();
          ok = true;
        } catch (err) {
          errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ err }, `${name}_threw`);
        }
        info.lastTickAt = new Date();
        info.lastOk = ok;
        info.lastResult = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
        info.lastError = errMsg;
        // Durable log only for ticks that DID something (acted>0) or
        // errored. Scanned-but-idle ticks (the common case: the 5-min sweep
        // scans every instance and finds nothing) stay out of the table —
        // liveness lives in the in-memory registry.
        const { scanned, acted } = tickCounts(result);
        const acting = !ok || acted > 0;
        if (acting) {
          await prisma.sweepRun
            .create({
              data: {
                sweep: name,
                startedAt: new Date(t0),
                durationMs: Date.now() - t0,
                ok,
                scanned,
                acted,
                error: errMsg,
                detail: (info.lastResult ?? undefined) as object | undefined,
              },
            })
            .catch((err) => logger.warn({ err, name }, 'sweep_run_log_failed'));
        }
        // Durable heartbeat: ONE upserted row per cron, every tick. Survives
        // deploys, so the admin shows an honest "last ticked" instead of
        // "not ticked yet" after every restart. lastActedAt/lastRequestId only
        // move on ticks that did work, so the output link points at real work.
        // A sweep may surface its agent turn's requestId as `.requestId` on its
        // result for the "view what it did" link.
        const reqId =
          result && typeof result === 'object' && typeof (result as Record<string, unknown>)['requestId'] === 'string'
            ? ((result as Record<string, unknown>)['requestId'] as string)
            : undefined;
        await prisma.cronState
          .upsert({
            where: { name },
            create: {
              name, expr, lastTickAt: info.lastTickAt, lastOk: ok,
              lastResult: (info.lastResult ?? undefined) as object | undefined,
              lastError: errMsg,
              lastActedAt: acting ? info.lastTickAt : null,
              lastRequestId: reqId ?? null,
            },
            update: {
              expr, lastTickAt: info.lastTickAt, lastOk: ok,
              lastResult: (info.lastResult ?? undefined) as object | undefined,
              lastError: errMsg,
              ...(acting ? { lastActedAt: info.lastTickAt } : {}),
              ...(reqId ? { lastRequestId: reqId } : {}),
            },
          })
          .catch((err) => logger.warn({ err, name }, 'cron_state_upsert_failed'));
        // Freshen mirrors only after a tick that actually ran — a crashed
        // sweep must not stamp a successful-looking "last run".
        if (ok && mirrorSlug) {
          try {
            await freshenSweepMirrors(mirrorSlug);
          } catch (err) {
            logger.warn({ err, mirrorSlug }, 'sweep_mirror_freshen_failed');
          }
        }
      },
      { scheduled: true },
    ),
  );
  logger.info(`${name}_started`);
}

/**
 * Marks idle instances as suspended in the DB. Pure bookkeeping on Fly
 * always-on (no compute is released; the chat proxy flips status back to
 * running on the next message) — Sokosumi uses it as a "we haven't heard
 * from this user lately" signal.
 */
export function startIdleSuspendCron(): void {
  register('idle_suspend_cron', '*/5 * * * *', runOnce);
}

/**
 * Restart idle instances whose registered MCP tool catalog is stale, so a
 * newly-deployed Sokosumi-MCP tool reaches existing machines without anyone
 * having to think about it. Idle-gated + capped per tick; the kill switch is
 * MCP_AUTO_ROLL_MAX_PER_TICK=0. See src/provision/mcp-tools-roll.ts.
 */
export function startMcpToolsRollCron(): void {
  register('mcp_tools_roll_cron', '*/5 * * * *', runMcpToolsRollSweep);
}

export async function runOnce(): Promise<number> {
  const cfg = loadConfig();
  const cutoff = new Date(Date.now() - cfg.DEFAULT_IDLE_SUSPEND_MINUTES * 60_000);
  const result = await prisma.hermesInstance.updateMany({
    where: { status: 'running', lastActivityAt: { lt: cutoff } },
    data: { status: 'suspended' },
  });
  if (result.count > 0) {
    logger.info({ count: result.count, cutoff }, 'idle_suspend_swept');
  }
  return result.count;
}

/**
 * Hourly cron that picks every instance whose Sokosumi workspace snapshot
 * is >23h old and re-syncs. Caps at 100 instances per tick. Skips
 * gracefully if no Sokosumi API key is configured.
 */
export function startSokosumiDailySyncCron(): void {
  register('sokosumi_daily_sync_cron', '0 * * * *', runSokosumiDailySweep, 'sokosumi-sync');
}

/**
 * Hourly cron — silent inbox refresh. For each instance with connected
 * mail/calendar MCPs whose lastInboxRefreshAt is >6h old, ask Hermes to
 * scan new mail and update memory. No user-visible output.
 */
export function startInboxRefreshCron(): void {
  register('inbox_refresh_cron', '15 * * * *', runInboxRefreshSweep, 'inbox-refresh');
}

/**
 * Every 5 minutes — the board sweep. ONE pass per instance over everything
 * that changed, tasks AND jobs together: blocked work gets answered, finished
 * work gets reported to the user and continued into a follow-up when memory
 * says a plan called for one, and genuinely new tasks get context.
 *
 * Replaces three sweeps that overlapped at different levels — taskboard
 * assistant (tasks), input-responder + follow-up continuation (jobs), and
 * urgent-interrupts (job notifications) — whose notification cooldown it
 * inherits. Tasks rank above jobs, and a job whose task is already in the
 * batch is dropped as a duplicate view of the same work.
 */
export function startBoardSweepCron(): void {
  register('board_sweep_cron', '4-59/5 * * * *', runBoardSweep, 'board-sweep');
}

/**
 * Hourly cron — end-of-day personal cron summary. Fires at :50 (staggered
 * off the :00 sokosumi-sync tick); the sweep itself filters by current
 * local hour (22:00) per-user via the instance's stored timezone, and
 * gates on the user's "eod-report" system_sweep toggle. Each delivery is
 * idempotent (skipped if today's report already sits in the user's outbox).
 */
export function startEodReportCron(): void {
  register('eod_report_cron', '50 * * * *', runEodReportSweep, 'eod-report');
}

/**
 * Hourly cron — native-prompt reconciler. Retries instances whose native
 * cronjob install was never verified (e.g. the onboarding-time agent turn
 * failed) or predates NATIVE_PROMPTS_VERSION (spec rollout), and enforces
 * mirror-row disabled flags on the machine. Cap 5/tick (each is a full
 * agent turn).
 */
export function startNativePromptReconcilerCron(): void {
  register('native_prompt_reconciler_cron', '20 * * * *', runNativePromptReconcilerSweep);
}

/**
 * Hourly — disable agent-created monitor crons whose watched task(s) are
 * terminal. A monitor without --repeat polls forever (observed: 96 machine
 * wakes/day against a COMPLETED task). Conservative matching; disables, not
 * deletes; see monitor-cron-reaper.ts.
 */
export function startMonitorCronReaperCron(): void {
  register('monitor_cron_reaper_cron', '40 * * * *', reapFinishedMonitorCrons);
}

/**
 * Every 2 minutes — top the warm pool back up to WARM_POOL_TARGET ready
 * machines (reaping stale-image / stuck-claim records first). No-op when
 * WARM_POOL_TARGET=0. Also kicks one sweep immediately on boot so the pool
 * fills after a deploy without waiting for the first tick.
 */
export function startPoolReplenishCron(): void {
  register('pool_replenish_cron', '*/2 * * * *', runPoolReplenishSweep);
  schedulePoolReplenishSoon();
}

/** How long executed tool calls stay queryable in the admin dashboard. Long
 *  enough to debug "what happened in that session last week", short enough
 *  that a busy fleet doesn't accumulate rows forever. */
const TOOL_CALL_RETENTION_DAYS = 30;

/**
 * Daily — prune the tool-call timeline. Every MCP call writes a row; without
 * this the table only ever grows.
 */
export function startToolCallPruneCron(): void {
  register('tool_call_prune_cron', '40 3 * * *', async () => {
    const cutoff = new Date(Date.now() - TOOL_CALL_RETENTION_DAYS * 24 * 60 * 60_000);
    const { count } = await prisma.agentToolCall.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { scanned: count, acted: count, cutoff: cutoff.toISOString() };
  });
}
