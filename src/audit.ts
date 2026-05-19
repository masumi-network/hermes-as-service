import { prisma } from './db.js';
import { logger } from './logger.js';

export type ProvisionEventType =
  | 'created'
  | 'creating_sprite'
  | 'sprite_created'
  | 'bootstrap_started'
  | 'bootstrap_done'
  | 'env_written'
  | 'service_registered'
  | 'ready'
  | 'infrastructure_ready'
  | 'onboarding_started'
  | 'onboarding_step'
  | 'onboarding_done'
  | 'returning_user_resumed'
  | 'integration_connecting'
  | 'integration_connected'
  | 'integration_failed'
  | 'integration_removed'
  | 'provision_failed'
  | 'suspended'
  | 'resumed'
  | 'secret_set'
  | 'destroyed'
  | 'chat_proxied'
  | 'chat_failed';

/**
 * Persist a lifecycle event to ProvisionEvent. Never throws — auditing must
 * not break the calling path.
 */
export async function recordEvent(args: {
  userId: string;
  instanceId?: string | null;
  event: ProvisionEventType;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.provisionEvent.create({
      data: {
        userId: args.userId,
        instanceId: args.instanceId ?? null,
        event: args.event,
        detail: args.detail ? (args.detail as object) : undefined,
      },
    });
  } catch (err) {
    logger.error({ err, args }, 'record_event_failed');
  }
}
