import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * One-off boot migration: existing HermesInstance rows that were
 * provisioned with sokosumiEnv="development" before we tightened the
 * provision contract get updated to "preprod" in place.
 *
 * Why: Sokosumi UI was passing "development" for users that actually
 * belong on preprod. We've since removed the silent dev→preprod
 * fallback and now reject dev at provision time. Existing rows in
 * that state would fail every Sokosumi call with "env not configured"
 * unless we either reprovision them or migrate the column.
 *
 * Migration is safe + reversible: changing only sokosumiEnv doesn't
 * touch the Fly machine, integrations, schedules, or memory file.
 * Hermes' next tool call hits preprod (which is where these instances
 * were actually being served via the old fallback) and proceeds as
 * if nothing changed.
 *
 * Logs every affected row so the audit trail is preserved.
 */
export async function migrateDevelopmentEnvRows(): Promise<void> {
  const rows = await prisma.hermesInstance.findMany({
    where: { sokosumiEnv: 'development' },
    select: { id: true, userId: true, name: true, email: true, company: true },
  });
  if (rows.length === 0) return;
  logger.warn(
    { count: rows.length, userIds: rows.map((r) => r.userId) },
    'sokosumi_env_migration_starting',
  );
  for (const r of rows) {
    await prisma.hermesInstance
      .update({ where: { id: r.id }, data: { sokosumiEnv: 'preprod' } })
      .catch((err) => logger.error({ err, instanceId: r.id }, 'sokosumi_env_migration_row_failed'));
    logger.info(
      {
        instanceId: r.id,
        userId: r.userId,
        name: r.name,
        email: r.email,
        company: r.company,
      },
      'sokosumi_env_migrated_dev_to_preprod',
    );
  }
}
