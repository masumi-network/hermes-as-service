# Sokosumi ↔ Hermes Orchestrator: End-to-End Curl Walkthrough

The full Onboarding v2 flow as raw HTTP. Copy-paste, run, watch it work.
Companion to `sokosumi-onboarding-integration-brief.md` (the spec); this
file is the "how do I actually exercise it" handbook.

---

## 0. Setup

```bash
# Base URL of the orchestrator (production)
export BASE="https://orchestrator-production-35d4.up.railway.app"

# Bearer token for the /v1/* API. Get this from Patrick (or from Railway →
# orchestrator service → variables → ORCHESTRATOR_API_TOKEN).
export TOKEN="<ask Patrick — DO NOT commit>"

# Test user ID (provisioned by Patrick for you)
export USER_ID="019e17e9-9092-75fb-a36a-fc6587f2eb89"

# Shorthand
H_AUTH='-H "Authorization: Bearer '$TOKEN'"'
```

Verify connectivity (no auth needed on `/health`):

```bash
curl -s "$BASE/health"
# {"ok":true}
```

---

## 1. Create the instance

```bash
curl -s -X POST "$BASE/v1/instances" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "'"$USER_ID"'",
    "name": "Test User",
    "email": "test+sokosumi@example.com"
  }'
```

Response (HTTP 202):

```json
{
  "instanceId": "<uuid>",
  "status": "provisioning",
  "onboardedAt": null
}
```

Save `instanceId` for later (you mostly drive everything off `userId` so
this is optional):

```bash
export INSTANCE_ID=$(curl -s -X POST "$BASE/v1/instances" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"'"$USER_ID"'","name":"Test User","email":"test+sokosumi@example.com"}' \
  | jq -r '.instanceId')
echo "instanceId=$INSTANCE_ID"
```

> **Idempotency:** Calling POST `/v1/instances` again for the same `userId`
> returns the existing instance without creating a new Fly app. Safe to call
> on every session-open.

---

## 2. Poll until `infrastructure_ready`

```bash
while :; do
  STATUS=$(curl -s "$BASE/v1/instances/$USER_ID" \
    -H "Authorization: Bearer $TOKEN" | jq -r '.status')
  echo "$(date +%H:%M:%S) status=$STATUS"
  case "$STATUS" in
    infrastructure_ready|ready|error) break ;;
  esac
  sleep 3
done
```

Expected timeline: ~60–90 seconds for first provision (Fly app create + IP
allocation + machine boot). Subsequent provisions for the same userId after
a destroy are slightly faster.

Once `infrastructure_ready`:

```bash
curl -s "$BASE/v1/instances/$USER_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

```json
{
  "instanceId": "<uuid>",
  "userId": "019e17e9-9092-75fb-a36a-fc6587f2eb89",
  "status": "infrastructure_ready",
  "endpointUrl": "https://hermes-019e17e9-9092-75fb-a3-xxxxxx.fly.dev",
  "lastActivityAt": "...",
  "onboardedAt": null,
  "integrations": []
}
```

**This is the gate where your UI shows the connect buttons + form.**

---

## 3. Connect an integration (Gmail via Composio)

For each integration the user connects in your UI, after Composio finishes
OAuth and gives you back a per-user MCP URL + token:

```bash
curl -s -X POST "$BASE/v1/instances/$USER_ID/integrations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gmail",
    "mcpUrl": "https://backend.composio.dev/v3/mcp/<server-uuid>?user_id='"$USER_ID"'"
  }'
```

Response (HTTP 202):

```json
{
  "provider": "gmail",
  "status": "connecting",
  "connectedAt": null,
  "lastError": null
}
```

Valid `provider` values:

| Value | Service |
|---|---|
| `gmail` | Google Mail |
| `google_calendar` | Google Calendar |
| `outlook` | Microsoft Outlook (Mail) |
| `outlook_calendar` | Microsoft Outlook Calendar |

**Don't pass `mcpToken` for Composio URLs.** The orchestrator holds the org-wide `COMPOSIO_API_KEY` server-side and injects `x-api-key: <key>` as a header on every MCP HTTP call. Per-user scoping is via the `?user_id=` query param in the URL. Outlook & Outlook Calendar share one Composio toolkit — POST twice with the same `mcpUrl` (once for `outlook`, once for `outlook_calendar`) and we'll track them as two providers.

Poll until `connected`:

```bash
while :; do
  S=$(curl -s "$BASE/v1/instances/$USER_ID/integrations" \
    -H "Authorization: Bearer $TOKEN" \
    | jq -r '.integrations[] | select(.provider=="gmail") | .status')
  echo "gmail status=$S"
  case "$S" in connected|failed) break ;; esac
  sleep 2
done
```

Typical time: 8–15 seconds (we patch the Fly machine env + restart it so
Hermes loads the new MCP at boot).

If `failed`, check `lastError`:

```bash
curl -s "$BASE/v1/instances/$USER_ID/integrations" \
  -H "Authorization: Bearer $TOKEN" | jq '.integrations[] | select(.provider=="gmail")'
```

Repeat for `google_calendar`, `outlook`, `outlook_calendar` as the user
connects them.

---

## 4. User clicks "Let's go" → fire onboarding

```bash
curl -s -X POST "$BASE/v1/instances/$USER_ID/onboard" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test+sokosumi@example.com",
    "researchDepth": "deep"
  }'
```

Response (HTTP 202):

```json
{ "status": "onboarding" }
```

`researchDepth`:
- `"deep"` (default) — uses connected MCPs for inbox/calendar scan + web research
- `"light"` — web research only, skip inbox scan even if MCPs are connected

If the user clicks "Skip for now" (no integrations connected), still call
`/onboard` — we'll run web-only research automatically.

---

## 5. Poll onboarding progress (drive the progress UI)

```bash
while :; do
  curl -s "$BASE/v1/instances/$USER_ID/onboarding" \
    -H "Authorization: Bearer $TOKEN" | jq -c '{status, etaSeconds, steps: [.steps[] | {id, status}]}'
  S=$(curl -s "$BASE/v1/instances/$USER_ID" -H "Authorization: Bearer $TOKEN" | jq -r '.status')
  [ "$S" = "ready" ] && break
  sleep 1
done
```

Response shape:

```json
{
  "status": "onboarding",
  "onboardedAt": null,
  "steps": [
    { "id": "memory",       "label": "Saving your details",          "status": "done",    "startedAt": "...", "finishedAt": "..." },
    { "id": "inbox_scan",   "label": "Reading your inbox",           "status": "done",    "startedAt": "...", "finishedAt": "..." },
    { "id": "web_research", "label": "Checking your public profile", "status": "running", "startedAt": "..." },
    { "id": "intro_draft",  "label": "Drafting your intro",          "status": "pending" }
  ],
  "etaSeconds": 25
}
```

Render `steps[]` directly — labels are orchestrator-controlled so we can
add/rename steps without a Sokosumi deploy.

Typical full onboarding time: **30–90s** (most variance is in the inbox scan).

---

## 6. `status === "ready"` → fetch the opening message + open the chat

```bash
curl -s "$BASE/v1/instances/$USER_ID/inbox" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Response:

```json
{
  "messages": [
    {
      "id": "<uuid>",
      "content": "Hey Test,\n\nSaw on LinkedIn you're …",
      "kind": "research_intro",
      "createdAt": "..."
    }
  ]
}
```

Render the `research_intro` message as Hermes' first chat turn. Then ack
it so we don't redeliver:

```bash
curl -s -X POST "$BASE/v1/instances/$USER_ID/inbox/ack" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "messageIds": ["<id-from-above>"] }'
# 204 No Content
```

From here, the user is in the chat. Use your existing chat-proxy path —
nothing in step 6+ changes from today's flow.

---

## 7. Returning user (session 2+)

When the user opens Hermes again after a previous session was destroyed:

```bash
# Step 1: re-create. Same call as before, idempotent.
curl -s -X POST "$BASE/v1/instances" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"'"$USER_ID"'"}'

# Step 2: poll status.
# For a returning user, status goes provisioning → ready directly.
# infrastructure_ready and onboarding are SKIPPED.
while :; do
  STATUS=$(curl -s "$BASE/v1/instances/$USER_ID" -H "Authorization: Bearer $TOKEN" | jq -r '.status')
  echo "status=$STATUS"
  [ "$STATUS" = "ready" ] && break
  sleep 3
done

# Step 3: GET the instance — note onboardedAt is NOT null.
curl -s "$BASE/v1/instances/$USER_ID" -H "Authorization: Bearer $TOKEN" | jq '{status, onboardedAt, integrations: [.integrations[] | {provider, status}]}'
```

```json
{
  "status": "ready",
  "onboardedAt": "2026-05-19T08:42:11.000Z",
  "integrations": [
    { "provider": "gmail", "status": "connected" },
    { "provider": "google_calendar", "status": "connected" }
  ]
}
```

**UI rule:** if `onboardedAt != null`, skip the onboarding screen entirely
and open the chat as soon as `status === "ready"`. The integrations have
already been re-injected into the new Fly machine — the user's Gmail/Outlook
just works on session 2.

A short "welcome back" message lands in the inbox (also `kind:"welcome"`).
Fetch via `/v1/instances/$USER_ID/inbox` same as step 6.

---

## 8. Remove an integration (user clicks "Disconnect Gmail")

```bash
curl -s -X DELETE "$BASE/v1/instances/$USER_ID/integrations/gmail" \
  -H "Authorization: Bearer $TOKEN"
# 204 No Content
```

We patch the Fly env (remove the MCP entry) and restart the machine.

---

## 9. Destroy at session-end

```bash
curl -s -X DELETE "$BASE/v1/instances/$USER_ID" \
  -H "Authorization: Bearer $TOKEN"
# 204 No Content
```

This soft-deletes: Fly app/machine/volume gone, but the user's profile
(`name`, `email`, `onboardedAt`, all `integrations`) stays in our DB. On
the next `POST /v1/instances` for the same userId, we replay everything
into a fresh Fly app and skip the onboarding screen.

---

## 10. Errors you might see

| Status | Code | Meaning | Action |
|---|---|---|---|
| 404 | `instance_not_found` | No row for this userId | Call POST /v1/instances first |
| 409 | `conflict` | e.g. trying to `/onboard` from status `provisioning` | Wait for `infrastructure_ready` and retry |
| 400 | `invalid_body` / `unsupported_provider` | Validation failed | Check `title` field for which field broke |
| 401 | `unauthorized` | Bearer token wrong/missing | Check `$TOKEN` |
| 502 | `upstream_error` | Fly API failure | Almost always transient; the row goes to `status=error` with `errorMessage` populated — surface the error to the user, retry |

All errors follow [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807):

```json
{
  "type": "https://hermes-as-service/errors/<code>",
  "title": "Human-readable message",
  "status": 409,
  "code": "conflict",
  "userId": "..."
}
```

---

## 11. Full happy-path script (copy-pasteable)

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://orchestrator-production-35d4.up.railway.app"
TOKEN="$ORCHESTRATOR_TOKEN"  # export beforehand
USER_ID="019e17e9-9092-75fb-a36a-fc6587f2eb89"
GMAIL_MCP_URL="https://backend.composio.dev/v3/mcp/<server-uuid>?user_id=$USER_ID"

curl_v1() { curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }

echo "== create =="
curl_v1 -X POST "$BASE/v1/instances" -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"name\":\"Test\",\"email\":\"test@example.com\"}" | jq -c

echo "== wait for infrastructure_ready =="
while :; do
  s=$(curl_v1 "$BASE/v1/instances/$USER_ID" | jq -r '.status')
  echo "  status=$s"
  [ "$s" = "infrastructure_ready" ] && break
  [ "$s" = "ready" ] && break    # returning user
  sleep 3
done

# If returning user, skip onboarding bits.
ONBOARDED_AT=$(curl_v1 "$BASE/v1/instances/$USER_ID" | jq -r '.onboardedAt')
if [ "$ONBOARDED_AT" = "null" ]; then
  echo "== connect gmail =="
  curl_v1 -X POST "$BASE/v1/instances/$USER_ID/integrations" \
    -H "Content-Type: application/json" \
    -d "{\"provider\":\"gmail\",\"mcpUrl\":\"$GMAIL_MCP_URL\"}" | jq -c

  echo "== wait for gmail connected =="
  while :; do
    s=$(curl_v1 "$BASE/v1/instances/$USER_ID/integrations" \
      | jq -r '.integrations[] | select(.provider=="gmail") | .status')
    echo "  gmail=$s"
    case "$s" in connected|failed) break ;; esac
    sleep 2
  done

  echo "== onboard (Let's go) =="
  curl_v1 -X POST "$BASE/v1/instances/$USER_ID/onboard" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"Test\",\"email\":\"test@example.com\",\"researchDepth\":\"deep\"}" | jq -c

  echo "== wait for ready =="
  while :; do
    s=$(curl_v1 "$BASE/v1/instances/$USER_ID" | jq -r '.status')
    eta=$(curl_v1 "$BASE/v1/instances/$USER_ID/onboarding" | jq -r '.etaSeconds')
    echo "  status=$s etaSeconds=$eta"
    [ "$s" = "ready" ] && break
    sleep 2
  done
fi

echo "== fetch opening message =="
curl_v1 "$BASE/v1/instances/$USER_ID/inbox" | jq '.messages[0]'
```

Save as `dogfood.sh`, `chmod +x`, run.

---

## Contact

Patrick (orchestrator team) — drop a line if anything is wrong or you want
new endpoints / response fields.
