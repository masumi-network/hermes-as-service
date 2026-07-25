import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hindsightBankUrl } from '../src/routes/hindsight-mcp.js';

/**
 * The security property under test: a machine can only ever reach ITS OWN
 * memory bank. Hindsight binds the bank in the URL path (single-bank mode),
 * and the proxy builds that path from the AUTHENTICATED userId — so there is
 * no bank_id argument for an agent to tamper with.
 */
describe('hindsightBankUrl — bank binding', () => {
  it('binds the bank from the userId in the path', () => {
    expect(hindsightBankUrl('http://hindsight.railway.internal:8888', 'user_1', '')).toBe(
      'http://hindsight.railway.internal:8888/mcp/user_1/',
    );
  });

  it('handles a real 32-char Sokosumi user id verbatim', () => {
    const uid = '8Z5tyaPc4LmMPB74hrXbi9huAa9QgJQz';
    expect(hindsightBankUrl('http://h:8888', uid, '')).toBe(`http://h:8888/mcp/${uid}/`);
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(hindsightBankUrl('http://h:8888/', 'u', '')).toBe('http://h:8888/mcp/u/');
  });

  it('appends a sub-path without losing the bank segment', () => {
    expect(hindsightBankUrl('http://h:8888', 'u', 'messages')).toBe('http://h:8888/mcp/u/messages');
  });

  it('URL-ENCODES a userId so it cannot escape its bank segment (path traversal)', () => {
    // A hostile/odd id must never produce a path that reaches another bank.
    const url = hindsightBankUrl('http://h:8888', '../other-bank', '');
    expect(url).toBe('http://h:8888/mcp/..%2Fother-bank/');
    expect(url).not.toContain('/mcp/../');
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
