# Work Package: Read-only Integrations + Reconnect Polish

**Audience:** Sokosumi dev + Hermes Orchestrator (Patrick / Claude).
**Why:** Most users will balk at "Hermes can send mail as me." We want read-only as the default consent path. Plus fix a latent bug where rapid reconnects leave integrations stuck in `pending`, and add a UI signal during the ~30-60s machine restart on integration changes.

---

## Goals

1. **Default to read-only** for Gmail / Outlook / Outlook Calendar / Google Calendar. Opt-in to full access via an explicit second button with a clear caveat.
2. **Defense in depth:** even if scope enforcement fails or is bypassed, our proxy filters the tool catalog so write-tools never reach Hermes when the integration is marked read-only.
3. **Fix the pending-stuck bug:** rapid back-to-back connect/disconnect can leave a later integration in `status: "pending"` after its restart completes. Reconcile.
4. **UI signal during restart:** chat is unresponsive for 30-60s while Fly does its `replacing` transition. User should see "Hermes is applying your change…" not silence.

---

## Sokosumi side

### S1. Scope split in the connect button
Per provider with read/write split (gmail / outlook / google_calendar / outlook_calendar):

- **Primary button: "Connect Gmail (read-only)"** — the default. Big, friendly, no scary copy.
- **Secondary action: "Connect Gmail (full access — read + send)"** — smaller, with this caveat shown: *"Hermes can read your mail, draft replies, and send on your behalf. Only enable if you want it acting in your inbox."*

When constructing the Composio OAuth URL, pass the scope choice:

- **Gmail:** read-only = `https://www.googleapis.com/auth/gmail.readonly`. Full = `https://www.googleapis.com/auth/gmail.modify` (or the broader `https://mail.google.com/`).
- **Google Calendar:** read-only = `https://www.googleapis.com/auth/calendar.readonly`. Full = `https://www.googleapis.com/auth/calendar`.
- **Outlook (Microsoft Graph):** read-only = `Mail.Read`. Full = `Mail.ReadWrite Mail.Send`.
- **Outlook Calendar:** read-only = `Calendars.Read`. Full = `Calendars.ReadWrite`.

Composio supports per-connection scope selection. Check their docs for the exact param name on the connection-create call.

### S2. Include `mode` in POST `/v1/instances/:userId/integrations`
New optional field in the request body:

```json
{
  "provider": "gmail",
  "mcpUrl": "https://backend.composio.dev/v3/mcp/<server-uuid>?user_id=<user-id>",
  "mode": "read"   // "read" | "write"  — defaults to "read" if omitted
}
```

Orchestrator stores it; the value drives our tool-list filter (see O1).

### S3. UI: show restart state during integration changes
When you POST `/v1/instances/:userId/integrations` or DELETE it on a live instance, the orchestrator triggers a Fly machine `replacing` transition that takes 30-60s. During that window, chat calls will timeout or 503.

Two options:

- **Lightweight:** show a toast/banner "Connecting Gmail… your chat will pause for a minute" and disable the chat input until the integration row reports `status: "connected"` (poll `GET /v1/instances/:userId/integrations` every 2s).
- **Richer:** the orchestrator will expose a `transitioning: true` field on `GET /v1/instances/:userId` (see O3) — gate the UI on that flag.

Either works. Whichever fits your patterns.

---

## Orchestrator side

### O1. Add `mode` to `Integration` + tool-list filtering in the MCP proxy

**Schema:**
```prisma
model Integration {
  ...
  /// "read" (default) or "write". Drives the proxy's tool-list filter:
  /// in "read" mode, write-tools like GMAIL_SEND_EMAIL are stripped from
  /// the catalog Hermes sees.
  mode  String  @default("read")
}
```

**Proxy behavior:** intercept the MCP `tools/list` JSON-RPC response, filter out write-tools, return the trimmed catalog to Hermes. Write-tool detection by name pattern per provider:

| Provider | Write-tool patterns (filter when mode=read) |
|---|---|
| `gmail` | `GMAIL_SEND_*`, `GMAIL_CREATE_*`, `GMAIL_UPDATE_*`, `GMAIL_DELETE_*`, `GMAIL_REPLY_*`, `GMAIL_FORWARD_*`, `GMAIL_MOVE_*` |
| `outlook` | `OUTLOOK_SEND_*`, `OUTLOOK_CREATE_*`, `OUTLOOK_REPLY_*`, `OUTLOOK_DELETE_*`, `OUTLOOK_MOVE_*`, `OUTLOOK_FORWARD_*` |
| `google_calendar` | `GOOGLECALENDAR_CREATE_*`, `GOOGLECALENDAR_UPDATE_*`, `GOOGLECALENDAR_DELETE_*`, `GOOGLECALENDAR_PATCH_*` |
| `outlook_calendar` | `OUTLOOKCALENDAR_CREATE_*`, `OUTLOOKCALENDAR_UPDATE_*`, `OUTLOOKCALENDAR_DELETE_*` |

Be conservative: when in doubt, strip. The defense is in addition to (not a replacement for) the OAuth scope.

### O2. Reconcile pending after each integration apply
After `addIntegration` / `removeIntegration` runs `patchMachineEnv` + `waitForState`, call `markPendingIntegrationsConnected(userId)`. The machine boots with all pending integrations baked in via `MCP_SERVERS_JSON`, so flipping their status is correct.

This closes the bug where back-to-back connects leave the second one stuck on `pending`.

### O3. Expose machine-transitioning state on `GET /v1/instances/:userId`
Add a boolean `transitioning` field to the response, true when any of:
- Any integration's `status == "connecting"`
- The Fly machine state (cached briefly, or fetched live) is in `replacing` / `starting` / `stopping`

Lets Sokosumi gate UI cleanly:
```ts
if (instance.transitioning) showRestartBanner();
```

### O4. (Stretch) Don't restart on no-op patches
If `addIntegration` is called with the exact same URL we already have stored, skip the patchMachineEnv + restart entirely. Sokosumi-side retries shouldn't cause repeated restarts.

---

## Out of scope (later)

- **Multi-account per provider** (personal Gmail + work Gmail simultaneously). Composio supports it; we don't yet. Schema would drop `@@unique([userId, provider])` and add a `label` field. ~1 day. Defer until users actually ask.
- **More integrations** (Slack, Linear, GitHub, Notion, HubSpot, X/Twitter). Same Composio + orchestrator pattern, ~30 min per provider on our side, more work on the Sokosumi UI. Defer to v2 batch.
- **Soft restart signal** (Hermes acknowledging "I just connected Gmail" via a system message after restart). Nice-to-have, not blocking.

---

## Acceptance criteria

| # | Check | Owner |
|---|---|---|
| 1 | Sokosumi onboarding shows two buttons per sensitive provider ("read-only" default + "full access") | Sokosumi |
| 2 | `POST /v1/instances/:userId/integrations` accepts `mode: "read" \| "write"` (defaults to `"read"`) | Both |
| 3 | When `mode=read`, Hermes' tool catalog for that integration contains only read-tools (verified via a tools/list probe through the proxy) | Orchestrator |
| 4 | Rapid back-to-back connects (Gmail then Outlook within 5s) both end up in `status: "connected"` | Orchestrator |
| 5 | `GET /v1/instances/:userId` returns `transitioning: true` during a live integration change | Orchestrator |
| 6 | Sokosumi UI shows a "Hermes is applying your change" banner when `transitioning: true` | Sokosumi |

---

## Order of execution

1. **Orchestrator first (O1 + O2 + O3).** Doesn't block Sokosumi — the `mode` field defaults to `"read"` so existing Sokosumi behavior gets the safer default automatically.
2. **Sokosumi UI** (S1 + S3) once O1/O3 are deployed.
3. Optional: O4 + multi-account once the above is stable.
