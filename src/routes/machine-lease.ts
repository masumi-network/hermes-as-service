import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * One agent turn at a time per MACHINE, enforced in the database.
 *
 * A Hermes machine runs one agent loop well. Two concurrent turns interleave
 * their tool calls and starve each other's session — and the user gets
 * nothing coherent from either.
 *
 * ── The production incident this exists for (2026-07-26) ───────────────────
 *   23:05:08  a sweep starts a cron turn                → req 87e3a981
 *   23:08:33  the orchestrator REDEPLOYS mid-fetch
 *             · runCronAgentTurn dies before writing its assistant row, so
 *               that turn leaves a user message with no reply, forever
 *             · the machine never noticed and keeps looping
 *   23:10:01  the fresh process, whose in-memory guards start EMPTY, fires
 *             another sweep turn                        → req 6fefecf1
 *   → two live loops on one machine. Prompt tokens climbed in two interleaved
 *     series (42k→84k alongside 76k→117k) and the user's own chat turn got a
 *     two-second stub.
 *
 * The chat proxy already had an in-memory guard, but it covered only the chat
 * path and could not survive the restart that caused this. Everything that
 * drives a turn goes through here now: the chat proxy, every sweep, approval
 * continuation, native-prompt dispatch.
 *
 * ── Why these mechanics ───────────────────────────────────────────────────
 * · IN THE DB, because the failure mode is a process restart.
 * · EXPIRY, not a boolean, because a holder that dies must not wedge the
 *   instance — the lease simply lapses.
 * · OWNER TOKEN, so release is idempotent and a stale holder returning late
 *   cannot free a lease that now belongs to someone else.
 * · Acquire is a conditional updateMany, which Postgres makes an atomic
 *   compare-and-swap: two racing callers cannot both see count === 1.
 */

/** Longest a turn may hold the machine. Real turns have run ~12 minutes. */
const DEFAULT_TTL_MS = 20 * 60_000;

export interface LeaseHandle {
  instanceId: string;
  token: string;
}

export interface LeaseBusy {
  /** What currently holds it — 'chat' or a sweep source. */
  kind: string | null;
  /** When the current holder's lease lapses. */
  until: Date;
  /** When it was acquired, derived from the expiry and its TTL. */
  since?: Date;
}

export type AcquireResult =
  | { ok: true; handle: LeaseHandle }
  | { ok: false; busy: LeaseBusy };

/**
 * Claim the machine for one turn. Succeeds when the lease is free or expired.
 * `kind` is what shows up in the busy reply, so make it human-meaningful.
 */
export async function acquireMachineTurn(
  instanceId: string,
  kind: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<AcquireResult> {
  const now = new Date();
  const token = randomUUID();
  const res = await prisma.hermesInstance.updateMany({
    // Atomic CAS: only one of two racing callers can match a free/expired lease.
    where: {
      id: instanceId,
      OR: [{ turnLeaseUntil: null }, { turnLeaseUntil: { lt: now } }],
    },
    data: {
      turnLeaseUntil: new Date(now.getTime() + ttlMs),
      turnLeaseOwner: token,
      turnLeaseKind: kind,
      turnLeaseStartedAt: now,
    },
  });
  if (res.count === 1) return { ok: true, handle: { instanceId, token } };

  const row = await prisma.hermesInstance.findUnique({
    where: { id: instanceId },
    select: { turnLeaseUntil: true, turnLeaseKind: true, turnLeaseStartedAt: true },
  });
  // Lost the race but the holder vanished in between — treat as busy rather
  // than retrying, so a caller can never end up doubling a turn.
  const until = row?.turnLeaseUntil ?? now;
  return {
    ok: false,
    busy: {
      kind: row?.turnLeaseKind ?? null,
      until,
      // The holder's own stamp. NEVER derive this from `until - ttlMs`: ttlMs
      // belongs to US (the caller that just lost the race), not to the holder,
      // and the two differ by 15 minutes on the commonest pairing.
      // Omitted rather than guessed when a pre-migration row has no stamp.
      ...(row?.turnLeaseStartedAt ? { since: row.turnLeaseStartedAt } : {}),
    },
  };
}

/**
 * Claim the machine, WAITING up to `waitMs` for a busy one to free up.
 *
 * A user who types while a background sweep holds the machine used to be told
 * to send their message again — we rejected their turn and made them redo it.
 * Background sweeps are short (AGENT_TURN_TIMEOUT_MS is 4 minutes, and the
 * median run is far under that), so most of those bounces were avoidable by
 * simply waiting a moment.
 *
 * Bounded, not unbounded: the caller is an open HTTP request from Sokosumi,
 * so we must answer well before any client-side timeout. If the wait runs out
 * we fall back to the honest busy reply rather than hanging.
 */
export async function acquireMachineTurnWithWait(
  instanceId: string,
  kind: string,
  opts: { waitMs: number; ttlMs?: number; pollMs?: number },
): Promise<AcquireResult> {
  const deadline = Date.now() + opts.waitMs;
  const pollMs = opts.pollMs ?? 1_500;
  let last = await acquireMachineTurn(instanceId, kind, opts.ttlMs);
  while (!last.ok && Date.now() < deadline) {
    // Never sleep past the holder's own expiry — once it lapses the next
    // acquire succeeds, and sleeping longer just adds dead latency.
    const untilExpiry = last.busy.until.getTime() - Date.now();
    const nap = Math.max(250, Math.min(pollMs, untilExpiry + 250, deadline - Date.now()));
    await new Promise((r) => setTimeout(r, nap));
    last = await acquireMachineTurn(instanceId, kind, opts.ttlMs);
  }
  return last;
}

/**
 * Release the machine. Only the owner can, so a lapsed holder finishing late
 * cannot free the turn that replaced it. Never throws — a failed release just
 * means the lease expires on its own.
 */
/**
 * Called after every successful release. Registered by index.ts so the queued
 * -turn drainer runs the instant a machine frees up, without this module
 * importing the queue (which imports cron-agent-turn, which imports this —
 * a cycle). Unset in tests, where release stays a pure DB write.
 */
let onReleased: ((instanceId: string) => void) | null = null;

export function setLeaseReleaseHook(fn: (instanceId: string) => void): void {
  onReleased = fn;
}

export async function releaseMachineTurn(handle: LeaseHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await releaseInner(handle);
  } finally {
    // The release must never be blocked or failed by a drain.
    try {
      onReleased?.(handle.instanceId);
    } catch (err) {
      logger.warn({ err, instanceId: handle.instanceId }, 'lease_release_hook_failed');
    }
  }
}

async function releaseInner(handle: LeaseHandle): Promise<void> {
  await prisma.hermesInstance
    .updateMany({
      where: { id: handle.instanceId, turnLeaseOwner: handle.token },
      data: {
        turnLeaseUntil: null,
        turnLeaseOwner: null,
        turnLeaseKind: null,
        turnLeaseStartedAt: null,
      },
    })
    .catch((err) => logger.warn({ err, instanceId: handle.instanceId }, 'machine_lease_release_failed'));
}

/**
 * Extend a lease that's still ours. For turns that legitimately outlive the
 * default TTL; a no-op if we no longer hold it.
 */
export async function renewMachineTurn(
  handle: LeaseHandle,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
  const res = await prisma.hermesInstance
    .updateMany({
      where: { id: handle.instanceId, turnLeaseOwner: handle.token },
      data: { turnLeaseUntil: new Date(Date.now() + ttlMs) },
    })
    .catch(() => ({ count: 0 }));
  return res.count === 1;
}

/**
 * Run `fn` holding the machine, or return `onBusy` without running it.
 *
 * For best-effort turns — settings nudges, integration greetings, native-cron
 * reconciliation. All of them are either idempotent or purely cosmetic, so
 * skipping a busy machine is strictly better than interleaving a second agent
 * loop with whatever is already running.
 */
export async function withMachineTurn<T>(
  instanceId: string,
  kind: string,
  fn: () => Promise<T>,
  opts: { onBusy: T; ttlMs?: number },
): Promise<T> {
  const claim = await acquireMachineTurn(instanceId, kind, opts.ttlMs);
  if (!claim.ok) {
    logger.info({ instanceId, kind, heldBy: claim.busy.kind }, 'machine_turn_skipped_busy');
    return opts.onBusy;
  }
  try {
    return await fn();
  } finally {
    await releaseMachineTurn(claim.handle);
  }
}

/**
 * Boot-time sweep: a lease held by a process that no longer exists would block
 * its instance until expiry. We cannot tell a dead holder from a live one in
 * another replica, so we do NOT clear leases here — that would reintroduce the
 * exact race this module prevents. We only REPORT them, so an orphaned turn is
 * visible in the logs instead of looking like a mysteriously silent agent.
 */
export async function reportHeldLeasesOnBoot(): Promise<void> {
  const held = await prisma.hermesInstance
    .findMany({
      where: { turnLeaseUntil: { gt: new Date() }, destroyedAt: null },
      select: { id: true, userId: true, turnLeaseKind: true, turnLeaseUntil: true },
    })
    .catch(() => []);
  for (const h of held) {
    logger.warn(
      {
        instanceId: h.id,
        userId: h.userId,
        kind: h.turnLeaseKind,
        until: h.turnLeaseUntil,
      },
      'machine_lease_held_at_boot',
    );
  }
}
