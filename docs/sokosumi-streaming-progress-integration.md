# Sokosumi ↔ Hermes Orchestrator: Streaming + Live Progress

**Audience:** Sokosumi platform devs working on the chat UI.
**Status:** Orchestrator side is built (behind an opt-in header — zero impact until you turn it on). Awaiting your UI work.
**Contact:** Patrick (orchestrator team).

---

## 1. What we're changing and why

Today the chat is **non-streaming**: Sokosumi waits for the whole response, so the user watches a spinner for the entire turn — which can be **minutes** when the agent searches the web, hands work to a coworker (Hannah/Hepha), reads their inbox, etc. — and then the full answer appears at once.

We're adding two things, both on the same endpoint you already call:

1. **Token streaming** — the answer appears word-by-word as the agent writes it.
2. **Live progress** — while the agent is working (before any answer text exists), we emit status events you can render as ephemeral chips: *"Searching the web"*, *"Asking Hannah — Mixture-of-Experts routing"*, *"Reading your inbox"*.

Both are **opt-in** and **backward-compatible**. If you change nothing, the endpoint behaves exactly as before.

---

## 2. How to turn it on

Same endpoint: `POST /v1/proxy/:userId/v1/chat/completions`.

1. Send `"stream": true` in the JSON body (standard OpenAI streaming).
2. Send the header **`X-Hermes-Progress: 1`** (or query `?progress=1`) to also receive progress events.

```
POST /v1/proxy/{userId}/v1/chat/completions
Authorization: Bearer <ORCHESTRATOR_API_TOKEN>
Content-Type: application/json
Accept: text/event-stream
X-Hermes-Progress: 1

{ "model": "hermes-agent", "stream": true, "messages": [...] }
```

Without `X-Hermes-Progress`, a `stream: true` request is a **pure OpenAI SSE stream** (just `data:` chat chunks) — no custom events. Without `stream: true`, you get the buffered JSON response exactly like today.

---

## 3. The wire format

The response is `text/event-stream`. Two kinds of frames are interleaved:

**(a) Standard OpenAI chat chunks** — unchanged, exactly what you'd parse from any OpenAI-compatible stream:

```
data: {"choices":[{"delta":{"content":"Agentic"}}]}

data: {"choices":[{"delta":{"content":" workflows"}}]}

data: [DONE]
```

**(b) Hermes progress frames** — a **named SSE event** (`event: hermes.status`). Your client listens for the `hermes.status` event specifically. **Important:** your SSE parser must branch on the `event:` field. A spec-compliant SSE parser routes these to a `hermes.status` listener and they never reach your default `message`/chat handler. But a naive parser that treats *every* `data:` line as a chat chunk (e.g. `for line in resp: if line.startswith("data:"): json.loads(...)`) will feed `{"phase":...}` into your chat-chunk parsing — our payloads deliberately omit `choices`, so a defensive `chunk.choices?.[0]?.delta?.content` access skips them safely, but strict eager validators may error. If your client can't branch on `event:`, omit `X-Hermes-Progress` (see §2).

```
event: hermes.status
data: {"phase":"thinking","elapsedMs":0,"ts":1718900000000}

event: hermes.status
data: {"phase":"tool","tool":"web_search","label":"Searching the web","detail":"agentic workflows 2026","elapsedMs":1200,"ts":...}

event: hermes.status
data: {"phase":"answering","elapsedMs":8400,"ts":...}
```

> If your SSE client can't cleanly ignore named events, just **omit `X-Hermes-Progress`** and consume the plain OpenAI stream. The progress layer is strictly additive.

---

## 4. `hermes.status` event schema

```ts
{
  phase: "thinking" | "reasoning" | "tool" | "tool_done" | "working" | "answering",
  tool?:   string,   // machine id, e.g. "web_search", "GMAIL_FETCH_EMAILS"
  id?:     string,   // tool_call_id — pair a `tool` chip with its `tool_done`
  label?:  string,   // SHORT human label to show: "Searching the web"
  detail?: string,   // tool: the query/topic. tool_done: a short result summary.
  elapsedMs: number, // ms since the turn started — drive an elapsed timer
  ts: number         // epoch ms the event was emitted
}
```

Phases:

| phase | when | suggested UI |
|---|---|---|
| `thinking` | immediately, at t=0 | flip from "sending" to "Hermes is thinking…" |
| `reasoning` | the agent's own thought before an action/answer | show `detail` as a transient "💭 thinking" line (a short snippet of the model's reasoning) |
| `tool` | the agent invoked a tool | show/append a chip from `label` (+ `detail`) |
| `tool_done` | that tool's result came back | mark the matching chip complete; `detail` is a short result summary ("found 5 results…") |
| `working` | heartbeat during a silent stretch (~every 20s) | keep the "thinking…" state alive + update elapsed timer |
| `answering` | the answer has started streaming | clear the chips; render the answer |

**Pairing `tool` ↔ `tool_done`:** match on `id` (the `tool_call_id`) when present; fall back to `tool` (name) otherwise. A `tool` chip is followed by its `tool_done` once the result returns — render it as the chip completing (e.g. spinner → check, with the summary as a subtitle). Parallel tool calls in one round each get their own `tool`/`tool_done` pair. Like all progress, `tool_done` is advisory — if one is missing, just leave the chip in its last state; the answer is unaffected.

**`label` is always present and always safe to display** — for unknown tools we humanise the name (e.g. `NOTION_SEARCH_PAGES` → "Notion search pages") rather than send nothing. `detail` is best-effort (a search query, a coworker's name, a task topic) and may be absent.

---

## 5. Rendering guidance

The intended UX:

1. User sends a message → you immediately show a "thinking" state (don't wait for the first byte; you'll get a `thinking` frame at t=0, but you can optimistically render on send).
2. As `tool` frames arrive, show them as a small stack of live chips above the (empty) answer area. `detail` is a nice second line — *"Asking Hannah · Mixture-of-Experts routing"*.
3. `working` heartbeats mean "still going" — update an elapsed timer; don't add a chip per heartbeat.
4. On `answering`, **clear the chips** and start rendering `delta.content` tokens as they stream.
5. On `data: [DONE]`, finalise.

Chips are **ephemeral** — they're a window into the current turn, not chat history. Don't persist them.

---

## 6. Guarantees & ordering

- **Frame integrity:** progress frames are only ever injected at SSE frame boundaries. A `hermes.status` frame will never appear in the middle of a `data:` chat chunk. You can parse the stream with a standard SSE parser.
- **Ordering:** `thinking` is first. `tool`/`working` frames arrive during the work phase. `answering` arrives once, before the first content token. Chat `data:` content chunks are in order and identical to a normal OpenAI stream.
- **`answering` fires once per turn.** If a turn produces no text at all (rare), you may not get one — fall back to `[DONE]`.
- **The chat content is authoritative.** Progress is advisory UI sugar. If a progress event is missing or out of order, the answer is unaffected. Never block rendering the answer on a progress event.

---

## 7. What this does NOT change

- Auth, endpoint path, request body shape, and the non-streaming behaviour are all unchanged.
- The onboarding/welcome flow (the separate integration brief) is untouched.
- We do **not** stream the agent's private chain-of-thought — only coarse tool/phase labels safe to show a user.

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| Client disconnects mid-turn | We tear down promptly; the assistant message is still captured server-side. |
| Long silent tool loop | `working` heartbeats (~20s) keep the connection alive and the timer moving. |
| Tool we don't have a label for | `label` is a humanised version of the tool name; still safe to show. |
| `X-Hermes-Progress` omitted | Pure OpenAI SSE — no `hermes.status` frames at all. |
| Non-streaming request | Buffered JSON, exactly like today. |

---

## 9. What we need from you

1. Sign-off on the `hermes.status` schema (§4) and phases.
2. Confirm your SSE client either (a) listens for the named `hermes.status` event, or (b) cleanly ignores non-default events — so we know whether to default the header on.
3. A test user ID + a willingness to dogfood a multi-tool turn (e.g. "research X and make an infographic") so we can verify the chip sequence end-to-end.

Reply on this doc or ping Patrick.
