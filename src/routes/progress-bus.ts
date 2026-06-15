// In-process pub/sub that lets the orchestrator surface what a Hermes agent
// is doing DURING a chat turn.
//
// The orchestrator sits in the middle of three streams for the same
// instance: the chat proxy (user-facing SSE), the LLM proxy (every
// tool DECISION the agent makes — OpenRouter returns tool_calls), and the
// MCP proxy (every tool EXECUTION). The Hermes gateway itself stays silent
// between tool calls, so without this bridge the user sees a spinner for
// minutes and then a wall of text.
//
// llm-proxy / mcp-proxy `publish()` progress as they observe it; the chat
// proxy `subscribe()`s for the life of an active streaming turn and injects
// the events into the SSE stream as `event: hermes.status` frames.
//
// Single-process only — same assumption the in-memory rate-limit buckets in
// llm-proxy already make (Railway runs one replica). If we ever scale out,
// this needs a shared bus (Redis pub/sub) or instance-sticky routing.
//
// Scoping caveat: events are keyed by instanceId, NOT by chat turn — because
// the publishers (llm-proxy/mcp-proxy) see the gateway's own outbound calls
// and the gateway gives us no per-turn correlation id to thread through. A
// HermesInstance is 1:1 with a user, so events never cross users. But if one
// user has two turns in flight for the same instance (two tabs, a reconnect
// while the first is still streaming, or a background cron firing during an
// open chat), every open chat stream for that instance sees the union of
// progress. This only mis-labels advisory progress chips — it never corrupts
// the SSE wire or the assistant content (those are per-request streams). The
// UI is told to treat progress as advisory. Effectively single-active-turn.

export type ProgressPhase = 'thinking' | 'tool' | 'tool_done' | 'working' | 'answering';

export interface ProgressEvent {
  /** Coarse lifecycle phase the UI can switch render style on. */
  phase: ProgressPhase;
  /** Machine tool id, e.g. "web_search", "gmail/GMAIL_FETCH_EMAILS". */
  tool?: string;
  /** Provider tool_call_id, so the UI can pair a `tool` chip with its `tool_done`. */
  id?: string;
  /** Human label the UI shows, e.g. "Searching the web". */
  label?: string;
  /** Optional secondary line, e.g. the search query or "Hannah". */
  detail?: string;
  /** ms since the turn started (set by the chat proxy on egress). */
  elapsedMs?: number;
  /** epoch ms the event was published. */
  ts: number;
}

type Subscriber = (event: ProgressEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();

/**
 * Publish a progress event for an instance. No-op (cheap) when nobody is
 * listening — the common case for background cron turns with no open chat.
 * A throwing subscriber never affects the publisher or other subscribers.
 */
export function publishProgress(instanceId: string, event: ProgressEvent): void {
  const set = subscribers.get(instanceId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      // a broken subscriber must not break publishing
    }
  }
}

/** True if at least one chat stream is currently listening for this instance. */
export function hasProgressSubscribers(instanceId: string): boolean {
  const set = subscribers.get(instanceId);
  return !!set && set.size > 0;
}

/**
 * Subscribe to an instance's progress events. Returns an unsubscribe
 * function that is safe to call more than once; the per-instance Set is
 * dropped when the last subscriber leaves so the map doesn't grow without
 * bound across the lifetime of the process.
 */
export function subscribeProgress(instanceId: string, fn: Subscriber): () => void {
  let set = subscribers.get(instanceId);
  if (!set) {
    set = new Set();
    subscribers.set(instanceId, set);
  }
  set.add(fn);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const s = subscribers.get(instanceId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(instanceId);
  };
}

/** Test/inspection helper. */
export function _subscriberCount(instanceId: string): number {
  return subscribers.get(instanceId)?.size ?? 0;
}
