import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { approveConfirmation, rejectConfirmation, type ApprovalOverrides } from '../confirmations/store.js';

const router = new Hono();

const rejectBody = z.object({
  reason: z.string().min(1).max(500).optional(),
});

// Override values can be a string id OR explicit null ("personal scope").
// Real-world Sokosumi org ids are cuids (e.g. cmayzk8f60002v7jg66bmvsg3),
// not strict UUIDs — accept a loose alnum-with-dashes/underscores format
// and cap the length so we don't forward arbitrary input downstream.
const idOrNull = z.union([
  z.string().regex(/^[A-Za-z0-9_-]+$/, 'organizationId must be alphanumeric').min(1).max(64),
  z.null(),
]);

const approveBody = z
  .object({
    overrides: z
      .object({
        organizationId: idOrNull.optional(),
      })
      .passthrough() // forward-compat: extra keys are tolerated, not rejected
      .optional(),
  })
  .passthrough();

/**
 * Approve a pending confirmation. Sokosumi UI calls this when the user
 * clicks "Approve" in the in-chat confirmation box.
 *
 * Optional body (additive — pre-existing callers with no body still work):
 *   { "overrides": { "organizationId": "<id>" | null } }
 *
 * When `overrides.organizationId` is present, the queued tool args are
 * patched before execution. Only `sokosumi_create_task` and
 * `sokosumi_create_job` honor the substitution; other tools log + ignore.
 *
 * Returns:
 *   200 { status: "approved", result: "..." } — tool executed successfully
 *   200 { status: "errored",  error: "..." }  — execution failed after approval
 *   200 { status: "already_resolved" }        — race / double-click safe
 *   400 { error: { message: ... } }           — malformed override
 *   404 { error: { message: ... } }           — confirmation not found
 */
router.post('/v1/instances/:userId/confirmations/:confirmationId/approve', async (c) => {
  const userId = c.req.param('userId');
  const confirmationId = c.req.param('confirmationId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }

  // Parse optional body. No body / non-JSON body / empty {} all mean "no
  // overrides" — keep the legacy approve path working.
  let overrides: ApprovalOverrides | undefined;
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = undefined;
    }
    if (raw && typeof raw === 'object') {
      const parsed = approveBody.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: { message: `invalid approve body: ${parsed.error.issues.map((i) => i.message).join('; ')}` } },
          400,
        );
      }
      const o = parsed.data.overrides;
      if (o && 'organizationId' in o) {
        overrides = { organizationId: o.organizationId ?? null };
      }
    }
  }

  const result = await approveConfirmation(instance.id, confirmationId, overrides);
  if (result.status === 'not_found') {
    return c.json({ error: { message: 'confirmation not found' } }, 404);
  }
  return c.json({
    status: result.status,
    result: result.resultText,
    error: result.errorMessage,
  });
});

/**
 * Reject a pending confirmation. Optional `reason` body is forwarded to
 * Hermes so it can ask the user what they'd prefer instead.
 */
router.post('/v1/instances/:userId/confirmations/:confirmationId/reject', async (c) => {
  const userId = c.req.param('userId');
  const confirmationId = c.req.param('confirmationId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }
  let reason: string | undefined;
  try {
    const body = (await c.req.json()) as unknown;
    const parsed = rejectBody.safeParse(body);
    if (parsed.success) reason = parsed.data.reason;
  } catch {
    // empty body is fine
  }
  const result = await rejectConfirmation(instance.id, confirmationId, reason);
  if (result.status === 'not_found') {
    return c.json({ error: { message: 'confirmation not found' } }, 404);
  }
  return c.json({ status: result.status });
});

/**
 * List pending confirmations for a user. Sokosumi UI can poll this if it
 * doesn't want to depend solely on the GET /v1/instances/:userId projection.
 */
router.get('/v1/instances/:userId/confirmations', async (c) => {
  const userId = c.req.param('userId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }
  const { listPendingConfirmations } = await import('../confirmations/store.js');
  const pending = await listPendingConfirmations(instance.id);
  return c.json({ confirmations: pending });
});

export { router as confirmationsRouter };
