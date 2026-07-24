# Harness Improvement Plan

Working plan derived from the 2026-07-24 agent-log analysis + architecture audit.
Rule: every item gets implemented, typechecked (`npx tsc --noEmit`), tested
(`npx vitest run`, baseline 327 pass / 1 skip), and committed before moving on.
Check a box ONLY after the item is verified. Items needing a deploy or image
build are flagged — deploys are MANUAL (`railway up`), image builds run on
Patrick's machine.

## Tier 0 — model

- [x] **0.1 Switch to MiMo-V2.5-Pro (we are on normal V2.5).**
      Verified 2026-07-25: `TEXT_MODEL_OVERRIDE=xiaomi/mimo-v2.5` AND v23
      config.yaml `default: xiaomi/mimo-v2.5` — both non-Pro. Fix:
      set `TEXT_MODEL_OVERRIDE=xiaomi/mimo-v2.5-pro`, re-pick providers
      (parasail does NOT host Pro; GMICloud hosts it WITHOUT tool support —
      rely on OpenRouter's tools-aware routing + pin tool-capable providers),
      update `docker/hermes-user/config.yaml` default for the v24 build.
      DONE 2026-07-24: env flipped (order=digitalocean,xiaomi — DO streams
      ~5 chars/frame; GMICloud excluded by tools-aware routing), config.yaml →
      pro for v24. Live-verified: agent tool-called get_credits on Pro; usage
      ledger shows xiaomi/mimo-v2.5-pro.
- [ ] **0.2 (user-driven, optional) Frontier A/B**: one day on
      `anthropic/claude-haiku-4-5` or `anthropic/claude-sonnet-5` via
      TEXT_MODEL_OVERRIDE; compare capitulation / invented-failure-causes /
      first-pass depth against Pro. Decision item for Patrick, not code.

## Tier 1 — directly reduces agent failures

- [x] **1.1 v24 SOUL failure-honesty rules** (`docker/hermes-user/SOUL.md`,
      "Ground truth" section, keep it tight):
      report observed errors verbatim / never invent a cause; re-check evidence
      when challenged (never confess to errors not made); read a deliverable
      fully before summarizing it. Needs v24 image build+roll (bundle with 0.1
      config change).
- [x] **1.2 `sokosumi_set_task_status`: from-state constraints + fail fast**
      (`src/routes/sokosumi-mcp.ts`): description documents that
      INPUT_REQUIRED/RUNNING tasks cannot be transitioned by the assistant
      (only the assigned coworker resumes them — comment instead); on a 4xx
      from Sokosumi return that guidance in the error text so the agent
      doesn't retry into a rate limit.
- [x] **1.3 Task-attachment tool** (`sokosumi_get_task_attachments`):
      scans a task's events for markdown/file links, validates each with a
      bounded HEAD/GET (status + size + content-type), returns verified URLs
      (and inline content for small text files). Stops the agent improvising
      with shell curl and mislabeling transient failures ("link expired").

## Tier 2 — turn economics + trust plumbing

- [x] **2.1 Clamp oversized replay messages in the chat proxy**
      (`src/routes/proxy.ts`): Sokosumi replays last 100 messages with no
      token cap; trim any NON-FINAL message to ~8k chars (marker appended).
      Final user message never trimmed. Cuts 300–600k-token turns.
- [x] **2.2 Cron results API for Sokosumi sidepanel**
      (`src/routes/schedules.ts` + schema): add `source` column to
      OutboxMessage (db push, additive); enqueue stamps it; GET
      `/v1/instances/:userId/schedules` returns per-item `lastResultSnippet`
      (orch tasks: latest ChatMessage by scheduledTaskId; native mirrors:
      latest OutboxMessage by source) alongside existing lastRunAt/lastError.
- [x] **2.3 Native-cron disable propagation for `system_prompt` kind**
      (`src/routes/schedules.ts`): PATCH toggle currently propagates to the
      machine only for kind='user'; extend to system_prompt mirrors so
      disabling in Sokosumi disables the native cron immediately (reconciler
      remains the eventual-consistency backstop; verify it skips disabled
      rows). VERIFIED live: native mirrors are actually kind='user' (toggle
      propagation already worked); the REAL bug was outbox.ts stamping
      lastRunAt on kind='system_prompt' — matched ZERO rows, "last ran"
      never stamped. Fixed to kind in [user, system_prompt].
- [x] **2.4 `rollExpiresAt` on GET /v1/instances/:userId**
      (`src/routes/instances.ts`): rollingAt + 4min window, null when not
      rolling — lets Sokosumi hard-clear the "applying your change" banner.

## Tier 3 — Sokosumi-side asks (deliverable: prompts Patrick can send)

- [ ] **3.1 Dev prompt: legal INPUT_REQUIRED→READY transition** (or a
      "resume" event) once input is provided — root cause of the jammed board.
- [ ] **3.2 Dev prompt: token-cap replay context** on Sokosumi's side
      (complements 2.1). Both prompts → `docs/sokosumi-dev-prompts.md`.

## Tier 4 — code health (audit's deferred items)

- [ ] **4.1 Instance bearer-auth unification** (`src/routes/instance-auth.ts`;
      outbox, schedules, llm-proxy, mcp-proxy, sokosumi-mcp) — preserve exact
      per-variant response messages + log tags.
- [ ] **4.2 Split `admin/routes.ts`** (~2,700 lines): extract trailing helpers
      → `src/admin/helpers.ts`; images section → `src/admin/images-routes.ts`;
      tests section → `src/admin/tests-routes.ts`. Pure moves; registration
      order preserved (images/compare before images/:tag).
- [ ] **4.3 Hoist the proven-acyclic dynamic imports** to top-level.
      NEVER hoist `confirmations/store ↔ routes/sokosumi-mcp` (real cycle).
      Post-listen recovery blocks in index.ts keep their call sites; leave
      intentional lazy-loads the audit documented.
- [ ] **4.4 Input-responder prefetch dedup** — share the per-instance
      row/toggle/job-listing between the input pass and followup pass;
      watermark writes clamped to the snapshot capture time (the subtlety
      that deferred this).
- [ ] **4.5 Admin Group D pagination**: `/admin/events` (before-cursor),
      `/admin/images/:tag` (true count in header), `/admin/chats`
      (before-cursor link), confirmations "showing X of N", instance-detail
      outbox "latest 50 of N".

## Deploy checklist (when tiers land)

- [ ] `railway up` (Patrick) — Tier 1.2/1.3 + Tier 2 + Tier 4 code; the
      OutboxMessage.source schema col applies automatically via boot db push.
- [ ] v24 image build+push (Patrick) — SOUL 1.1 + config.yaml 0.1 baked.
- [ ] Bump FLY_MACHINE_IMAGE → v24, roll Patrick's instance, add manifest
      entry, verify self-reported model = mimo-v2.5-pro.
