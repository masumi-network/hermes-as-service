import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { recordEvent } from '../audit.js';
import { HttpError, notFound } from '../errors.js';
import { FlyClient } from '../fly/client.js';
import {
  prepareSkill,
  writeSkillToMachine,
  removeSkillFromMachine,
  type SkillFile,
} from './install-on-machine.js';

/** Audit risk levels we refuse to install server-side, regardless of what the
 *  Sokosumi client says — defense in depth on top of the UI's own gating. */
const BLOCKED_RISK = new Set(['HIGH', 'CRITICAL']);

export interface InstallSkillInput {
  userId: string;
  skillId: string;
  source: string;
  slug: string;
  name: string;
  hash: string;
  auditRisk?: string | null;
  installUrl?: string | null;
  files: SkillFile[];
}

export interface InstalledSkillView {
  skillId: string;
  source: string;
  slug: string;
  name: string;
  auditRisk: string | null;
  status: string;
  installedAt: string | null;
}

/**
 * Install (or re-install) a marketplace skill for a user. Records it in the
 * InstalledSkill table (the reprovision-safe source of truth) and, if the
 * machine is live, writes it onto /opt/data/skills via exec so it's usable on
 * the next turn. If the machine isn't live (or the write fails), the row stays
 * `installing` and the boot-time replay materializes it later.
 */
export async function installSkill(input: InstallSkillInput): Promise<{ slug: string; status: string }> {
  const instance = await prisma.hermesInstance.findUnique({ where: { userId: input.userId } });
  if (!instance || instance.destroyedAt) throw notFound(input.userId);

  // Policy gate (defense in depth — Sokosumi already screened the audit).
  const risk = (input.auditRisk ?? '').toUpperCase();
  if (BLOCKED_RISK.has(risk)) {
    throw new HttpError(403, 'skill_blocked', `Skill audit risk ${risk} is not installable`, input.userId);
  }

  // Validate + sanitize + strip scripts (instructions-only default).
  let prepared;
  try {
    prepared = prepareSkill(input.slug, input.files);
  } catch (err) {
    throw new HttpError(400, 'invalid_skill', err instanceof Error ? err.message : 'invalid skill', input.userId);
  }

  // Guard against a slug owned by a different source (typosquat / collision).
  const existing = await prisma.installedSkill.findUnique({
    where: { userId_slug: { userId: input.userId, slug: prepared.slug } },
  });
  if (existing && existing.source !== input.source) {
    throw new HttpError(
      409,
      'skill_slug_conflict',
      `Slug "${prepared.slug}" is already installed from a different source (${existing.source})`,
      input.userId,
    );
  }

  const row = await prisma.installedSkill.upsert({
    where: { userId_slug: { userId: input.userId, slug: prepared.slug } },
    create: {
      instanceId: instance.id,
      userId: input.userId,
      skillId: input.skillId,
      source: input.source,
      slug: prepared.slug,
      name: input.name,
      hash: input.hash,
      auditRisk: input.auditRisk ?? null,
      installUrl: input.installUrl ?? null,
      filesJson: prepared.files as object,
      status: 'installing',
    },
    update: {
      instanceId: instance.id,
      skillId: input.skillId,
      source: input.source,
      name: input.name,
      hash: input.hash,
      auditRisk: input.auditRisk ?? null,
      installUrl: input.installUrl ?? null,
      filesJson: prepared.files as object,
      status: 'installing',
      lastError: null,
    },
  });

  // Push onto the live machine if it's started. Otherwise leave it queued.
  if (instance.spriteId && instance.spriteName) {
    try {
      const machine = await new FlyClient().getMachine(instance.spriteName, instance.spriteId);
      if (machine?.state === 'started') {
        await writeSkillToMachine(instance.spriteName, instance.spriteId, prepared);
        await prisma.installedSkill.update({
          where: { id: row.id },
          data: { status: 'installed', installedAt: new Date(), lastError: null },
        });
        await recordEvent({
          instanceId: instance.id,
          userId: input.userId,
          event: 'skill_installed',
          detail: { slug: prepared.slug, skillId: input.skillId, auditRisk: input.auditRisk ?? null },
        });
        return { slug: prepared.slug, status: 'installed' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'install failed';
      logger.warn({ err, userId: input.userId, slug: prepared.slug }, 'skill_install_live_write_failed');
      await prisma.installedSkill.update({ where: { id: row.id }, data: { lastError: msg.slice(0, 300) } });
      // fall through: stays 'installing' so the boot replay picks it up
    }
  }

  await recordEvent({
    instanceId: instance.id,
    userId: input.userId,
    event: 'skill_install_queued',
    detail: { slug: prepared.slug, skillId: input.skillId },
  });
  return { slug: prepared.slug, status: 'installing' };
}

export async function listInstalledSkills(userId: string): Promise<InstalledSkillView[]> {
  const rows = await prisma.installedSkill.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      skillId: true,
      source: true,
      slug: true,
      name: true,
      auditRisk: true,
      status: true,
      installedAt: true,
    },
  });
  return rows.map((r) => ({
    skillId: r.skillId,
    source: r.source,
    slug: r.slug,
    name: r.name,
    auditRisk: r.auditRisk,
    status: r.status,
    installedAt: r.installedAt?.toISOString() ?? null,
  }));
}

export async function removeSkill(userId: string, slug: string): Promise<{ removed: boolean }> {
  const row = await prisma.installedSkill.findUnique({ where: { userId_slug: { userId, slug } } });
  if (!row) return { removed: false };
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (instance && !instance.destroyedAt && instance.spriteId && instance.spriteName) {
    try {
      await removeSkillFromMachine(instance.spriteName, instance.spriteId, slug);
    } catch (err) {
      logger.warn({ err, userId, slug }, 'skill_remove_machine_failed');
      // delete the DB row anyway so it isn't replayed onto a fresh machine
    }
  }
  await prisma.installedSkill.delete({ where: { id: row.id } });
  await recordEvent({
    instanceId: instance?.id ?? null,
    userId,
    event: 'skill_removed',
    detail: { slug },
  });
  return { removed: true };
}
