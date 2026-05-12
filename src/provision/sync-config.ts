import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { SpritesClient } from '../sprites/client.js';
import { configYaml, SOUL_MD } from './profile.js';
import { INSTALL_SKILLS_SCRIPT } from './provision.js';
import { SCHEDULE_SKILL_MD, SCHEDULE_SKILL_PATH } from './schedule-skill.js';
import { OUTBOX_SKILL_MD, OUTBOX_SKILL_PATH } from './outbox-skill.js';
import { notFound, conflict } from '../errors.js';

/**
 * Re-push config.yaml + SOUL.md from the orchestrator's source of truth onto
 * a live sprite, then restart the Hermes service so it picks up the changes.
 *
 * Use this whenever you change `src/provision/profile.ts` (model, persona,
 * tool config) and want to roll it out without a full ~5-minute bootstrap.
 *
 * Does NOT touch /opt/data/.env (which contains per-instance secrets that
 * must not be re-derived).
 */
export async function syncConfig(userId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) throw notFound(userId);
  if (row.status === 'provisioning') {
    throw conflict(userId, 'Instance still provisioning');
  }
  const sprites = new SpritesClient();
  await sprites.writeFile(row.spriteName, '/opt/data/config.yaml', configYaml(), '0640');
  await sprites.writeFile(row.spriteName, '/opt/data/SOUL.md', SOUL_MD, '0644');
  // Orchestrator-owned skills (separate from the third-party skill packs
  // which install-skills.sh handles).
  await sprites.writeFile(row.spriteName, SCHEDULE_SKILL_PATH, SCHEDULE_SKILL_MD, '0644');
  await sprites.writeFile(row.spriteName, OUTBOX_SKILL_PATH, OUTBOX_SKILL_MD, '0644');
  // Wipe any cron jobs Hermes' built-in cron tool may have registered
  // before we disabled it — those still tick locally otherwise and produce
  // output that Sokosumi never sees.
  await sprites.writeFile(row.spriteName, '/opt/data/cron/jobs.json', '{"jobs": []}\n', '0600');

  // Refresh curated skills via the install script. Idempotent — clones if
  // missing, fetch + reset if present. ~10–30s typical.
  await sprites.writeFile(row.spriteName, '/tmp/install-skills.sh', INSTALL_SKILLS_SCRIPT, '0755');
  try {
    await sprites.exec(row.spriteName, '/tmp/install-skills.sh', { timeoutMs: 5 * 60_000 });
  } catch (err) {
    logger.warn({ err, userId }, 'sync_config_skills_install_failed');
  }

  await sprites.restartService(row.spriteName, 'hermes');
  logger.info({ userId, spriteName: row.spriteName }, 'sync_config_done');
}
