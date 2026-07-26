/**
 * Sokosumi job state — the two taxonomies, and how to tell them apart.
 *
 * This module exists because conflating them caused a silent, total failure:
 * the input-responder sweep ran every 5 minutes for months and could never
 * fire, because it tested a lifecycle value against a field that only ever
 * holds payment values.
 *
 * ── Taxonomy 1: the `status` FIELD on a job (payment / settlement) ──────────
 * Verified against a full 647-job scan of a production workspace. The only
 * values that ever appear:
 *     completed · refund_resolved · failed · dispute_resolved · payment_pending
 * `awaiting_input` and `running` NEVER appear here. Testing `job.status` for
 * them is unsatisfiable.
 *
 * ── Taxonomy 2: the `?status=` QUERY PARAM (lifecycle history) ──────────────
 * A different dimension entirely, and NOT a current-state filter: it matches
 * jobs that have EVER entered that state. Evidence from the same workspace
 * (647 jobs total):
 *     ?status=INITIATED        → 647     ?status=RUNNING    → 75
 *     ?status=AWAITING_PAYMENT → 646     ?status=COMPLETED  → 554
 *     ?status=AWAITING_INPUT   → 7       ?status=FAILED     → 62
 * Those sum to 1991, and 5 of the 7 AWAITING_INPUT ids also appear under
 * COMPLETED. The API validates the value (422 on an unknown one, and on
 * lowercase), so the filter is real — it just answers "was it ever X?".
 *
 * ── Therefore ──────────────────────────────────────────────────────────────
 * `?status=AWAITING_INPUT` is the right way to NARROW the candidate set
 * (647 → 7, one page instead of seven), but it cannot decide whether a job is
 * awaiting input RIGHT NOW. Current state lives in the job's `events[]`.
 * The flow is: narrow with the query param → drop obviously-settled jobs for
 * free → confirm the survivors against their event log.
 */

/** Payment-status values seen on the `status` field. Lowercase, as returned. */
export const JOB_PAYMENT_STATUSES = [
  'completed',
  'refund_resolved',
  'failed',
  'dispute_resolved',
  'payment_pending',
] as const;

/** Lifecycle values accepted by the `?status=` query param. Uppercase — the
 *  API returns 422 for lowercase. */
export const JOB_LIFECYCLE_STATUSES = [
  'INITIATED',
  'AWAITING_PAYMENT',
  'AWAITING_INPUT',
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;

export type JobLifecycleStatus = (typeof JOB_LIFECYCLE_STATUSES)[number];

/** The subset of a job list item this module reasons about. */
export interface JobStateFields {
  status?: string;
  completedAt?: string | null;
  jobStatusSettled?: boolean;
}

/**
 * Free (no extra HTTP) rejection of jobs that CANNOT be awaiting input.
 *
 * A job that has settled on-chain or carries a completedAt is finished — the
 * `?status=AWAITING_INPUT` bucket is full of these, because they were awaiting
 * input at some point in the past. Returning false here is definitive;
 * returning true only means "worth confirming against the event log".
 */
export function couldBeAwaitingInput(job: JobStateFields): boolean {
  if (job.jobStatusSettled === true) return false;
  if (job.completedAt) return false;
  // A terminal payment status is equally definitive.
  const s = (job.status ?? '').toLowerCase();
  if (s === 'completed' || s === 'failed' || s === 'refund_resolved' || s === 'dispute_resolved') {
    return false;
  }
  return true;
}

/**
 * Pull the pending awaiting-input event out of a job's events[]. Sokosumi has
 * no dedicated input-request endpoint — the question and the event id you must
 * answer both live in the job's event log. Defensive: the exact event shape
 * isn't guaranteed, so we match any event whose type/status mentions INPUT and
 * return the newest. Exported for unit tests.
 */
export function extractAwaitingInputEvent(events: unknown): Record<string, unknown> | null {
  if (!Array.isArray(events)) return null;
  // A job's event log keeps BOTH the open request and its later resolution
  // (e.g. type INPUT_REQUEST followed by INPUT_PROVIDED / INPUT_RESPONSE). Match
  // the OPEN request only — never an already-answered event, whose id is useless
  // to provide_job_input and would re-submit against a resolved event.
  const RESOLVED = /PROVIDED|RESPONSE|RECEIVED|RESOLVED|ANSWERED|SUBMITTED|COMPLETED|FULFILLED/;
  const matches = events.filter((e): e is Record<string, unknown> => {
    if (!e || typeof e !== 'object') return false;
    const o = e as Record<string, unknown>;
    const t = String(o['type'] ?? '').toUpperCase();
    const s = String(o['status'] ?? '').toUpperCase();
    if (!(t.includes('INPUT') || s.includes('INPUT'))) return false;
    if (RESOLVED.test(t) || RESOLVED.test(s)) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) =>
    String(b['createdAt'] ?? b['updatedAt'] ?? '').localeCompare(
      String(a['createdAt'] ?? a['updatedAt'] ?? ''),
    ),
  );
  return matches[0] ?? null;
}

/** The timestamp to key an awaiting-input watermark on — when the REQUEST was
 *  raised, not when the job row was last touched. */
export function awaitingInputTimestamp(
  event: Record<string, unknown>,
  fallback: JobStateFields & { updatedAt?: string; createdAt?: string },
): string | null {
  const ts = event['createdAt'] ?? event['updatedAt'];
  if (typeof ts === 'string' && ts) return ts;
  return fallback.updatedAt ?? fallback.createdAt ?? null;
}
