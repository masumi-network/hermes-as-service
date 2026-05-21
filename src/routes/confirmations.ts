import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { approveConfirmation, rejectConfirmation } from '../confirmations/store.js';

const router = new Hono();

const rejectBody = z.object({
  reason: z.string().min(1).max(500).optional(),
});

/**
 * Approve a pending confirmation. Sokosumi UI calls this when the user
 * clicks "Approve" in the in-chat confirmation box.
 *
 * Returns:
 *   200 { status: "approved", result: "..." } — tool executed successfully
 *   200 { status: "errored",  error: "..." }  — execution failed after approval
 *   200 { status: "already_resolved" }        — race / double-click safe
 *   404 { error: { message: ... } }           — confirmation not found
 */
router.post('/v1/instances/:userId/confirmations/:confirmationId/approve', async (c) => {
  const userId = c.req.param('userId');
  const confirmationId = c.req.param('confirmationId');
  const instance = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!instance || instance.destroyedAt) {
    return c.json({ error: { message: 'instance not found' } }, 404);
  }
  const result = await approveConfirmation(instance.id, confirmationId);
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
