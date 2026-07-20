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
  if (!row || row.destroyedAt) return c.json({ error: { message: 'instance not found' } }, 404);

  // Orchestrator-managed tasks (system + user-created through our API).
  const orchTasks = await prisma.scheduledTask.findMany({
    where: { instanceId: row.id },
    orderBy: { createdAt: 'desc' },
  });

  // Hermes-managed tasks (created via Hermes' built-in cronjob tool, e.g.
  // daily-suggestions and anything the user has asked the agent to
  // schedule mid-conversation). Best-effort — if Hermes' API doesn't
  // expose its cron list, we return [] and don't block the response.
  let hermesTasks: Array<{
    id: string;
    name: string;
    cron_expr: string;
    enabled: boolean;
    source: 'hermes';
  }> = [];
  if (row.endpointUrl && row.apiServerKey) {
    try {
      const apiKey = await decryptSecret(row.apiServerKey);
      hermesTasks = await fetchHermesCronList(row.endpointUrl, apiKey);
    } catch (err) {
      logger.debug({ err, userId }, 'hermes_cron_list_fetch_failed');
    }
  }

  return c.json({
    schedules: [
      ...orchTasks.map((t) => ({ ...toApiShape(t), source: 'orchestrator' as const })),
      ...hermesTasks,
    ],
  });
});

sokosumi.delete('/v1/instances/:userId/schedules/:scheduleId', async (c) => {
  const userId = c.req.param('userId');
  const scheduleId = c.req.param('scheduleId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: { message: 'instance not found' } }, 404);
  await prisma.scheduledTask.deleteMany({
    where: { id: scheduleId, instanceId: row.id, kind: 'user' },
  });
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
  // Upsert by (instance, name) — but ONLY for the orchestrator-defined
  // native prompt names (+ daily-brief): agents re-register those mirrors
  // on every reconcile pass and duplicates would double-list them. User
  // schedules keep plain-create semantics so a re-used name can never
  // silently clobber an existing user schedule's content.
  const { NATIVE_PROMPTS } = await import('../schedules/native-prompts.js');
  const upsertableNames = new Set([...NATIVE_PROMPTS.map((n) => n.name), 'daily-brief']);
  const existing = upsertableNames.has(input.name)
    ? await prisma.scheduledTask.findFirst({
        where: { instanceId: row.id, name: input.name, kind: 'user' },
        select: { id: true },
      })
    : null;
  if (existing) {
    const updated = await prisma.scheduledTask.update({
      where: { id: existing.id },
      data: {
        prompt: input.prompt,
        cronExpr: input.cron_expr,
        timezone: input.timezone,
        enabled: input.enabled,
        nextRunAt: next,
      },
    });
    return c.json(toApiShape(updated), 200);
  }
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
  kind?: string;
  description?: string | null;
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
    kind: task.kind ?? 'user',
    description: task.description ?? null,
  };
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * Probe Hermes' API for its native cron list and normalize the response.
 *
 * Hermes' upstream gateway may expose this under one of a few paths
 * depending on version. We try them in order and return whichever
 * succeeds; the response shapes are also normalized to {id, name,
 * cron_expr, enabled, source:"hermes"}.
 *
 * Failure modes (returns []):
 *   - Hermes' API not reachable
 *   - All probe paths 404
 *   - Response doesn't parse into the expected shape
 *
 * If Hermes doesn't expose a cron list endpoint at all, this returns
 * an empty array — the orchestrator-side ScheduledTask rows still
 * show up in the parent response.
 */
async function fetchHermesCronList(
  endpointUrl: string,
  apiKey: string,
): Promise<Array<{ id: string; name: string; cron_expr: string; enabled: boolean; source: 'hermes' }>> {
  const probeUrls = [
    `${endpointUrl}/v1/cron/jobs`,
    `${endpointUrl}/v1/cron`,
    `${endpointUrl}/cron/jobs`,
  ];
  for (const url of probeUrls) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as unknown;
      const jobs = extractCronJobs(body);
      if (jobs.length === 0 && !Array.isArray(body)) continue;
      return jobs.map((j) => ({
        id: j.id ?? j.name ?? '(unnamed)',
        name: j.name ?? j.id ?? '(unnamed)',
        cron_expr: j.cron_expr ?? j.cron ?? j.schedule ?? '',
        enabled: j.enabled ?? true,
        source: 'hermes' as const,
      }));
    } catch {
      // try next path
    }
  }
  return [];
}

interface RawCronJob {
  id?: string;
  name?: string;
  cron_expr?: string;
  cron?: string;
  schedule?: string;
  enabled?: boolean;
}

function extractCronJobs(body: unknown): RawCronJob[] {
  if (Array.isArray(body)) return body as RawCronJob[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['jobs', 'cron_jobs', 'cronjobs', 'items']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as RawCronJob[];
    }
  }
  return [];
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
