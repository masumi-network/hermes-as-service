import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { decryptSecret } from '../crypto.js';
import { isValidCron, safeNextRun } from '../schedules/cron.js';
import { logger } from '../logger.js';

const scheduleInput = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(8000),
  cron_expr: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
});

const patchInput = z.object({
  name: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(8000).optional(),
  cron_expr: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

// ---------- Sokosumi-callable (bearer auth on /v1/instances/:userId/...) ----

const sokosumi = new Hono();

sokosumi.post('/v1/instances/:userId/schedules', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);
  const json = (await safeJson(c)) ?? {};
  const parsed = scheduleInput.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  return createScheduleResponse(c, row, parsed.data);
});

sokosumi.get('/v1/instances/:userId/schedules', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);
  const tasks = await prisma.scheduledTask.findMany({
    where: { instanceId: row.id },
    orderBy: { createdAt: 'desc' },
  });
  return c.json({ schedules: tasks.map(toApiShape) });
});

sokosumi.delete('/v1/instances/:userId/schedules/:scheduleId', async (c) => {
  const userId = c.req.param('userId');
  const scheduleId = c.req.param('scheduleId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);
  await prisma.scheduledTask.deleteMany({ where: { id: scheduleId, instanceId: row.id } });
  return c.body(null, 204);
});

sokosumi.patch('/v1/instances/:userId/schedules/:scheduleId', async (c) => {
  const userId = c.req.param('userId');
  const scheduleId = c.req.param('scheduleId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);
  const json = (await safeJson(c)) ?? {};
  const parsed = patchInput.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  const task = await prisma.scheduledTask.findFirst({
    where: { id: scheduleId, instanceId: row.id },
  });
  if (!task) return c.json({ error: { message: 'schedule not found' } }, 404);
  return updateScheduleResponse(c, task, parsed.data);
});

// ---------- Sprite-callable (per-instance bearer on /v1/llm/:instanceId/...) ----
// Hermes uses these from inside the sprite via its `schedule-task` skill.

const sprite = new Hono();

sprite.post('/v1/llm/:instanceId/schedules', async (c) => {
  const auth = await authenticateSprite(c);
  if (!auth.ok) return c.json({ error: { message: auth.message } }, auth.status);
  const json = (await safeJson(c)) ?? {};
  const parsed = scheduleInput.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  return createScheduleResponse(c, auth.row, parsed.data);
});

sprite.get('/v1/llm/:instanceId/schedules', async (c) => {
  const auth = await authenticateSprite(c);
  if (!auth.ok) return c.json({ error: { message: auth.message } }, auth.status);
  const tasks = await prisma.scheduledTask.findMany({
    where: { instanceId: auth.row.id },
    orderBy: { createdAt: 'desc' },
  });
  return c.json({ schedules: tasks.map(toApiShape) });
});

sprite.delete('/v1/llm/:instanceId/schedules/:scheduleId', async (c) => {
  const auth = await authenticateSprite(c);
  if (!auth.ok) return c.json({ error: { message: auth.message } }, auth.status);
  const scheduleId = c.req.param('scheduleId');
  await prisma.scheduledTask.deleteMany({ where: { id: scheduleId, instanceId: auth.row.id } });
  return c.body(null, 204);
});

sprite.patch('/v1/llm/:instanceId/schedules/:scheduleId', async (c) => {
  const auth = await authenticateSprite(c);
  if (!auth.ok) return c.json({ error: { message: auth.message } }, auth.status);
  const scheduleId = c.req.param('scheduleId');
  const json = (await safeJson(c)) ?? {};
  const parsed = patchInput.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: { message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
  }
  const task = await prisma.scheduledTask.findFirst({
    where: { id: scheduleId, instanceId: auth.row.id },
  });
  if (!task) return c.json({ error: { message: 'schedule not found' } }, 404);
  return updateScheduleResponse(c, task, parsed.data);
});

// ---------- shared helpers ----------

interface InstanceRef {
  id: string;
  userId: string;
}

async function createScheduleResponse(
  c: Context,
  row: InstanceRef,
  input: z.infer<typeof scheduleInput>,
) {
  if (!isValidCron(input.cron_expr, input.timezone)) {
    return c.json({ error: { message: `invalid cron expression '${input.cron_expr}' for tz '${input.timezone}'` } }, 400);
  }
  const next = safeNextRun(input.cron_expr, input.timezone);
  if (!next) return c.json({ error: { message: 'could not compute next run' } }, 400);
  const created = await prisma.scheduledTask.create({
    data: {
      instanceId: row.id,
      userId: row.userId,
      name: input.name,
      prompt: input.prompt,
      cronExpr: input.cron_expr,
      timezone: input.timezone,
      enabled: input.enabled,
      nextRunAt: next,
    },
  });
  return c.json(toApiShape(created), 201);
}

async function updateScheduleResponse(
  c: Context,
  task: { id: string; cronExpr: string; timezone: string },
  patch: z.infer<typeof patchInput>,
) {
  const newCron = patch.cron_expr ?? task.cronExpr;
  const newTz = patch.timezone ?? task.timezone;
  if (patch.cron_expr || patch.timezone) {
    if (!isValidCron(newCron, newTz)) {
      return c.json({ error: { message: `invalid cron expression '${newCron}'` } }, 400);
    }
  }
  const next = safeNextRun(newCron, newTz) ?? new Date(Date.now() + 24 * 60 * 60_000);
  const updated = await prisma.scheduledTask.update({
    where: { id: task.id },
    data: {
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.prompt ? { prompt: patch.prompt } : {}),
      ...(patch.cron_expr ? { cronExpr: patch.cron_expr } : {}),
      ...(patch.timezone ? { timezone: patch.timezone } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      nextRunAt: next,
    },
  });
  return c.json(toApiShape(updated));
}

function toApiShape(task: {
  id: string;
  name: string;
  prompt: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
  nextRunAt: Date;
  createdAt: Date;
}) {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    cron_expr: task.cronExpr,
    timezone: task.timezone,
    enabled: task.enabled,
    last_run_at: task.lastRunAt?.toISOString() ?? null,
    last_error: task.lastError,
    next_run_at: task.nextRunAt.toISOString(),
    created_at: task.createdAt.toISOString(),
  };
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

interface AuthOk {
  ok: true;
  row: { id: string; userId: string };
}
interface AuthErr {
  ok: false;
  status: 401 | 404 | 500;
  message: string;
}

async function authenticateSprite(c: Context): Promise<AuthOk | AuthErr> {
  const instanceId = c.req.param('instanceId') ?? '';
  if (!instanceId) return { ok: false, status: 401, message: 'missing instanceId' };
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return { ok: false, status: 401, message: 'missing bearer' };
  const bearer = header.slice(7).trim();
  if (!bearer) return { ok: false, status: 401, message: 'empty bearer' };
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row || !row.llmProxyToken) return { ok: false, status: 404, message: 'instance not found' };
  let expected: string;
  try {
    expected = await decryptSecret(row.llmProxyToken);
  } catch (err) {
    logger.error({ err }, 'schedule_auth_decrypt_failed');
    return { ok: false, status: 500, message: 'decrypt failed' };
  }
  if (bearer !== expected) return { ok: false, status: 401, message: 'bad bearer' };
  return { ok: true, row: { id: row.id, userId: row.userId } };
}

export { sokosumi as schedulesSokosumiRouter, sprite as schedulesSpriteRouter };
