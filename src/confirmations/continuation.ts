import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { isCronNoOp } from '../routes/outbox.js';

/** One agent turn is plenty; cap it so a stuck machine can't wedge the flow. */
const CONTINUATION_TIMEOUT_MS = 4 * 60_000;
/** Enough recent turns to carry the plan ("…then comment on it") without
 *  replaying the whole conversation. */
const HISTORY_LIMIT = 10;

export interface ContinuationInstance {
  id: string;
  userId: string;
  endpointUrl: string | null;
  apiServerKey: string;
  autonomyLevel: string;
}

/**
 * Resume the agent after the user approves a pending action.
 *
 * When a write raises a confirmation card, the agent's turn ENDS there — so
 * any follow-up it planned ("create the task, then comment on it") is lost:
 * approving only executes the one queued tool. This gives the agent its turn
 * back. It replays the recent conversation (the machine is driven by the
 * history Sokosumi sends each turn, so a bare nudge wouldn't recall the plan)
 * plus a note that the action is done, and lets the agent finish. Free follow-
 * ups (comments are write-light) execute immediately; anything that spends or
 * creates still raises a fresh card, so an approval can never chain into
 * autonomous spending.
 *
 * Returns the agent's short end-to-end summary to post in chat, or null when
 * it had nothing further (so the caller falls back to the canned "here's your
 * task" announcement). Best-effort: any failure returns null, never throws.
 */
export async function runApprovalContinuation(args: {
  instance: ContinuationInstance;
  toolName: string;
  resultText: string;
}): Promise<string | null> {
  const { instance, toolName, resultText } = args;
  if (!instance.endpointUrl) return null;
  // Low autonomy is read-only and never raises cards; guard anyway so an
  // approval can't drive autonomous follow-through there.
  if (instance.autonomyLevel === 'low') return null;

  const history = await prisma.chatMessage.findMany({
    where: { userId: instance.userId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  const messages: { role: string; content: string }[] = history
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  messages.push({
    role: 'user',
    content:
      `[Automated continuation — NOT a new message from the user. Your pending "${toolName}" ` +
      `was just APPROVED and completed. Result:\n${resultText.slice(0, 1500)}\n\n` +
      `Now carry out the next step you told the user you would take (for example, the comment you ` +
      `said you'd add). Comments post immediately. Anything that creates a task/job or spends ` +
      `credits still needs a fresh confirmation — propose it the normal way, don't force it. When ` +
      `done, reply with ONE short line summarizing what you did end-to-end. If you promised no ` +
      `further step, reply with EXACTLY [SILENT] and nothing else.]`,
  });

  let apiKey: string;
  try {
    apiKey = await decryptSecret(instance.apiServerKey);
  } catch (err) {
    logger.warn({ err, userId: instance.userId }, 'approval_continuation_decrypt_failed');
    return null;
  }

  try {
    const res = await fetch(`${instance.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hermes-agent', messages, stream: false }),
      signal: AbortSignal.timeout(CONTINUATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, userId: instance.userId }, 'approval_continuation_http_error');
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    // Empty or a "nothing more to do" reply → let the caller use the canned
    // announcement instead. Reuse the outbox no-op detector so "[SILENT]" and
    // narrated non-answers are treated the same here as anywhere else.
    if (!text || isCronNoOp(text, 'confirmation_resolved')) return null;
    logger.info({ userId: instance.userId, toolName }, 'approval_continuation_completed');
    return text;
  } catch (err) {
    logger.warn({ err, userId: instance.userId }, 'approval_continuation_failed');
    return null;
  }
}
