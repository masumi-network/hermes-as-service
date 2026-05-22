import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { runOnboarding } from './onboarding.js';

/**
 * Boot-time sweep: any instance whose status is 'onboarding' must be
 * stranded — onboarding promises live in-process, so an orchestrator
 * restart while one was running leaves the DB row with a 'running' step
 * and no one driving it.
 *
 * We re-kick runOnboarding for each such instance. It's idempotent at
 * the row level (status flips to onboarding → ready), and re-running a
 * "done" step is safe because each step writes its own outcome.
 */
export async function recoverStrandedOnboardings(): Promise<void> {
  const stranded = await prisma.hermesInstance.findMany({
    where: {
      status: 'onboarding',
      onboardedAt: null,
      destroyedAt: null,
    },
    select: { id: true, userId: true, createdAt: true },
    take: 50,
  });
  if (stranded.length === 0) return;
  logger.info({ count: stranded.length }, 'onboarding_recovery_starting');
  for (const inst of stranded) {
    logger.info(
      { instanceId: inst.id, userId: inst.userId, createdAt: inst.createdAt },
      'onboarding_recovery_retrying',
    );
    // Reset running/pending steps to pending so the pipeline picks them up.
    try {
      const row = await prisma.hermesInstance.findUnique({
        where: { id: inst.id },
        select: { onboardingSteps: true },
      });
      const steps = ((row?.onboardingSteps as Array<{ id: string; status: string }> | null) ?? []).map(
        (s) => (s.status === 'running' ? { ...s, status: 'pending' } : s),
      );
      await prisma.hermesInstance.update({
        where: { id: inst.id },
        data: { status: 'infrastructure_ready', onboardingSteps: steps as object },
      });
    } catch (err) {
      logger.warn({ err, instanceId: inst.id }, 'onboarding_recovery_reset_failed');
      continue;
    }
    // Fire-and-forget — same pattern as the /onboard route handler.
    void runOnboarding(inst.id, {}).catch((err) =>
      logger.error({ err, instanceId: inst.id }, 'onboarding_recovery_run_failed'),
    );
  }
}
