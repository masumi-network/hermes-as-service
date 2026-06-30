import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { FlyClient } from '../fly/client.js';
import { notFound, conflict } from '../errors.js';

/**
 * Apply the current baked operator profile to a live instance.
 *
 * On Fly there is no file-push channel into a machine — the image
 * filesystem (/opt/hermes-user-config/*) is the source of truth and the
 * launcher re-syncs it onto /opt/data on every boot. So "sync config"
 * means: update the machine to the current FLY_MACHINE_IMAGE. Fly
 * replaces the machine in-place, the launcher runs, and the instance
 * comes back with the image's SOUL.md, config.yaml, and skills.
 *
 * To roll out a profile change: edit docker/hermes-user/*, rebuild the
 * image (scripts/build-hermes-image.sh), bump FLY_MACHINE_IMAGE, then
 * run this per instance. Running it without an image bump is still a
 * clean way to restore drifted /opt/data files.
 *
 * Never touches /opt/data persistent state: .env (per-instance secrets),
 * memories, sessions, or cron/jobs.json (the agent's own cronjobs).
 */
export async function syncConfig(userId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  if (row.status === 'provisioning') {
    throw conflict(userId, 'Instance still provisioning');
  }
  if (row.destroyedAt || !row.spriteId) {
    throw conflict(userId, 'Instance has no machine');
  }
  const cfg = loadConfig();
  const fly = new FlyClient();
  await fly.updateMachineImage(row.spriteName, row.spriteId, cfg.FLY_MACHINE_IMAGE);
  await fly.waitForState(row.spriteName, row.spriteId, 'started', 90);
  await prisma.hermesInstance.update({
    where: { id: row.id },
    data: { imageTag: cfg.FLY_MACHINE_IMAGE, imageRolledAt: new Date() },
  });
  logger.info(
    { userId, spriteName: row.spriteName, image: cfg.FLY_MACHINE_IMAGE },
    'sync_config_done',
  );
}
