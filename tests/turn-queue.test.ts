import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Replay of user messages that collided with a busy machine.
 *
 * Before this, a chat turn that hit a running background sweep was answered
 * with "send this again once I've replied" and the message itself was never
 * persisted — the ChatMessage insert happens AFTER the lease is acquired, so
 * the busy branch dropped it entirely. These pin the properties that make the
 * replacement trustworthy, above all that the reply only promises a pickup
 * when one was really stored.
 */

interface Row {
  id: string;
  instanceId: string;
  userId: string;
  content: string;
  requestId: string;
  createdAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  deliveredAt: Date | null;
  attempts: number;
  lastError: string | null;
}

function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const match = (r: Row, where: Record<string, any>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      const actual = (r as any)[k];
      if (v === null) {
        if (actual !== null) return false;
      } else if (typeof v === 'object' && v && 'lt' in v) {
        if (!(actual instanceof Date) || !(actual.getTime() < (v.lt as Date).getTime())) return false;
      } else if (actual !== v) {
        return false;
      }
    }
    return true;
  };
  const apply = (r: Row, data: Record<string, any>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) (r as any)[k] += v.increment;
      else if (v && typeof v === 'object' && 'decrement' in v) (r as any)[k] -= v.decrement;
      else (r as any)[k] = v;
    }
  };
  return {
    rows,
    prisma: {
      queuedTurn: {
        count: async ({ where }: any) => rows.filter((r) => match(r, where)).length,
        create: async ({ data }: any) => {
          const row: Row = {
            id: `q${++seq}`,
            createdAt: new Date(Date.now() + seq),
            claimedAt: null,
            claimedBy: null,
            deliveredAt: null,
            attempts: 0,
            lastError: null,
            ...data,
          };
          rows.push(row);
          return row;
        },
        findFirst: async ({ where }: any) =>
          rows.filter((r) => match(r, where)).sort((a, b) => +a.createdAt - +b.createdAt)[0] ?? null,
        findMany: async ({ where }: any) => rows.filter((r) => match(r, where)),
        updateMany: async ({ where, data }: any) => {
          const { id, ...rest } = where;
          const hit = rows.filter((r) => (id ? r.id === id : true) && match(r, rest));
          hit.forEach((r) => apply(r, data));
          return { count: hit.length };
        },
        update: async ({ where, data }: any) => {
          const r = rows.find((x) => x.id === where.id)!;
          apply(r, data);
          return r;
        },
      },
      hermesInstance: { findUnique: async () => null },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
const load = async () => import('../src/queue/turn-queue.js');

beforeEach(() => {
  vi.resetModules();
  db = fakeDb();
  vi.doMock('../src/db.js', () => ({ prisma: db.prisma }));
});
afterEach(() => {
  vi.doUnmock('../src/db.js');
  vi.resetModules();
});

const base = { instanceId: 'i1', userId: 'u1', requestId: 'r1' };

describe('holding a message instead of dropping it', () => {
  it('persists the message and reports its place in line', async () => {
    const { enqueueTurn } = await load();
    expect((await enqueueTurn({ ...base, content: 'first' })).depth).toBe(1);
    expect((await enqueueTurn({ ...base, content: 'second' })).depth).toBe(2);
    expect(db.rows.map((r) => r.content)).toEqual(['first', 'second']);
  });

  it('refuses past the depth cap rather than swallowing the message', async () => {
    const { enqueueTurn, QueueFullError } = await load();
    for (let i = 0; i < 5; i++) await enqueueTurn({ ...base, content: `m${i}` });
    await expect(enqueueTurn({ ...base, content: 'overflow' })).rejects.toBeInstanceOf(QueueFullError);
    expect(db.rows).toHaveLength(5);
  });

  it('counts only undelivered messages toward the cap', async () => {
    const { enqueueTurn, queueDepth } = await load();
    for (let i = 0; i < 5; i++) await enqueueTurn({ ...base, content: `m${i}` });
    db.rows[0]!.deliveredAt = new Date();
    expect(await queueDepth('i1')).toBe(4);
    await expect(enqueueTurn({ ...base, content: 'now fits' })).resolves.toBeTruthy();
  });

  it('keeps queues separate per instance', async () => {
    const { enqueueTurn, queueDepth } = await load();
    await enqueueTurn({ ...base, content: 'a' });
    await enqueueTurn({ ...base, instanceId: 'i2', content: 'b' });
    expect(await queueDepth('i1')).toBe(1);
    expect(await queueDepth('i2')).toBe(1);
  });
});

describe('the busy reply matches what actually happened', () => {
  const holder = { holder: 'a background check of your task board', since: new Date(Date.now() - 90_000) };

  it('promises a pickup ONLY when the message was stored', async () => {
    const { busyMessage } = await import('../src/routes/turn-guard.js');
    const queued = busyMessage(holder, null, { position: 1 });
    expect(queued).toContain('No need to resend');
    expect(queued).not.toMatch(/Send it again/i);

    // Enqueue failed (queue full, DB down): must fall back to asking.
    const notQueued = busyMessage(holder, null, null);
    expect(notQueued).toMatch(/Send it again/i);
    expect(notQueued).not.toMatch(/No need to resend/i);
  });

  it('names the position when the user is behind other messages', async () => {
    const { busyMessage } = await import('../src/routes/turn-guard.js');
    expect(busyMessage(holder, null, { position: 3 })).toContain('3rd in line');
    expect(busyMessage(holder, null, { position: 2 })).toContain('2nd in line');
  });
});

describe('draining', () => {
  it('no-ops when the instance is gone rather than throwing', async () => {
    const { enqueueTurn, drainQueuedTurns } = await load();
    await enqueueTurn({ ...base, content: 'hi' });
    await expect(drainQueuedTurns('i1')).resolves.toEqual({ sent: 0, reason: 'no_instance' });
    // The message stays queued for a later, healthier drain.
    expect(db.rows[0]!.deliveredAt).toBeNull();
  });

  it('releases claims stranded by a crash mid-replay', async () => {
    const { enqueueTurn, sweepQueuedTurns } = await load();
    await enqueueTurn({ ...base, content: 'hi' });
    db.rows[0]!.claimedAt = new Date(Date.now() - 60 * 60_000);
    db.rows[0]!.claimedBy = 'dead-process';
    await sweepQueuedTurns();
    expect(db.rows[0]!.claimedAt).toBeNull();
    expect(db.rows[0]!.deliveredAt).toBeNull();
  });

  it('does not release a claim that is still within its turn budget', async () => {
    const { enqueueTurn, sweepQueuedTurns } = await load();
    await enqueueTurn({ ...base, content: 'hi' });
    const fresh = new Date(Date.now() - 5_000);
    db.rows[0]!.claimedAt = fresh;
    await sweepQueuedTurns();
    expect(db.rows[0]!.claimedAt).toEqual(fresh);
  });
});
