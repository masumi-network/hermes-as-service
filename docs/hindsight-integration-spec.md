# Hindsight v0.8.5 — Integration Spec (source-verified)

Produced by a 4-way source recon of `vectorize-io/hindsight` @ v0.8.5 on
2026-07-25 (47 findings). Kept because Hindsight is PRE-1.0: when we bump the
pinned image, re-verify the sections marked [unverified] / [docs-only] before
trusting them.

Our deployment decisions that follow from this doc live in PLAN-HINDSIGHT.md.

---

# HINDSIGHT v0.8.5 — PROXY INTEGRATION SPEC

Ground truth: source at tag `v0.8.5` (`vectorize-io/hindsight`). Everything below is `verified-in-source` unless tagged **[docs-only]**, **[unverified]**, or **[platform]**.

Notation: `$H` = `http://hindsight:8888`, `$TOK` = value of `HINDSIGHT_API_MCP_AUTH_TOKEN`, `$BANK` = the per-user bank id the proxy derives server-side.

---

## A. MCP endpoint contract

### A.1 Endpoint

| Property | Value |
|---|---|
| Base URL | `$H/mcp` (multi-bank) **or** `$H/mcp/{bank_id}/` (single-bank) |
| Port | **8888 — same port as REST.** Not 9999 (that is the Next.js Control Plane UI). |
| Transport | **Streamable HTTP only.** No legacy SSE (`/sse`, `/messages` are not mounted). No stdio. |
| Mount | ASGI middleware, not a Starlette `Mount` → both `/mcp` and `/mcp/` work, **no 307 redirect**. |
| Affected by `HINDSIGHT_API_BASE_PATH`? | **No.** That only sets FastAPI `root_path` for REST. `/mcp` is hardcoded. |
| Kill switch | `HINDSIGHT_API_MCP_ENABLED=false` |

Routing rule: **any** first path segment after `/mcp/` is treated as a bank id, with no blocklist. `/mcp/sse/` is a bank literally named `sse`.

> Note: the REST surface (`POST /v1/default/banks/{bank_id}/memories|.../recall|.../reflect`) is a strictly simpler contract — bank_id is a mandatory path segment, plain JSON in/out, no session, no SSE framing. If the proxy does not need to speak MCP to its own clients, REST removes an entire class of failure modes documented in A.5/F.

### A.2 HTTP methods the proxy must support

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/mcp`, `/mcp/`, `/mcp/{bank}`, `/mcp/{bank}/` | All JSON-RPC traffic. This is the only method you actually need. |
| `GET` **without** `Mcp-Session-Id` | `/mcp*` | Returns **HTTP 200, body `{}`, `content-type: application/json`, before any auth check.** Deliberate Claude Code ≥ v2.1.84 probe workaround. Never 401s, even with a bad token. Do not treat as "MCP is healthy + authorized". |
| `GET` **with** `Mcp-Session-Id` | `/mcp*` | Opens the server→client `text/event-stream`. Requires `Accept: text/event-stream` (else 406). Second concurrent GET on one session → 409. Only exists in stateful mode. |
| `DELETE` | `/mcp` + `Mcp-Session-Id` | Session termination per MCP spec — **[unverified]**, see F.2. |

**Recommendation: set `HINDSIGHT_API_MCP_STATELESS=true`.** Every request then spawns its own transport+server task from the current request's context. This eliminates the ContextVar hazard in A.5 and costs only GET/SSE, which a request/response proxy does not use.

### A.3 Auth

```
Authorization: Bearer <token>
```
Bare `Authorization: <token>` is also accepted (middleware strips a literal `"Bearer "` prefix, else uses the whole trimmed value).

Behaviour when `HINDSIGHT_API_MCP_AUTH_TOKEN` is set (read **once at module import** — changing it requires a process restart):

| Case | Response |
|---|---|
| No `Authorization` header | `401` `{"error":"Authorization header required"}` |
| Wrong value | `401` `{"error":"Invalid authentication token"}` |
| Correct | pass through |

No `WWW-Authenticate` header is emitted. Both bodies are `application/json`.

**If the var is unset, `/mcp` is completely open** (shipped `DefaultTenantExtension` performs no auth). Always set it.

### A.4 Required request headers

```
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer $TOK
Mcp-Session-Id: <from initialize response>   # stateful mode, all calls after initialize
X-Bank-Id: $BANK                             # only if using multi-bank /mcp; see B.4
```
If `Accept` lacks `text/event-stream` the middleware force-injects the full value anyway — so **the proxy must be able to parse an SSE-framed POST response regardless of what it asked for.**

### A.5 JSON-RPC shapes

**1. initialize** — POST
```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},
           "clientInfo":{"name":"hermes-proxy","version":"1.0.0"}}}
```
Response (stateful) carries header `mcp-session-id: <uuid>` — capture and reuse it. Body may arrive as raw JSON **or** SSE-framed:
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"...","capabilities":{...},"serverInfo":{...}}}
```
Parser must accept both. Echo back the server's `protocolVersion`; do not hardcode. **[unverified]** which protocol revisions FastMCP 3.2.0 accepts — see F.1.

**2. notifications/initialized** — POST, no `id`, expect `202` with empty body.
```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```
Standard MCP requirement before `tools/call` in stateful mode. **[unverified]** whether hindsight enforces it — F.1.

**3. tools/list**
```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```
→ `result.tools[]`, each `{name, description, inputSchema, annotations}`. `annotations` carry `readOnlyHint` (recall/reflect/list_*/get_*), `destructiveHint` (delete_*/clear_*/invalidate_memory), `openWorldHint:false`.

**4. tools/call**
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"recall","arguments":{"query":"what did I say about X"}}}
```
→ `result.content[0].text`. **Return type differs by mode:** multi-bank `recall`/`reflect`/`get_bank_stats` return a JSON **string** (`model_dump_json(indent=2)`); single-bank returns a **dict**. Parse defensively: `json.loads(text)` if `text` is a string that starts with `{`.

### A.5.1 Three behaviours that will bite the implementer

1. **Tool errors are NOT JSON-RPC errors.** They come back as a successful `tools/call` result whose payload contains `{"status":"error","message":...}` or an `error` field. You must inspect the payload; `result.isError` alone is insufficient.
2. **Unknown arguments are silently dropped, never rejected.** Every tool schema is `additionalProperties:false`, so hindsight wraps `tool.run` with `_make_tools_tolerant`, which filters `arguments` down to declared property names and auto-`json.loads` string-encoded arrays/objects. A typo'd argument name vanishes without a trace. Validate argument names proxy-side.
3. **Stateful-session ContextVar hazard — confidence: `unclear`.** In default stateful mode, the bank/auth/schema ContextVars a tool reads are the ones captured on the session's `initialize` POST, not the current request. The mcp SDK spawns one long-lived `run_server` task at session creation and asyncio copies the context at spawn time. **Practical rule: one MCP session per (bank, token) pair. Never multiplex banks or tenants over one `Mcp-Session-Id` — changing `X-Bank-Id` mid-session will be ignored.** Mitigate with either the single-bank URL form (B.4 Option 1) or `HINDSIGHT_API_MCP_STATELESS=true`. Verification curl in F.3.

---

## B. Tool schemas

32 tools exist in `_ALL_TOOLS`. Single-bank mode registers 29 (drops `list_banks`, `create_bank`, `get_bank_stats`). Docs claiming "27 tools"/"30 tools" are stale — trust `_ALL_TOOLS`.

### B.1 `retain` / `sync_retain`

```
retain(content: str,                                    # REQUIRED
       context: str = "general",
       timestamp: str | None = None,                    # ISO-8601
       tags: list[str] | None = None,
       metadata: dict[str, str] | None = None,          # values must be strings
       document_id: str | None = None,                  # upsert key
       bank_id: str | None = None,                      # MULTI-BANK ONLY
       strategy: str | None = None,
       update_mode: str | None = None) -> dict           # "replace" | "append"
```
JSON Schema: `type:object`, `additionalProperties:false`, `required:["content"]`. `content` `{type:string}`; `context` `{type:string,default:"general"}`; `timestamp`/`document_id`/`bank_id`/`strategy`/`update_mode` `{anyOf:[{type:string},{type:null}],default:null}`; `tags` `{anyOf:[{type:array,items:{type:string}},{type:null}],default:null}`; `metadata` `{anyOf:[{type:object,additionalProperties:{type:string}},{type:null}],default:null}`.

Returns `{"status":"accepted","message":"Memory storage initiated","operation_id":...}` — **`retain` is ASYNC.** For read-after-write use **`sync_retain`** (identical args minus `update_mode`), which returns `{"status":"completed","memory_ids":[...]}`.

### B.2 `recall`

```
recall(query: str,                                      # REQUIRED
       max_tokens: int = 4096,
       budget: str = "high",                            # low|mid|high; anything else → HIGH
       types: list[str] | None = None,                  # world|experience|observation
       prefer_observations: bool = False,
       tags: list[str] | None = None,
       tags_match: str = "any",                         # any|all|any_strict|all_strict|exact
       tag_groups: list[dict] | None = None,            # MUTUALLY EXCLUSIVE with tags
       query_timestamp: str | None = None,
       min_scores: dict | None = None,
       bank_id: str | None = None)                      # MULTI-BANK ONLY
```
`required:["query"]`, `additionalProperties:false`. Sending both `tags` and `tag_groups` raises. Docs omit `prefer_observations` and `tag_groups` — they exist.

### B.3 `reflect`

```
reflect(query: str,                                     # REQUIRED
        context: str | None = None,
        budget: str = "low",                            # NOTE: default LOW, unlike recall's HIGH
        max_tokens: int = 4096,
        response_schema: dict | None = None,            # JSON Schema → structured_output
        tags: list[str] | None = None,
        tags_match: str = "any",
        include_based_on: bool = False,
        include_trace: bool = False,
        bank_id: str | None = None)                     # MULTI-BANK ONLY
```
`required:["query"]`, `additionalProperties:false`. `based_on` is stripped unless `include_based_on=true`; `tool_trace`/`llm_trace`/`directives_applied` stripped unless `include_trace=true`. Docs omit `include_based_on` and `bank_id`.

### B.4 WHERE bank_id lives — and how to force it server-side

`bank_id` resolution inside every tool: `target_bank = bank_id_argument or resolver()`, where resolver reads a per-request ContextVar set by the middleware as:

> **URL path segment `/mcp/{bank}/` (wins) → `X-Bank-Id` header → `HINDSIGHT_MCP_BANK_ID` env → literal `"default"`.**

There is no "no bank configured" error path over HTTP; a missing bank silently becomes `"default"`, i.e. **a shared bucket**. Guard against this.

**Option 1 — RECOMMENDED. Pin the path: proxy to `$H/mcp/$BANK/`.**
- `bank_id` is **not in the tool schemas at all**. A client that injects `"bank_id":"someone-else"` has it **silently stripped** by `_make_tools_tolerant` — it is structurally impossible for a caller to cross banks.
- Also removes `list_banks`, `create_bank`, `get_bank_stats` from `tools/list` automatically.
- Combined with one MCP session per bank, this also neutralises the A.5.1(3) ContextVar hazard.
- Percent-encode `$BANK` into the path.

**Option 2 — if you must use `/mcp`.** For every `tools/call`, the proxy must **overwrite** (not default) `params.arguments.bank_id = $BANK` before forwarding, AND pin `X-Bank-Id: $BANK`, AND filter `list_banks`/`create_bank`/`get_bank_stats`/`delete_bank` out of `tools/list` and reject them in `tools/call`. Strictly worse than Option 1.

**Defence in depth (both options):** `HINDSIGHT_API_MCP_ENABLED_TOOLS=retain,sync_retain,recall,reflect` — a server-side intersection against `_ALL_TOOLS`; unlisted tools are never registered and are invisible in `tools/list`. Caveat: tools injected via `HINDSIGHT_API_MCP_EXTENSION` bypass this intersection (not applicable if you set no extension).

---

## C. Bank lifecycle

### C.1 Auto-create

| Operation | Unknown bank_id behaviour |
|---|---|
| `retain` / `sync_retain` (sync + async) | **Auto-creates.** `INSERT INTO banks (...) ON CONFLICT (bank_id) DO NOTHING`, name = bank_id, disposition `{skepticism:3,literalism:3,empathy:3}`, mission `""`. Also creates 3 per-bank vector indexes and applies `HINDSIGHT_API_DEFAULT_BANK_TEMPLATE` if set. |
| `recall` | **No create, no 404.** Returns HTTP 200 with `results: []`. Every retrieval arm is just `WHERE bank_id = $N`. |
| `reflect` | Same read path — no create. |
| `PATCH /banks/{id}/config`, `POST /banks/{id}/import` | Auto-creates. |
| `GET /banks/{id}/profile`, `PATCH /banks/{id}` | **404** (`create_if_missing=False`). |

**`create_bank` is never a prerequisite.** Do not call it. There is no kill switch to disable auto-create (only a custom `OperationValidatorExtension`).

If you want every new user to start with the same mission/directives, set `HINDSIGHT_API_DEFAULT_BANK_TEMPLATE` (a JSON object) — applied once, best-effort, at first bank creation. No extra round trip.

### C.2 bank_id charset

**A 32-char alphanumeric user id such as `8Z5tyaPc4LmMPB74hrXbi9huAa9QgJQz` is SAFE VERBATIM.**

- **Zero validation anywhere.** No regex, no length cap, no charset check, no case folding, no trimming. Plain `bank_id: str` path param; Pydantic `Field(description=...)` with no constraints.
- Storage: `banks.bank_id` is `TEXT PRIMARY KEY` (unbounded). As of migration `a1d3f5b7c9e2` (shipped in v0.8.5) **all** other bank_id columns are TEXT too — earlier releases had `VARCHAR(64)` that 500'd on ids > 64 chars. Do not run < v0.8.5 with long ids.
- **Case-sensitive.** `Abc` and `abc` are two different banks. Always send the byte-identical string.
- Structural (not validated) constraints: it is a URL path segment, so `/`, `?`, `#` must be percent-encoded; it is interpolated into per-bank index DDL escaped only by doubling `'`; it prefixes chunk ids as `{bank_id}_{document_id}_{chunk_index}` (underscores make chunk ids unparseable, still unique — cosmetic); it appears in object-storage keys `banks/{bank_id}/files/...`. Alphanumerics are unaffected by all of these.

### C.3 Destroying a user's memory

```bash
curl -sS -X DELETE "$H/v1/default/banks/$BANK" \
  -H "Authorization: Bearer $REST_KEY"
# → {"success":true,"message":"...","deleted_count":N}
```
- **REST only** (there is a `delete_bank` MCP tool that maps to the same engine call).
- **Real hard delete**, one transaction, no soft-delete flag or tombstone: `documents` (→ chunks), `memory_units` (→ unit_entities, memory_links, observation_history), `invalidated_memory_units`, `entities` (→ entity_cooccurrences, memory_links), then the `banks` row, which `ON DELETE CASCADE`s to `async_operations`, `webhooks`, `directives`, `mental_models` (→ history), `learnings`, `pinned_reflections`. Post-commit it drops the 3 per-bank vector indexes and invalidates the stats cache.
- **Idempotent:** deleting a non-existent bank returns `success:true, deleted_count:0`. No 404.
- Memories-only (keep profile/config): `DELETE $H/v1/default/banks/$BANK/memories?type=world|experience|observation`.

**RESIDUE — tables with a `bank_id` column but no FK to `banks`, so rows survive deletion:**

| Table | Contains | Default |
|---|---|---|
| `llm_requests` | `input`/`output` JSONB = **prompts and completions containing the user's memory text** | tracing **ON**, truncated 50k chars, retention **1 day** |
| `audit_log` | audit rows | OFF; retention `-1` = forever when enabled |
| `file_storage` | raw uploaded bytes, key `banks/{bank_id}/files/...`, **no bank_id column at all** | bytes deleted right after retain (`FILE_DELETE_AFTER_RETAIN=true`) |
| `graph_maintenance_queue`, `bank_stats_cache` | orphan rows | — |

If the product promises "delete my data", either disable LLM tracing (see F.6) or add an explicit sweep of `llm_requests` / `audit_log` / `file_storage` by bank_id prefix.

---

## D. Isolation verdict

### Verdict

**One shared instance with per-user bank_id is QUERY-LEVEL isolation only. bank_id is a NAMESPACE, not a security boundary.**

It is **acceptable** if and only if:
1. Port 8888 is reachable **only** by your proxy (Railway private networking, no public domain on the hindsight service).
2. The proxy **derives bank_id server-side from the authenticated user** and never accepts it from the client (use B.4 Option 1).
3. The proxy exposes **no** bank-enumerating or bank-less endpoint (list below).

It is **not acceptable** if any untrusted party can reach 8888 directly, or if you need a defensible DB-level boundary for compliance. For that, the only real answer is a custom `TenantExtension` that maps each user to their own PostgreSQL schema (as `SupabaseTenantExtension` does with `{prefix}_{user_id}`).

### How isolation actually works

Two distinct boundaries — do not conflate:
- **Tenant boundary = PostgreSQL SCHEMA.** `TenantExtension.authenticate()` → `TenantContext(schema_name)` → contextvar → `fq_table()` qualifies every table. With the default `DefaultTenantExtension` or `ApiKeyTenantExtension`, **every request resolves to the same schema** (`HINDSIGHT_API_DATABASE_SCHEMA`, default `public`).
- **Bank boundary = a `bank_id` column predicate inside that one schema.** No RLS, no partitioning, no schema-per-bank.

Normal recall is correctly scoped: semantic, BM25, temporal, spreading-activation, link-expansion, and entity-resolution arms all carry `WHERE bank_id = $N`. Recall on bank A cannot surface bank B's facts.

### Shared / global state that could leak

| # | Vector | Severity | Mitigation |
|---|---|---|---|
| 1 | **`GET /v1/default/chunks/{chunk_id:path}` — bank-less.** `SELECT ... FROM chunks WHERE chunk_id = $1`, **no bank filter**, returns raw `chunk_text`. Chunk ids are fully derivable: `{bank_id}_{document_id}_{chunk_index}`. Authorization exists only if you install an `OperationValidatorExtension` — **unset by default**. | **HIGH** | Never proxy this path. Keep 8888 private. |
| 2 | **`GET /v1/default/banks`** returns every bank in the schema (id, name, mission, fact counts). MCP equivalent: `list_banks`. Filtered only by `filter_bank_list`, whose default is a no-op. | **HIGH** | Never proxy. Use `/mcp/{bank}/` (drops the tool) + `MCP_ENABLED_TOOLS`. |
| 3 | **Any caller can address any bank_id in the URL.** The only authz hook is `HINDSIGHT_API_OPERATION_VALIDATOR_EXTENSION`, unset by default. | **HIGH** | Proxy-derived bank_id; path-pinned MCP. |
| 4 | **Graph-expansion CTE has no explicit bank predicate.** `build_entity_expansion_cte` / `build_semantic_causal_cte` traverse `unit_entities` and `memory_links` purely from bank-scoped `seed_ids`. Isolation is a *transitive invariant* (entities carry bank_id, links are created within a bank), not an enforced filter. Holds in v0.8.5, but any bug creating a cross-bank entity/link leaks silently through recall. | MED | Accept; re-audit on upgrade. |
| 5 | **`HINDSIGHT_API_MCP_AUTH_TOKEN` silently disables tenant schema selection.** When set, the middleware sets `tenant_context = None` + `mcp_pre_authenticated = True`, the engine skips `tenant_extension.authenticate()`, and `get_current_schema()` falls back to `HINDSIGHT_API_DATABASE_SCHEMA`. **A static MCP token collapses all MCP traffic into one schema.** Deliberate (issue #627), not a bug. | MED | Harmless for a single-schema deploy. **Choose one: static MCP token OR real per-tenant schemas. Never both.** |
| 6 | `RequestContext.allowed_bank_ids` looks like a per-request bank ACL. It is **dead code** — nothing reads it. | INFO | Do not rely on it. |
| 7 | Outbound attribution: `HINDSIGHT_API_LLM_SEND_BANK_AS_USER` (sends `user=<bank_id>` to the LLM provider) and `HINDSIGHT_API_RERANKER_SEND_BANK_AS_HEADER` (`X-Hindsight-Bank-Id`). Both default **False**. If bank_id is your end-user id, enabling either forwards it to a third party. | MED | Leave both false. Explicitly pin them. |
| 8 | `MemoryEngine.delete_memory_unit(unit_id)` deletes with **no bank_id predicate**. Not wired to any HTTP route in v0.8.5. | INFO | Never call from embedded/SDK code without an ownership check. |
| 9 | `llm_requests` / `audit_log` / `file_storage` are shared tables (see C.3). `file_storage` has no bank_id column at all. | MED | See C.3 sweep. |
| 10 | **Scaling, not leakage:** 3 partial vector indexes per bank on `memory_units` (`idx_mu_emb_{worl\|expr\|obsv}_{internal_id[:16]}`), created at bank creation. N users = **3N indexes on one table**. Real DDL-lock and planner cost. | MED | Cap users per instance; monitor. |

**Confirmed NOT shared:** entity graph is per-bank (`entities.bank_id` is a real column, resolution filters on it); no embeddings cache exists at all; stats cache is keyed `(schema, bank_id)`; Gemini prompt cache is fingerprinted on model+system_instruction+schema+tools (prompt prefix only, no user content).

---

## E. Deployment config

### E.1 Image

`ghcr.io/vectorize-io/hindsight:v0.8.5` — target `standalone` (API + Control Plane UI, local models baked in). ~9 GB amd64 / ~3.7 GB arm64.

**Use the FULL image, not `-slim`.** Slim (~500 MB) ships no local models and *requires* external embeddings + reranker providers, which contradicts the "embeddings local" requirement.

### E.2 Ports

| Port | Serves |
|---|---|
| **8888** | REST `/v1/...`, MCP `/mcp` + `/mcp/{bank}/`, `GET /health`, `GET /version`, `GET /metrics`. Everything the proxy needs. |
| 9999 | Next.js Control Plane UI. Set `HINDSIGHT_ENABLE_CP=false` to drop the process entirely. |

`HINDSIGHT_API_WORKER_HTTP_PORT` (8889) is read only by the separate `hindsight-worker` CLI; nothing opens it in single-container mode. **Railway's injected `PORT` is ignored** — hindsight reads only `HINDSIGHT_API_PORT` / `HINDSIGHT_CP_PORT`.

### E.3 Volume

**Mount exactly at `/home/hindsight/.pg0`.** Not `/home/hindsight` — that shadows the baked-in `/home/hindsight/.cache` model cache and breaks local embeddings.

Landmines:
- The container runs rootless as `hindsight` (**UID 1000**). `start-all.sh` does a write pre-check on `${HOME}/.pg0` and **`exit 1`s before starting anything** if the touch fails. Confirm the Railway volume is writable by UID 1000 (F.5).
- `start-all.sh` keys off `${HOME}`. **Pin `HOME=/home/hindsight` explicitly** — if the platform runs the container under a UID with no passwd entry, HOME collapses and pg0 writes to the wrong path (silent data loss).
- Graceful shutdown: the script traps SIGTERM and gives children up to 30 s to flush WAL. Docker's default stop grace is 10 s. **Raise the platform stop timeout to ~30 s** or risk the data-loss class the script explicitly warns about (issue #675).

**Strongly consider external Postgres instead** (`HINDSIGHT_API_DATABASE_URL=postgresql://...`). When set, the pg0 writability check is skipped entirely — no volume, no UID-1000 hazard, no ~30 s pg0 start, no WAL-flush shutdown risk, plus backups. Requires PG 14+ with pgvector installable (F.7) and `HINDSIGHT_API_DB_POOL_MAX_SIZE` lowered from its default of **100** to ~10–20.

### E.4 Environment variables

```bash
# ---- LLM (OpenAI-compatible base URL) ----
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=https://<your-openai-compatible-endpoint>/v1
HINDSIGHT_API_LLM_API_KEY=<key>
HINDSIGHT_API_LLM_MODEL=<model-id>          # else per-provider default, fallback gpt-4o-mini
HINDSIGHT_API_LLM_TIMEOUT=120
HINDSIGHT_API_LLM_MAX_CONCURRENT=32
HINDSIGHT_API_LLM_MAX_RETRIES=3
# HINDSIGHT_API_SKIP_LLM_VERIFICATION=true  # only if boot-time LLM verify fails on your endpoint
# Per-op overrides exist with the same suffixes: HINDSIGHT_API_{RETAIN,REFLECT,CONSOLIDATION}_LLM_*

# ---- Embeddings: LOCAL ----
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5   # default, 384-dim, ~130 MB
HINDSIGHT_API_RERANKER_PROVIDER=local                          # default, cross-encoder/ms-marco-MiniLM-L-6-v2 ~90 MB
# HINDSIGHT_API_RERANKER_PROVIDER=rrf                          # RRF pass-through: no reranker model, big CPU/RAM saving
# NOTE: the value "none" is NOT a valid provider and raises at startup.
# NOTE: for the Google embeddings provider the value is "google", NOT "gemini".

# ---- MCP ----
HINDSIGHT_API_MCP_ENABLED=true
HINDSIGHT_API_MCP_AUTH_TOKEN=<long-random-secret>              # else /mcp is WIDE OPEN
HINDSIGHT_API_MCP_STATELESS=true                               # recommended: kills the ContextVar hazard
HINDSIGHT_API_MCP_ENABLED_TOOLS=retain,sync_retain,recall,reflect
HINDSIGHT_MCP_BANK_ID=__no_bank__                              # NOTE: no _API_ segment. Read at MODULE IMPORT.
                                                               # Sentinel value: a misrouted call lands in a junk
                                                               # bank instead of the shared literal "default".

# ---- Server ----
HOME=/home/hindsight
HINDSIGHT_API_HOST=::                                          # [platform] Railway private net is IPv6-only — verify (F.4)
HINDSIGHT_API_PORT=8888
HINDSIGHT_API_LOG_LEVEL=info                                   # critical|error|warning|info|debug|trace
HINDSIGHT_API_LOG_FORMAT=json
HINDSIGHT_API_WORKER_ID=hermes-hindsight-1                     # STABLE. Defaults to container hostname, which
                                                               # changes every redeploy and orphans in-flight ops.
HINDSIGHT_ENABLE_CP=false                                      # drop the 9999 UI process
HF_HUB_OFFLINE=1                                               # deterministic, network-free boot (full image only)

# ---- Privacy / isolation hardening ----
HINDSIGHT_API_LLM_SEND_BANK_AS_USER=false                      # default; pin it
HINDSIGHT_API_RERANKER_SEND_BANK_AS_HEADER=false               # default; pin it

# ---- Storage: pick ONE ----
# (a) embedded pg0 — volume mounted at /home/hindsight/.pg0, nothing else needed
# (b) external Postgres:
# HINDSIGHT_API_DATABASE_URL=postgresql://user:pass@host:5432/db
# HINDSIGHT_API_DATABASE_SCHEMA=public
# HINDSIGHT_API_DB_POOL_MAX_SIZE=15                            # default is 100
# HINDSIGHT_API_MIGRATION_DATABASE_URL=<direct url>            # only if fronted by PgBouncer (advisory locks)

# ---- Optional: REST auth (defence in depth) ----
# HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
# HINDSIGHT_API_TENANT_API_KEY=<secret>
# Caveat: with MCP_AUTH_TOKEN set, MCP skips tenant re-validation and uses the default schema (see D#5).
```

**The REST API is UNAUTHENTICATED by default.** Every `/v1/...` endpoint is open unless you install `ApiKeyTenantExtension`. For a private-networking-only deploy this is survivable, but **the proxy must be the only thing that can reach 8888.**

### E.5 Boot-time network needs & timing

- **Models: no download needed.** In the full image, `BAAI/bge-small-en-v1.5`, `cross-encoder/ms-marco-MiniLM-L-6-v2`, and the tiktoken `cl100k_base` encoding are baked in at build time. Embedded Postgres binaries ship inside the `pg0-embedded` wheel.
- **But:** nothing sets `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`, and `SentenceTransformer` is constructed without `local_files_only`, so on every boot huggingface_hub still attempts a revision check against huggingface.co and falls back to cache on failure. **Set `HF_HUB_OFFLINE=1`** for a strictly network-free, faster boot.
- **Outbound to your LLM base URL is needed at boot** unless `HINDSIGHT_API_SKIP_LLM_VERIFICATION=true`.
- Init (pg0 + embeddings + cross-encoder + query analyzer + LLM verify) runs in parallel under a hard cap of `HINDSIGHT_API_MODEL_INIT_TIMEOUT` (default 300 s) and raises if exceeded.
- **Migrations run automatically in-process** during `MemoryEngine.initialize()` (`HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP=true`). The app also issues `CREATE EXTENSION vector` and `pg_trgm` itself, raising a hard `RuntimeError` if pgvector is neither present nor installable. Out-of-band alternative: `hindsight-admin run-db-migration [--schema <name>]`.
- **Startup gate:** `start-all.sh` starts the API, then polls `/health` for `HINDSIGHT_API_STARTUP_WAIT_SECONDS` (default 300 s) and **aborts the whole container** if not healthy. A long first-run migration must fit in that window.
- **Health probe:** `GET /health` only — no `/ready`, `/readyz`, `/livez`. 200 `{"status":"healthy","database":"connected"}` / 503 otherwise. Unauthenticated, not under `/v1`. Use it for both liveness and readiness (as the official Helm chart does).

### E.6 Resources **[docs-only]**

Full-image API: 1.5 GB min / 2 GB recommended; idle RSS 0.8–1.0 GB, 1.2–1.5 GB under load. + PostgreSQL 512 MB min / 1 GB+. **Budget ~2.5–3 GB** for full image + embedded pg0 (CP disabled). 2 vCPU adequate for dev/basic load; the local cross-encoder reranker is the stated production bottleneck — switch to `rrf` or an external reranker if CPU-bound. Helm's own API block: requests 500m/1Gi, limits 2000m/4Gi.

### E.7 Proxy-relevant HTTP behaviours

1. **HTTP 499 on client disconnect.** recall and reflect are wrapped in `run_cancellable_on_disconnect`. If the caller hangs up, the server aborts and raises 499. **The proxy must not treat 499 as a server fault, and must keep the downstream connection open or it will cancel the work.**
2. `X-Ignored-Params: <csv>` response header lists unknown request fields — logged, not rejected. Surface it when debugging.
3. **Response bodies omit null keys.** `ExcludeNoneRoute` sets `response_model_exclude_none=True`. `trace`/`entities`/`chunks`/`source_facts` are **absent**, not `null`. Never assume a key exists.
4. Error bodies are `{"detail": ...}`. Retain's memory-defense 422 carries `{"detail":{"violations":[...]}}` — a **dict**, not a string.
5. Bodies ≥ 1024 bytes are gzipped.
6. Feature-flagged endpoints 404 when off. Check `GET /version` → `features` before calling them.

---

## F. UNKNOWNS / must-verify-live

Run these against the booted container before the proxy ships.

**F.1 — MCP framing, protocol version, and initialized handshake** *(unverified: content-type, accepted protocol revisions, whether `notifications/initialized` is enforced)*
```bash
curl -isS -X POST "$H/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```
Record: (a) response `Content-Type` — `application/json` or `text/event-stream`; (b) presence of `mcp-session-id`; (c) `result.protocolVersion`. Then immediately try `tools/list` **without** sending `notifications/initialized` — if it errors, the notification is mandatory.

**F.2 — Session termination via DELETE** *(unverified)*
```bash
curl -isS -X DELETE "$H/mcp" -H "Authorization: Bearer $TOK" -H "Mcp-Session-Id: $SID"
```
Expect 200/204 if supported, 405 if not. Determines whether the proxy must explicitly close sessions or rely on server-side expiry.

**F.3 — Stateful ContextVar hazard** *(confidence: `unclear`; no upstream test covers it)*
```bash
# one session at /mcp, then two retains with DIFFERENT X-Bank-Id on the SAME session
curl -sS -X POST "$H/mcp" -H "Authorization: Bearer $TOK" -H "Mcp-Session-Id: $SID" \
  -H "X-Bank-Id: bankA" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"sync_retain","arguments":{"content":"CANARY-A"}}}'
curl -sS -X POST "$H/mcp" -H "Authorization: Bearer $TOK" -H "Mcp-Session-Id: $SID" \
  -H "X-Bank-Id: bankB" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"sync_retain","arguments":{"content":"CANARY-B"}}}'
curl -sS -X POST "$H/v1/default/banks/bankB/memories/recall" -H "Content-Type: application/json" -d '{"query":"CANARY"}'
```
If `CANARY-B` is missing from bankB (both landed in bankA), the hazard is real → mandate `HINDSIGHT_API_MCP_STATELESS=true` and/or path-pinned `/mcp/{bank}/`.

**F.4 — Railway IPv6 bind** *(platform knowledge, not in repo)*
With `HINDSIGHT_API_HOST=::`, from another Railway service in the same project:
```bash
curl -sS http://hindsight.railway.internal:8888/health
```
Must return `{"status":"healthy","database":"connected"}`. If it fails with `0.0.0.0`, IPv6 binding is required as suspected.

**F.5 — Volume writability under UID 1000** *(platform)*
Deploy with the volume attached and grep the boot logs for:
```
The embedded database directory /home/hindsight/.pg0 is not writable by this container (UID
```
Presence of that line = the container will `exit 1`. Fix the volume ownership (or Railway's `RAILWAY_RUN_UID`) before proceeding — or switch to external Postgres and drop the volume entirely.

**F.6 — LLM trace env var name** *(env var name unverified; only the `DEFAULT_LLM_TRACE_ENABLED = True` constant is confirmed)*
```bash
curl -sS "$H/version" | jq '.features.llm_trace'
# set HINDSIGHT_API_LLM_TRACE_ENABLED=false, redeploy, re-run, confirm it flips to false
```
Matters because `llm_requests` stores prompts/completions containing user memory text and survives bank deletion (C.3).

**F.7 — pgvector on Railway Postgres** *(only if choosing external PG; could not verify Railway's image from the repo)*
```bash
psql "$DATABASE_URL" -c "SELECT version();"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
psql "$DATABASE_URL" -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm');"
```
Needs PG **14+** and both extensions. If `CREATE EXTENSION vector` fails, external PG is off the table — keep embedded pg0.

**F.8 — Retain batch mode** (would break any synchronous REST retain)
```bash
curl -sS -X POST "$H/v1/default/banks/probe/memories" -H "Content-Type: application/json" \
  -d '{"items":[{"content":"probe"}],"async":false}'
```
A `400` means `HINDSIGHT_API_RETAIN_BATCH_ENABLED=true` and **all** retains must set `"async": true`.

**F.9 — Auth boundary sanity** (confirms the GET probe quirk and that POST is actually gated)
```bash
curl -isS "$H/mcp" -H "Authorization: Bearer WRONG"          # expect 200 {}  (probe, pre-auth)
curl -isS -X POST "$H/mcp" -H "Authorization: Bearer WRONG" \
  -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
                                                              # expect 401 {"error":"Invalid authentication token"}
curl -isS "$H/v1/default/banks"                               # expect 200 + full bank list unless ApiKeyTenantExtension is on
```
The third call is the isolation canary from D#2 — if it returns data without auth, 8888 must never be publicly routable.

**F.10 — RAM/CPU figures are docs-only.** After boot, read the Railway metrics pane: expect ~0.8–1.0 GB idle RSS with the full image, CP disabled. Size the plan from the measurement, not the table.

**F.11 — Ghost env var.** `HINDSIGHT_API_MCP_LOCAL_BANK_ID` appears in hindsight-docs v0.8 but exists in **zero** source files at v0.8.5. Ignore it. The real var is `HINDSIGHT_MCP_BANK_ID` (no `_API_`). Likewise the docs' MCP tool counts ("27 tools", "30 tools") and the claim that bank-filtered tools "still appear in the tools list" are both wrong for v0.8.5.

**F.12 — Minimum-viable env set composition (E.4) is a recommendation, not a source artifact.** Every var name in it is individually source-verified; the *combination* is untested. Validate by booting and confirming `GET /health` → 200 plus a successful `sync_retain` → `recall` round trip on a throwaway bank.