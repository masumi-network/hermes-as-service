# Sokosumi ↔ Hermes Orchestrator: Onboarding v2 Integration Brief

**Audience:** Sokosumi platform devs integrating against the Hermes Orchestrator API.
**Status:** Proposed. Awaiting your sign-off before we ship the orchestrator side.
**Contact:** Patrick (orchestrator team).

---

## 1. What we're changing and why

Today, the user opens Hermes in Sokosumi and immediately lands in a chat with a generic welcome message ("Hey, I'm Hermes…"). The agent has no context about the user — no name, no email beyond what's passed at provision time, no integrations, no inbox access. The research-intro we generate is based on `name + public web search` only, which is shallow.

We want the first-chat experience to feel like the agent already knows the user. To do that, we need a short onboarding step *before* the chat opens:

1. User opens Hermes in Sokosumi.
2. Sokosumi shows a "Preparing your agent" screen with **integration connect buttons** (Gmail, Calendar, Slack, GitHub, etc.) plus an optional name/email form.
3. User connects 0+ integrations and clicks **"Let's go"**.
4. Sokosumi shows a **progressive loader** ("Reading your inbox… ✓ / Checking your LinkedIn… / Drafting your intro…") for 30–90 seconds while Hermes does context-aware research.
5. Chat unlocks with a tailored opening message from Hermes as the first visible turn.

On return visits (session 2+), the integration screen is skipped and we go straight to chat.

---

## 2. Lifecycle states (what `GET /v1/instances/:userId` returns)

```
provisioning ─→ infrastructure_ready ─→ onboarding ─→ ready
                                                       ↑
                                          (chat is now safe to open)
```

| Status | Meaning | What Sokosumi UI should show |
|---|---|---|
| `provisioning` | Fly machine being created | "Spinning up your private agent…" spinner |
| `infrastructure_ready` | Machine up, Hermes API responsive, **no chat history yet** | **Onboarding screen** (integration buttons + optional name/email form + "Let's go" button) |
| `onboarding` | User clicked "Let's go", we're running boot + research | **Progressive loader** (poll `GET /v1/instances/:userId/onboarding` for step-by-step progress) |
| `ready` | Research-intro is in the outbox, chat can open | **Open the chat.** First message is the research-intro pulled via `GET /v1/llm/:instanceId/inbox` |
| `error` | Provision or onboarding failed | Show retry CTA + `errorMessage` field |

**For returning users** (`onboardedAt != null` on the instance row): we skip `infrastructure_ready` and `onboarding` — status jumps `provisioning → ready` directly. Sokosumi can detect this and not show the onboarding screen.

---

## 3. API contract

### 3.1 `POST /v1/instances` (changed)

Provisions the Fly machine. Same shape as today, with one behavior change: we no longer auto-fire the welcome + research-intro. Those are deferred until `POST .../onboard` (see 3.4).

**Request:**
```json
{
  "userId": "tlWZpOti3028HUbtsY49CkuaSbadJwGm",
  "name": "Patrick Tobler",         // optional
  "email": "patrick@example.com",   // optional
  "region": "fra"                   // optional, defaults to FRA
}
```

**Response (200):**
```json
{
  "instanceId": "bed9f24b-3c64-44bb-9110-fa24508944a2",
  "userId": "tlWZpOti3028HUbtsY49CkuaSbadJwGm",
  "status": "provisioning",
  "endpointUrl": null,
  "lastActivityAt": "2026-05-19T17:23:38.880Z",
  "onboardedAt": null   // NEW: null = first session, set = returning user
}
```

**Idempotency:** Calling `POST /v1/instances` with a `userId` that already has an instance returns the existing instance (no new machine). Use this on every session-open — it's safe.

### 3.2 `GET /v1/instances/:userId` (changed)

Now returns the richer status:
```json
{
  "instanceId": "...",
  "userId": "...",
  "status": "ready",
  "endpointUrl": "https://hermes-....fly.dev",
  "lastActivityAt": "...",
  "onboardedAt": "2026-05-20T08:42:11.000Z",
  "welcomeMessage": "Hey Patrick,\n\nI saw on your inbox you're working on…",
  "welcomeKind": "research_intro",
  "integrations": [
    { "provider": "gmail", "status": "connected", "connectedAt": "..." }
  ]
}
```

Poll this every 2s while `status ∈ {provisioning, onboarding}`. Stop polling once `status ∈ {infrastructure_ready, ready, error}`.

**`welcomeMessage` is the one-shot intro the user sees when the chat opens.** It's populated atomically before status flips to `ready` — no separate poll needed, no race with the inbox. Render it as Hermes' first turn directly. `welcomeKind` is one of `research_intro` (full Gmail-aware intro), `welcome` (generic fallback when research failed), or `returning` (short welcome-back on session 2+). Use it to pick a render style if you like. The field is cleared on each fresh provision and re-populated by onboarding/returning-user-boot.

The async `GET /v1/instances/:userId/inbox` endpoint is for **post-ready pushes only** — scheduled task results, daily suggestions, cron output. The welcome no longer lands there.

### 3.3 `POST /v1/instances/:userId/integrations` (NEW)

Called by Sokosumi when the user finishes an OAuth flow for a provider.

**Request:**
```json
{
  "provider": "gmail",
  "mcpUrl": "https://backend.composio.dev/v3/mcp/<server-uuid>?user_id=<sokosumi-user-id>"
}
```

Valid `provider` values: `gmail`, `google_calendar`, `outlook`, `outlook_calendar`.

**Auth:** for Composio integrations you do **not** send a token. The orchestrator holds `COMPOSIO_API_KEY` server-side and injects it as the `x-api-key` header on every MCP request the Hermes agent makes to `*.composio.dev` URLs. Outlook & Outlook Calendar share one Composio toolkit — POST twice (`outlook` then `outlook_calendar`) with the same `mcpUrl` and we'll track them as two providers.

`mcpToken` is still accepted in the body but ignored for Composio URLs (kept for future non-Composio brokers).

**What we do:**
- Encrypt + persist `(userId, provider, mcpUrl, mcpToken)` in Postgres.
- Patch the Fly machine env vars (`MCP_SERVERS_JSON` gets the new entry merged in).
- Restart the Fly machine (~5s downtime — Hermes reloads MCPs at boot).
- Mark integration as `connected` once Hermes confirms the MCP tools are discoverable.

**Response (202 Accepted):**
```json
{
  "provider": "gmail",
  "status": "pending",
  "connectedAt": null,
  "lastError": null
}
```

Status values: `pending` (queued — instance has no Fly machine yet, will be applied at next provision/boot) · `connecting` (live patch in progress) · `connected` · `error` (`lastError` populated) · `disconnected`.

**Two regimes:**

- **Pre-provision / mid-provision / re-provision** — the Hermes machine isn't running yet (no `spriteId`, or instance still `provisioning`, or just been destroyed by Sokosumi). The integration is persisted as `pending`. No Fly traffic, no restart. The next provision pipeline bakes it into `MCP_SERVERS_JSON` and flips it to `connected` once the machine reaches `started`. **This is the path Sokosumi's UI uses by default.**
- **Live machine** — patch the Fly machine env in place + restart (`connecting` → `connected`). Typical time: 8–15 seconds.

### 3.4 `POST /v1/instances/:userId/onboard` (NEW)

Called when the user clicks **"Let's go"** on the onboarding screen.

**Request:**
```json
{
  "name": "Patrick Tobler",
  "email": "patrick@example.com",
  "researchDepth": "deep"   // optional: "light" | "deep" (default), affects Gmail scope
}
```

**What we do:**
- Set `status = "onboarding"`.
- Fire Hermes boot prompt (memory write + daily-suggestions cron registration).
- Fire research prompt — now context-aware: uses connected MCPs (Gmail inbox, Calendar, etc.) plus public web search. Takes 30–90s.
- Push the research result to outbox as `kind: "research_intro"`.
- Set `status = "ready"` and `onboardedAt = now()`.

**Response (202 Accepted):**
```json
{ "status": "onboarding" }
```

### 3.5 `GET /v1/instances/:userId/onboarding` (NEW)

Returns step-by-step progress for the loader UI.

**Response:**
```json
{
  "status": "onboarding",
  "steps": [
    { "id": "memory",        "label": "Saving your details",        "status": "done"  },
    { "id": "inbox_scan",    "label": "Reading your inbox",         "status": "done"  },
    { "id": "web_research",  "label": "Checking your public profile", "status": "running" },
    { "id": "intro_draft",   "label": "Drafting your intro",        "status": "pending" }
  ],
  "etaSeconds": 22
}
```

Poll every 1s. The `steps` array is opinionated by the orchestrator — Sokosumi just renders whatever we return, so we can add/remove steps without a Sokosumi deploy.

### 3.6 `DELETE /v1/instances/:userId/integrations/:provider` (NEW)

User disconnects an integration. We remove it from the env, restart the machine, mark disconnected.

### 3.7 `GET /v1/llm/:instanceId/inbox` (existing, unchanged)

After `status = "ready"`, Sokosumi calls this to fetch the research-intro message and render it as Hermes' first chat turn. Same endpoint Sokosumi already uses for async messages.

---

## 4. Sokosumi UI states

```
┌─────────────────────────────────────────────────────────────────┐
│ State A: status === "provisioning"                              │
│ ─────────────────────────────────                               │
│ [Big spinner]  "Spinning up your private agent…"                │
│ (poll every 2s)                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ State B: status === "infrastructure_ready" && !onboardedAt      │
│ ─────────────────────────────────────────────                   │
│  Welcome to Hermes                                              │
│  Connect a few tools so I can be useful from minute one.        │
│                                                                 │
│  Name:  [Patrick Tobler              ]                          │
│  Email: [patrick@example.com         ]                          │
│                                                                 │
│  [ Connect Gmail     ]    ✓ Connected                           │
│  [ Connect Calendar  ]                                          │
│  [ Connect Slack     ]                                          │
│  [ Connect GitHub    ]                                          │
│  [ Skip for now      ]                                          │
│                                                                 │
│                                            [  Let's go  →  ]    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ State C: status === "onboarding"                                │
│ ───────────────────────────────                                 │
│  Hermes is getting ready for you…                               │
│                                                                 │
│  ✓ Saving your details                                          │
│  ✓ Reading your inbox                                           │
│  ⟳ Checking your public profile                                 │
│  ◌ Drafting your intro                                          │
│                                                                 │
│  About 20 seconds remaining                                     │
│ (poll /onboarding every 1s)                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ State D: status === "ready"                                     │
│ ──────────────────────────                                      │
│  → Open the chat. Fetch /inbox once. The first message there    │
│    (kind="research_intro") is Hermes' opening turn.             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ State E: status === "ready" && onboardedAt (returning user)     │
│ ────────────────────────────────────────────                    │
│  → Open the chat directly. No onboarding screen.                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. OAuth (the Connect buttons)

**You own this part.** We deliberately don't run OAuth in the orchestrator — managing 10+ OAuth apps + verification + token refresh is a multi-quarter project.

**Recommendation: use Composio.** Workflow:

1. User clicks "Connect Gmail" in your UI → opens a Composio-hosted OAuth popup.
2. Composio runs the Google OAuth, stores the token in their DB, returns a per-user connection scoped by `user_id`.
3. You build the MCP URL: `https://backend.composio.dev/v3/mcp/<server-uuid>?user_id=<sokosumi-user-id>` and `POST` it to us at `/v1/instances/:userId/integrations` (no token in the body — see §3.3).
4. We inject + restart Hermes. The orchestrator attaches `x-api-key: <COMPOSIO_API_KEY>` to every outbound MCP call on Hermes' behalf, so the API key never leaves the orchestrator-controlled environment.
5. Done.

Outlook & Outlook Calendar share one Composio toolkit but we still track them as two providers — POST twice with the same `mcpUrl`.

---

## 6. Error handling

| Failure | Status | UI behavior |
|---|---|---|
| Fly provision fails | `error` (errorMessage set) | "Something went wrong. Retry?" button → re-POST `/v1/instances` |
| Integration MCP fails to load | integration stays `connecting` for >30s | Show "Connection failed. Try again." next to that button. Other integrations + flow continue. |
| Onboarding research times out (>3min) | `ready` (we degrade gracefully — research-intro just won't include inbox context) | Open chat normally. User won't know research was partial. |
| Hermes API unreachable after `ready` | `ready` (status unchanged) | Standard chat error handling — retry the message |

---

## 7. Returning users (session 2+)

This is the part the current Sokosumi behavior makes important: you destroy instances on session-end, so every session is technically a "new" instance from Fly's perspective. We mitigate this by persisting onboarding state on our side, keyed by `userId`.

On `POST /v1/instances` for a user where `onboardedAt != null`:
- We re-create the Fly machine.
- We re-inject the stored integration MCPs into the new machine's env.
- We re-inject the stored name/email + a "this is a returning user, session resuming" boot prompt.
- We push a short welcome-back message to the outbox (not a fresh research-intro — too costly).
- Status goes `provisioning → ready` directly. **No `infrastructure_ready` or `onboarding` states emitted.**

UI rule: `if (onboardedAt) → skip onboarding screen, go straight to chat once ready`.

Note: user memory inside Hermes itself is gone on each destroy (Fly volume goes with the app). The integration MCPs + name/email survive. We could fix the memory side too but that's out of scope for this brief.

---

## 8. Timeline + open questions for you

**Open for you to decide:**
1. **Which OAuth broker?** Composio is our recommendation; happy to use whichever you pick. Just need to know the MCP URL format.
2. **Which integrations for v1?** We suggest Gmail + Calendar to start (highest value). Slack, GitHub, Linear, Notion are cheap follow-ups once the pattern works.
3. **Returning-user welcome** — do you want a fresh research-intro on session 2 (costly, ~$0.05 each, but the user gets "here's what's new since we last spoke") or just a short "welcome back, what's up?" (cheap)? Default we'll ship: cheap.
4. **Skip button** — if user clicks "Skip for now" without connecting anything, do we still run research (web-only) or skip straight to a basic chat? Default we'll ship: run research, web-only.

**Our side of the work** (assuming you sign off on this brief):
- DB schema additions (`integrations` table, `onboardedAt` column): ~half day
- New endpoints (3.3–3.6): ~1 day
- Lifecycle state machine refactor: ~half day
- Hermes config hot-reload (MCP env patch + machine restart): ~1 day
- Progressive onboarding step instrumentation: ~half day
- **Total: ~3–4 working days** once we agree.

**Your side** (rough estimate from outside):
- Onboarding screen UI: ~1 day
- Composio integration + OAuth callback handling: ~1–2 days
- Progressive loader UI: ~half day
- Returning-user branching: ~half day
- **Total: ~3–4 working days.**

---

## 9. What we need from you to move forward

1. Sign-off (or pushback) on the lifecycle states in §2.
2. Decision on the OAuth broker (§5).
3. List of integrations you want for v1.
4. A test user ID we can use to dogfood the flow end-to-end before you ship the UI.

Reply on this doc or ping Patrick directly.
