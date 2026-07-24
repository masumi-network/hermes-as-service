# Hermes Orchestrator

A HTTP service that provisions and manages **per-user Hermes Agent**
instances. Each user gets one isolated [Hermes Agent](https://github.com/NousResearch/hermes-agent)
running on its own always-on [Fly Machine](https://fly.io/docs/machines/)
(Firecracker microVM, one Fly app per user). The orchestrator itself runs on
Railway.

**This is a backend service.** It has no end-user UI (there is an operator
dashboard under `/admin`, Basic Auth). The Sokosumi web app calls it over HTTP
to provision instances, then proxies user chat traffic through it to each
user's private Hermes endpoint.

## Architecture

```
   ┌──────────────────┐    HTTP/Bearer       ┌──────────────────────┐
   │     Sokosumi     │ ───────────────────▶ │  Hermes Orchestrator │
   │   (web app)      │                      │  (this service, on   │
   │                  │ ◀─── instance state  │   Railway)           │
   └──────────────────┘                      └─────────┬────────────┘
                                                       │  Machines API
                                                       ▼
                                       ┌───────────────────────────────┐
                                       │  Per-user Fly Machine         │
                                       │  (image: hermes-user-image)   │
                                       │  Hermes Agent on :8642        │
                                       │  /opt/data persistent volume  │
                                       └───────────────────────────────┘
```

Key flows:
- **Chat**: Sokosumi → `POST /v1/proxy/:userId/v1/chat/completions` → the
  user's machine. The proxy captures transcripts, streams progress, and runs
  post-turn guards.
- **LLM traffic**: each machine's `OPENROUTER_BASE_URL` points back at the
  orchestrator (`/v1/llm/:instanceId`), so all model traffic flows through the
  llm-proxy (model override, provider routing, usage metering, pricing).
- **MCP tools**: each machine gets a per-instance Sokosumi MCP server from the
  orchestrator (`/v1/mcp/:instanceId`) — taskboard read/write tools,
  autonomy-gated (medium autonomy intercepts writes into confirmation cards).
- **Warm pool**: signup speed comes from pre-booted stopped machines
  (`WARM_POOL_TARGET`); provisioning from the pool takes seconds, a cold
  create ~1–2 min.

Per-user isolation properties:
- One Firecracker microVM per user (one Fly app per user). Never shared.
- Per-instance random `API_SERVER_KEY` (32 bytes), encrypted at rest in
  Postgres with libsodium secretbox.
- `OPENROUTER_API_KEY` is orchestrator-owned; machines only ever see a
  per-instance proxy URL, never the upstream key.
- The machine's public URL is the only ingress; auth is the `API_SERVER_KEY`
  bearer.

## Environment variables

`src/config.ts` is the source of truth (zod-validated at boot). The
must-haves:

| Variable | Required | Description |
|---|---|---|
| `ORCHESTRATOR_API_TOKEN` | **yes** | Shared secret. Sokosumi sends this as `Authorization: Bearer …`. |
| `DATABASE_URL` | **yes** | Postgres URL. |
| `FLY_API_TOKEN` | **yes** | Fly Machines API token. |
| `FLY_MACHINE_IMAGE` | **yes** | Per-user image ref, e.g. `registry.fly.io/hermes-user-image:v23`. |
| `ORCHESTRATOR_PUBLIC_URL` | **yes** | Public URL of this service (machines call back through it). |
| `OPENROUTER_API_KEY` | **yes** | Orchestrator-owned upstream LLM key. |
| `MASTER_ENCRYPTION_KEY` | **yes** | 32 random bytes, base64. Encrypts secrets at rest. |
| `ADMIN_PASSWORD` | **yes** | Basic Auth password for `/admin` (user `admin`). |
| `SOKOSUMI_ORCHESTRATOR_API_KEY_*` | per env | Sokosumi service token per env (mainnet/preprod/dev). |
| `TEXT_MODEL_OVERRIDE` | no | Force the fleet's text model without an image rebuild. |
| `WARM_POOL_TARGET` | no | Warm-pool size; `0` disables the pool. |

Generate `MASTER_ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## API

All `/v1/*` endpoints require `Authorization: Bearer $ORCHESTRATOR_API_TOKEN`
(machine-facing routes like the llm/mcp proxies authenticate with per-instance
keys instead). Errors are `application/problem+json`.

### Provision

```bash
curl -X POST https://orchestrator.example.com/v1/instances \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u_abc123"}'
# 202 Accepted
# { "instanceId": "…", "status": "provisioning" }
```

Idempotent on `userId`. Provisioning is async — seconds from the warm pool,
~1–2 min cold; poll `GET` until `status` reaches `infrastructure_ready`
(setup wizard) and later `ready`/`running` (after onboarding).

### Get state

```bash
curl https://orchestrator.example.com/v1/instances/u_abc123 \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# { "status": "running",
#   "model": "xiaomi/mimo-v2.5",
#   "endpointUrl": "https://hermes-u-abc123.fly.dev",
#   "transitioning": false, "integrations": [...], "pendingConfirmations": [...] }
```

### More instance endpoints

- `POST …/resume` / `POST …/suspend` — bookkeeping + machine stop/start.
- `POST …/onboard` — run the onboarding pipeline (persona, memory, skills).
- `POST …/secrets` — set a per-user secret (restarts the machine's Hermes).
- `GET …/key` — the per-instance bearer Sokosumi uses for direct chat.
- `GET …/inbox` — outbox messages (agent-initiated pushes, cron results).
- `GET/PATCH/DELETE …/schedules…` — the user's scheduled tasks (orchestrator
  mirror + native machine crons).
- `GET …/confirmations` + `POST …/confirmations/:id/approve|reject` —
  medium-autonomy write approvals.
- `DELETE /v1/instances/:userId` — destroy machine, app, and DB row.

### Chat proxy

```bash
curl $ORCH/v1/proxy/u_abc123/v1/chat/completions \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"hi"}]}'
```

## Local development

```bash
npm install
cp .env.example .env   # fill in the required vars above

npx prisma db push     # this repo uses db push (no migration files)
npm run dev
npm test
```

## Deployment (Railway)

Deploys are **manual** — pushing to git does NOT deploy:

```bash
railway up --detach
# verify: /admin/version bootedAt changed
```

The container runs `prisma db push` on boot, so additive schema changes apply
automatically. The per-user image is built separately — see
`Dockerfile.hermes-user`'s header for the build/push commands — then bump
`FLY_MACHINE_IMAGE` and roll instances (admin → instance → sync-config).

## Decisions worth knowing

- **Always-on machines** (`auto_stop_machines: off`): Hermes' gateway daemon
  must stay up for native cron and MCP; idle cost is accepted.
- **Warm pool**: pre-booted stopped machines make signup fast;
  `WARM_POOL_TARGET=0` is the kill switch.
- **Model pinning**: the per-user image pins `nousresearch/hermes-agent` to a
  tag that supports `agent.tool_use_enforcement` (anti-narration guard); the
  llm-proxy can override the served model fleet-wide via
  `TEXT_MODEL_OVERRIDE` without an image rebuild.
- **Two cron systems**: native machine cron (Hermes' own scheduler; the
  orchestrator mirrors + reconciles specs) plus orchestrator sweeps
  (taskboard assistant, input responder, urgent interrupts, capability
  rolls). `/admin/crons` shows both.
