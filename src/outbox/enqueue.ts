import { prisma } from '../db.js';
import { logger } from '../logger.js';

// Per-spec soft caps.
const MAX_MESSAGES_PER_OUTBOX = 1000;
const MAX_CONTENT_BYTES = 32 * 1024;

export interface EnqueueArgs {
  instanceId: string;
  userId: string;
  content: string;
  kind?: string;
}

export interface EnqueueResult {
  id: string;
  createdAt: Date;
  truncated: boolean;
}

/**
 * Append a single message to a user's outbox, enforcing the 1000-message soft
 * cap by dropping oldest + inserting a synthetic overflow marker.
 *
 * Returns the enqueued message id + a `truncated` flag if the supplied
 * content was clipped to 32 KB.
 */
export async function enqueueOutboxMessage(args: EnqueueArgs): Promise<EnqueueResult> {
  let content = args.content;
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    content = clipToByteLength(content, MAX_CONTENT_BYTES);
    truncated = true;
  }
  const kind = args.kind && args.kind.length <= 64 ? args.kind : 'text';

  // Enforce the per-user cap in a transaction so concurrent writes can't
  // both push past 1000.
  const result = await prisma.$transaction(async (tx) => {
    const count = await tx.outboxMessage.count({ where: { userId: args.userId } });
    if (count >= MAX_MESSAGES_PER_OUTBOX) {
      const target = MAX_MESSAGES_PER_OUTBOX - 2; // leave room for marker + this new one
      const overshoot = count - target;
      // Identify oldest IDs to drop.
      const oldest = await tx.outboxMessage.findMany({
        where: { userId: args.userId },
        orderBy: { createdAt: 'asc' },
        take: overshoot,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await tx.outboxMessage.deleteMany({
          where: { id: { in: oldest.map((r) => r.id) } },
        });
        // Synthetic overflow marker so Sokosumi sees the gap.
        await tx.outboxMessage.create({
          data: {
            instanceId: args.instanceId,
            userId: args.userId,
            kind: 'text',
            content: `[Hermes outbox overflow — ${oldest.length} earlier messages dropped]`,
          },
        });
      }
    }
    return tx.outboxMessage.create({
      data: {
        instanceId: args.instanceId,
        userId: args.userId,
        kind,
        content,
      },
    });
  });

  if (truncated) {
    logger.warn(
      { userId: args.userId, originalBytes: Buffer.byteLength(args.content, 'utf8') },
      'outbox_content_truncated',
    );
  }
  return { id: result.id, createdAt: result.createdAt, truncated };
}

function clipToByteLength(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  // Trim ~64 bytes of headroom for the trailing notice.
  const headroom = 64;
  let cut = maxBytes - headroom;
  // Don't slice mid-codepoint.
  while (cut > 0 && (buf[cut] !== undefined && (buf[cut]! & 0xc0) === 0x80)) cut--;
  return buf.subarray(0, cut).toString('utf8') + '… [truncated]';
}
