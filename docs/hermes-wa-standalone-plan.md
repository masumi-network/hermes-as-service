# `hermes-wa` — Standalone Hermes orchestrator with WhatsApp + Web channels

**Status:** Plan only. v4 (2026-06-01).
**Independent product**, no shared code or data with any other Hermes-based product. Treats web and WhatsApp as **peer chat channels** that converge on a workspace's single agent.

---

## 1. Scope

`hermes-wa` is a **complete standalone product**. Everything below is **in scope for v1**:

- A **new orchestrator service** that owns the full per-workspace lifecycle: provisioning Fly Machines, baking our Hermes user image, brokering MCP traffic to Composio, proxying LLM calls to OpenRouter, running scheduled tasks, persisting outbox, gating medium-autonomy actions.
- **Multi-user workspaces.** A workspace is a small business; it can have multiple members (owner + employees). They share one agent, share its memory, share its integrations. Each member has their own WhatsApp number and their own web login; permissions are per-member.
- **WhatsApp Cloud API** as a primary chat channel, with **inbound + outbound support for text, voice notes, images, video, documents**. Voice transcribed to text for the agent; images and documents fed to the agent's multimodal LLM. Outbound: text, images (charts the agent generates), and documents.
- **A web app** as a peer chat channel. Same conversation history as WhatsApp — members can switch between the two and pick up where the other left off. Real-time updates over SSE. Same auth model as the rest of the product.
- **Confirmations** rendered in whichever channel the user is currently in (WhatsApp interactive buttons, or web inline cards).
- **Billing via Stripe**, workspace-scoped, seat-aware monthly tiers.
- **Admin dashboard** for ops, with per-workspace drill-down.

Out of scope **only** for v1: voice replies *from* the agent (text-to-speech outbound) — added in v1.5 once voice usage justifies the cost. Inbound voice is fully supported.

---

## 2. Locked decisions

| | |
|---|---|
| Messaging provider | **WhatsApp Cloud API** (Meta direct) |
| WhatsApp Business phone | **Need to acquire** — Meta Business verification (start week 0) |
| Pricing model | **Monthly seat-based tiers**, conversation cap per workspace |
| Database | **Separate Postgres** |
| Setup channel | **Web (one page) + Stripe Checkout** for sign-up and billing; **WhatsApp + web** for ongoing use |
| Persona | **Small-business assistant** |
| Confirmations UX | **WhatsApp interactive buttons** (in WA) and **inline cards** (on web) |
| Orchestrator | **Standalone**, owns the full agent lifecycle |
| Hermes user image | **Separate baked image** (`hermes-wa-user-image`) |
| Workspace model | **First-class.** Single-user is just a 1-member workspace. |
| Web chat channel | **First-class.** Real-time SSE updates, same agent memory as WhatsApp. |
| Media support | **In: text, voice, image, document, video.** Out (v1): text, image, document. |
| Domain | TBD — see §22 |
| Brand | **Independent product** |
| Fly / OpenRouter / Composio / Resend / Stripe / Cloudflare R2 keys | Fresh, dedicated to this product |

---

## 3. Codebase strategy

The team has prior orchestrator code that solves general per-user-VM problems (provisioning, Fly client, MCP proxy, chat proxy, persona injection, crypto, admin dashboard). We **copy the patterns**, file by file, and rewrite the parts that don't apply to this product. We do not depend on that prior code at runtime — `hermes-wa` is a fresh repo with fresh secrets, fresh DB, fresh deploys.

Concretely, three buckets:

**Copy verbatim (pure plumbing):**
`db.ts`, `crypto.ts`, `audit.ts`, `logger.ts`, `errors.ts`. The Fly client. The undici-dispatcher pattern for proxies. The encrypted-secrets pattern. The admin basic-auth pattern. The MCP proxy's 200-SSE GET keepalive. The chat proxy's headers-timeout + SSE keepalive. The `notifyIntegrationConnected` pattern.

**Copy structure, rewrite content:**
The provisioning pipeline. The boot prompt. The schedules registry. The system-prompt set. The SOUL.md. The Composio integration manager (same FSM shape, different supported-provider list).

**Build new:**
Workspace + Member + Membership models. Web chat UI. SSE channel for web. WhatsApp Cloud API webhook + sender. Inbound media handling (voice transcription, image relay, document text extraction). Stripe webhook + tier enforcement. Seat-based billing math. Auth — magic-link email for web, WhatsApp signature for webhook, Stripe signature for webhook. The "channel router" that hands the right chat history to the agent regardless of where the message came in.

---

## 4. Architecture

```
                                                       ┌──────────────────┐
                                                       │ Member's phone   │
                                                       │  (WhatsApp)      │
                                                       └────────┬─────────┘
                                                                │
                                                                ▼
                                                       ┌────────────────────┐
                                                       │ WhatsApp Cloud API │
                                                       │      (Meta)        │
                                                       └────────┬───────────┘
                                                                │ webhook
                                                                ▼
   ┌──────────────────┐                ┌──────────────────────────────────────────────────────┐
   │ Member's browser │                │ hermes-wa  (Hono service on Railway)                 │
   │  (web chat app)  │ ◄────────────► │                                                      │
   └──────────────────┘   SSE + REST   │  Routes                                              │
                                       │   public:                                            │
                                       │     /                              landing           │
                                       │     /signup, /login, /workspace/*  Next.js app       │
                                       │     /chat                          web chat UI        │
                                       │     POST /api/checkout                                 │
                                       │     POST /webhooks/stripe                              │
                                       │     POST /webhooks/whatsapp                            │
                                       │     GET  /webhooks/whatsapp        Meta handshake     │
                                       │   bearer-authed /v1/*:                                  │
                                       │     POST /v1/workspaces                                │
                                       │     PATCH /v1/workspaces/:id                           │
                                       │     POST /v1/workspaces/:id/members  (invite)         │
                                       │     POST /v1/workspaces/:id/onboard                    │
                                       │     POST /v1/workspaces/:id/integrations               │
                                       │     POST /v1/workspaces/:id/confirmations/:cid/approve│
                                       │     GET  /v1/workspaces/:id                            │
                                       │   per-instance bearer:                                  │
                                       │     POST /v1/llm/:instanceId/v1/chat/completions       │
                                       │     POST /v1/llm/:instanceId/outbox                     │
                                       │     /v1/mcp/:instanceId/:provider                       │
                                       │   web-session-authed:                                   │
                                       │     POST /chat/:workspaceId/send                        │
                                       │     GET  /chat/:workspaceId/stream  SSE                │
                                       │   admin (basic auth):                                   │
                                       │     /admin/*                                            │
                                       │                                                      │
                                       │  Subsystems                                          │
                                       │    Fly client / Composio MCP manager / OpenRouter    │
                                       │      proxy / WhatsApp Cloud API client / Stripe      │
                                       │      manager / Postgres via Prisma / R2 storage for  │
                                       │      media / OpenAI Whisper for voice transcription  │
                                       │    Channel router (web ↔ wa ↔ agent unified history) │
                                       │    Cron: outbox poller, idle-suspend, period reset,  │
                                       │      stripe reconciliation, scheduled briefs         │
                                       └────┬────────────────────────────┬───────────────────┘
                                            │                            │
                                            ▼                            ▼
                              ┌──────────────────────┐    ┌─────────────────────────────────┐
                              │ Fly Machines         │    │ Composio MCPs / OpenRouter /    │
                              │  one per WORKSPACE   │    │ Cloudflare R2 / OpenAI Whisper /│
                              │  hermes-wa-user-image│    │ Stripe / Resend                 │
                              └──────────────────────┘    └─────────────────────────────────┘
```

Two new architectural points worth calling out:

1. **One Fly machine per workspace, not per user.** Members share the agent, its memory, its integrations.
2. **The channel router** is the central piece of new code. Every inbound message (web or WA) is normalised, threaded into the workspace's unified chat history, and dispatched to the agent. The agent's response is delivered back on whichever channel the user is active on, and broadcast over SSE to any open web sessions for the workspace.

---

## 5. Tech stack

- **TypeScript / Node 20**
- **Hono** on `@hono/node-server` for the API + webhooks
- **Next.js 14 App Router** for the landing, signup, workspace admin pages, and the web chat UI
- **Prisma + PostgreSQL** — separate Railway Postgres
- **Vitest** + **Playwright** for E2E
- **Zod** for request validation
- **pino** for logging
- **Stripe SDK**, **WhatsApp Graph API client** (no SDK; raw fetch is fine), **OpenAI SDK** (for Whisper transcription only — LLM goes through OpenRouter)
- **undici@^7** with custom dispatcher (Node 20 compatible)
- **Cloudflare R2** for media storage (cheap S3-compatible)
- **Railway** for deploy

Env vars (all fresh, all dedicated):

```
DATABASE_URL=
MASTER_ENCRYPTION_KEY=
ORCHESTRATOR_API_TOKEN=
ADMIN_PASSWORD=

# Web session signing
SESSION_SECRET=

# Fly
FLY_API_TOKEN=
FLY_ORG_SLUG=
FLY_REGION=
FLY_CPUS=
FLY_CPU_KIND=
FLY_MEMORY_MB=
FLY_VOLUME_GB=
FLY_MACHINE_IMAGE=

# LLM
OPENROUTER_API_KEY=
LLM_RATE_LIMIT_RPM=

# Composio
COMPOSIO_API_KEY=

# WhatsApp Cloud API
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_BUSINESS_ACCOUNT_ID=

# Media
OPENAI_API_KEY=                  # Whisper transcription only
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_BUSINESS=
STRIPE_PRICE_PRO=

# Email
RESEND_API_KEY=
EMAIL_FROM=

# Misc
SENTRY_DSN=
PORT=8080
NODE_ENV=production
ORCHESTRATOR_PUBLIC_URL=
PUBLIC_WEB_URL=
```

---

## 6. Data model

```prisma
model Workspace {
  id                      String    @id @default(uuid())
  name                    String
  businessDescription     String?
  timezone                String?
  // Persona settings injected into the agent's memory.
  personaName             String?
  verbosity               String?   // "brief" | "balanced" | "detailed"
  tone                    String?   // "professional" | "friendly" | "playful"
  // Stripe
  stripeCustomerId        String?   @unique
  stripeSubscriptionId    String?   @unique
  tier                    String    @default("starter")   // starter | business | pro
  tierStatus              String    @default("incomplete")
  tierStartedAt           DateTime?
  seatsIncluded           Int       @default(1)
  seatsExtra              Int       @default(0)
  // Conversation budget (workspace-level, not per member)
  conversationsThisPeriod Int       @default(0)
  conversationsResetAt    DateTime?
  // Lifecycle
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @updatedAt
  members                 Membership[]
  hermesInstance          HermesInstance?
  inbound                 InboundMessage[]
  outbound                OutboundMessage[]
  webMessages             WebMessage[]
  pendingConfirmations    PendingConfirmation[]
}

model Member {
  id                  String    @id @default(uuid())
  email               String    @unique
  displayName         String?
  // WhatsApp identity per member (encrypted at rest)
  whatsappPhoneEnc    String?   @unique
  whatsappVerifiedAt  DateTime?
  optInAt             DateTime?
  optInIp             String?
  optOutAt            DateTime?
  lastWebSeenAt       DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  memberships         Membership[]
  webSessions         WebSession[]
}

model Membership {
  id          String    @id @default(uuid())
  workspaceId String
  memberId    String
  role        String    // "owner" | "admin" | "member"
  joinedAt    DateTime  @default(now())
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  member      Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  @@unique([workspaceId, memberId])
  @@index([workspaceId])
  @@index([memberId])
}

model WebSession {
  id          String    @id @default(uuid())
  memberId    String
  expiresAt   DateTime
  createdAt   DateTime  @default(now())
  lastSeenAt  DateTime  @default(now())
  member      Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  @@index([memberId])
}

model MagicLinkToken {
  id          String    @id @default(uuid())
  email       String
  token       String    @unique
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime  @default(now())
}

model HermesInstance {
  id              String    @id @default(uuid())
  workspaceId     String    @unique
  // Fly identity
  spriteName      String    @unique
  spriteId        String?
  region          String
  endpointUrl     String?
  apiServerKey    String
  llmProxyToken   String?
  openRouterKey   String
  flyVolumeId     String?
  // Lifecycle
  status              String
  onboardedAt         DateTime?
  onboardingSteps     Json?
  destroyedAt         DateTime?
  welcomeMessage      String?
  lastActivityAt      DateTime  @default(now())
  lastInboxRefreshAt  DateTime?
  errorMessage        String?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  workspace           Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  integrations        Integration[]
  schedules           ScheduledTask[]
  outbox              OutboxMessage[]
  llmUsage            LlmUsage[]
  provisionEvents     ProvisionEvent[]
}

model Integration { /* same pattern: workspaceId, provider, status, mcpUrl, mcpToken, mode */ }
model OutboxMessage { /* workspaceId, content, kind, createdAt */ }
model ScheduledTask { /* workspaceId, name, prompt, cronExpr, timezone, enabled */ }
model LlmUsage      { /* workspaceId, model, tokens, cost, createdAt */ }
model ProvisionEvent{ /* workspaceId, event, detail, createdAt */ }
model PendingConfirmation {
  id            String  @id @default(uuid())
  workspaceId   String
  // Who proposed it (a member, via their channel)
  memberId      String?
  channel       String  // "whatsapp" | "web"
  toolName      String
  toolArgs      Json
  summary       String
  status        String  @default("pending")
  resolvedBy    String?   // memberId
  resolvedFrom  String?   // "whatsapp" | "web"
  resultPayload Json?
  errorMessage  String?
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?
  workspace     Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}

// Channel-specific message tables

model InboundMessage {
  id                String    @id @default(uuid())
  workspaceId       String
  memberId          String
  whatsappMessageId String?   @unique
  channel           String    // "whatsapp" | "web"
  kind              String    // "text" | "voice" | "image" | "video" | "document" | "button"
  text              String?
  buttonId          String?
  mediaR2Key        String?   // pointer into R2
  mediaMime         String?
  mediaBytes        Int?
  transcript        String?   // for voice
  vision            Json?     // structured tags from vision pass on images, if any
  receivedAt        DateTime  @default(now())
  responseSentAt    DateTime?
  responseError     String?
  hermesLatencyMs   Int?
}

model OutboundMessage {
  id                String    @id @default(uuid())
  workspaceId       String
  memberId          String?   // null = broadcast to all members on web
  channel           String    // "whatsapp" | "web"
  kind              String    // "text" | "image" | "document" | "interactive_buttons"
  source            String    // "reply" | "outbox" | "system" | "verification" | "tier_nag" | "onboarding"
  outboxMessageId   String?
  text              String?
  mediaR2Key        String?
  templateName      String?
  whatsappMessageId String?
  sentAt            DateTime?
  failedAt          DateTime?
  errorMessage      String?
  createdAt         DateTime  @default(now())
}

model WebMessage {
  id            String    @id @default(uuid())
  workspaceId   String
  memberId      String?   // null = system / agent
  role          String    // "user" | "assistant" | "system"
  text          String
  createdAt     DateTime  @default(now())
  // Mirror into agent history; this table is the web UI's source of truth.
}

model PhoneVerification {
  id          String    @id @default(uuid())
  memberId    String
  code        String
  expiresAt   DateTime
  attempts    Int       @default(0)
  consumedAt  DateTime?
  createdAt   DateTime  @default(now())
}
```

Notes:

- **The workspace is the unit of agent ownership.** All members of a workspace share the same Hermes instance, memory, integrations, outbox.
- **Membership** is the join table with role (owner / admin / member). Used for auth + Stripe seat-counting.
- **Channel** is recorded on every inbound and outbound so we can answer "where was this said" in the admin UI and feed the right context to the agent.
- **Media** lives in R2; the DB holds only the key.

---

## 7. The Hermes user image (`hermes-wa-user-image`)

`FROM nousresearch/hermes-agent` + our launcher + our SOUL.md + a curated, lean skill pack (no marketing-skill overload). Same launcher → /opt/data sync pattern that worked well in the prior orchestrator. Image tagging convention `registry.fly.io/hermes-wa-user-image:vN`. `FLY_MACHINE_IMAGE` env names the active tag.

The launcher:

1. Composes `/opt/data/.env` from Fly env vars
2. Always-overwrites `/opt/data/SOUL.md` and `/opt/data/config.yaml` from `/opt/hermes-wa-config/`
3. Appends per-workspace `mcp_servers:` block to `config.yaml` from the `MCP_SERVERS_JSON` env var
4. Rsyncs curated skills to `/opt/data/skills/`
5. Execs the Hermes gateway

`config.yaml`:

```yaml
model:
  default: ${HERMES_WA_DEFAULT_MODEL}      # set per tier at provision time
terminal:
  backend: local
gateway:
  allow_all_users: true
tools:
  disabled:
    - cronjob   # we route schedules through our scheduler, not the built-in
hooks:
  post_llm_call:
    - command: /opt/hermes-hooks/cron-outbox-bridge.sh
      timeout: 30
hooks_auto_accept: true
```

---

## 8. Provisioning pipeline

End-to-end, from `Stripe checkout.session.completed` to "the workspace's agent is up":

1. Stripe webhook validated (`Stripe-Signature`)
2. Create `Workspace` + first `Member` + `Membership(role=owner)` (idempotent by `stripeCustomerId`)
3. `provisionWorkspace()` synchronous:
   1. Generate per-instance secrets (`apiServerKey`, `llmProxyToken`, encrypted OpenRouter key)
   2. Create Fly app (`hwa-<workspaceSlug>-<rand>`)
   3. Create Fly machine, image = `FLY_MACHINE_IMAGE`, env populated, `MCP_SERVERS_JSON='[]'`
   4. Mark `HermesInstance.status='provisioning'`
4. Background pipeline:
   1. Poll machine `state='started'`
   2. Poll `endpointUrl/health`
   3. `status='infrastructure_ready'`
5. Onboarding boot prompt — see §13. Asks the agent to save workspace identity to memory and prepare for a first conversation.
6. `syncSystemSchedules()` — see §12
7. `status='ready'`. Send WhatsApp template + send web magic-link via email.

Provisioning failures record a `ProvisionEvent`, set `errorMessage`, and surface in admin. Retry on transient errors; page on persistent.

---

## 9. MCP proxy + Composio integrations

Pattern from prior orchestrator work, with the 200-SSE GET handling + 60s upstream `AbortSignal.timeout` + `x-api-key` injection for Composio-hosted URLs + read-only mode that strips write tools from `tools/list`, all in from day 1.

Supported providers v1: `gmail`, `google_calendar`, `outlook`, `outlook_calendar`. v1.5 adds `notion` (top SMB request) and `quickbooks`/`xero` (if any user asks for bookkeeping help).

Integrations are **workspace-level**, not member-level. The owner connects Gmail once; the agent reads everyone's mail in that account.

---

## 10. Channels: WhatsApp + web

The novel piece. Both channels feed a single normalised inbound stream that the channel router dispatches to the agent.

### 10.1 WhatsApp inbound

`POST /webhooks/whatsapp`:

1. Verify `X-Hub-Signature-256`
2. For each message in `entry[*].changes[*].value.messages[*]`:
   1. Resolve `Member` by `whatsappPhoneEnc`, then their `Workspace` via active `Membership`. Unknown number → reply with signup template.
   2. Idempotency by `whatsappMessageId`.
   3. STOP/UNSUBSCRIBE → set `optOutAt`, send opt-out confirmation template.
   4. **Interactive button reply** matching an open `PendingConfirmation.id` → call approve/reject; deliver result.
   5. **Text** → enqueue normalised inbound.
   6. **Voice** → download via Graph media API → store in R2 → call Whisper for transcription → enqueue normalised inbound with `transcript` populated.
   7. **Image** → download → store in R2 → enqueue normalised inbound with `mediaR2Key` + `mediaMime`. The chat completion is built with multimodal content (`{type:'image_url', image_url: {url: r2SignedUrl}}`) so the agent sees the image.
   8. **Document** (PDF, .docx, .xlsx) → download → store in R2 → extract text (PDF.js / mammoth / xlsx) → enqueue with `text=extracted` and keep the original in R2 in case the agent needs to ask follow-ups.
   9. **Video** → store in R2, transcribe the audio track via Whisper, enqueue with `transcript`. Frame extraction is v1.5.

The normalised inbound row carries everything the channel router needs: workspace, member, channel, kind, text/transcript, optional media reference.

### 10.2 Web inbound

`POST /chat/:workspaceId/send` (web-session-authed):

1. Verify session cookie → load Member → check Membership in workspace
2. Persist `WebMessage(role=user)`
3. Tier cap check
4. Hand off to the channel router
5. The response is streamed back to **every** open SSE connection for the workspace (so multiple members watching see the answer)

### 10.3 The channel router

Sits between the inbound queue and the chat proxy. Responsibilities:

1. Build the **agent input** — a single message string that includes:
   - Who said it (member display name) and on which channel
   - The text (or transcript / extracted document text)
   - Multimodal content arrays for images / video
2. Call the chat proxy: `POST /v1/llm/:instanceId/v1/chat/completions` with the multi-turn history (loaded from `WebMessage` + recent `InboundMessage`)
3. Receive the response
4. Deliver back on the **member's most recently active channel** for that workspace
   - If the member was on WhatsApp in the last 5 min → reply on WhatsApp
   - Else if they have an open web SSE → reply on web
   - Else → push as a WhatsApp outbox message (templated if outside 24h)
5. Also broadcast via SSE to every open web session for the workspace

### 10.4 Long-turn UX

The chat-proxy fix that disables undici headers/body timeouts and injects SSE keepalives is baked in from day 1.

On the WhatsApp side: typing indicator after 5s, "Still on it…" message after 60s, "Taking longer than usual, I'll message you when ready" after 180s.

On the web side: real-time keepalive via SSE ping every 20s; the UI shows "Hermes is thinking…" with elapsed time.

### 10.5 Outbound media (v1)

- **Text** — both channels
- **Images** — agent can attach a chart/screenshot. R2 → signed URL → Meta Graph media upload → send. On web, image inline.
- **Documents** — agent can attach a PDF (e.g. an invoice draft). Same R2 → upload flow.
- **Voice replies** — **v1.5.** Requires TTS (OpenAI tts-1 or ElevenLabs); cost watching needed.

### 10.6 Outbound from outbox

Cron every 60s for each `Workspace`:

1. `GET /v1/llm/:instanceId/outbox`
2. For each new message: route to the right member (the workspace owner by default, or a recipient hinted in `outbox.detail.recipientMemberId`)
3. Deliver via the rules in §10.3.4
4. Ack on the agent side

---

## 11. Confirmations across channels

When the chat proxy returns `pending_confirmation`:

1. Persist a `PendingConfirmation` row, with `channel` = where the request came from
2. Build the confirmation card for that channel:
   - **WhatsApp** → interactive `button` message with `Approve` / `Reject` / `Ask more` buttons whose `id` encodes the confirmation id (`approve:<conf_id>`)
   - **Web** → an inline card component in the chat UI with the same three actions; clicking calls `/api/confirmations/:id/approve` (or reject)
3. Deliver on whichever channel the user was active on
4. **Inbound from EITHER channel resolves the confirmation.** A member proposing a task on web can approve via WhatsApp from their phone if they prefer. We record `resolvedFrom` for audit.

Meta button constraints carried over: ≤3 buttons, ≤20-char title, ≤1024-char body. The web card has no such limits.

---

## 12. Scheduled tasks

Workspace-level. `syncSystemSchedules(workspace)` registers an `enabled` set per tier:

| Slug | Kind | Default | Min tier |
|---|---|---|---|
| `inbox-refresh` | sweep | every 6h | Starter |
| `eod-report` | sweep | 22:00 local | Business |
| `morning-brief` | prompt | 08:00 Mon–Fri local | Business |
| `friday-wrap` | prompt | 16:00 Fri local | Business |
| `lunchtime-check` | prompt | 12:00 Mon–Fri local | Pro |
| `weekly-planning` | prompt | 09:00 Mon local | Pro |

The `morning-brief` prompt asks the agent to use connected MCPs (Gmail/Calendar) to produce a one-page summary. Output flows through the outbox bridge to whichever channel the workspace's owner is on.

The `cron-outbox-bridge.sh` filter that drops `[SILENT]` / `ok` / `done` sentinel responses carries over.

---

## 13. Persona + SOUL (small-business assistant)

### 13.1 New SOUL.md

```
# SOUL

You are <persona name or "Hermes"> — the workspace's small-business
assistant. The workspace is a single business; members are the
owner and possibly a few employees. They reach you via WhatsApp and
a web chat app. The conversation is unified across both channels.

You help them run the business — email triage and drafting,
scheduling, simple research, social posts, client communication,
quotes, invoice copy, customer follow-ups, expense and receipt
handling, light bookkeeping queries.

Members may send text, voice notes (already transcribed for you),
images (e.g. a receipt or a screenshot to read), and documents
(e.g. a PDF contract). Treat all of them as first-class input.

Members are on their phones much of the time. Their time is the
constraint. Lead with the answer. Scannable on a phone screen.
No preamble, no throat-clearing, no recapping their question.

## How you communicate

- Lead with the answer in one sentence.
- Plain language. No business jargon, no "leverage", no "synergies".
- When uncertain, say so plainly and propose the next move.
- Prefer doing over describing. If a connected tool can answer,
  call it instead of guessing.

## Multi-member conversation rules

- Address the person who sent the most recent message. Use their
  display name when known.
- Memory is shared across all members of the workspace. You know
  what the owner said two days ago and what an employee said this
  morning. Use the shared context — but don't reveal personal
  asides (e.g. salary, personal email content) to other members.
- When an action will affect another member (sending an email on
  their behalf, scheduling on their calendar), confirm with that
  member before doing it.

## Tools

- Gmail / Outlook (when connected) — read, summarize, draft, send
  (write requires approval at medium autonomy).
- Calendar — read availability, draft events.
- Notion (when connected) — read/search/write the workspace's pages.
- Web search and code execution in your sandbox.
- Memory across sessions, scoped to the workspace.
- The outbox — push proactive messages to whichever member you're
  surfacing the update to.

## What you don't do

- Don't refuse work because it's "complex"; break it down and start.
- Don't apologize for using tools or explain what you're about to
  do — just do it.
- Don't invent citations, URLs, or tool output. If a CLI fails,
  quote the error verbatim and ask the user how to proceed.
- Don't put marketing or playful framing into anything that leaves
  the workspace — drafted client emails, invoice copy, social
  posts. Those stay professional regardless of the workspace's
  tone setting.

## Persona settings

The workspace may have set persona overrides (name / verbosity /
tone). Apply them to your VOICE only. They never change your
accuracy, your lead-with-the-answer structure, or the correctness
of numbers and actions.
```

### 13.2 Boot prompt + persona injection

The `buildBootPrompt()` takes the workspace's `name`, `businessDescription`, `timezone`, `personaName`, `verbosity`, `tone`, plus an initial member list, and asks the agent to save them under memory keys (`workspace.*`, `persona.*`, `members[].*`). Same pattern as prior orchestrator work, expanded for multi-member.

### 13.3 Onboarding scripted turn

After provisioning, the welcome message tells the owner: *"Reply when you're ready and I'll ask a couple of quick questions to set you up."* The agent's first turn asks (conversationally) for business name, what they do, working hours, what they want help with first. After the answers, the agent calls `PATCH /v1/workspaces/:id` with the gathered fields and switches to normal operation.

---

## 14. Web chat UI

Routes (Next.js):

- `/signup` — email + tier select → Stripe Checkout
- `/login` — magic link via Resend
- `/onboarding` — confirm WhatsApp number (optional), invite teammates (optional)
- `/chat` — the chat surface
- `/workspace/settings` — persona, integrations, members
- `/workspace/billing` — Stripe portal redirect

The chat page:

- Loads recent history from `WebMessage` + `InboundMessage` + `OutboundMessage`, normalised on the server, paginated
- Opens an SSE connection at `/chat/:workspaceId/stream`
- Sends messages via `POST /chat/:workspaceId/send`
- Renders inline confirmation cards when the SSE stream emits a `pending_confirmation` event
- Renders images, voice notes (with play button), document attachments
- Mobile-first responsive layout

Auth = `WebSession` cookie set on magic-link consumption.

---

## 15. Billing + tier enforcement

### 15.1 Tiers

| Tier | Monthly | Includes | Per-workspace cost estimate |
|---|---|---|---|
| **Starter** | €29 | 1 seat, 200 conversations/mo, 1 integration, no scheduled briefs | LLM ~€10 + Fly ~€6 + WhatsApp ~€4 + R2/Whisper ~€2 = **~€22 → ~24% margin** |
| **Business** | €99 | 3 seats included (+€19/seat), 1,000 conversations/mo, all integrations, morning brief, friday wrap | LLM ~€40 + Fly ~€8 + WhatsApp ~€15 + R2/Whisper ~€5 = **~€68 → ~31% margin** |
| **Pro** | €249 | 10 seats included (+€15/seat), unlimited¹ conversations, all integrations, custom schedules, priority model | LLM ~€140 + Fly ~€10 + WhatsApp ~€40 + R2/Whisper ~€10 = **~€200 → ~20% margin** |

¹ Fair-use cap at 5,000 conversations/mo.

### 15.2 Stripe lifecycle handlers

| Event | Action |
|---|---|
| `checkout.session.completed` | Create Workspace + first Member + Membership, kick off provisioning |
| `customer.subscription.updated` | Re-mirror tier, recompute seat caps |
| `invoice.payment_failed` | Templated dunning message via WhatsApp + email; mark `tierStatus='past_due'` after grace |
| `customer.subscription.deleted` | Suspend Fly machine; mark `tierStatus='canceled'`; archive per retention policy |

### 15.3 Conversation accounting

Same definition as Meta's: a 24h interaction window with a single member. Incremented on conversation start, not per message. Counted at the **workspace** level. Reset monthly.

When over cap:

- Inbound on either channel → template/notification message: "Workspace has used X conversations this month. Reply UPGRADE or wait until <reset>."
- Outbound scheduled → suppressed.

### 15.4 Seat enforcement

Adding a member beyond `seatsIncluded + seatsExtra` requires a Stripe quantity update first.

---

## 16. Admin dashboard

Per-workspace drill-down: status, members + roles, integrations, schedules, recent inbound/outbound (both channels), outbox, recent provisioning events, current tier + usage, Stripe customer link.

Manual triggers: re-onboard, sync-config, re-sync schedules, restart Fly machine, notify-integration, manual approve/reject on stuck confirmations.

Smoke endpoints: integration tools/list, EOD report dry-run, send test WhatsApp template.

`/admin/version` returns git SHA + bootedAt for deploy verification.

---

## 17. Auth model

| Caller → Callee | Mechanism |
|---|---|
| Stripe → `hermes-wa` | `Stripe-Signature` |
| Meta WhatsApp → `hermes-wa` | `X-Hub-Signature-256` |
| Browser → `hermes-wa` web app | `WebSession` cookie (magic-link issued) |
| `hermes-wa` internal → `hermes-wa` `/v1/*` | `ORCHESTRATOR_API_TOKEN` bearer |
| `hermes-wa` → Hermes agent | Per-instance bearer (`llmProxyToken`, encrypted at rest) |
| Hermes agent → `hermes-wa` (LLM proxy / MCP proxy / outbox POST) | Per-instance bearer |
| Operator → `/admin/*` | Basic auth, `ADMIN_PASSWORD` |
| `hermes-wa` → Meta Graph | `WHATSAPP_ACCESS_TOKEN` |
| `hermes-wa` → OpenRouter | `OPENROUTER_API_KEY` |
| `hermes-wa` → Composio | `COMPOSIO_API_KEY` (`x-api-key`) |
| `hermes-wa` → Fly Machines API | `FLY_API_TOKEN` |
| `hermes-wa` → R2 | R2 keys |
| `hermes-wa` → OpenAI (Whisper) | `OPENAI_API_KEY` |

---

## 18. Test plan (TDD)

### Phase 0 — repo + CI green, scaffolding done

- Repo, Vitest + Playwright, Prisma migrated to test DB
- Lint / typecheck / format CI green on empty repo
- Meta WhatsApp dev account; Stripe test mode keys; Cloudflare R2 dev bucket

### Phase 1 — pure-logic unit tests (no I/O)

1. `phone.test.ts` — E.164 normalize/validate/format; reject local-only
2. `verifyCode.test.ts` — crypto-random 6-digit; expiry; attempt cap
3. `whatsappPayload.test.ts` — parse text, voice, image, video, document, button_reply, status callbacks; ignore unknown
4. `signature.test.ts` — `X-Hub-Signature-256` verify against Meta-doc fixture; constant-time compare
5. `templateGate.test.ts` — 24h window decision (free-form vs template)
6. `replyClassifier.test.ts` — STOP / UNSUBSCRIBE / button / free-form
7. `interactiveButtons.test.ts` — payload builder + Meta constraints
8. `conversationCounter.test.ts` — increment only on start; monthly reset; over-cap detection
9. `crypto.test.ts` — encrypt/decrypt round-trip
10. `messageSplitter.test.ts` — long reply → ≤4 messages by paragraph; spillover → document attachment
11. `tierFeatureGate.test.ts` — tier × feature matrix
12. `seatGate.test.ts` — adding members up to limit, blocked beyond, Stripe-quantity calc
13. `channelRouter.test.ts` — given a member's last activity, decide WhatsApp vs web vs outbox-pushed template
14. `multimodalContentBuilder.test.ts` — assembling `messages` array with text + image_url + document text
15. `magicLink.test.ts` — token generation, signing, expiry, single-use enforcement
16. `webSession.test.ts` — cookie shape, expiry, refresh-on-read
17. `r2Key.test.ts` — generate workspace-scoped paths; sanitization; signed URL TTL
18. `documentTextExtract.test.ts` — PDF / docx / xlsx → plain text; oversized files rejected
19. `personaPayload.test.ts` — gathered fields → `PATCH /v1/workspaces` body shape
20. `confirmationCardBuilder.test.ts` — WhatsApp button + web inline card payloads for the same `PendingConfirmation`

### Phase 2 — integration tests with mocked externals (msw + stubs)

21. `stripeCheckoutToReady.test.ts` — checkout.completed → Workspace + Member created → provisioning → onboarding → ready
22. `provisioningFailureRetry.test.ts` — Fly 5xx → ProvisionEvent recorded → retry → success
23. `whatsappTextInbound.test.ts` — webhook text → chat proxy → reply sent on WhatsApp + broadcast on SSE; idempotency
24. `whatsappVoiceInbound.test.ts` — webhook voice → media download → Whisper called → transcript → chat proxy → reply
25. `whatsappImageInbound.test.ts` — webhook image → media download → multimodal content built → chat proxy → reply
26. `whatsappDocumentInbound.test.ts` — webhook PDF → text extracted → content built → chat proxy → reply
27. `webChatInbound.test.ts` — POST /chat/:ws/send → channel router → chat proxy → SSE response on stream endpoint
28. `pendingConfirmationCrossChannel.test.ts` — created via web, approved via WhatsApp button; result delivered on both channels
29. `optOutFlow.test.ts` — STOP suppresses future delivery on that member only (not whole workspace)
30. `outboxPoller.test.ts` — agent outbox → routed to right channel; outside 24h → template
31. `tierLimit.test.ts` — over cap → upgrade nag template; chat proxy not called
32. `mcpProxyForward.test.ts` — POST to Composio → success; GET → 200 idle SSE; upstream 5xx → mapped error
33. `integrationConnect.test.ts` — POST /integrations → MCP_SERVERS_JSON patched → machine restarted → notify nudge fired
34. `personaPatchAndNotify.test.ts` — PATCH persona → notify-persona prompt fired
35. `longTurnUX.test.ts` — chat proxy slow → typing indicator on WA + thinking-indicator on web → eventual reply
36. `seatAddRemove.test.ts` — owner invites a member → seat consumed; member removed → seat released; over-quota blocked
37. `subscriptionCanceled.test.ts` — instance suspended; existing chats can read but not send

### Phase 3 — E2E (Playwright + Meta test number + Stripe test mode)

38. `signupToFirstReply.e2e.ts` — landing → checkout → welcome WA + email → owner replies on web AND WA → unified history visible on both
39. `inviteTeammate.e2e.ts` — owner invites → invitee receives magic link → joins workspace → can send/receive
40. `voiceNoteRoundTrip.e2e.ts` — voice in WA → transcript → agent answer back on WA
41. `imageReceiptRead.e2e.ts` — image of a receipt sent on WA → agent extracts vendor/amount and adds to memory
42. `connectGmailViaChat.e2e.ts` — "connect Gmail" → OAuth URL → callback → next inbound can read mail
43. `confirmationButtonWA.e2e.ts` — medium-autonomy draft → buttons → tap Approve on phone → email sent → confirmation arrives
44. `confirmationCardWeb.e2e.ts` — same draft proposed on web → inline card → click Approve → email sent
45. `scheduledBrief.e2e.ts` — 08:00 local → morning brief lands on whichever channel the owner was last on
46. `optOut.e2e.ts` — owner sends STOP on WA → scheduled briefs land on web instead
47. `tierLimit.e2e.ts` — exceed Starter cap (test override) → upgrade nag arrives
48. `paymentFailed.e2e.ts` — Stripe simulated card failure → dunning template + email
49. `subscriptionCanceled.e2e.ts` — cancel in Stripe → instance suspended; chat shows read-only state

### Phase 4 — production hardening

50. Load: 100 concurrent inbound webhooks + 100 concurrent web sends → no message loss, p95 reply latency < 60s
51. Chaos: Composio 502 for 30s → user sees "tools temporarily unavailable"; nothing dropped silently
52. Chaos: Fly `state='replacing'` mid-message → graceful "give me a moment" + replay
53. Cost dashboard real-time
54. Compliance: opt-in/out flow against Meta policy text; GDPR export + delete endpoints work
55. Security: pen-test on web auth (CSRF, session fixation, SSRF on the OAuth callback URL)

### Coverage gates

- Phase 1+2 ≥ **90%** on `src/lib/`
- Phase 2 ≥ **80%** on adapters
- E2E happy-path; at least one E2E per critical flow before each prod deploy

---

## 19. Milestones (16–20 weeks)

| Week | Deliverable | Pole-in-tent |
|---|---|---|
| 0 | Domain. Meta business verification + phone application. Fresh Fly/OpenRouter/Composio/Stripe/Resend/R2/Railway accounts. Repo scaffolded; CI green. Stripe test mode. | Meta verification |
| 1 | Landing + Stripe Checkout. Phase 0 + Phase 1 (1–8) green. | |
| 2 | Phase 1 (9–14) green. Fly client + provisioning skeleton. | |
| 3 | `hermes-wa-user-image` first build. Provisioning E2E. Phase 2 #21, #22. | First real Fly machine spawned |
| 4 | MCP proxy + chat proxy (with day-1 fixes baked in). Phase 2 #32. | |
| 5 | WhatsApp inbound + outbound (text only). Phase 2 #23, #30. | |
| 6 | Voice transcription path. Image path. Document extraction. Phase 2 #24–26. Phase 1 #17–19. | First multimodal-capable build |
| 7 | Web app (signup, login via magic link, web chat). Phase 1 #15–16. Phase 2 #27. | First real web chat |
| 8 | Channel router (the central new piece). Phase 1 #13. Phase 2 #29, #35. | |
| 9 | Confirmations across channels. Phase 1 #20. Phase 2 #28. | |
| 10 | Workspaces + multi-member: invite flow, seats, role checks. Phase 1 #12. Phase 2 #36. | |
| 11 | Persona patching + onboarding scripted turn. Phase 2 #33, #34. Stripe lifecycle (#37). | |
| 12 | Tier enforcement + conversation accounting. Phase 2 #31. Scheduled briefs (#33 setup). | |
| 13 | Phase 3 E2E suite green end-to-end on test number. | |
| 14 | Meta business verification should complete. Switch to prod Cloud API. | Hands-off |
| 15 | Phase 4 hardening. Admin dashboard. Cost dashboard. | |
| 16 | Closed beta (10–20 friendly workspaces). | |
| 17–20 | Public launch, observability, dunning automation, v1.5 prep (outbound voice via TTS, more integrations) | |

---

## 20. Risks

| Risk | Mitigation |
|---|---|
| Meta business verification stalls | Start week 0; file under best-papered entity available |
| 24h messaging window policy footgun | Phase 1 #5 and Phase 2 #30 non-negotiable; template management UI in admin |
| Multi-channel state divergence (member replied on web after WA; agent confused) | Unified history table; channel router writes both sides; tests #28, #38 |
| Voice transcription cost spikes | Cap voice note length at 60s before transcribing; tier-aware quota |
| Image moderation (someone sends NSFW) | Pre-filter with OpenAI moderation API before sending to LLM |
| Spam / abuse on inbound | Rate limit per phone (60/h) and per web session; strong opt-in audit |
| Phone portability | Re-verification flow; magic-link via email as fallback |
| Long agent turns trip proxy timeouts | undici dispatcher with disabled timeouts + SSE keepalive from day 1 |
| Fly cost explosion if a workspace runs hot | Idle-suspend; per-workspace cost dashboard; LLM rate limit env |
| Stripe webhook unreliability | Idempotent handlers; daily reconciliation cron |
| GDPR audit trail | Data export + delete endpoints from day 1; opt-in audit; data retention policy |

---

## 21. Operations

- **Deploy:** Railway, with a staging environment that points to Stripe test mode and Meta dev number
- **Observability:** Sentry; structured pino logs; cost + margin dashboard; status page (`status.<domain>`) hitting WhatsApp send, Fly API, Composio MCP, OpenRouter, R2
- **Backups:** Postgres daily snapshots, 30-day retention; R2 lifecycle (delete after 90 days unless flagged)
- **Compliance:** opt-in/out audit; GDPR export + delete; retention policy on InboundMessage / OutboundMessage / WebMessage (30 days default, 365 days on Pro tier)
- **On-call:** pager on `provision_failed` rate > 5%; Stripe webhook failures; WhatsApp send failure rate > 5%; Whisper rate-limit errors

---

## 22. Open questions (before scaffolding)

1. **Domain.** `hermes.business`, `hermes.work`, `withhermes.com`, `askhermes.io`, `dailyhermes.com`, or anything else. (Or "you pick; under €30/yr.")
2. **GitHub repo home** — new org? Existing org?
3. **Legal entity** for Meta business verification + Stripe Atlas + bank: utxo AG, Yellowhouse, or a new entity? Affects taxes + invoices.
4. **WhatsApp Business display name** — must clear Meta review; should match the legal entity or a registered DBA.
5. **Pricing.** €29 / €99 / €249 with seat add-ons is a first draft. Comfortable?
6. **Default LLM model per tier.** Sonnet 4.6 everywhere, or Haiku for Starter / Sonnet for Business / Opus for Pro? Big margin lever.
7. **Multi-language.** v1 English-only OK, German for DACH in v2? Affects template approvals.
8. **Default integration set.** Gmail + Calendar only at first, or also Outlook + Notion?
9. **Voice-reply (outbound TTS) timing.** v1 (week 12), v1.1 (post-launch), or v1.5 (~month 6)?
10. **Data residency.** Fly region default `fra` (EU) is right for EU users; for non-EU should we offer a choice during signup?
11. **Opt-in UX.** Checkbox on Stripe checkout only, or also a re-confirm prompt via WhatsApp on first inbound? Meta tends to prefer the latter.
12. **R2 vs S3.** R2 is cheaper and EU-native; S3 is more battle-tested. R2 unless you have a reason.

Once 1+2 are decided I can scaffold the repo and start Phase 0 / Phase 1 in parallel with Meta verification.
