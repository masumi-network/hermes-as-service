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

export interface LeaseHolderInfo {
  /** Human phrase for what holds the machine, from describeLeaseHolder. */
  holder: string;
  /** When it started, when derivable — omitted rather than guessed. */
  since?: Date;
}

/** Human phrasing for whatever holds the machine lease. */
export function describeLeaseHolder(kind: string | null): string {
  if (!kind || kind === 'chat') return 'your previous message';
  const named: Record<string, string> = {
    board_sweep: 'a background check of your task board',
    approval_continuation: 'the action you just approved',
    native_prompt: 'a scheduled task',
    inbox_refresh: 'a background inbox refresh',
    sokosumi_sync: 'a background workspace sync',
  };
  return named[kind] ?? `a background task (${kind})`;
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
 * The reply sent instead of starting a second agent. Says WHAT is running, how
 * long it has been going when we can tell, and what it is doing right now when
 * the progress bus knows — the information the user was actually asking for.
 *
 * Note the holder may be a background sweep, not the user's own last message,
 * so the wording must not assume "your previous message".
 */
export function busyMessage(info: LeaseHolderInfo, currentActivity?: string | null): string {
  const elapsed = info.since ? ` (started ${humanDuration(Date.now() - info.since.getTime())} ago)` : '';
  const doing = currentActivity ? `\n\nRight now: ${currentActivity}` : '';
  return `I'm still busy with ${info.holder}${elapsed}, so I haven't started on this yet — running two things at once would make a mess of both.${doing}\n\nSend this again once I've replied and I'll pick it up.`;
}
