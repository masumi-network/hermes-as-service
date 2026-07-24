import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The capability-roll sweep restarts idle machines whose registered MCP tool
 * catalog is stale, so a newly-deployed tool reaches existing instances
 * without a manual roll. These pin the loop's behaviour (counting, stamping,
 * kill switch, failure backoff) by mocking Prisma + Fly — there is no DB in
 * the test env.
 */

const CURRENT = 'ver_current1';

// Mutable test doubles the mocks close over.
const findMany = vi.fn();
const update = vi.fn();
const restartMachine = vi.fn();

vi.mock('../src/db.js', () => ({
  prisma: { hermesInstance: { findMany: (...a: unknown[]) => findMany(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock('../src/fly/client.js', () => ({
  FlyClient: class {
    restartMachine = (...a: unknown[]) => restartMachine(...a);
  },
}));
vi.mock('../src/routes/sokosumi-mcp.js', () => ({ MCP_TOOLS_VERSION: CURRENT }));

const inst = (id: string) => ({ id, userId: `u_${id}`, spriteName: `app_${id}`, spriteId: `m_${id}` });

async function importSweep() {
  const mod = await import('../src/provision/mcp-tools-roll.js');
  return mod;
}

beforeEach(() => {
  process.env['MCP_AUTO_ROLL_MAX_PER_TICK'] = '3';
  process.env['MCP_AUTO_ROLL_IDLE_MINUTES'] = '10';
  vi.resetModules();
  findMany.mockReset();
  update.mockReset().mockResolvedValue({});
  restartMachine.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env['MCP_AUTO_ROLL_MAX_PER_TICK'];
});

describe('runMcpToolsRollSweep', () => {
  it('is a no-op when the kill switch (max per tick = 0) is set', async () => {
    process.env['MCP_AUTO_ROLL_MAX_PER_TICK'] = '0';
    vi.resetModules();
    const { runMcpToolsRollSweep } = await importSweep();
    const r = await runMcpToolsRollSweep();
    expect(r).toEqual({ scanned: 0, rolled: 0, failed: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rolls each stale idle candidate and stamps it current on success', async () => {
    findMany.mockResolvedValue([inst('a'), inst('b')]);
    const { runMcpToolsRollSweep } = await importSweep();
    const r = await runMcpToolsRollSweep();

    expect(r).toEqual({ scanned: 2, rolled: 2, failed: 0 });
    expect(restartMachine).toHaveBeenCalledWith('app_a', 'm_a');
    expect(restartMachine).toHaveBeenCalledWith('app_b', 'm_b');
    // Each instance: rollingAt set (in-flight), then stamped current on
    // success. rollingAt is deliberately NOT cleared here — it keeps the
    // banner over the post-restart API-boot tail.
    const stamps = update.mock.calls.filter((c) => (c[0] as { data: Record<string, unknown> }).data.mcpToolsVersion === CURRENT);
    expect(stamps).toHaveLength(2);
    for (const s of stamps) expect((s[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('rollingAt');
    // ...and the in-flight marker was set first, before the restart.
    const markers = update.mock.calls.filter((c) => (c[0] as { data: Record<string, unknown> }).data.rollingAt instanceof Date);
    expect(markers).toHaveLength(2);
  });

  it('counts a failed restart and does NOT stamp it (leaves rollingAt for backoff)', async () => {
    findMany.mockResolvedValue([inst('a'), inst('b')]);
    restartMachine.mockImplementation((app: string) =>
      app === 'app_a' ? Promise.reject(new Error('fly 500')) : Promise.resolve(undefined),
    );
    const { runMcpToolsRollSweep } = await importSweep();
    const r = await runMcpToolsRollSweep();

    expect(r).toEqual({ scanned: 2, rolled: 1, failed: 1 });
    // b got stamped current; a did NOT (only its rollingAt marker was set).
    const stampedIds = update.mock.calls
      .filter((c) => (c[0] as { data: Record<string, unknown> }).data.mcpToolsVersion === CURRENT)
      .map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(stampedIds).toEqual(['b']);
  });

  it('queries only idle, live, stale, not-recently-rolled instances, capped', async () => {
    findMany.mockResolvedValue([]);
    const { runMcpToolsRollSweep } = await importSweep();
    await runMcpToolsRollSweep();

    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown>; take: number; orderBy: unknown });
    expect(where.take).toBe(3); // MCP_AUTO_ROLL_MAX_PER_TICK
    expect(where.where['destroyedAt']).toBeNull();
    expect(where.where['status']).toEqual({ in: ['ready', 'running', 'suspended'] });
    expect(where.where['lastActivityAt']).toHaveProperty('lt'); // idle gate
    expect(where.where['integrations']).toEqual({ none: { status: { in: ['connecting', 'pending'] } } });
    expect(where.orderBy).toEqual({ lastActivityAt: 'asc' }); // most-idle first

    // Staleness must match NEVER-stamped (null) instances too — SQL
    // `NOT (col = v)` is false for NULL, so the explicit null branch is the
    // thing that lets this feature deliver a new tool to existing machines.
    const and = where.where['AND'] as Array<{ OR: unknown[] }>;
    const staleGroup = and.find((g) => JSON.stringify(g).includes('mcpToolsVersion'))!;
    expect(staleGroup.OR).toContainEqual({ mcpToolsVersion: null });
    expect(staleGroup.OR).toContainEqual({ mcpToolsVersion: { not: CURRENT } });
  });
});

describe('stampMcpToolsVersion', () => {
  it('sets the current version and clears the roll marker', async () => {
    const { stampMcpToolsVersion } = await importSweep();
    await stampMcpToolsVersion('x');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'x' },
      data: { mcpToolsVersion: CURRENT, rollingAt: null },
    });
  });
});
