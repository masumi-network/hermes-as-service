import { prisma } from './db.js';
import { logger } from './logger.js';
import { notifyMasumi, shortId } from './notify/masumi.js';

// Failure + lifecycle events forwarded to the Masumi Team Channel. Kept
// deliberately tight so the channel stays high-signal (chat_proxied /
// chat_failed / onboarding_step etc. are intentionally excluded — too chatty).
const MASUMI_NOTIFY: Partial<
  Record<ProvisionEventType, (userId: string, detail?: Record<string, unknown>) => string>
> = {
  provision_failed: (u, d) => `🔴 Provision FAILED — ${shortId(u)}${detailSuffix(d)}`,
  integration_failed: (u, d) => `🔴 Integration failed — ${shortId(u)}${detailSuffix(d)}`,
  hermes_task_failed: (u, d) => `🔴 Hermes task failed — ${shortId(u)}${detailSuffix(d)}`,
  onboarding_done: (u) => `✅ New instance onboarded — ${shortId(u)}`,
  destroyed: (u) => `🗑️ Instance destroyed — ${shortId(u)}`,
};

function detailSuffix(detail?: Record<string, unknown>): string {
  if (!detail) return '';
  const msg = detail['error'] ?? detail['errorMessage'] ?? detail['reason'];
  if (typeof msg === 'string' && msg) return `: ${msg.slice(0, 200)}`;
  return '';
}

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
  | 'chat_failed'
  | 'hermes_task_picked'
  | 'hermes_task_completed'
  | 'hermes_task_failed'
  | 'eod_report_sent'
  | 'skill_installed'
  | 'skill_install_queued'
  | 'skill_removed';

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

  // Forward high-signal failure/lifecycle events to the Masumi Team Channel.
  // Best-effort; keyed per event+user so a flapping instance is throttled.
  const fmt = MASUMI_NOTIFY[args.event];
  if (fmt) {
    notifyMasumi(fmt(args.userId, args.detail), { key: `${args.event}:${args.userId}` });
  }
}
