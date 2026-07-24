import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { recordEvent } from '../audit.js';
import { decryptSecret } from '../crypto.js';
import { loadConfig } from '../config.js';
import { runCronAgentTurn } from './cron-agent-turn.js';

/**
 * Ground-truth guard for chat turns.
 *
 * Failure mode it catches: the agent ends a chat turn by telling the user it
 * DID a Sokosumi write ("here's what I told Elena", "I commented on the task",
 * "I moved it to READY") without ever calling the tool — a confabulated
 * completion. Tool-use enforcement doesn't catch this because the model never
 * attempts a tool call; it just narrates one as done.
 *
 * How: every executed write tool records a `sokosumi_write` audit event
 * (see sokosumi-mcp callTool). After a user chat turn, if the assistant's
 * reply CLAIMS a write but zero `sokosumi_write` events landed for this
 * instance since the turn started, we treat it as a probable confabulation:
 * log it for admin visibility and fire ONE self-heal turn that tells the agent
 * to either actually call the tool now or send the user a correction.
 *
 * The self-heal turn is driven via runCronAgentTurn (a direct machine call, not
 * the chat proxy), so it never re-enters this guard — no loops.
 */

/** How many recent chat turns the self-heal turn replays for context. */
const RECHECK_HISTORY = 8;
const RECHECK_TIMEOUT_MS = 4 * 60_000;

/**
 * High-precision, PAST-TENSE, first-person claims that a Sokosumi write
 * completed. Deliberately narrow — we'd rather miss a confab than nag on a
 * legitimate message. Future/intent ("I'll comment"), modal ("I can comment")
 * and negation ("I couldn't comment") are excluded both by requiring the past
 * tense inline and by the veto check in detectUnverifiedWriteClaim.
 */
const WRITE_CLAIM_PATTERNS: RegExp[] = [
  // Coworker-directed claim: "Here's what I told Elena", "I told Hannah",
  // "I answered Maya", "I replied to Hepha". Case-sensitive on purpose — it
  // requires a Capitalized name so conversational "I told you / I told her"
  // (talking to the user, not writing to a task) does NOT match.
  /\b(?:[Hh]ere'?s what I told|I(?:'ve| have)? told|I answered|I replied to)\s+[A-Z][a-z]+/,
  // Comments — "comment" vocabulary only lives on tasks:
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:left|added|posted|dropped|written)\s+(?:\w+\s+){0,3}comment/i,
  /\bi\s+commented\b/i,
  /\bcommented on (?:the|that|this|her|his|their)\b/i,
  // Status / move: "I moved it to READY", "I set the status to DONE":
  /\bi(?:'ve| have)?\s+(?:moved|set|marked|transitioned|flipped|changed)\s+(?:it|the task|the status|that|this)\b[^.!?\n]{0,40}\b(?:to|as)\b/i,
  // Created task/job: "I created the task", "I've kicked off the job":
  /\bi(?:'ve| have)?\s+(?:created|kicked off|started|queued)\s+(?:the\s+|a\s+|your\s+)?(?:task|job)\b/i,
  // Provided job input (narrow to "input" so conversational "I provided the
  // answer" doesn't trip it):
  /\bi(?:'ve| have)?\s+(?:provided|submitted|supplied)\s+(?:the\s+)?(?:required\s+)?input\b/i,
];

/**
 * Returns the matched claim snippet if `text` asserts a completed Sokosumi
 * write, or null. Vetoes matches preceded by an intent/modal ("I'll", "let me",
 * "I can") or containing a negation ("couldn't", "didn't", "unable").
 */
export function detectUnverifiedWriteClaim(text: string): string | null {
  if (!text) return null;
  for (const re of WRITE_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    // Future/intent immediately before the verb flips it from done to planned.
    if (
      /\b(?:i'?ll|i will|i'?m going to|i am going to|let me|i can|i could|i'?d|i would|about to|planning to|going to|need to|have to|want to|should i|shall i)\s*$/.test(
        before,
      )
    ) {
      continue;
    }
    // Negation / inability anywhere in the matched span flips it to not-done.
    const span = text.slice(m.index, m.index + m[0].length + 24).toLowerCase();
    if (
      /\b(?:couldn'?t|could not|can'?t|cannot|didn'?t|did not|won'?t|will not|unable|failed to|wasn'?t able|haven'?t|have not|not yet)\b/.test(
        span,
      )
    ) {
      continue;
    }
    return m[0].trim();
  }
  return null;
}

export interface GuardArgs {
  instanceId: string;
  userId: string;
  requestId: string;
  /** ms epoch when the chat turn started (CaptureCtx.startedAt). */
  turnStartedAt: number;
  /** The assistant's final reply text for this turn. */
  assistantText: string;
}

/**
 * Best-effort — never throws. Detects a confabulated write claim and, when
 * found with no matching real write this turn, records it and fires one
 * self-heal agent turn. Fire-and-forget from the chat proxy's capture.
 */
export async function runGroundTruthGuard(args: GuardArgs): Promise<void> {
  try {
    if (!loadConfig().GROUNDTRUTH_GUARD) return;
    const claim = detectUnverifiedWriteClaim(args.assistantText);
    if (!claim) return;

    // Did any real write execute during this turn? Agent turns are serialized
    // per instance, so any sokosumi_write for this instance since the turn
    // started belongs to this turn.
    const writeCount = await prisma.provisionEvent.count({
      where: {
        instanceId: args.instanceId,
        event: 'sokosumi_write',
        createdAt: { gte: new Date(args.turnStartedAt) },
      },
    });
    if (writeCount > 0) return; // claim is backed by a real write — leave it.

    const instance = await prisma.hermesInstance.findUnique({ where: { id: args.instanceId } });
    if (!instance || !instance.endpointUrl) return;
    // Low autonomy is read-only — the agent can't write, so a self-heal that
    // tries to "do it now" would just fail; skip.
    if (instance.autonomyLevel === 'low') return;

    await recordEvent({
      userId: args.userId,
      instanceId: args.instanceId,
      event: 'confabulation_suspected',
      detail: { requestId: args.requestId, claim: claim.slice(0, 200) },
    });
    logger.warn(
      { userId: args.userId, requestId: args.requestId, claim },
      'confabulation_suspected',
    );

    let apiKey: string;
    try {
      apiKey = await decryptSecret(instance.apiServerKey);
    } catch (err) {
      logger.warn({ err, userId: args.userId }, 'groundtruth_guard_decrypt_failed');
      return;
    }

    const prompt =
      `[Automated integrity check — NOT a new message from the user. In your last reply you told the ` +
      `user: "${claim}". Our records show you did NOT call the matching Sokosumi tool during that turn, ` +
      `so that action did NOT actually happen. Put it right now: if you meant to do it, CALL THE TOOL ` +
      `this turn (comments are free and immediate), then tell the user in ONE short line via your ` +
      `outbox-send skill what you actually did. If you did not mean to act, send the user a ONE-line ` +
      `correction via outbox-send. If our records are wrong and you genuinely already did it through a ` +
      `tool, reply with EXACTLY [SILENT] and nothing else.]`;

    await runCronAgentTurn({
      instanceId: args.instanceId,
      userId: args.userId,
      endpointUrl: instance.endpointUrl,
      apiKey,
      source: 'groundtruth_recheck',
      prompt,
      timeoutMs: RECHECK_TIMEOUT_MS,
      includeHistory: RECHECK_HISTORY,
    }).catch((err) =>
      logger.warn({ err, userId: args.userId }, 'groundtruth_guard_recheck_failed'),
    );
  } catch (err) {
    logger.warn({ err, requestId: args.requestId }, 'groundtruth_guard_failed');
  }
}
