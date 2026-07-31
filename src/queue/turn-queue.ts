import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { runCronAgentTurn, MachineBusyError } from '../notifications/cron-agent-turn.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';

/**
 * Replay of user messages that arrived while the machine was busy.
 *
 * The machine runs exactly one agent turn at a time (routes/machine-lease.ts).
 * When a user typed during a background sweep we used to answer "send this
 * again once I've replied" and drop their message on the floor — the busy
 * branch returns before the ChatMessage insert, so nothing survived. That is
 * the orchestrator making its own concurrency limit the human's problem.
 *
 * Now the message is persisted and replayed as soon as the machine frees up,
 * with the reply pushed to the user's outbox.
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 * · FIFO per instance, and strictly one at a time — the replay itself takes
 *   the machine lease via runCronAgentTurn, so it cannot interleave with a
 *   sweep or a live chat turn.
 * · CLAIMED with an atomic compare-and-swap (same shape as the machine lease)
 *   so two drainers, or a drainer racing the boot sweep, cannot double-send.
 * · A drain is triggered by lease RELEASE, not polled — the moment the machine
 *   is free is exactly when we want to run. A periodic sweep is the safety net
 *   for the case where the releasing process died.
 * · Re-entrancy guard: draining runs a turn, which acquires and releases the
 *   lease, which would trigger another drain. `draining` breaks that cycle.
 */

/** Beyond this many unsent messages we stop accepting — a queue the user can
 *  no longer reason about is worse than an honest refusal. */
const MAX_QUEUE_DEPTH = 5;

/** A message older than this is almost certainly stale: the user has moved on,
 *  or asked again. Replaying it would be confusing, so it is dropped with a
 *  recorded reason rather than answered late. */
const MAX_AGE_MS = 30 * 60_000;

/** Give up after this many failed replays. */
const MAX_ATTEMPTS = 3;

const AGENT_TURN_TIMEOUT_MS = 4 * 60_000;

/** Instances with a drain in flight IN THIS PROCESS. */
const draining = new Set<string>();

export class QueueFullError extends Error {
  constructor(readonly depth: number) {
    super(`queue full (${depth})`);
    this.name = 'QueueFullError';
  }
}

/**
 * Hold a user message for replay. Throws QueueFullError when the user already
 * has MAX_QUEUE_DEPTH messages waiting, so the caller can say so plainly
 * instead of silently swallowing the message.
 */
export async function enqueueTurn(args: {
  instanceId: string;
  userId: string;
  content: string;
  requestId: string;
}): Promise<{ id: string; depth: number }> {
  const depth = await prisma.queuedTurn.count({
    where: { instanceId: args.instanceId, deliveredAt: null },
  });
  if (depth >= MAX_QUEUE_DEPTH) throw new QueueFullError(depth);

  const row = await prisma.queuedTurn.create({
    data: {
      instanceId: args.instanceId,
      userId: args.userId,
      content: args.content,
      requestId: args.requestId,
    },
    select: { id: true },
  });
  logger.info(
    { instanceId: args.instanceId, queuedTurnId: row.id, depth: depth + 1 },
    'queued_turn_enqueued',
  );
  return { id: row.id, depth: depth + 1 };
}

/** Undelivered messages waiting for this instance. */
export async function queueDepth(instanceId: string): Promise<number> {
  return prisma.queuedTurn.count({ where: { instanceId, deliveredAt: null } });
}

/**
 * Claim the oldest waiting message with an atomic CAS. Returns null when there
 * is nothing to do or another drainer got there first.
 */
async function claimNext(
  instanceId: string,
  token: string,
): Promise<{ id: string; userId: string; content: string; requestId: string; createdAt: Date; attempts: number } | null> {
  const candidate = await prisma.queuedTurn.findFirst({
    where: { instanceId, deliveredAt: null, claimedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, content: true, requestId: true, createdAt: true, attempts: true },
  });
  if (!candidate) return null;
  const res = await prisma.queuedTurn.updateMany({
    // Only one caller can flip claimedAt from null.
    where: { id: candidate.id, claimedAt: null, deliveredAt: null },
    data: { claimedAt: new Date(), claimedBy: token, attempts: { increment: 1 } },
  });
  return res.count === 1 ? candidate : null;
}

/**
 * Replay every waiting message for an instance, oldest first.
 *
 * Safe to call spuriously: it no-ops when the queue is empty, when a drain is
 * already running in this process, and when the machine is busy (the next
 * release, or the safety-net sweep, will pick it up).
 */
export async function drainQueuedTurns(instanceId: string): Promise<{ sent: number; reason?: string }> {
  if (draining.has(instanceId)) return { sent: 0, reason: 'already_draining' };
  draining.add(instanceId);
  const token = randomUUID();
  let sent = 0;
  try {
    const row = await prisma.hermesInstance.findUnique({
      where: { id: instanceId },
      select: { userId: true, endpointUrl: true, apiServerKey: true, destroyedAt: true },
    });
    if (!row || row.destroyedAt || !row.endpointUrl) return { sent: 0, reason: 'no_instance' };

    let apiKey: string;
    try {
      apiKey = await decryptSecret(row.apiServerKey);
    } catch (err) {
      logger.warn({ err, instanceId }, 'queued_turn_decrypt_failed');
      return { sent: 0, reason: 'decrypt_failed' };
    }

    for (;;) {
      const item = await claimNext(instanceId, token);
      if (!item) break;
      const log = logger.child({ instanceId, queuedTurnId: item.id });

      const ageMs = Date.now() - item.createdAt.getTime();
      if (ageMs > MAX_AGE_MS) {
        await prisma.queuedTurn.update({
          where: { id: item.id },
          data: { deliveredAt: new Date(), lastError: `dropped_stale_after_${Math.round(ageMs / 60_000)}m` },
        });
        log.info({ ageMs }, 'queued_turn_dropped_stale');
        continue;
      }

      try {
        const turn = await runCronAgentTurn({
          instanceId,
          userId: item.userId,
          endpointUrl: row.endpointUrl,
          apiKey,
          source: 'queued_turn',
          prompt: buildReplayPrompt(item.content, ageMs),
          timeoutMs: AGENT_TURN_TIMEOUT_MS,
          // The replay is a real conversational turn, so it needs the thread.
          includeHistory: 8,
        });

        const reply = turn.reply.trim();
        if (reply) {
          await enqueueOutboxMessage({
            instanceId,
            userId: item.userId,
            content: reply,
            kind: 'queued_reply',
          });
        }
        await prisma.queuedTurn.update({
          where: { id: item.id },
          data: { deliveredAt: new Date(), lastError: reply ? null : 'empty_reply' },
        });
        sent += 1;
        log.info({ requestId: turn.requestId, delivered: !!reply }, 'queued_turn_replayed');
      } catch (err) {
        if (err instanceof MachineBusyError) {
          // Someone else took the machine between release and claim. Put it
          // back for the next drain rather than burning an attempt.
          await prisma.queuedTurn.update({
            where: { id: item.id },
            data: { claimedAt: null, claimedBy: null, attempts: { decrement: 1 } },
          });
          return { sent, reason: 'machine_busy' };
        }
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = item.attempts + 1 >= MAX_ATTEMPTS;
        await prisma.queuedTurn.update({
          where: { id: item.id },
          data: {
            claimedAt: null,
            claimedBy: null,
            lastError: message.slice(0, 500),
            ...(exhausted ? { deliveredAt: new Date() } : {}),
          },
        });
        log.warn({ err, attempts: item.attempts + 1, exhausted }, 'queued_turn_failed');
        if (!exhausted) return { sent, reason: 'retry_later' };
      }
    }
    return { sent };
  } finally {
    draining.delete(instanceId);
  }
}

/**
 * Frame the replay so the agent knows this is the user's own message arriving
 * late, not a system instruction — and knows to acknowledge the delay when it
 * was long enough for the user to notice.
 */
function buildReplayPrompt(content: string, ageMs: number): string {
  const waited = Math.round(ageMs / 1000);
  const delay =
    waited >= 60
      ? `\n\n(You were busy with background work when this arrived, so it waited ${Math.round(waited / 60)} min. Briefly acknowledge the delay in your first sentence, then answer.)`
      : '';
  return `${content}${delay}`;
}

/**
 * Safety net for messages whose drain never ran — the releasing process died,
 * or the machine was busy every time we tried. Also clears claims stranded by
 * a crash mid-replay.
 */
export async function sweepQueuedTurns(): Promise<void> {
  const stranded = await prisma.queuedTurn.updateMany({
    where: {
      deliveredAt: null,
      claimedAt: { lt: new Date(Date.now() - (AGENT_TURN_TIMEOUT_MS + 2 * 60_000)) },
    },
    data: { claimedAt: null, claimedBy: null },
  });
  if (stranded.count > 0) logger.warn({ count: stranded.count }, 'queued_turn_claims_released');

  const pending = await prisma.queuedTurn.findMany({
    where: { deliveredAt: null, claimedAt: null },
    distinct: ['instanceId'],
    select: { instanceId: true },
  });
  for (const p of pending) {
    await drainQueuedTurns(p.instanceId).catch((err) =>
      logger.warn({ err, instanceId: p.instanceId }, 'queued_turn_sweep_drain_failed'),
    );
  }
}

/** Fire-and-forget drain, for use right after a lease is released. */
export function scheduleDrain(instanceId: string): void {
  setTimeout(() => {
    void drainQueuedTurns(instanceId).catch((err) =>
      logger.warn({ err, instanceId }, 'queued_turn_drain_failed'),
    );
  }, 250).unref();
}
