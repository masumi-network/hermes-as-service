import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin dashboard could show what a user asked and what the agent finally
 * answered, but nothing in between — the agent's tool loop runs against the LLM
 * proxy on a different route, so no tool call was ever persisted. That made a
 * real session ("it raised three approval cards and explained none of them")
 * impossible to reconstruct from the dashboard.
 *
 * recordToolCall is what fills that gap. It runs on every executed tool, so its
 * two load-bearing properties are: it captures enough to debug with, and it can
 * never break the agent's turn.
 */

process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';

const CTX = {
  instanceId: 'i1',
  userId: 'user_1',
  env: 'mainnet' as const,
  autonomyLevel: 'medium' as const,
};

let created: Array<Record<string, unknown>>;
let createImpl: (args: { data: Record<string, unknown> }) => Promise<unknown>;

/** Recording is fire-and-forget, so let the floating promise settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  created = [];
  createImpl = async ({ data }) => {
    created.push(data);
    return data;
  };
  vi.resetModules();
  vi.doMock('../src/db.js', () => ({
    prisma: {
      agentToolCall: { create: (a: { data: Record<string, unknown> }) => createImpl(a) },
    },
  }));
});

afterEach(() => {
  vi.doUnmock('../src/db.js');
  vi.resetModules();
});

const load = async () => (await import('../src/routes/sokosumi-mcp.js')).recordToolCall;

describe('recordToolCall', () => {
  it('captures the fields needed to diagnose a bad turn', async () => {
    const record = await load();
    record({
      ctx: CTX,
      toolName: 'sokosumi_list_coworkers',
      args: { limit: 30 },
      ok: true,
      resultBytes: 534_555,
      latencyMs: 226,
    });
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      instanceId: 'i1',
      userId: 'user_1',
      toolName: 'sokosumi_list_coworkers',
      ok: true,
      // The number that explains a derailed session.
      resultBytes: 534_555,
      latencyMs: 226,
      autonomy: 'medium',
    });
    expect(created[0]!['args']).toEqual({ limit: 30 });
  });

  it('records failures with the error, not just successes', async () => {
    const record = await load();
    record({
      ctx: CTX,
      toolName: 'sokosumi_create_task',
      args: { name: 'X' },
      ok: false,
      errorMessage: 'task not found in any org',
      latencyMs: 12,
    });
    await settle();

    expect(created[0]).toMatchObject({ ok: false, errorMessage: 'task not found in any org' });
    expect(created[0]!['resultBytes']).toBeNull();
  });

  it('truncates oversized arguments instead of storing them whole', async () => {
    const record = await load();
    record({
      ctx: CTX,
      toolName: 'sokosumi_add_task_comment',
      args: { comment: 'x'.repeat(10_000) },
      ok: true,
      resultBytes: 10,
      latencyMs: 1,
    });
    await settle();

    const args = created[0]!['args'] as Record<string, unknown>;
    expect(args['_truncated']).toBe(true);
    expect(args['_bytes']).toBeGreaterThan(10_000);
    expect(String(args['preview']).length).toBeLessThanOrEqual(2000);
  });

  it('caps a long error message', async () => {
    const record = await load();
    record({
      ctx: CTX,
      toolName: 't',
      args: {},
      ok: false,
      errorMessage: 'e'.repeat(2000),
      latencyMs: 1,
    });
    await settle();
    expect(String(created[0]!['errorMessage']).length).toBe(500);
  });

  it('survives arguments that cannot be serialised', async () => {
    const record = await load();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() =>
      record({ ctx: CTX, toolName: 't', args: circular, ok: true, resultBytes: 1, latencyMs: 1 }),
    ).not.toThrow();
    await settle();
    expect(created[0]!['args']).toEqual({ _unserializable: true });
  });

  it('a DB failure never propagates to the caller', async () => {
    createImpl = async () => {
      throw new Error('db down');
    };
    const record = await load();
    expect(() =>
      record({ ctx: CTX, toolName: 't', args: {}, ok: true, resultBytes: 1, latencyMs: 1 }),
    ).not.toThrow();
    // And the rejected write is swallowed rather than becoming an unhandled
    // rejection that could take the process down.
    await settle();
    expect(created).toHaveLength(0);
  });
});
