import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Org enumeration is available again via orch+ctx (Sokosumi PR #3408), but the
 * create paths must still TRUST an explicit organization_id (the user's
 * workspace pick on a confirmation card) directly — Sokosumi validates
 * membership server-side — rather than gating a write on an enumeration
 * round-trip.
 *
 * These drive the real executeTool dispatcher through a fetch mock so we test
 * the actual header + endpoint behaviour, not a paraphrase of it.
 */

const CTX = { instanceId: 'i1', userId: 'user_1', env: 'mainnet' as const, autonomyLevel: 'high' as const };

interface Call {
  method: string;
  path: string;
  org: string | undefined;
  body?: unknown;
}
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Route a request to a canned response by (method, pathname). */
function router(method: string, pathname: string): unknown {
  if (pathname === '/coworkers') return { data: [{ id: 'cow_1', slug: 'hannah', name: 'Hannah' }] };
  if (pathname === '/tasks' && method === 'POST') return { data: { id: 'tsk_new', status: 'READY' } };
  if (pathname === '/agents/agent_1/jobs' && method === 'POST') return { data: { id: 'job_new' } };
  if (pathname === '/agents/agent_1/input-schema')
    return {
      data: {
        input_data: [
          { id: 'intro', type: 'none', name: 'Information' },
          { id: 'question', type: 'textarea', name: 'Research Question' },
        ],
      },
    };
  if (pathname.endsWith('/credits'))
    return {
      data: {
        subscription: { plan: 'starter', status: 'active', credits: { total: 1500, remaining: 800, used: 700 } },
        extra: { credits: { total: 100, remaining: 25, used: 75 } },
      },
    };
  return { data: [] };
}

beforeEach(() => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
  calls = [];
  fetchMock = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path: u.pathname.replace(/^\/v1/, ''),
      org: init.headers?.['X-Context-Organization-Id'],
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, status: 200, json: async () => router(method, u.pathname.replace(/^\/v1/, '')) };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function run(name: string, args: Record<string, unknown>) {
  const { executeTool } = await import('../src/routes/sokosumi-mcp.js');
  return executeTool(name, args, CTX);
}

describe('org-scoped create paths trust an explicit organization_id', () => {
  it('create_task with an explicit org NEVER calls the dead enumeration endpoint', async () => {
    await run('sokosumi_create_task', { name: 'T', coworker_id: 'cow_1', organization_id: 'org_a' });
    // The whole bug: it must not gate on /users/{id}/organizations.
    expect(calls.some((c) => c.path.includes('/organizations'))).toBe(false);
  });

  it('create_task with organization_id OMITTED files in personal (not the broken iterate branch)', async () => {
    // The tool tells the agent to omit org for personal; "create a task for
    // Hannah" (no org) must route to the personal path, not the legacy
    // iterate-orgs branch that errored "not found in any of the user's orgs".
    const out = await run('sokosumi_create_task', { name: 'T', coworker_id: 'cow_1' });
    const coworkerCall = calls.find((c) => c.path === '/coworkers');
    const taskCall = calls.find((c) => c.path === '/tasks' && c.method === 'POST');
    expect(coworkerCall?.org).toBeUndefined(); // personal — no org header
    expect(taskCall?.org).toBeUndefined();
    expect(JSON.parse(out).scope).toBe('personal');
  });

  it('create_task scopes both the coworker check and the write to the given org', async () => {
    const out = await run('sokosumi_create_task', {
      name: 'T',
      coworker_id: 'cow_1',
      organization_id: 'org_a',
    });
    const coworkerCall = calls.find((c) => c.path === '/coworkers');
    const taskCall = calls.find((c) => c.path === '/tasks' && c.method === 'POST');
    expect(coworkerCall?.org).toBe('org_a'); // membership gate is the scoped list
    expect(taskCall?.org).toBe('org_a');
    expect(JSON.parse(out).orgId).toBe('org_a');
  });

  it('create_task with organization_id: null files in the personal workspace (no org header)', async () => {
    const out = await run('sokosumi_create_task', { name: 'T', coworker_id: 'cow_1', organization_id: null });
    const taskCall = calls.find((c) => c.path === '/tasks' && c.method === 'POST');
    expect(taskCall?.org).toBeUndefined();
    expect(JSON.parse(out).scope).toBe('personal');
  });

  it('create_job honors an explicit organization_id instead of blindly using org[0]', async () => {
    const out = await run('sokosumi_create_job', {
      agent_id: 'agent_1',
      input_data: { question: 'why?' },
      organization_id: 'org_a',
    });
    const jobCall = calls.find((c) => c.path === '/agents/agent_1/jobs');
    expect(jobCall?.org).toBe('org_a');
    expect(JSON.parse(out).orgId).toBe('org_a');
  });

  it('create_job without an org runs in the personal workspace', async () => {
    const out = await run('sokosumi_create_job', {
      agent_id: 'agent_1',
      input_data: { question: 'why?' },
    });
    const jobCall = calls.find((c) => c.path === '/agents/agent_1/jobs');
    expect(jobCall?.org).toBeUndefined();
    expect(JSON.parse(out).orgId).toBeNull();
  });

  /**
   * The regression that made create_job unusable from day one: the body carried
   * only `inputSchema`, fed with the VALUES, so the required `inputData` was
   * always absent and Sokosumi answered every shape with the same opaque
   * "Key: inputSchema - Invalid input". Assert both halves, and assert the
   * schema is the one WE fetched — the model never echoes it.
   */
  it('create_job sends the fetched schema AND the values as separate fields', async () => {
    await run('sokosumi_create_job', {
      agent_id: 'agent_1',
      input_data: { question: 'why?' },
      max_credits: 25,
    });
    const body = calls.find((c) => c.path === '/agents/agent_1/jobs')?.body as {
      inputSchema?: { input_data?: unknown[] };
      inputData?: Record<string, unknown>;
      maxCredits?: number;
    };
    expect(body?.inputData).toEqual({ question: 'why?' });
    expect(body?.inputSchema?.input_data).toHaveLength(2);
    expect(body?.maxCredits).toBe(25);
    expect(calls.some((c) => c.path === '/agents/agent_1/input-schema')).toBe(true);
  });

  it('create_job rejects unknown field ids locally, naming the real fields', async () => {
    await expect(
      run('sokosumi_create_job', {
        agent_id: 'agent_1',
        input_data: { 'Research Question': 'keyed by display name, not id' },
      }),
    ).rejects.toThrow(/unknown input_data field\(s\): Research Question.*question \(textarea/s);
    expect(calls.some((c) => c.path === '/agents/agent_1/jobs')).toBe(false);
  });

  it('get_credits returns the real balance + plan (reopened by PR #3408)', async () => {
    const out = JSON.parse(await run('sokosumi_get_credits', {}));
    expect(out.plan).toBe('starter');
    expect(out.status).toBe('active');
    expect(out.totalRemaining).toBe(825); // subscription 800 + extra 25
    // It now DOES read /users/{id}/credits.
    expect(calls.some((c) => c.path.includes('/credits'))).toBe(true);
  });
});
