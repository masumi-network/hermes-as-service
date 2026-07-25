# Hindsight Integration Plan

Give every Hermes instance long-term, retrievable memory (retain / recall /
reflect) via a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight)
service, injected through our existing per-instance MCP pattern.

Same discipline as PLAN.md: implement → `npx tsc --noEmit` → `npx vitest run`
→ commit per item; check a box ONLY after verification. Deploys are manual
(`railway up`); image builds run on Patrick's machine.

**Positioning:** Hermes' native MEMORY.md/USER.md stay (identity + standing
preferences, auto-injected each session). Hindsight adds the missing layer:
unbounded episodic/semantic memory with real retrieval — the gap left by the
unconfigured session_search.

**Architecture decision (locked):** self-hosted on Railway (data stays in our
infra), reached ONLY via Railway private networking; agents reach it ONLY
through an orchestrator proxy that enforces `bank_id = userId` server-side.
Machines never hold Hindsight credentials — same trust model as sokosumi-mcp
and the Composio proxy.

## Phase 1 — stand up the service (needs Railway dashboard: Patrick or pairing)

- [x] **1.1 Create Railway service `hindsight`** in the hermes-orchestrator
      project from image `ghcr.io/vectorize-io/hindsight:v0.8.5` (PINNED —
      pre-1.0 project, never `:latest`). Attach a volume mounted at
      `/home/hindsight/.pg0` (embedded Postgres; isolated from our main DB by
      design). No public domain — private networking only
      (`hindsight.railway.internal:8888`).
- [x] **1.2 Env for the service:**
      `HINDSIGHT_API_LLM_PROVIDER=openai`,
      `HINDSIGHT_API_LLM_BASE_URL=https://openrouter.ai/api/v1`,
      `HINDSIGHT_API_LLM_API_KEY=<OPENROUTER_API_KEY>`,
      `HINDSIGHT_API_LLM_MODEL=xiaomi/mimo-v2.5` (consolidation is
      extraction work — the cheap non-Pro tier is fine; revisit if fact
      quality disappoints),
      `HINDSIGHT_API_MCP_AUTH_TOKEN=<fresh 32-byte random>`,
      embeddings left at default (local BGE-small, no external calls).
- [ ] **1.3 Smoke test from the orchestrator side:** `railway run` curl to
      `http://hindsight.railway.internal:8888` — create a probe bank, retain
      one fact, recall it, delete the bank. Record the exact REST paths used
      (SDK docs → verify against the live server; the API is pre-1.0).

## Phase 2 — orchestrator proxy route

- [x] **2.1 Config** (`src/config.ts`): `HINDSIGHT_MCP_URL` (optional,
      default '') + `HINDSIGHT_MCP_TOKEN` (optional). Empty URL = feature
      fully off — deploying the code before Phase 1 is safe.
- [x] **2.2 Route `src/routes/hindsight-mcp.ts`** modeled on mcp-proxy:
      - `ALL /v1/hindsight/:instanceId/mcp` with `authenticateInstanceBearer`
        (the shared helper from PLAN 4.1).
      - Forward JSON-RPC to `HINDSIGHT_MCP_URL` with the auth token header;
        reuse mcp-proxy's GET/SSE keepalive handling if FastMCP's
        streamable_http GET behaves like Composio's (verify; may pass through
        cleanly).
      - **Tenant enforcement (the security core):** on `tools/call`, OVERWRITE
        `arguments.bank_id = userId` unconditionally — never trust the
        agent's value. On `tools/list`, filter to `retain`, `recall`,
        `reflect` only (no `create_bank`/`list_banks`/mental-model tools in
        v1). Banks are auto-created on first retain; if the live server 404s
        instead, create-on-first-use in the proxy.
      - Timeouts on every upstream fetch (20s) per the audit convention.
- [x] **2.3 Tests** (`tests/hindsight-mcp.test.ts`, fetch-mock style like
      mcp-org-scope.test.ts): bank_id overwrite proven (agent-supplied
      bank_id ignored), tools/list filtered, bearer auth rejects bad tokens,
      feature-off (empty URL) returns a clean "not configured" error.

## Phase 3 — deliver the tools to machines

- [x] **3.1 Injection** (`src/integrations/manager.ts`
      `buildMcpServersJsonForUser`): append a `hindsight` server entry →
      `${ORCHESTRATOR_PUBLIC_URL}/v1/hindsight/${instanceId}/mcp` with the
      per-instance bearer, ONLY when `HINDSIGHT_MCP_URL` is configured.
      New provisions get it automatically.
- [x] **3.2 Existing machines:** a new SERVER in `MCP_SERVERS_JSON` is
      machine ENV — the capability roll's tool-hash does NOT cover it. Reuse
      the integration-connect path: patch env (`patchMachineEnv`) + restart,
      swept over idle instances (extend `mcp-tools-roll` staleness to include
      an `mcpServersVersion` alongside `MCP_TOOLS_VERSION`, or a one-off
      admin resync action). Requires `prisma db push` if a column is added —
      flag in deploy notes.
- [ ] **3.3 Lifecycle hook:** `destroyInstance` also deletes the user's
      Hindsight bank (REST DELETE, best-effort + logged) — destroying an
      assistant must destroy its memory. Mirror the existing purge semantics.

## Phase 4 — teach the agent (SOUL v25)

- [ ] **4.1 SOUL section (tight, ~15 lines):** what Hindsight is FOR
      (episodic archive) vs the `memory` tool (identity snapshot); retain
      durable facts/decisions/outcomes at the moment they happen (not
      transcripts, never credentials/secrets); recall BEFORE answering
      anything about past work, prior decisions, or "what did I tell you";
      reflect for judgment-shaped questions. One rule against retain-spam
      (retain conclusions, not chatter).
- [ ] **4.2 v25 image build+push (Patrick) + FLY_MACHINE_IMAGE bump + roll +
      manifest entry.** VERIFY the push landed (digest line) before bumping —
      lesson from v24.

## Phase 5 — verification + ops (definition of done)

- [ ] **5.1 Isolation proof:** two instances; A retains a marker fact; B's
      recall must NOT return it; A's must. (Automated probe via the proxy,
      like the pagination live-probes.)
- [ ] **5.2 End-to-end memory proof:** tell the agent a durable fact in chat
      → confirm a `retain` tool call fired (progress chips/admin) → new
      conversation (no replay overlap) → ask about the fact → correct answer
      sourced from `recall`.
- [ ] **5.3 Cost + latency check after 24h:** consolidation token spend on
      the OpenRouter key attributable to Hindsight's model; recall latency
      added to agent turns (budget: recall p50 < 1s).
- [ ] **5.4 Ops notes** in README + memory: image pinned at v0.8.5 (upgrade
      = deliberate bump), volume is the memory store (Railway volume
      snapshots = backup story), retention policy deferred until user count
      grows, admin UI (port 9999) is unexposed — reach it via
      `railway port-forward` when debugging.

## Risks (accepted going in)

- Pre-1.0 API drift → pinned image + smoke test on every bump.
- Python black-box service in the fleet → private-network only, orchestrator
  is the sole caller.
- Retain quality depends on the cheap consolidation model → 5.2/5.3 gate;
  flip `HINDSIGHT_API_LLM_MODEL` to Pro if extraction is weak (env-only).

## Effort

Phase 1: ~half day (dashboard + smoke). Phases 2–3: ~1.5 days (the pattern
exists twice in-repo). Phase 4: ~half day + image roll. Phase 5: ~half day.
**Total ≈ 3 focused days**, decoupled — each phase deployable alone, feature
dark until `HINDSIGHT_MCP_URL` is set.


---

## Execution log (2026-07-25)

**Deviations from the plan, and why — all verified against source/live infra:**

1. **Image tag is `0.8.5`, NOT `v0.8.5`** — ghcr 404s on the `v` prefix. First
   deploy failed on MANIFEST_UNKNOWN until corrected.
2. **Embedded Postgres does NOT work on Railway.** Railway bind-mounts volumes
   root-owned; Hindsight runs rootless (UID 1000) and refuses to init its
   embedded PG (their issue #1483). Switched to EXTERNAL Postgres via
   `HINDSIGHT_API_DATABASE_URL`. Hindsight's container now has NO volume (the
   local embedding model re-downloads on restart, ~30s boot cost — acceptable).
3. **Railway's own Postgres can't host it** — `postgres-ssl:16` has no `vector`
   extension (checked `pg_available_extensions`: only pg_trgm). Created a
   dedicated `hindsightdb` service from `pgvector/pgvector:pg18` with its own
   volume. This ALSO avoids a real hazard: the orchestrator boots with
   `prisma db push --accept-data-loss`, which must never point at a database
   holding Hindsight's tables.
   - Gotcha: PGDATA must be a SUBDIRECTORY of the mount
     (`/var/lib/postgresql/18/docker/pgdata`) or initdb aborts on `lost+found`.
4. **Tenancy is stronger than planned.** Hindsight supports SINGLE-BANK MODE:
   the bank is bound by URL path (`/mcp/{bank_id}/`), not a tool argument. The
   proxy builds that path from the AUTHENTICATED userId, so there is no
   `bank_id` argument to rewrite or tamper with — strictly safer than the
   planned argument-overwrite. Path traversal is covered by encodeURIComponent
   (unit-tested).
5. **Tool restriction is server-side**, not proxy-side: set
   `HINDSIGHT_API_MCP_ENABLED_TOOLS=retain,recall,reflect` on the Hindsight
   service. Bank-management tools are never registered at all.
6. **Smoke test deferred to the proxy path.** `railway ssh` needs an
   interactive re-login, and I would not expose Hindsight publicly just to
   curl it. Verification happens through the authenticated proxy after deploy
   (Phase 5.1/5.2) instead.
