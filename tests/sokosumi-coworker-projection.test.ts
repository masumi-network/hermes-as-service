import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sokosumi-mcp.js resolves its config at module load, so the env has to be in
// place before the FIRST import anywhere in this file — and the import itself
// must be dynamic.
process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
const load = async () => import('../src/routes/sokosumi-mcp.js');

/**
 * sokosumi_list_coworkers returned 534,555 bytes on a real 9-workspace account
 * — roughly 130k tokens, half the context window, for one tool call. 90% of it
 * was a `metadata` blob (~4.6 KB per coworker) that the tool's own description
 * never promised and the agent cannot act on.
 */
describe('projectCoworker', () => {
  let projectCoworker: (raw: unknown) => Record<string, unknown>;
  beforeEach(async () => {
    projectCoworker = (await load()).projectCoworker as typeof projectCoworker;
  });
  afterEach(() => vi.resetModules());

  const RAW = {
    id: 'cw_1',
    slug: 'hannah',
    name: 'Hannah',
    caption: 'Research',
    description: 'Does deep research.',
    capabilities: ['research', 'summarize'],
    // Everything below must be dropped.
    metadata: { blob: 'x'.repeat(4600) },
    vendor: { name: 'v'.repeat(260) },
    image: 'https://example.test/' + 'i'.repeat(90),
    baseURL: 'https://example.test/agent',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    isWhitelisted: true,
    priority: 1,
    archivedAt: null,
    url: null,
  };

  it('keeps exactly the fields the tool description promises', () => {
    expect(projectCoworker(RAW)).toEqual({
      id: 'cw_1',
      slug: 'hannah',
      name: 'Hannah',
      caption: 'Research',
      description: 'Does deep research.',
      capabilities: ['research', 'summarize'],
    });
  });

  it('drops the metadata blob that was 90% of the payload', () => {
    const out = JSON.stringify(projectCoworker(RAW));
    expect(out).not.toContain('metadata');
    expect(out).not.toContain('vendor');
    expect(out).not.toContain('baseURL');
    expect(out.length).toBeLessThan(200);
  });

  it('cuts a realistic 108-coworker fan-out by >95%', () => {
    const rawBytes = JSON.stringify(Array.from({ length: 108 }, () => RAW), null, 2).length;
    const projBytes = JSON.stringify(Array.from({ length: 108 }, () => projectCoworker(RAW))).length;
    expect(rawBytes).toBeGreaterThan(500_000); // reproduces the observed scale
    expect(projBytes / rawBytes).toBeLessThan(0.05);
  });

  it('caps a runaway description', () => {
    const out = projectCoworker({ id: 'x', description: 'd'.repeat(5000) });
    expect((out.description ?? '').length).toBe(400);
  });

  it('omits absent fields rather than emitting nulls', () => {
    expect(projectCoworker({ id: 'x' })).toEqual({ id: 'x' });
    expect(projectCoworker({ id: 'x', capabilities: null })).toEqual({ id: 'x' });
  });

  it('survives junk input', () => {
    expect(projectCoworker(null)).toEqual({});
    expect(projectCoworker('nope')).toEqual({});
    expect(projectCoworker(42)).toEqual({});
  });
});

describe('sokosumi_list_coworkers end to end', () => {
  const CTX = {
    instanceId: 'i1',
    userId: 'user_1',
    env: 'mainnet' as const,
    autonomyLevel: 'high' as const,
  };

  beforeEach(() => {
    process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
    process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/v1/, '');
        let body: unknown = { data: [] };
        if (path.endsWith('/organizations')) {
          body = {
            data: Array.from({ length: 8 }, (_, i) => ({ id: `org_${i}`, name: `Org ${i}` })),
            meta: { pagination: { nextCursor: null, total: 8 } },
          };
        } else if (path === '/coworkers') {
          body = {
            data: Array.from({ length: 12 }, (_, i) => ({
              id: `cw_${i}`,
              name: `Coworker ${i}`,
              slug: `cw-${i}`,
              caption: 'cap',
              description: 'desc',
              capabilities: ['a'],
              metadata: { blob: 'x'.repeat(4600) },
              image: 'https://example.test/img',
            })),
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

  it('dedupes 108 entries down to 12 people, in a few KB', async () => {
    const { executeTool } = await load();
    const raw = await executeTool('sokosumi_list_coworkers', {}, CTX);
    const out = JSON.parse(raw);

    // 12 coworkers whitelisted in all 9 workspaces = 108 raw rows, 12 people.
    expect(out.count).toBe(12);
    // The old implementation produced >500KB for exactly this shape.
    expect(raw.length).toBeLessThan(10_000);
    expect(raw).not.toContain('metadata');

    // Still carries what the agent needs to choose a coworker...
    expect(out.coworkers[0]).toMatchObject({ id: 'cw_0', name: 'Coworker 0', slug: 'cw-0' });
    // ...and where it can assign them, without repeating the whole record.
    const orgIds = out.coworkers[0].availableIn.map((a: { orgId: string | null }) => a.orgId);
    expect(orgIds).toHaveLength(9);
    expect(orgIds).toContain(null); // personal
    expect(orgIds).toContain('org_7');
  });

  it('keeps a coworker that exists in only one workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
        const path = new URL(url).pathname.replace(/^\/v1/, '');
        const org = init.headers?.['X-Context-Organization-Id'];
        let body: unknown = { data: [] };
        if (path.endsWith('/organizations')) {
          body = { data: [{ id: 'org_0', name: 'Org 0' }], meta: { pagination: { nextCursor: null } } };
        } else if (path === '/coworkers') {
          body = {
            data: org
              ? [{ id: 'only_here', name: 'OrgOnly', slug: 'org-only' }]
              : [{ id: 'shared', name: 'Shared', slug: 'shared' }],
          };
        }
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_list_coworkers', {}, CTX));
    expect(out.count).toBe(2);
    const orgOnly = out.coworkers.find((c: { id: string }) => c.id === 'only_here');
    expect(orgOnly.availableIn).toEqual([{ orgId: 'org_0', orgName: 'Org 0' }]);
  });
});
