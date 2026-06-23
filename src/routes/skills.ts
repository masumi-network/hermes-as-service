import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError, problemJson } from '../errors.js';
import { installSkill, listInstalledSkills, removeSkill } from '../skills/manager.js';

const router = new Hono();

const fileSchema = z.object({
  path: z.string().min(1).max(200),
  contents: z.string().max(256 * 1024),
});

/**
 * Sokosumi (which holds the Vercel OIDC token and has already fetched the
 * audited file bytes + hash + audit verdict from skills.sh) posts them here.
 * The orchestrator validates, gates on audit risk, strips scripts, records the
 * install, and writes it onto the live machine. The orchestrator NEVER calls
 * skills.sh itself (the API is Vercel-OIDC-only).
 */
const installBody = z.object({
  skillId: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  hash: z.string().min(1).max(128),
  auditRisk: z.string().max(20).nullish(),
  installUrl: z.string().url().max(500).nullish(),
  files: z.array(fileSchema).min(1).max(50),
});

router.post('/v1/instances/:userId/skills', async (c) => {
  const userId = c.req.param('userId');
  const json = await c.req.json().catch(() => null);
  const parsed = installBody.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return c.json({ error: { message: `invalid body: ${detail}` } }, 400);
  }
  try {
    const result = await installSkill({
      userId,
      skillId: parsed.data.skillId,
      source: parsed.data.source,
      slug: parsed.data.slug,
      name: parsed.data.name,
      hash: parsed.data.hash,
      auditRisk: parsed.data.auditRisk ?? null,
      installUrl: parsed.data.installUrl ?? null,
      files: parsed.data.files,
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof HttpError) return problemJson(c, err);
    throw err;
  }
});

router.get('/v1/instances/:userId/skills', async (c) => {
  const userId = c.req.param('userId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }
  return c.json({ skills: await listInstalledSkills(userId) });
});

// Skills BAKED INTO the agent's image (curated packs), distinct from
// marketplace installs. Same list for every user on a given image version.
// Returns {skills:[]} (treated as "none") if it can't be read right now.
router.get('/v1/instances/:userId/skills/preinstalled', async (c) => {
  const userId = c.req.param('userId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }
  const { listPreinstalledSkills } = await import('../skills/preinstalled.js');
  const skills = await listPreinstalledSkills(instance);
  return c.json({ skills: skills ?? [] });
});

router.delete('/v1/instances/:userId/skills/:slug', async (c) => {
  const userId = c.req.param('userId');
  const slug = c.req.param('slug');
  const result = await removeSkill(userId, slug);
  if (result.removed) return c.body(null, 204);

  // Not a marketplace install — if it's a pre-installed (image-baked) skill,
  // reject: users can't remove image defaults. Otherwise it's just unknown.
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (instance && !instance.destroyedAt) {
    const { isPreinstalledSlug } = await import('../skills/preinstalled.js');
    if (await isPreinstalledSlug(instance, slug)) {
      return c.json(
        { error: { message: 'Pre-installed skills that ship with the agent image cannot be removed' } },
        409,
      );
    }
  }
  return c.json({ error: { message: 'skill not installed' } }, 404);
});

export { router as skillsSokosumiRouter };
