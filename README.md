# Hermes Orchestrator

A small HTTP service that provisions and manages **per-user Hermes Agent**
instances. Each user gets one isolated [Hermes Agent](https://github.com/NousResearch/hermes-agent)
running in a hardware-isolated [Sprites.dev](https://sprites.dev) microVM
(Firecracker). The orchestrator itself runs on Railway.

**This is a backend service.** It has no UI. The Sokosumi web app calls it over
HTTP to provision instances, then proxies user chat traffic to each user's
private Hermes endpoint.

## Architecture

```
   ┌──────────────────┐    HTTP/Bearer       ┌──────────────────────┐
   │     Sokosumi     │ ───────────────────▶ │  Hermes Orchestrator │
   │   (web app)      │                      │  (this service, on   │
   │                  │ ◀─── instance state  │   Railway)           │
   └────────┬─────────┘                      └─────────┬────────────┘
            │                                          │  REST
            │                                          ▼
            │                                ┌────────────────────┐
            │                                │   Sprites.dev API  │
            │                                └─────────┬──────────┘
            │  OpenAI-format chat                      │ create / fs / exec / services
            │  (Bearer apiServerKey)                   ▼
            │                          ┌───────────────────────────────┐
            └─────────────────────────▶│   User Sprite (microVM)       │
                                       │   Hermes Agent on :8642       │
                                       │   /opt/data persistent volume │
                                       └───────────────────────────────┘
```

Per-user isolation properties:
- One Firecracker microVM per user. Never shared.
- Per-instance random `API_SERVER_KEY` (32 bytes), encrypted at rest in Postgres
  with libsodium secretbox.
- `OPENROUTER_API_KEY` is orchestrator-owned. It's written into the user
  sprite's `/opt/data/.env` so Hermes can call OpenRouter — the user never
  sees it.
- The sprite's public URL is the only ingress; auth is the `API_SERVER_KEY`
  bearer.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Orchestrator HTTP port. Default `8080`. |
| `LOG_LEVEL` | no | pino level. Default `info`. |
| `ORCHESTRATOR_API_TOKEN` | **yes** | Shared secret. Sokosumi sends this as `Authorization: Bearer …` on every request. Use ≥32 random bytes. |
| `DATABASE_URL` | **yes** | Neon Postgres URL with `sslmode=require`. |
| `SPRITES_API_TOKEN` | **yes** | Token from sprites.dev → Settings → API tokens. |
| `SPRITES_API_BASE` | no | Default `https://api.sprites.dev`. |
| `SPRITES_DEFAULT_REGION` | no | Empty = sprites' default region. |
| `DEFAULT_IDLE_SUSPEND_MINUTES` | no | Idle threshold for the bookkeeping cron. Default `30`. |
| `PER_USER_INSTANCE_CAP` | no | Hard cap per user. Default `1`. |
| `OPENROUTER_API_KEY` | **yes** | Orchestrator-owned. Injected into each user sprite. |
| `MASTER_ENCRYPTION_KEY` | **yes** | 32 random bytes, base64-encoded. Encrypts `apiServerKey` at rest. |

Generate `MASTER_ENCRYPTION_KEY`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## API

All endpoints require `Authorization: Bearer $ORCHESTRATOR_API_TOKEN`. Errors
are returned as `application/problem+json` with `userId` included for
correlation when relevant.

### Provision

```bash
curl -X POST https://orchestrator.example.com/v1/instances \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u_abc123"}'
# 202 Accepted
# { "instanceId": "…", "status": "provisioning" }
```

Idempotent on `userId`. Returns the existing record if one already exists.
Bootstrap runs asynchronously (~5–10 min); poll `GET` for `status: running`.

### Get state

```bash
curl https://orchestrator.example.com/v1/instances/u_abc123 \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# { "status": "running",
#   "endpointUrl": "https://hermes-u-abc123-xxxxxx.sprites.app",
#   "lastActivityAt": "2026-05-12T14:21:00.000Z" }
```

### Resume / Suspend

```bash
curl -X POST https://orchestrator.example.com/v1/instances/u_abc123/resume \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# { "endpointUrl": "…", "status": "running" }

curl -X POST https://orchestrator.example.com/v1/instances/u_abc123/suspend \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# { "status": "suspended" }
```

Sprites releases the microVM's compute on idle automatically and wakes it
sub-second on inbound HTTP — `/resume` is mostly a bookkeeping flip so
Sokosumi knows the instance is allowed to receive traffic again.

### Set per-user secret

```bash
curl -X POST https://orchestrator.example.com/v1/instances/u_abc123/secrets \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"EXA_API_KEY","value":"…"}'
# 204
```

Reserved keys (`API_SERVER_*`, `HERMES_HOME`, `OPENROUTER_API_KEY`) are
rejected — the orchestrator owns those. Writing a secret restarts the Hermes
service inside the sprite so the new value takes effect.

### Get bearer key

```bash
curl https://orchestrator.example.com/v1/instances/u_abc123/key \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# { "apiServerKey": "…" }
```

Sokosumi uses this to call the user's Hermes endpoint:
```bash
curl $ENDPOINT_URL/v1/chat/completions \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"hi"}]}'
```

### Destroy

```bash
curl -X DELETE https://orchestrator.example.com/v1/instances/u_abc123 \
  -H "Authorization: Bearer $ORCHESTRATOR_API_TOKEN"
# 204 — sprite and DB row deleted
```

## Local development

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, SPRITES_API_TOKEN, OPENROUTER_API_KEY, MASTER_ENCRYPTION_KEY,
# ORCHESTRATOR_API_TOKEN

npx prisma migrate dev --name init
npm run dev
```

Health check:
```bash
curl http://localhost:8080/health
```

## Deployment (Railway)

```bash
railway login
railway link            # link to your project
railway up              # builds from Dockerfile and deploys

# Then in Railway dashboard → Variables, set every entry from .env.example.
# Most importantly: DATABASE_URL (from Railway-Postgres or Neon),
# SPRITES_API_TOKEN, OPENROUTER_API_KEY, MASTER_ENCRYPTION_KEY,
# ORCHESTRATOR_API_TOKEN.
```

The container runs `prisma migrate deploy` on boot.

## Per-user image (chat-only)

This service does **not** push a Docker image to Sprites — Sprites is a
stateful-microVM platform, not a container registry. Each user sprite is
bootstrapped by `scripts/bootstrap-hermes-sprite.sh`, which:

1. Installs system Python + uv + git inside the sprite.
2. Clones [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).
3. Runs `uv sync --frozen` for the **core extras only** — no Playwright, no
   Node, no browser binaries. (Chat-only profile.)
4. Writes `/opt/data/config.yaml` disabling `terminal`, `shell`, `browser`,
   `web`, `playwright`, `filesystem_write`.

The orchestrator then writes `/opt/data/.env` with `API_SERVER_*` and
`OPENROUTER_API_KEY`, registers the Hermes process as a sprite **service**
on `http_port: 8642`, and the sprite's public URL routes traffic there.

## Decisions worth knowing

- **Why Sprites and not Fly:** Fly Machines is the brief's reference design;
  Sprites gives equivalent Firecracker isolation, native auto-suspend, and a
  simpler "no Docker image to push" deployment model.
- **No Docker registry step:** Sprites can't run arbitrary OCI images. The
  Hermes install happens inside the running sprite via the bootstrap script.
- **Why bootstrap-on-first-boot vs. snapshot fork:** Sprites' checkpoints are
  for in-place rollback only; you cannot fork a sprite from a checkpoint of
  another. First-boot install costs ~10 min per user; the cost is paid once,
  then the sprite is reused forever.
- **Suspend is automatic:** Sprites pulls compute on idle. The orchestrator's
  cron is bookkeeping-only — it doesn't actively stop machines.
