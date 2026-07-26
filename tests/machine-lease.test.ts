import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One agent turn per MACHINE, enforced in the database.
 *
 * The production incident (2026-07-26) this guards:
 *   23:05:08  a sweep starts a cron turn
 *   23:08:33  the orchestrator redeploys mid-fetch — that turn's process dies
 *             before writing its reply, and the machine keeps looping
 *   23:10:01  the fresh process, in-memory guards EMPTY, starts another turn
 *   → two live loops on one machine, prompt tokens climbing in two interleaved
 *     series, and the user's own chat turn got a two-second stub.
 *
 * The previous guard was in memory and covered only the chat path, so it could
 * not survive the restart that caused this. These tests pin the three
 * properties that make the DB version correct.
 */

/** Minimal fake of the one Postgres behaviour we depend on: a conditional
 *  updateMany is an atomic compare-and-swap. */
function fakeDb() {
  const rows = new Map<string, { turnLeaseUntil: Date | null; turnLeaseOwner: string | null; turnLeaseKind: string | null }>();
  rows.set('i1', { turnLeaseUntil: null, turnLeaseOwner: null, turnLeaseKind: null });
  rows.set('i2', { turnLeaseUntil: null, turnLeaseOwner: null, turnLeaseKind: null });
  return {
    rows,
    prisma: {
      hermesInstance: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = rows.get(where['id'] as string);
          if (!row) return { count: 0 };
          // acquire: free OR expired
          if (where['OR']) {
            const free = row.turnLeaseUntil === null || row.turnLeaseUntil.getTime() < Date.now();
            if (!free) return { count: 0 };
          }
          // release/renew: owner must match
          if (where['turnLeaseOwner'] && row.turnLeaseOwner !== where['turnLeaseOwner']) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        findMany: async () => [],
      },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
const load = async () => import('../src/routes/machine-lease.js');

beforeEach(() => {
  vi.resetModules();
  db = fakeDb();
  vi.doMock('../src/db.js', () => ({ prisma: db.prisma }));
});
afterEach(() => {
  vi.doUnmock('../src/db.js');
  vi.resetModules();
  vi.useRealTimers();
});

describe('acquireMachineTurn', () => {
  it('grants a free machine', async () => {
    const { acquireMachineTurn } = await load();
    const r = await acquireMachineTurn('i1', 'chat');
    expect(r.ok).toBe(true);
  });

  it('REFUSES a second turn and reports what holds it', async () => {
    const { acquireMachineTurn } = await load();
    await acquireMachineTurn('i1', 'board_sweep');
    const r = await acquireMachineTurn('i1', 'chat');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.busy.kind).toBe('board_sweep');
  });

  it('is per machine — one instance does not block another', async () => {
    const { acquireMachineTurn } = await load();
    await acquireMachineTurn('i1', 'chat');
    expect((await acquireMachineTurn('i2', 'chat')).ok).toBe(true);
  });

  it('two racing callers cannot both win', async () => {
    const { acquireMachineTurn } = await load();
    const [a, b] = await Promise.all([
      acquireMachineTurn('i1', 'chat'),
      acquireMachineTurn('i1', 'board_sweep'),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('survives a process restart — the lease is in the DB, not memory', async () => {
    // This is the whole point: the incident was caused by a redeploy clearing
    // in-memory state. Re-importing the module simulates that restart.
    const first = await load();
    await first.acquireMachineTurn('i1', 'board_sweep');
    vi.resetModules();
    const afterRestart = await load();
    const r = await afterRestart.acquireMachineTurn('i1', 'board_sweep');
    expect(r.ok).toBe(false);
  });

  it('lapses rather than wedging the machine forever', async () => {
    vi.useFakeTimers();
    const { acquireMachineTurn } = await load();
    await acquireMachineTurn('i1', 'board_sweep', 60_000);
    expect((await acquireMachineTurn('i1', 'chat')).ok).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect((await acquireMachineTurn('i1', 'chat')).ok).toBe(true);
  });

  it('holds for a long but legitimate turn', async () => {
    vi.useFakeTimers();
    const { acquireMachineTurn } = await load();
    await acquireMachineTurn('i1', 'chat', 20 * 60_000);
    vi.advanceTimersByTime(12 * 60_000); // real turns have run this long
    expect((await acquireMachineTurn('i1', 'board_sweep')).ok).toBe(false);
  });

  it('reports a start time so the busy reply can say how long', async () => {
    const { acquireMachineTurn } = await load();
    await acquireMachineTurn('i1', 'chat', 60_000);
    const r = await acquireMachineTurn('i1', 'board_sweep', 60_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.busy.since).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - r.busy.since!.getTime())).toBeLessThan(5_000);
    }
  });
});

describe('releaseMachineTurn', () => {
  it('frees the machine for the next turn', async () => {
    const { acquireMachineTurn, releaseMachineTurn } = await load();
    const r = await acquireMachineTurn('i1', 'chat');
    if (!r.ok) throw new Error('expected acquire');
    await releaseMachineTurn(r.handle);
    expect((await acquireMachineTurn('i1', 'board_sweep')).ok).toBe(true);
  });

  it('a lapsed holder returning late cannot free someone ELSE\'s lease', async () => {
    vi.useFakeTimers();
    const { acquireMachineTurn, releaseMachineTurn } = await load();
    const stale = await acquireMachineTurn('i1', 'board_sweep', 60_000);
    if (!stale.ok) throw new Error('expected acquire');
    vi.advanceTimersByTime(61_000);
    const fresh = await acquireMachineTurn('i1', 'chat', 60_000);
    expect(fresh.ok).toBe(true);
    // The old sweep finally finishes and tries to release.
    await releaseMachineTurn(stale.handle);
    // The live chat turn must still hold it.
    expect((await acquireMachineTurn('i1', 'board_sweep', 60_000)).ok).toBe(false);
  });

  it('is a no-op on null and safe to call twice', async () => {
    const { acquireMachineTurn, releaseMachineTurn } = await load();
    await releaseMachineTurn(null);
    const r = await acquireMachineTurn('i1', 'chat');
    if (!r.ok) throw new Error('expected acquire');
    await releaseMachineTurn(r.handle);
    await expect(releaseMachineTurn(r.handle)).resolves.toBeUndefined();
  });
});

describe('renewMachineTurn', () => {
  it('extends a lease we still own', async () => {
    vi.useFakeTimers();
    const { acquireMachineTurn, renewMachineTurn } = await load();
    const r = await acquireMachineTurn('i1', 'chat', 60_000);
    if (!r.ok) throw new Error('expected acquire');
    vi.advanceTimersByTime(50_000);
    expect(await renewMachineTurn(r.handle, 60_000)).toBe(true);
    vi.advanceTimersByTime(30_000); // past the ORIGINAL expiry
    expect((await acquireMachineTurn('i1', 'board_sweep')).ok).toBe(false);
  });

  it('refuses to renew a lease we no longer hold', async () => {
    vi.useFakeTimers();
    const { acquireMachineTurn, releaseMachineTurn, renewMachineTurn } = await load();
    const r = await acquireMachineTurn('i1', 'chat', 60_000);
    if (!r.ok) throw new Error('expected acquire');
    await releaseMachineTurn(r.handle);
    await acquireMachineTurn('i1', 'board_sweep', 60_000);
    expect(await renewMachineTurn(r.handle, 60_000)).toBe(false);
  });
});

describe('the busy reply', () => {
  it('names a background holder rather than claiming it was your message', async () => {
    const { describeLeaseHolder, busyMessage } = await import('../src/routes/turn-guard.js');
    expect(describeLeaseHolder('board_sweep')).toBe('a background check of your task board');
    const msg = busyMessage(
      { holder: describeLeaseHolder('board_sweep'), since: new Date(Date.now() - 90_000) },
      'Searching the web',
    );
    expect(msg).toContain('a background check of your task board');
    expect(msg).toContain('1 min 30 s ago');
    expect(msg).toContain('Searching the web');
    expect(msg).not.toContain('your previous message');
  });

  it('still reads correctly for the user\'s own earlier turn', async () => {
    const { describeLeaseHolder, busyMessage } = await import('../src/routes/turn-guard.js');
    expect(busyMessage({ holder: describeLeaseHolder('chat') })).toContain('your previous message');
  });

  it('names an unknown holder without pretending to know it', async () => {
    const { describeLeaseHolder } = await import('../src/routes/turn-guard.js');
    expect(describeLeaseHolder('some_new_sweep')).toBe('a background task (some_new_sweep)');
  });
});
