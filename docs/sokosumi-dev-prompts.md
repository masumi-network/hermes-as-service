# Prompts for Sokosumi Dev

Ready to paste. Both originate from the 2026-07-24 Hermes agent-log analysis.

---

## 1. Allow resuming INPUT_REQUIRED tasks once their input is provided

```text
Problem: tasks get permanently stuck in INPUT_REQUIRED. When a coworker asks
a question on a task and the answer arrives as a task comment (from the user
or their Hermes assistant), there is no API path to move the task forward:
POST /v1/tasks/{id}/events with status READY (or COMPLETED) is rejected for
tasks in INPUT_REQUIRED — only the assigned coworker can resume, and if it
doesn't re-poll the thread the task sits blocked forever. We measured five
tasks on one board stuck this way, all with approved plans in their comments.

Ask: give the task owner (session user or orchestrator+context) a legal way
to un-block a task whose input has been answered. Any of these shapes works
for us, in order of preference:

1. A "resume" / "input-provided" event: POST /v1/tasks/{id}/events with
   { type: "resume", comment? } that flips INPUT_REQUIRED → READY and
   notifies the assigned coworker to re-read the thread.
2. Allow status: READY on /tasks/{id}/events for INPUT_REQUIRED tasks when
   the actor is the task owner (orchestrator+ctx included).
3. At minimum: have coworkers subscribe to new comments on their
   INPUT_REQUIRED tasks so an answering comment wakes them without a status
   transition.

Also worth checking: rate-limiting counts these rejected transitions against
the caller (we hit a 429 after 3 rejections); rejections this cheap probably
shouldn't burn quota.
```

---

## 2. Token-cap the replayed chat context sent to Hermes

```text
Problem: apps/core builds the Hermes conversation by replaying the last 100
hermesMessage rows verbatim (apps/core/src/routes/v1/hermes/index.ts,
~lines 1572-1596 buffered / 1844-1868 streaming). The cap is a MESSAGE count,
not a size: one long assistant reply (e.g. a pasted 14-page report) then
rides along in every subsequent turn. We observed single turns costing
300-600k tokens and 2-4 minutes of latency almost entirely from replayed
bulk.

The orchestrator now trims non-final replayed messages to ~8k chars at the
proxy as a stopgap, but the right fix is at the source where the array is
built:

Ask:
1. When assembling `conversation`, cap each replayed message (say 8k chars,
   append a "[trimmed]" marker) and/or cap the total replay budget (say
   150k chars) dropping oldest first.
2. Never trim the final (current) user message.
3. Keep the existing kind !== "confirmation_card" filter as is.
```
