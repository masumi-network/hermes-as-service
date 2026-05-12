// The schedule-task skill. Written by the orchestrator into
// /opt/data/skills/orchestrator/schedule-task/SKILL.md so Hermes knows how
// to register recurring tasks via the proxy endpoint.
//
// Hermes' OpenRouter base URL is set to the orchestrator's LLM proxy
// (https://.../v1/llm/<instanceId>), and OPENROUTER_API_KEY is the
// per-instance bearer. Both are available as env vars in the sprite, so
// the agent can curl from its shell tool.

export const SCHEDULE_SKILL_PATH = '/opt/data/skills/orchestrator/schedule-task/SKILL.md';

export const SCHEDULE_SKILL_MD = `---
name: schedule-task
description: Schedule a recurring or one-time task with the orchestrator. THIS IS YOUR ONLY WAY TO SCHEDULE ANYTHING. You do NOT have a built-in cron tool. Every time the user mentions anything time-based ("every morning", "every minute", "in 1 hour", "next Friday", "every day at X", "schedule X", "remind me", "recurring", "interval"), you MUST invoke this skill via the shell tool. Never claim a schedule exists without first POSTing to the API and reading back the response.
version: 2.0.0
---

# Schedule Task

You can register scheduled tasks with the orchestrator. When the schedule
fires, the orchestrator sends the prompt back to you as a normal chat
message, captures your response, and shows it in the user's chat history
tagged as scheduled.

## MANDATORY behavior on every scheduling turn

1. **Always start by listing current schedules.** Run \`GET /schedules\`
   first. This is non-negotiable — your conversation context may contain
   prior turns where you claimed to schedule things that don't actually
   exist. The API is the only source of truth.
2. **Tell the user what's actually scheduled** based on the API response,
   not your memory.
3. **Then create / modify / delete** as needed via the API.
4. **Quote the API response verbatim** (the JSON or at least the id and
   next_run_at) in your reply so the user can verify it landed.
5. **If the API returns anything other than 201/200 success, you MUST
   report the actual error.** Do NOT claim success when you got an error.

## When to use

- User asks for ANY time-based task: "every X do Y", "every minute", "in
  1 minute", "remind me to Z each morning", "weekly digest of N",
  "summarize my Inbox every Monday".
- User asks to see, edit, pause, or cancel existing schedules.
- User asks "did you schedule that?" or "what's running?" — list first.

## How to register a schedule

Use your shell tool to POST to your own scheduling endpoint. Your sandbox
shell does NOT inherit the gateway's env vars, so you MUST source
\`/opt/data/.env\` first. The pattern below is the only one that works:

\`\`\`bash
set -a; . /opt/data/.env; set +a
curl -sS -X POST \\
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "<short slug, e.g. arxiv-morning>",
    "prompt": "<the full prompt you should run when the schedule fires>",
    "cron_expr": "<5-field cron, UTC by default>",
    "timezone": "<IANA tz, e.g. Europe/Berlin>"
  }' \\
  "$OPENROUTER_BASE_URL/schedules"
\`\`\`

**You MUST inspect the response.** A successful create returns HTTP 201 with
JSON like \`{"id":"...","next_run_at":"..."}\`. If you get \`{"error":{"message":"..."}}\`
or anything other than the success shape, the schedule was NOT created and
you MUST tell the user the actual error verbatim — do not claim success.

## Common cron expressions

| Frequency | Expression |
|---|---|
| Every day at 09:00 | \`0 9 * * *\` |
| Every weekday at 08:30 | \`30 8 * * 1-5\` |
| Every Monday at 10:00 | \`0 10 * * 1\` |
| Every hour on the hour | \`0 * * * *\` |
| Every 15 minutes | \`*/15 * * * *\` |
| First of the month at midnight | \`0 0 1 * *\` |

## How to list / cancel schedules

Always source the env file first (one-time per shell invocation):

\`\`\`bash
set -a; . /opt/data/.env; set +a

# list
curl -sS -H "Authorization: Bearer $OPENROUTER_API_KEY" "$OPENROUTER_BASE_URL/schedules"

# delete
curl -sS -X DELETE -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  "$OPENROUTER_BASE_URL/schedules/<schedule_id>"

# disable (PATCH enabled=false) — keeps it for later
curl -sS -X PATCH -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"enabled": false}' \\
  "$OPENROUTER_BASE_URL/schedules/<schedule_id>"
\`\`\`

## Rules

- ALWAYS confirm the schedule details (what + when + timezone) with the
  user in plain English before registering. Show them the cron expression
  you plan to use.
- Pick a clear, short \`name\` — it's how the user will refer to the task
  later.
- The \`prompt\` field is what YOU will receive when the schedule fires.
  Write it as a direct instruction to yourself, with all the context you'll
  need (the original user won't be in the loop at fire time).
- If the user specifies a local time, ask for their timezone OR use a
  sensible default and tell them what you chose so they can correct it.
`;
