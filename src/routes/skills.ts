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

router.delete('/v1/instances/:userId/skills/:slug', async (c) => {
  const userId = c.req.param('userId');
  const slug = c.req.param('slug');
  const result = await removeSkill(userId, slug);
  if (!result.removed) return c.json({ error: { message: 'skill not installed' } }, 404);
  return c.body(null, 204);
});

export { router as skillsSokosumiRouter };
