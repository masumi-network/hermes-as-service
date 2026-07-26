import { logger } from '../logger.js';

/**
 * One agent turn at a time, per instance.
 *
 * Without this, every chat request spawned a parallel run on the same machine.
 * A real session:
 *
 *   16:20:42  "run the weekly release report now"     → turn A (8m 0s)
 *   16:26:29  "what happened??"                       → turn B (11m 50s)
 *
 * Turn A was still running when B started; they overlapped for 131 seconds.
 * Neither could see the other, and the agent said so out loud in turn B —
 * "the previous session context is lost since this is a new turn, let me redo
 * the full pipeline end to end". It did. The user got three CMS release
 * entries for three different (and partly nonsensical) week ranges, plus
 * duplicate approval cards, from one request.
 *
 * The user did nothing wrong: they waited six minutes with no visible progress
 * and asked what was going on. So the answer isn't to reject their message —
 * it's to answer it immediately with the truth ("still working, here's where I
 * am") instead of starting a second agent.
 */

interface ActiveTurn {
  startedAt: number;
  requestId: string;
  /** First ~120 chars of the message that started it, for the status reply. */
  prompt: string;
}

/**
 * Hard ceiling on how long a turn may hold the slot. Real turns have been
 * observed at ~12 minutes; past this we assume the tracking leaked (a crash
 * between acquire and release) and let the next message through rather than
 * wedging the instance forever.
 */
const MAX_TURN_MS = 20 * 60_000;

const active = new Map<string, ActiveTurn>();

/** Try to claim the turn slot. Returns null on success, or the turn already
 *  running. */
export function acquireTurn(
  instanceId: string,
  turn: { requestId: string; prompt: string },
): ActiveTurn | null {
  const existing = active.get(instanceId);
  if (existing) {
    if (Date.now() - existing.startedAt < MAX_TURN_MS) return existing;
    logger.warn(
      { instanceId, staleRequestId: existing.requestId, ageMs: Date.now() - existing.startedAt },
      'turn_guard_stale_slot_reclaimed',
    );
  }
  active.set(instanceId, {
    startedAt: Date.now(),
    requestId: turn.requestId,
    prompt: turn.prompt.slice(0, 120),
  });
  return null;
}

/** Release the slot. Safe to call twice; only clears the turn that owns it. */
export function releaseTurn(instanceId: string, requestId: string): void {
  const existing = active.get(instanceId);
  if (existing && existing.requestId !== requestId) return;
  active.delete(instanceId);
}

/** Test seam. */
export function resetTurnGuard(): void {
  active.clear();
}

/**
 * Reply in the shape the caller asked for — an SSE chat-completion stream or a
 * plain JSON completion. Must look like a NORMAL successful answer, not an
 * error: Sokosumi renders it straight into the chat, and the user's question
 * deserves a reply rather than a red banner.
 */
export function busyResponse(text: string, streaming: boolean, model?: string): Response {
  const id = `chatcmpl-busy-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const m = model ?? 'hermes-agent';
  if (!streaming) {
    return new Response(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: m,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const frame = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: m,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body = frame({ role: 'assistant', content: text }, null) + frame({}, 'stop') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 1 && rem === 0) return '1 minute';
  return rem === 0 ? `${m} minutes` : `${m} min ${rem} s`;
}

/**
 * The reply sent instead of starting a second agent. Says what is running, how
 * long it has been going, and what it is doing right now when the progress bus
 * knows — the information the user was actually asking for.
 */
export function busyMessage(turn: ActiveTurn, currentActivity?: string | null): string {
  const elapsed = humanDuration(Date.now() - turn.startedAt);
  const doing = currentActivity ? `\n\nRight now: ${currentActivity}` : '';
  return `I'm still working on your previous message — "${turn.prompt}" — started ${elapsed} ago.${doing}\n\nI haven't started on this new message yet; send it again once I've replied, and I'll pick it up. (Starting a second run in parallel would duplicate the work.)`;
}
