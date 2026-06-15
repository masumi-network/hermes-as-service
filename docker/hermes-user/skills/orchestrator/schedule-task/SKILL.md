---
name: schedule-task
description: Mirror a cronjob into the orchestrator so it shows up in the user's Sokosumi settings panel. Your built-in 'cronjob' tool is what actually schedules work — use it first. Then, every time you create/change/delete a cronjob (anything time-based: "every morning", "every minute", "in 1 hour", "every day at X", "schedule X", "remind me", "recurring"), invoke this skill via the shell tool to keep the panel in sync. Also use it to list/cancel previously registered rows. Never claim a row exists without POSTing to the API and reading back the response.
version: 3.0.0
---

# Schedule Task (orchestrator visibility mirror)

Your built-in `cronjob` tool is the real scheduler — it fires the prompt
and its output reaches the user via the outbox bridge. This skill is the
companion step: it registers a mirror row with the orchestrator so the
schedule also appears in the user's Sokosumi settings panel. Create the
cronjob first, then register it here.

## MANDATORY behavior on every scheduling turn

1. **Create (or change/delete) the cronjob with your built-in tool first.**
   That is what actually runs.
2. **Then sync the orchestrator.** List current rows (`GET /schedules`)
   so you know what's already mirrored — your conversation context may
   contain prior turns claiming rows that don't exist. The API is the
   source of truth for the panel.
3. **Create / modify / delete the matching row** so the panel reflects
   reality.
4. **Quote the API response verbatim** (at least the id and next_run_at)
   so the user can verify it landed.
5. **If the API returns anything other than 201/200 success, report the
   actual error.** The cronjob still runs — this row is visibility only —
   but do NOT claim it showed up in the panel when it didn't.

## When to use

- Right after you create a cronjob for ANY time-based task: "every X do Y",
  "every minute", "remind me to Z each morning", "weekly digest of N".
- User asks to see, edit, pause, or cancel existing schedules.
- User asks "did you schedule that?" or "what's running?" — list first.

## How to register the mirror row

Use your shell tool to POST to your own scheduling endpoint. Your sandbox
shell does NOT inherit the gateway's env vars, so you MUST source
`/opt/data/.env` first. The pattern below is the only one that works:

```bash
set -a; . /opt/data/.env; set +a
curl -sS -X POST \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<short slug, e.g. arxiv-morning>",
    "prompt": "<the full prompt you should run when the schedule fires>",
    "cron_expr": "<5-field cron, UTC by default>",
    "timezone": "<IANA tz, e.g. Europe/Berlin>"
  }' \
  "$OPENROUTER_BASE_URL/schedules"
```

**You MUST inspect the response.** A successful create returns HTTP 201 with
JSON like `{"id":"...","next_run_at":"..."}`. If you get `{"error":{"message":"..."}}`
or anything other than the success shape, the row was NOT created and
you MUST tell the user the actual error verbatim — do not claim success.

## Common cron expressions

| Frequency | Expression |
|---|---|
| Every day at 09:00 | `0 9 * * *` |
| Every weekday at 08:30 | `30 8 * * 1-5` |
| Every Monday at 10:00 | `0 10 * * 1` |
| Every hour on the hour | `0 * * * *` |
| Every 15 minutes | `*/15 * * * *` |
| First of the month at midnight | `0 0 1 * *` |

## How to list / cancel rows

Always source the env file first (one-time per shell invocation):

```bash
set -a; . /opt/data/.env; set +a

# list
curl -sS -H "Authorization: Bearer $OPENROUTER_API_KEY" "$OPENROUTER_BASE_URL/schedules"

# delete
curl -sS -X DELETE -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  "$OPENROUTER_BASE_URL/schedules/<schedule_id>"

# disable (PATCH enabled=false) — keeps it for later
curl -sS -X PATCH -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  "$OPENROUTER_BASE_URL/schedules/<schedule_id>"
```

## Rules

- ALWAYS confirm the schedule details (what + when + timezone) with the
  user in plain English before registering. Show them the cron expression
  you plan to use.
- Pick a clear, short `name` — it's how the user will refer to the task
  later. Use the SAME name for the cronjob and the mirror row.
- The `prompt` field is what YOU will receive when the schedule fires.
  Write it as a direct instruction to yourself, with all the context you'll
  need (the original user won't be in the loop at fire time).
- If the user specifies a local time, ask for their timezone OR use a
  sensible default and tell them what you chose so they can correct it.
- On delete: remove BOTH the cronjob (built-in tool) AND the orchestrator
  row, so the panel doesn't show ghosts.
