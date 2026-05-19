# Sokosumi API → Hermes Memory Integration Plan

Source: Sokosumi OpenAPI spec v1.0.0 (95 endpoints across Tasks, Jobs, Projects, Conversations, Agents, Coworkers, Users, Credits).

Goal: give Hermes a full read view (and eventually write access) over the user's Sokosumi workspace — tasks, completed jobs, agent history, conversations — so it knows what its user is actually working on.

---

## Tier 1 — Must-have (Phase A)

The minimum read set for "Hermes knows your work":

| Endpoint | Purpose |
|---|---|
| `GET /tasks` | List tasks (status filter, scope=workspace) |
| `GET /tasks/{id}` | Task detail incl. embedded jobs + events |
| `GET /jobs?status=COMPLETED` | Completed jobs paginated |
| `GET /jobs/{id}` | Job detail with `result` (markdown output) |
| `GET /jobs/{id}/files` | Job output files |
| `GET /agents/{id}/jobs` | Per-agent job history |

## Tier 2 — High-value (Phase B)

| Endpoint | Purpose |
|---|---|
| `GET /conversations` + `/messages` | Chat history with other coworkers |
| `GET /jobs/{id}/events` | Per-job timeline |
| `GET /tasks/{id}/events` | Task activity log |
| `GET /projects` + `GET /projects/{id}` | Project groupings |
| `GET /users/{id}/credits` | Balance — drives cost-aware suggestions |
| `GET /coworkers` | Available coworkers for cross-recommendation |

## Tier 3 — Write endpoints (Phase C, the big unlock)

Hermes goes from observer to orchestrator:

| Endpoint | Action |
|---|---|
| `POST /tasks` | Create task |
| `POST /tasks/{id}/jobs` / `POST /agents/{id}/jobs` | Launch a job |
| `GET /agents/{id}/input-schema` | Read agent input schema before launching |
| `POST /projects` + `POST /projects/{id}/jobs` | Organize into projects |
| `POST /conversations` / `/messages` | Hand off to another coworker |

Requires user-consent UX (these cost credits) — confirmation prompt before each call.

---

## Auth model (already perfect)

Sokosumi's API supports coworker API keys with delegation headers — exact shape we need:

- `Authorization: Bearer <coworker-api-key>` — one key for Hermes overall, held in our Railway env
- `X-Delegation-User-Id: <sokosumi-user-id>` — scopes the call to a specific end user
- `X-Delegation-Organization-Id: <org-id>` — optional, for multi-org users

No per-user OAuth needed. Single secret, delegated per request.

---

## Implementation phases

### Phase A — bulk sync at onboarding (~1 day)

In `runOnboarding`, add a `sokosumi_sync` step. Pulls:
1. `GET /tasks?scope=workspace&limit=100`
2. `GET /jobs?status=COMPLETED&limit=50`
3. `GET /conversations?limit=20` + last 20 messages each
4. `GET /users/:id/credits`
5. `GET /agents`

Summarize and pipe into the boot-prompt memory write so Hermes' memory file knows the user's history.

### Phase B — live drill-down via Hermes tools

Give Hermes 3 new tools that proxy through the orchestrator (same pattern as the planned Composio MCP proxy):

- `sokosumi.list_jobs({status?, agent_id?, limit})` → `GET /jobs`
- `sokosumi.get_job(id)` → `GET /jobs/{id}` + `/files`
- `sokosumi.list_tasks({status?, q?})` → `GET /tasks`

Single `SOKOSUMI_COWORKER_API_KEY` in orchestrator env. Per-instance bearer auth from Hermes side, delegation headers attached server-side.

### Phase C — write endpoints

Add `sokosumi.create_task(...)`, `sokosumi.run_agent(...)`, etc. Needs user-consent prompts before each call.

---

## Asks for the Sokosumi dev (when we kick this off)

1. Create a "Hermes Coworker" via `POST /coworkers`, give us the resulting `coworkerApiKey`.
2. Confirm base URL for `/v1` (presumably `https://sokosumi.com/v1` or similar).
3. Clarify: are organizations relevant for our users (do we need to discover/track org IDs for delegation), or is everyone effectively solo?
