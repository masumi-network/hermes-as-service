import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hermes could read tasks and comment on them, but had no way to change a
 * task's status — so asked to "move these DRAFTs to READY" it created
 * duplicate replacement tasks instead. Sokosumi supports the change all along
 * via POST /tasks/{id}/events with a status field (requireTaskCollaboration
 * explicitly admits the orchestrator actor, gated on task ownership).
 * These pin the tool that closes that gap.
 */

const CTX = { instanceId: 'i1', userId: 'user_1', env: 'mainnet' as const, autonomyLevel: 'high' as const };

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let calls: Call[];

beforeEach(() => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
  vi.resetModules();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      const path = new URL(url).pathname.replace(/^\/v1/, '');
      calls.push({
        method: init.method ?? 'GET',
        path,
        body: init.body ? JSON.parse(init.body) : null,
      });
      return { ok: true, status: 200, json: async () => ({ data: { id: 'evt_1' } }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function run(args: Record<string, unknown>) {
  const { executeTool } = await import('../src/routes/sokosumi-mcp.js');
  return executeTool('sokosumi_set_task_status', args, CTX);
}

describe('sokosumi_set_task_status', () => {
  it('moves a DRAFT to READY via the task events endpoint', async () => {
    const out = JSON.parse(await run({ task_id: 'tsk_1', status: 'READY' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/tasks/tsk_1/events');
    expect(calls[0]!.body).toEqual({ status: 'READY' });
    expect(out.status).toBe('READY');
  });

  it('does NOT create a replacement task — the whole point of the tool', async () => {
    await run({ task_id: 'tsk_1', status: 'READY' });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/tasks')).toBe(false);
  });

  it('records an optional comment alongside the status change', async () => {
    await run({ task_id: 'tsk_1', status: 'CANCELED', comment: 'superseded' });
    expect(calls[0]!.body).toEqual({ status: 'CANCELED', comment: 'superseded' });
  });

  it('accepts lowercase status from the model', async () => {
    await run({ task_id: 'tsk_1', status: 'ready' });
    expect(calls[0]!.body).toEqual({ status: 'READY' });
  });

  it('refuses coworker-driven statuses instead of faking board state', async () => {
    await expect(run({ task_id: 'tsk_1', status: 'RUNNING' })).rejects.toThrow(/must be one of/);
    await expect(run({ task_id: 'tsk_1', status: 'INPUT_REQUIRED' })).rejects.toThrow(/must be one of/);
    expect(calls).toHaveLength(0); // never reached the API
  });

  it('requires task_id and status', async () => {
    await expect(run({ status: 'READY' })).rejects.toThrow(/missing required args/);
    await expect(run({ task_id: 'tsk_1' })).rejects.toThrow(/missing required args/);
  });

  it('is gated like create_task: blocked at low, confirms at medium, free at high', async () => {
    const { toolsForAutonomy } = await import('../src/routes/sokosumi-mcp.js');
    const at = (lvl: 'low' | 'medium' | 'high') =>
      toolsForAutonomy(lvl).find((t) => t.name === 'sokosumi_set_task_status');
    expect(at('low')).toBeUndefined();
    expect(at('medium')?.access).toBe('write');
    expect(at('high')?.access).toBe('write');
  });
});

describe('confirmation-card copy for set_task_status', () => {
  // The card is what the user actually reads before approving. Without a
  // dedicated case it fell through to `Run <tool> with arguments: {json}` —
  // confirmed live against the deployed build before this was added.
  const summarize = async (args: Record<string, unknown>) => {
    const { summarizeToolCall } = await import('../src/confirmations/store.js');
    return summarizeToolCall('sokosumi_set_task_status', args);
  };

  it('reads as a sentence, not raw JSON', async () => {
    const s = await summarize({ task_id: 'tsk_1', status: 'READY' });
    expect(s).toBe('Move task tsk_1 to READY so its assigned coworker can start it.');
    expect(s).not.toContain('{');
  });

  it('phrases cancel and complete naturally', async () => {
    expect(await summarize({ task_id: 't', status: 'CANCELED' })).toBe('Cancel task t.');
    expect(await summarize({ task_id: 't', status: 'COMPLETED' })).toBe('Mark task t as completed.');
  });

  it('includes the note when one is given', async () => {
    expect(await summarize({ task_id: 't', status: 'READY', comment: 'go' })).toMatch(/with the note "go"\.$/);
  });
});
