import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * From a real session: three sokosumi_create_task confirmation cards in five
 * minutes — two of them NINE SECONDS apart — and every card read
 *
 *     Create a new task "X" and assign it to coworker 019ed9d2-6cb0-778b-…
 *
 * so the user saw three approval requests with no explanation of what they
 * were for or who would do the work. Two fixes, covered here: readable card
 * copy, and a burst guard that refuses the second card instead of stacking it.
 */

const load = async () => import('../src/confirmations/store.js');

describe('confirmation card copy', () => {
  it('names the coworker and workspace instead of printing UUIDs', async () => {
    const { summarizeToolCall } = await load();
    vi.resetModules();
    const s = await summarizeToolCall('sokosumi_create_task', {
      name: 'Draft the Q4 report',
      coworker_id: '019ed9d2-6cb0-778b-b4aa-f9167b2787fb',
      description: 'Pull the numbers from Dune and write a one-pager.',
    });
    // Without a ctx the ids stay raw, but the SHAPE is the fix: the card now
    // carries the task title, the workspace, and what the coworker will do.
    expect(s).toContain('Draft the Q4 report');
    expect(s).toContain('your personal workspace');
    expect(s).toContain("What they'll be asked to do: Pull the numbers from Dune");
  });

  it('shows the actual answer being submitted for a paused job', async () => {
    const { summarizeToolCall } = await load();
    const s = await summarizeToolCall('sokosumi_provide_job_input', {
      job_id: 'job_1',
      input_data: { budget: 5000, deadline: '2026-08-01' },
    });
    // Previously: "Provide input to job job_1 so it can continue." — approving blind.
    expect(s).toContain('budget');
    expect(s).toContain('5000');
    expect(s).toContain('deadline');
  });

  it('flags credit spend loudly on a job card', async () => {
    const { summarizeToolCall } = await load();
    const s = await summarizeToolCall('sokosumi_create_job', { agent_id: 'a1', task_id: 't1' });
    expect(s).toContain('SPENDS CREDITS');
  });

  it('never throws when id resolution is impossible', async () => {
    const { summarizeToolCall } = await load();
    await expect(summarizeToolCall('sokosumi_create_task', {})).resolves.toBeTruthy();
    await expect(summarizeToolCall('totally_unknown_tool', { a: 1 })).resolves.toContain(
      'totally_unknown_tool',
    );
  });
});

describe('confirmation burst guard', () => {
  const rows: Array<{ id: string; summary: string; createdAt: Date; toolArgs: unknown }> = [];

  beforeEach(() => {
    rows.length = 0;
    vi.resetModules();
    vi.doMock('../src/db.js', () => ({
      prisma: {
        pendingConfirmation: {
          findMany: async () => rows.map((r) => ({ id: r.id, summary: r.summary, toolArgs: r.toolArgs })),
          findFirst: async ({ where }: { where: { createdAt?: { gt: Date } } }) => {
            const cutoff = where.createdAt?.gt;
            const hit = rows.filter((r) => !cutoff || r.createdAt > cutoff).at(-1);
            return hit ?? null;
          },
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = {
              id: `c${rows.length + 1}`,
              summary: String(data['summary']),
              createdAt: new Date(),
              toolArgs: data['toolArgs'],
            };
            rows.push(row);
            return row;
          },
        },
      },
    }));
    vi.doMock('../src/notify/masumi.js', () => ({ notifyMasumi: () => {}, shortId: (s: string) => s }));
  });

  afterEach(() => {
    vi.doUnmock('../src/db.js');
    vi.doUnmock('../src/notify/masumi.js');
    vi.resetModules();
  });

  const make = (toolArgs: Record<string, unknown>, summary = 'do a thing') => ({
    instanceId: 'i1',
    userId: 'u1',
    toolName: 'sokosumi_create_task',
    toolArgs,
    summary,
  });

  it('creates the first card normally', async () => {
    const { createPendingConfirmation } = await load();
    const first = await createPendingConfirmation(make({ name: 'A' }));
    expect(first.id).toBe('c1');
    expect(rows).toHaveLength(1);
  });

  it('returns the SAME card for an identical retry (exact-args dedupe)', async () => {
    const { createPendingConfirmation } = await load();
    const a = await createPendingConfirmation(make({ name: 'A' }));
    const b = await createPendingConfirmation(make({ name: 'A' }));
    expect(b.id).toBe(a.id);
    expect(rows).toHaveLength(1);
  });

  it('BLOCKS a different proposal seconds later instead of stacking a card', async () => {
    // This is the exact production shape: two create_task calls 9s apart with
    // different names. Exact-args dedupe cannot catch it.
    const { createPendingConfirmation, ConfirmationBurstError } = await load();
    await createPendingConfirmation(make({ name: 'A' }, 'Create task A'));
    await expect(createPendingConfirmation(make({ name: 'B' }))).rejects.toBeInstanceOf(
      ConfirmationBurstError,
    );
    expect(rows).toHaveLength(1); // no second card reached the user
  });

  it('carries the existing card back so the agent can explain THAT one', async () => {
    const { createPendingConfirmation, ConfirmationBurstError } = await load();
    await createPendingConfirmation(make({ name: 'A' }, 'Create task A'));
    try {
      await createPendingConfirmation(make({ name: 'B' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmationBurstError);
      expect((err as InstanceType<typeof ConfirmationBurstError>).existingId).toBe('c1');
      expect((err as InstanceType<typeof ConfirmationBurstError>).existingSummary).toBe(
        'Create task A',
      );
    }
  });

  it('allows a genuinely later proposal once the window passes', async () => {
    const { createPendingConfirmation } = await load();
    await createPendingConfirmation(make({ name: 'A' }));
    // Age the existing row past BURST_WINDOW_MS (90s).
    rows[0]!.createdAt = new Date(Date.now() - 120_000);
    const second = await createPendingConfirmation(make({ name: 'B' }));
    expect(second.id).toBe('c2');
    expect(rows).toHaveLength(2);
  });
});
