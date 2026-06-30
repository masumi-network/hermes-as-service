import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { FlyClient } from '../fly/client.js';

/**
 * Backfill HermesInstance.imageTag from live Fly machine state for instances
 * that don't have it recorded yet (provisioned before the column existed).
 * Best-effort + capped; safe to run repeatedly.
 */
export async function reconcileImageTags(limit = 50): Promise<{ scanned: number; updated: number }> {
  const rows = await prisma.hermesInstance.findMany({
    where: { destroyedAt: null, spriteId: { not: null }, imageTag: null },
    select: { id: true, spriteName: true, spriteId: true },
    take: limit,
  });
  const fly = new FlyClient();
  let updated = 0;
  for (const r of rows) {
    if (!r.spriteId) continue;
    try {
      const machine = await fly.getMachine(r.spriteName, r.spriteId);
      // Prefer image_ref.tag (a clean tag); fall back to the full image ref.
      const ref = machine?.image_ref?.tag ?? machine?.config?.image;
      if (ref) {
        await prisma.hermesInstance.update({ where: { id: r.id }, data: { imageTag: ref } });
        updated += 1;
      }
    } catch (err) {
      logger.warn({ err, instanceId: r.id }, 'reconcile_image_tag_failed');
    }
  }
  if (rows.length > 0) logger.info({ scanned: rows.length, updated }, 'reconcile_image_tags_done');
  return { scanned: rows.length, updated };
}
