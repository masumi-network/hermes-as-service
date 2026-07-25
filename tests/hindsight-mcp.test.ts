import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security property under test: a machine can only ever reach ITS OWN
 * memory bank. Hindsight binds the bank in the URL path (single-bank mode),
 * and the proxy builds that path from the AUTHENTICATED userId — so there is
 * no bank_id argument for an agent to tamper with.
 */
describe('forceBankPath — tenancy enforcement', () => {
  const UID = '8Z5tyaPc4LmMPB74hrXbi9huAa9QgJQz';

  it('rewrites the REST bank segment to the authenticated user', async () => {
    const { forceBankPath } = await import('../src/routes/hindsight-mcp.js');
    expect(forceBankPath('/v1/default/banks/someone-else/memories', UID)).toBe(
      `/v1/default/banks/${UID}/memories`,
    );
  });

  it('rewrites the MCP single-bank segment too', async () => {
    const { forceBankPath } = await import('../src/routes/hindsight-mcp.js');
    expect(forceBankPath('/mcp/attacker-bank/', UID)).toBe(`/mcp/${UID}/`);
  });

  it('rewrites EVERY bank occurrence in a path', async () => {
    const { forceBankPath } = await import('../src/routes/hindsight-mcp.js');
    expect(forceBankPath('/v1/default/banks/a/x/banks/b/y', UID)).toBe(
      `/v1/default/banks/${UID}/x/banks/${UID}/y`,
    );
  });

  it('URL-encodes the user id so it cannot escape its segment', async () => {
    const { forceBankPath } = await import('../src/routes/hindsight-mcp.js');
    const out = forceBankPath('/v1/default/banks/x/memories', '../other');
    expect(out).toBe('/v1/default/banks/..%2Fother/memories');
    expect(out).not.toContain('/banks/../');
  });

  it('leaves paths without a bank segment untouched', async () => {
    const { forceBankPath } = await import('../src/routes/hindsight-mcp.js');
    expect(forceBankPath('/health', UID)).toBe('/health');
  });
});

describe('hindsight proxy route', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    process.env['HINDSIGHT_MCP_URL'] = '';
    process.env['HINDSIGHT_MCP_TOKEN'] = '';
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...ORIG };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is OFF when HINDSIGHT_MCP_URL is unset — 503, no upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { hindsightMcpRouter } = await import('../src/routes/hindsight-mcp.js');
    const res = await hindsightMcpRouter.request('/v1/hindsight/i1/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer whatever', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/not configured/i);
    // Feature-off must short-circuit BEFORE any upstream/database work.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no bearer once configured', async () => {
    process.env['HINDSIGHT_MCP_URL'] = 'http://hindsight.test:8888';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { hindsightMcpRouter } = await import('../src/routes/hindsight-mcp.js');
    const res = await hindsightMcpRouter.request('/v1/hindsight/i1/mcp', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractSseJsonPayload — framing normalization', () => {
  it('unwraps a standard FastMCP SSE frame', async () => {
    const { extractSseJsonPayload } = await import('../src/routes/hindsight-mcp.js');
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    expect(extractSseJsonPayload(body)).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  });

  it('survives CRLF framing and a leading comment/ping', async () => {
    const { extractSseJsonPayload } = await import('../src/routes/hindsight-mcp.js');
    const body = ': ping\r\n\r\nevent: message\r\ndata: {"ok":true}\r\n\r\n';
    expect(extractSseJsonPayload(body)).toBe('{"ok":true}');
  });

  it('joins multi-line data payloads', async () => {
    const { extractSseJsonPayload } = await import('../src/routes/hindsight-mcp.js');
    const body = 'event: message\ndata: {"a":\ndata: 1}\n\n';
    expect(extractSseJsonPayload(body)).toBe('{"a":\n1}');
  });

  it('takes the LAST parseable frame when several arrive', async () => {
    const { extractSseJsonPayload } = await import('../src/routes/hindsight-mcp.js');
    const body = 'data: {"first":1}\n\ndata: {"second":2}\n\n';
    expect(extractSseJsonPayload(body)).toBe('{"second":2}');
  });

  it('returns null on unparseable / empty bodies (caller passes through)', async () => {
    const { extractSseJsonPayload } = await import('../src/routes/hindsight-mcp.js');
    expect(extractSseJsonPayload('')).toBeNull();
    expect(extractSseJsonPayload('event: message\ndata: not-json\n\n')).toBeNull();
    expect(extractSseJsonPayload('data: [DONE]\n\n')).toBeNull();
  });
});
