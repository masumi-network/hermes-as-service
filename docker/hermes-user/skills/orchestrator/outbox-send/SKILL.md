---
name: outbox-send
description: Send a proactive message to the user (outside the current chat turn). Use for long-running task completions, follow-ups the user asked you to surface later, or anything the user should see now even though they didn't just ask. The message lands in their chat thread on next page load.
version: 1.0.0
---

# Outbox: send the user a proactive message

You have a one-way push channel into the user's chat. Use it when:

- A long-running task you kicked off in the background has finished and the
  user is waiting on the result.
- The user asked you to "tell me when X happens" or "follow up about Y" and
  X / Y is now true.
- You've decided the user needs to know something time-sensitive and they
  are not currently in the chat.

You should NOT use it for:

- Responses to the user's current message (those go through the normal chat
  response — just reply).
- Routine commentary, "FYI" filler, or anything the user wouldn't
  immediately act on.
- Spam: rate yourself, multiple messages in quick succession will feel like
  pestering.

## How to push

Your sandbox shell does NOT inherit the gateway's env vars, so source
`/opt/data/.env` first — without it the bearer is empty and the call fails
with "missing bearer".

```bash
set -a; . /opt/data/.env; set +a
curl -sS -X POST \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "<plain text or markdown the user should see>",
    "kind": "task_result"
  }' \
  "$OPENROUTER_BASE_URL/outbox"
```

**Inspect the response.** Success returns HTTP 201 with `{"id":"msg_...","createdAt":"..."}`.
Anything else is a failure — tell the user, don't claim success.

`kind` is one of:
- `text` (default) — generic message
- `task_result` — completion of a long-running task
- `reminder` — a follow-up you promised earlier

## Constraints

- Each message ≤ 32 KB. Longer content will be auto-truncated; chunk it
  yourself if you want to preserve full text.
- The user's outbox holds at most 1000 unacknowledged messages; oldest get
  dropped if you over-produce. Be deliberate.
- Scheduled-task results are auto-pushed by the orchestrator — you do NOT
  need to push them again yourself.

## Tone

Write outbox messages as if they're the next thing the user will read when
they open the app. Lead with the point. No "Hi again!" or "I wanted to let
you know that…". Just the fact + the action it implies.
