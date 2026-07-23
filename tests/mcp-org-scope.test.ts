import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After Sokosumi #3394 the orchestrator can no longer enumerate a user's orgs.
 * The org-scoping USE path still works — Sokosumi validates membership
 * server-side — so an explicit organization_id (the user's workspace pick on a
 * confirmation card) must be TRUSTED, not rejected against a dead enumeration.
 *
 * These drive the real executeTool dispatcher through a fetch mock so we test
 * the actual header + endpoint behaviour, not a paraphrase of it.
 */

const CTX = { instanceId: 'i1', userId: 'user_1', env: 'mainnet' as const, autonomyLevel: 'high' as const };

interface Call {
  method: string;
  path: string;
  org: string | undefined;
}
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Route a request to a canned response by (method, pathname). */
function router(method: string, pathname: string): unknown {
  if (pathname === '/coworkers') return { data: [{ id: 'cow_1', slug: 'hannah', name: 'Hannah' }] };
  if (pathname === '/tasks' && method === 'POST') return { data: { id: 'tsk_new', status: 'READY' } };
  if (pathname === '/agents/agent_1/jobs' && method === 'POST') return { data: { id: 'job_new' } };
  return { data: [] };
}

beforeEach(() => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
  calls = [];
  fetchMock = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname.replace(/^\/v1/, ''), org: init.headers?.['X-Context-Organization-Id'] });
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
      input_schema: {},
      organization_id: 'org_a',
    });
    const jobCall = calls.find((c) => c.path === '/agents/agent_1/jobs');
    expect(jobCall?.org).toBe('org_a');
    expect(JSON.parse(out).orgId).toBe('org_a');
  });

  it('create_job without an org runs in the personal workspace', async () => {
    const out = await run('sokosumi_create_job', { agent_id: 'agent_1', input_schema: {} });
    const jobCall = calls.find((c) => c.path === '/agents/agent_1/jobs');
    expect(jobCall?.org).toBeUndefined();
    expect(JSON.parse(out).orgId).toBeNull();
  });

  it('get_credits reports balances are unavailable rather than faking a null number', async () => {
    const out = JSON.parse(await run('sokosumi_get_credits', {}));
    expect(out.available).toBe(false);
    // And it must not have hit the session-only /users/{id}/credits at all.
    expect(calls.some((c) => c.path.includes('/credits'))).toBe(false);
  });
});
