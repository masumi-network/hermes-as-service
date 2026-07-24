import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sokosumi lists are cursor-paginated and the org fan-out used to hard-cap at
 * 5 scopes. These drive the real executeTool dispatcher through a fetch mock
 * to prove list_tasks (a) fans out over EVERY workspace (personal + all orgs,
 * not just 5) and (b) follows nextCursor to page each workspace fully.
 */

const CTX = { instanceId: 'i1', userId: 'user_1', env: 'mainnet' as const, autonomyLevel: 'high' as const };

interface Call {
  path: string;
  org: string | undefined;
  cursor: string | null;
}
let calls: Call[];

beforeEach(() => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v1/, '');
      const org = init.headers?.['X-Context-Organization-Id'];
      const cursor = u.searchParams.get('cursor');
      calls.push({ path, org, cursor });
      let body: unknown = { data: [] };
      if (path.endsWith('/organizations')) {
        // 8 orgs, single page.
        body = {
          data: Array.from({ length: 8 }, (_, i) => ({ id: `org_${i}`, name: `Org ${i}` })),
          meta: { pagination: { nextCursor: null, total: 8 } },
        };
      } else if (path === '/tasks') {
        // Two cursor pages per workspace: page 1 (2 + nextCursor), page 2 (1, end).
        const tag = org ?? 'personal';
        body = cursor
          ? { data: [{ id: `${tag}-t3`, status: 'READY' }], meta: { pagination: { nextCursor: null, total: 3 } } }
          : {
              data: [
                { id: `${tag}-t1`, status: 'READY' },
                { id: `${tag}-t2`, status: 'READY' },
              ],
              meta: { pagination: { nextCursor: 'c1', total: 3 } },
            };
      }
      return { ok: true, status: 200, json: async () => body };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function run(name: string, args: Record<string, unknown>) {
  const { executeTool } = await import('../src/routes/sokosumi-mcp.js');
  return executeTool(name, args, CTX);
}

describe('list_tasks — full workspace fan-out + cursor pagination', () => {
  it('spans personal + all 8 orgs (not capped at 5) and pages each fully', async () => {
    const out = JSON.parse(await run('sokosumi_list_tasks', { limit: 200 }));

    // 9 scopes × 3 tasks (2 pages each) = 27.
    expect(out.tasks.length).toBe(27);
    expect(out.total).toBe(27); // sum of per-scope API totals (9 × 3)
    expect(out.truncated).toBe(false);

    // Fanned out over EVERY workspace — personal + org_0..org_7 = 9 distinct.
    const taskScopes = new Set(calls.filter((c) => c.path === '/tasks').map((c) => c.org ?? 'personal'));
    expect(taskScopes.size).toBe(9);

    // Each scope followed nextCursor to a 2nd page.
    const secondPages = calls.filter((c) => c.path === '/tasks' && c.cursor === 'c1');
    expect(secondPages.length).toBe(9);
  });
});
