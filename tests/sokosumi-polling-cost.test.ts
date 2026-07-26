import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the two fixes that took the Sokosumi polling storm down: watermark
 * early-stop on pagination, and the workspace-scope cache.
 *
 * Baseline that motivated them: 4,648 API calls in 12 hours for ONE user, 93%
 * of all log volume, because two 5-minute sweeps each re-enumerated 9
 * workspaces and then paged a 647-job history to its end — every tick, to find
 * jobs that were all five months old.
 */

const BASE = 'https://api.example.test/v1';

interface Call {
  path: string;
  org: string | undefined;
  cursor: string | null;
}
let calls: Call[];

/** Seven pages of jobs, newest-first, every one of them ancient. */
function jobsPage(cursor: string | null): unknown {
  const pageIndex = cursor ? Number(cursor.replace('p', '')) : 0;
  const last = pageIndex >= 6;
  // Page 0 newest (2026-02), each later page a month older.
  const month = String(2 + (6 - pageIndex)).padStart(2, '0');
  return {
    data: Array.from({ length: last ? 47 : 100 }, (_, i) => ({
      id: `job-${pageIndex}-${i}`,
      status: 'completed',
      updatedAt: `2025-${month}-10T00:00:00.000Z`,
      completedAt: `2025-${month}-10T00:00:00.000Z`,
    })),
    meta: { pagination: { nextCursor: last ? null : `p${pageIndex + 1}`, total: 647 } },
  };
}

beforeEach(() => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = BASE;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v1/, '');
      const cursor = u.searchParams.get('cursor');
      calls.push({ path, org: init.headers?.['X-Context-Organization-Id'], cursor });
      let body: unknown = { data: [] };
      if (path.endsWith('/organizations')) {
        body = {
          data: Array.from({ length: 8 }, (_, i) => ({ id: `org_${i}`, name: `Org ${i}` })),
          meta: { pagination: { nextCursor: null, total: 8 } },
        };
      } else if (path === '/jobs') {
        body = jobsPage(cursor);
      }
      return { ok: true, status: 200, json: async () => body };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('pagination early-stop on a watermark', () => {
  it('stops after ONE page when the whole page predates the cutoff', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    // Watermark of "an hour ago" against a listing whose newest item is 2026-02.
    const res = await client.listAllJobs({
      maxItems: 500,
      stopWhenOlderThan: new Date('2026-07-26T00:00:00.000Z'),
    });
    expect(res.pages).toBe(1);
    expect(calls.filter((c) => c.path === '/jobs').length).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it('still pages fully with no watermark (unchanged behaviour)', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    const res = await client.listAllJobs({ maxItems: 1000 });
    expect(res.pages).toBe(7);
    expect(res.items.length).toBe(647);
  });

  it('does NOT stop early when the page straddles the cutoff', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    // Cutoff older than every item — nothing may be skipped.
    const res = await client.listAllJobs({
      maxItems: 1000,
      stopWhenOlderThan: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(res.pages).toBe(7);
  });

  it('never stops on a page whose items carry no parseable timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url);
        const cursor = u.searchParams.get('cursor');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: cursor ? 'b' : 'a' }],
            meta: { pagination: { nextCursor: cursor ? null : 'p1', total: 2 } },
          }),
        };
      }),
    );
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    const res = await client.listAllJobs({ stopWhenOlderThan: new Date() });
    expect(res.pages).toBe(2);
  });
});

describe('workspace-scope cache', () => {
  it('enumerates orgs once across repeated sweeps', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    for (let i = 0; i < 5; i++) await client.listWorkspaceScopes();
    expect(calls.filter((c) => c.path.endsWith('/organizations')).length).toBe(1);
  });

  it('still returns every scope from the cache', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    const first = await client.listWorkspaceScopes();
    const second = await client.listWorkspaceScopes();
    expect(first.length).toBe(9); // personal + 8 orgs
    expect(second).toEqual(first);
  });

  it('is keyed per user — one user cannot serve another from cache', async () => {
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    await new SokosumiClient('u1', 'mainnet').listWorkspaceScopes();
    await new SokosumiClient('u2', 'mainnet').listWorkspaceScopes();
    const orgCalls = calls.filter((c) => c.path.endsWith('/organizations'));
    expect(orgCalls.length).toBe(2);
    expect(orgCalls[0]!.path).toContain('u1');
    expect(orgCalls[1]!.path).toContain('u2');
  });

  it('does NOT cache a degraded personal-only result', async () => {
    // A swallowed 403 collapses the scope list to personal-only. Caching that
    // would pin the user to one workspace for the whole TTL.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/organizations')) {
          return {
            ok: false,
            status: 403,
            text: async () => 'User authentication required',
            json: async () => ({}),
          };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }),
    );
    const { SokosumiClient } = await import('../src/sokosumi/client.js');
    const client = new SokosumiClient('u1', 'mainnet');
    const a = await client.listWorkspaceScopes();
    const b = await client.listWorkspaceScopes();
    expect(a).toEqual([{ id: null, name: 'Personal' }]);
    expect(b).toEqual(a);
    // Retried rather than served stale.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it('invalidateWorkspaceScopeCache forces a re-enumeration', async () => {
    const mod = await import('../src/sokosumi/client.js');
    const client = new mod.SokosumiClient('u1', 'mainnet');
    await client.listWorkspaceScopes();
    mod.invalidateWorkspaceScopeCache('u1');
    await client.listWorkspaceScopes();
    expect(calls.filter((c) => c.path.endsWith('/organizations')).length).toBe(2);
  });
});

/*
 * The aged-paused-job BACKSTOP CADENCE that used to live here is gone.
 *
 * The predecessor sweep only ran the `?status=AWAITING_INPUT` listing every
 * 6th tick, to save one call per workspace. The merged board sweep runs it
 * every tick on purpose: a job that paused before the recency window could
 * otherwise sit unnoticed for half an hour, and a blocked job is the most
 * time-critical thing on the board. Detection latency beats the saved call.
 */
