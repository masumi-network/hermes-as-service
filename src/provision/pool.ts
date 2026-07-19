import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { FlyClient } from '../fly/client.js';
import { generateApiServerKey } from '../crypto.js';
import { buildMachineConfig } from './machine-spec.js';
import type { HermesPoolMachine } from '@prisma/client';

/**
 * Warm pool of pre-provisioned Fly machines. A pool machine is created,
 * booted once (so its ~2.7GB image is resident on its Fly host), then STOPPED.
 * Signup claims one via an atomic compare-and-swap, patches in the per-user
 * env, and starts it — seconds instead of the ~3.5-min cold image pull.
 *
 * The pool is a pure optimization: if it's empty (or WARM_POOL_TARGET=0),
 * signup falls back to the cold provision path. Nothing here is on the
 * critical path when the pool is disabled.
 */

const POOL_APP_PREFIX = 'hermes-pool-';
/** A claim that never adopts its machine (row-create crash) is reaped after this. */
const STALE_CLAIMING_MS = 10 * 60 * 1000;
/** A warm that never reached ready/failed (orchestrator crashed mid-warm) is
 *  reaped after this. Worst-case healthy warm ≈ 7 min (300s image pull + stop). */
const STALE_WARMING_MS = 15 * 60 * 1000;

let replenishInFlight = false;

function poolAppName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${POOL_APP_PREFIX}${suffix}`;
}

/**
 * Atomically claim a ready pool machine matching the requested image+region.
 * Compare-and-swap via updateMany (count===1 means we won it), so two
 * concurrent signups can never grab the same machine. Returns null when the
 * pool is empty or every candidate was contended — caller falls back to cold.
 */
export async function claimPoolMachine(
  userId: string,
  region: string,
  imageTag: string,
): Promise<HermesPoolMachine | null> {
  const cfg = loadConfig();
  if (cfg.WARM_POOL_TARGET <= 0) return null;

  const candidates = await prisma.hermesPoolMachine.findMany({
    where: { status: 'ready', region, imageTag },
    orderBy: { readyAt: 'asc' },
    take: 8,
  });
  for (const cand of candidates) {
    const res = await prisma.hermesPoolMachine.updateMany({
      where: { id: cand.id, status: 'ready' },
      data: { status: 'claiming', claimedByUserId: userId, claimedAt: new Date() },
    });
    if (res.count === 1) {
      logger.info({ userId, poolId: cand.id, appName: cand.appName }, 'pool_machine_claimed');
      return { ...cand, status: 'claiming', claimedByUserId: userId, claimedAt: new Date() };
    }
  }
  return null;
}

/**
 * Remove the pool record once its Fly resources have been adopted by a real
 * HermesInstance row. From this point the instance's own lifecycle (incl. the
 * error-retry teardown) owns the app/machine/volume.
 */
export async function releaseClaimedPoolRecord(poolId: string): Promise<void> {
  await prisma.hermesPoolMachine.delete({ where: { id: poolId } }).catch((err) => {
    logger.warn({ err, poolId }, 'pool_record_delete_failed');
  });
}

/**
 * Create one pool machine: app → IPs → volume → machine → wait started →
 * stop. Boots with throwaway-but-valid per-instance env (a placeholder key,
 * a non-routable instanceId) so Hermes starts cleanly and reaches `started`;
 * the real per-user env is patched in at claim time. Best-effort: on any
 * failure the half-built app is torn down so we never leak.
 */
export async function warmOnePoolMachine(): Promise<void> {
  const cfg = loadConfig();
  const fly = new FlyClient();
  const appName = poolAppName();
  const region = cfg.FLY_REGION;
  const image = cfg.FLY_MACHINE_IMAGE;

  const record = await prisma.hermesPoolMachine.create({
    data: { appName, machineId: '', volumeId: '', region, imageTag: image, status: 'warming' },
  });
  const log = logger.child({ poolId: record.id, appName });

  try {
    log.info({ region, image }, 'pool_warm_start');
    await fly.createApp(appName);
    await fly.ensurePublicIps(appName);
    const volume = await fly.createVolume(appName, {
      name: 'hermes_data',
      region,
      size_gb: cfg.FLY_VOLUME_GB,
      encrypted: true,
    });

    const placeholderKey = await generateApiServerKey();
    const req = buildMachineConfig(cfg, {
      region,
      image,
      volumeId: volume.id,
      // Non-routable placeholders — overwritten by patchMachineEnv on claim.
      instanceId: `pool-${record.id}`,
      apiServerKey: placeholderKey,
      llmProxyToken: placeholderKey,
      mcpServersJson: '[]',
    });
    const machine = await fly.createMachine(appName, req);
    await prisma.hermesPoolMachine.update({
      where: { id: record.id },
      data: { machineId: machine.id, volumeId: volume.id },
    });

    // Cold pull happens here — but off the user's critical path.
    await fly.waitForState(appName, machine.id, 'started', 300);
    // Stop so it costs volume storage only, not CPU. The rootfs (incl. the
    // pulled image + first-boot skill rsync) stays resident on the host, so
    // start-on-claim is fast.
    await fly.stopMachine(appName, machine.id);
    await fly.waitForState(appName, machine.id, 'stopped', 60);

    await prisma.hermesPoolMachine.update({
      where: { id: record.id },
      data: { status: 'ready', readyAt: new Date() },
    });
    log.info({ machineId: machine.id }, 'pool_machine_ready');
  } catch (err) {
    log.error({ err }, 'pool_warm_failed');
    // Mark failed FIRST so a crash below still leaves a record the reaper
    // can retry teardown from.
    await prisma.hermesPoolMachine
      .update({ where: { id: record.id }, data: { status: 'failed' } })
      .catch(() => {});
    // Tear down the half-built Fly app. Only drop the tracking record if the
    // delete SUCCEEDED — otherwise keep the failed record so the reaper
    // retries; deleting it would orphan the app untracked forever.
    try {
      await fly.deleteApp(appName);
      await prisma.hermesPoolMachine.delete({ where: { id: record.id } }).catch(() => {});
    } catch (e) {
      log.warn({ err: e }, 'pool_warm_cleanup_failed_will_retry');
    }
  }
}

/**
 * Reap pool records that can never be claimed:
 *  - ready/warming machines on a now-stale image or wrong region
 *  - claims that never adopted their machine (crash after CAS, >10 min)
 *  - warms that never finished (orchestrator crashed mid-warm, >15 min —
 *    without this a crashed warm inflates the ready+warming count forever
 *    and silently disables replenishment)
 *  - failed records whose Fly teardown didn't succeed yet (retry it)
 *
 * SAFETY: a pool app may already belong to a LIVE user — the claim flow
 * creates the HermesInstance (spriteName = pool appName) and then deletes the
 * pool record best-effort; if that delete was lost (crash / DB blip) the
 * record lingers as 'claiming' while the app serves a real user. Deleting the
 * app would destroy their machine + volume. So before touching Fly we check
 * whether any HermesInstance owns the appName — if yes, drop ONLY the record.
 * And we only drop a record after its deleteApp succeeded; otherwise we keep
 * it (marked failed) so the next sweep retries — no untracked orphans.
 */
async function reapUnusablePoolMachines(currentImage: string, region: string): Promise<void> {
  const fly = new FlyClient();
  const now = Date.now();

  const candidates = await prisma.hermesPoolMachine.findMany({
    where: {
      OR: [
        { status: { in: ['ready', 'warming'] }, NOT: { imageTag: currentImage, region } },
        { status: 'claiming', claimedAt: { lt: new Date(now - STALE_CLAIMING_MS) } },
        { status: 'warming', createdAt: { lt: new Date(now - STALE_WARMING_MS) } },
        { status: 'failed' },
      ],
    },
  });

  for (const m of candidates) {
    // Adopted by a live instance? The app belongs to that user now — the
    // stale record is just leftover bookkeeping. Never touch the app.
    const adopted = await prisma.hermesInstance.findUnique({
      where: { spriteName: m.appName },
      select: { id: true },
    });
    if (adopted) {
      logger.info({ poolId: m.id, appName: m.appName }, 'pool_record_adopted_dropping');
      await prisma.hermesPoolMachine.delete({ where: { id: m.id } }).catch(() => {});
      continue;
    }
    logger.warn(
      { poolId: m.id, appName: m.appName, status: m.status, imageTag: m.imageTag },
      'pool_reaping',
    );
    try {
      await fly.deleteApp(m.appName); // 404 = already gone = success
      await prisma.hermesPoolMachine.delete({ where: { id: m.id } }).catch(() => {});
    } catch (err) {
      // Keep the record so the next sweep retries the teardown.
      logger.warn({ err, poolId: m.id, appName: m.appName }, 'pool_reap_deleteapp_failed_will_retry');
      await prisma.hermesPoolMachine
        .update({ where: { id: m.id }, data: { status: 'failed' } })
        .catch(() => {});
    }
  }
}

/**
 * Bring the pool up to WARM_POOL_TARGET ready+warming machines for the current
 * image+region. Reaps unusable machines first. Warms new machines in the
 * background, capped at WARM_POOL_WARM_CONCURRENCY per tick. Re-entrancy-guarded
 * so overlapping cron ticks don't double-provision.
 */
export async function runPoolReplenishSweep(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.WARM_POOL_TARGET <= 0) return;
  if (replenishInFlight) return;
  replenishInFlight = true;
  try {
    await reapUnusablePoolMachines(cfg.FLY_MACHINE_IMAGE, cfg.FLY_REGION);

    const current = await prisma.hermesPoolMachine.count({
      where: {
        status: { in: ['ready', 'warming'] },
        imageTag: cfg.FLY_MACHINE_IMAGE,
        region: cfg.FLY_REGION,
      },
    });
    const deficit = Math.min(cfg.WARM_POOL_TARGET - current, cfg.WARM_POOL_WARM_CONCURRENCY);
    if (deficit <= 0) return;

    logger.info(
      { target: cfg.WARM_POOL_TARGET, current, warming: deficit },
      'pool_replenish',
    );
    // Warm concurrently; each self-cleans on failure.
    await Promise.all(Array.from({ length: deficit }, () => warmOnePoolMachine()));
  } catch (err) {
    logger.error({ err }, 'pool_replenish_sweep_threw');
  } finally {
    replenishInFlight = false;
  }
}

/** Fire a replenish in the background (after a claim, or on boot). */
export function schedulePoolReplenishSoon(): void {
  void runPoolReplenishSweep().catch((err) => logger.error({ err }, 'pool_replenish_soon_threw'));
}

export interface PoolStats {
  ready: number;
  warming: number;
  claiming: number;
  failed: number;
  target: number;
  currentImage: string;
}

export async function poolStats(): Promise<PoolStats> {
  const cfg = loadConfig();
  const rows = await prisma.hermesPoolMachine.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const by = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return {
    ready: by('ready'),
    warming: by('warming'),
    claiming: by('claiming'),
    failed: by('failed'),
    target: cfg.WARM_POOL_TARGET,
    currentImage: cfg.FLY_MACHINE_IMAGE,
  };
}
