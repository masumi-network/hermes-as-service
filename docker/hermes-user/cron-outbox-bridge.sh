#!/usr/bin/env bash
# Hermes post_llm_call hook — bridges native-cron output into the
# orchestrator's outbox so Sokosumi sees scheduled-task results.
#
# Hermes pipes a JSON payload to stdin shaped like:
#   { "hook_event_name": "post_llm_call",
#     "tool_name": null,
#     "tool_input": null,
#     "session_id": "...",
#     "cwd": "...",
#     "extra": { "user_message": "...", "assistant_response": "...",
#                "model": "...", "platform": "cron" | "cli" | "gateway" | ... } }
#
# We only push when platform == "cron". User chat turns are captured by the
# orchestrator's chat proxy already, so pushing them here would double-count.
#
# We post to:
#   POST $ORCHESTRATOR_BASE/v1/llm/$INSTANCE_ID/outbox
#   Authorization: Bearer $ORCHESTRATOR_OUTBOX_TOKEN (same per-instance bearer
#     used for the LLM proxy; the outbox endpoint shares that auth)
#   body: { "content": "<assistant_response>", "kind": "task_result" }

set -euo pipefail

payload="$(cat -)"

platform="$(printf '%s' "$payload" | jq -r '.extra.platform // ""')"
if [ "$platform" != "cron" ]; then
  # Silent no-op for non-cron turns. printf "{}" so Hermes parses cleanly.
  printf '{}\n'
  exit 0
fi

response="$(printf '%s' "$payload" | jq -r '.extra.assistant_response // ""')"
if [ -z "$response" ]; then
  printf '{}\n'
  exit 0
fi

# Drop placeholder replies the LLM emits when a cron prompt told it to act
# silently. Without this, sentinels like "[SILENT]" leak into the user's
# chat via the outbox.
case "$(printf '%s' "$response" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
  ""|"[silent]"|"[noreply]"|"[noop]"|"[none]"|"ok"|"done")
    printf '{}\n'
    exit 0
    ;;
esac

# Read the originating cron job's name (when present) so the orchestrator
# can tag the outbox row with the right `kind`. Hermes injects the job name
# into the extra payload as `cron_job_name`. Fallbacks: default to
# "task_result" for backward compat.
job_name="$(printf '%s' "$payload" | jq -r '.extra.cron_job_name // ""')"
case "$job_name" in
  research-intro)     kind="research_intro" ;;
  daily-suggestions)  kind="daily_suggestions" ;;
  daily-brief)        kind="daily_brief" ;;
  *)                  kind="task_result" ;;
esac

# These come from Fly Machine env vars set by the orchestrator at create time.
: "${ORCHESTRATOR_BASE:?ORCHESTRATOR_BASE not set}"
: "${INSTANCE_ID:?INSTANCE_ID not set}"
: "${ORCHESTRATOR_OUTBOX_TOKEN:?ORCHESTRATOR_OUTBOX_TOKEN not set}"

# POST to the orchestrator. Use jq -nR to safely encode the multi-line
# assistant response as a JSON string.
body="$(jq -nR --arg c "$response" --arg k "$kind" '{content: $c, kind: $k}')"

curl -sS -m 15 \
  -X POST \
  -H "Authorization: Bearer $ORCHESTRATOR_OUTBOX_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$body" \
  "$ORCHESTRATOR_BASE/v1/llm/$INSTANCE_ID/outbox" \
  >/dev/null 2>&1 || true   # best-effort; hook never blocks the agent

printf '{}\n'
