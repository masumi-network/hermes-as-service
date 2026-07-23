import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sokosumi #3394 ("block coworker impersonation via user context") flipped
 * `requireAccessToTargetUserData` to `requireUserAuthContext`, making every
 * `/v1/users/{id}/*` route session-only. Our orchestrator service token now
 * gets a hard 403 on org enumeration and credits.
 *
 * That broke the whole sweep, because the fan-out was driven ONLY by the
 * enumerated orgs: no orgs → no clients → no tasks, jobs or coworkers, even
 * though those endpoints still answer perfectly well. These tests pin the
 * fix — the personal workspace is always swept — so the bug can't come back.
 */

const ORG_403 = {
  ok: false,
  status: 403,
  text: async () =>
    JSON.stringify({ error: 'Forbidden', message: 'User authentication required' }),
};

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
  process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function makeClient() {
  const { SokosumiClient } = await import('../src/sokosumi/client.js');
  return new SokosumiClient('user_1', 'mainnet');
}

describe('workspace scopes after the /users/{id}/* lockout', () => {
  it('listOrganizations degrades to [] on the session-only 403', async () => {
    fetchMock.mockResolvedValue(ORG_403);
    const client = await makeClient();
    await expect(client.listOrganizations()).resolves.toEqual([]);
  });

  it('still throws on errors that are NOT the session-only lockout', async () => {
    // A 500 must stay loud — swallowing every failure would silently blind us.
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const client = await makeClient();
    await expect(client.listOrganizations()).rejects.toThrow(/500/);
  });

  it('listWorkspaceScopes yields the personal workspace even when orgs 403', async () => {
    fetchMock.mockResolvedValue(ORG_403);
    const client = await makeClient();
    const scopes = await client.listWorkspaceScopes();
    // This is the regression that took Hermes down: an empty list here meant
    // every fan-out (`scopes.slice(0,5).map(...)`) produced zero requests.
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.id).toBeNull();
  });

  it('puts the personal workspace first, then real orgs', async () => {
    fetchMock.mockResolvedValue(jsonOk({ data: [{ id: 'org_a', name: 'Acme' }] }));
    const client = await makeClient();
    const scopes = await client.listWorkspaceScopes();
    expect(scopes.map((s) => s.id)).toEqual([null, 'org_a']);
  });

  it('withOrganization(null) sends NO org header — that is the personal workspace', async () => {
    fetchMock.mockResolvedValue(jsonOk({ data: [] }));
    const client = await makeClient();
    expect(client.withOrganization(null)).toBe(client);

    await client.withOrganization(null).listTasks({ limit: 1 });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers['X-Context-User-Id']).toBe('user_1');
    expect(headers['X-Context-Organization-Id']).toBeUndefined();
  });

  it('withOrganization(id) still scopes to that org', async () => {
    fetchMock.mockResolvedValue(jsonOk({ data: [] }));
    const client = await makeClient();
    await client.withOrganization('org_a').listTasks({ limit: 1 });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers['X-Context-Organization-Id']).toBe('org_a');
  });

  it('getCredits returns null instead of throwing when locked out', async () => {
    fetchMock.mockResolvedValue(ORG_403);
    const client = await makeClient();
    await expect(client.getCredits()).resolves.toBeNull();
  });
});
