import { describe, it, expect } from 'vitest';
import {
  handleToolsListResponse,
  isComposioUpstream,
  isToolsCallToWriteVerb,
} from '../src/routes/mcp-proxy.js';
import { resolveSokosumiTarget } from '../src/sokosumi/client.js';

describe('handleToolsListResponse — read-only filter for MCP tools/list', () => {
  it('strips write-verb tools from a JSON tools/list result', () => {
    const upstream = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'GMAIL_FETCH_EMAILS' },
          { name: 'GMAIL_SEND_EMAIL' },
          { name: 'GMAIL_CREATE_DRAFT' },
          { name: 'GMAIL_LIST_LABELS' },
          { name: 'GMAIL_DELETE_MESSAGE' },
        ],
      },
    });
    const out = handleToolsListResponse(upstream, 200, 'gmail');
    expect(out.action).toBe('filtered');
    const parsed = JSON.parse(out.body) as { result: { tools: { name: string }[] } };
    const names = parsed.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_LABELS']);
  });

  it('strips write-verb tools from an SSE-framed tools/list result', () => {
    const upstream =
      'event: message\n' +
      'data: ' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'OUTLOOK_READ_INBOX' },
            { name: 'OUTLOOK_REPLY_EMAIL' },
            { name: 'OUTLOOK_FORWARD_EMAIL' },
          ],
        },
      }) +
      '\n';
    const out = handleToolsListResponse(upstream, 200, 'outlook');
    expect(out.action).toBe('filtered');
    // SSE framing is preserved
    expect(out.body).toMatch(/^event: message\ndata: \{/);
    const dataLine = out.body.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(dataLine.slice('data: '.length)) as {
      result: { tools: { name: string }[] };
    };
    expect(json.result.tools.map((t) => t.name)).toEqual(['OUTLOOK_READ_INBOX']);
  });

  it('passes through HTTP 202 + empty body as the deferred-via-SSE pattern', () => {
    const out = handleToolsListResponse('', 202, 'gmail');
    expect(out.action).toBe('deferred');
    expect(out.body).toBe('');
    expect(out.logMeta).toMatchObject({ status: 202, empty: true });
  });

  it('passes through HTTP 200 + empty body without throwing', () => {
    // This was the case that previously 502'd: JSON.parse('') → SyntaxError.
    const out = handleToolsListResponse('', 200, 'gmail');
    expect(out.action).toBe('deferred');
    expect(out.body).toBe('');
  });

  it('passes through HTTP 204 No Content unchanged', () => {
    const out = handleToolsListResponse('', 204, 'outlook');
    expect(out.action).toBe('deferred');
    expect(out.body).toBe('');
  });

  it('passes through an unparseable body unchanged (does not 502)', () => {
    const out = handleToolsListResponse('this is not json', 200, 'gmail');
    expect(out.action).toBe('unparseable');
    expect(out.body).toBe('this is not json');
    expect(out.logMeta.status).toBe(200);
  });

  it('preserves a tools/list response that has no tools[] (e.g. error response)', () => {
    const upstream = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'session not initialized' },
    });
    const out = handleToolsListResponse(upstream, 200, 'gmail');
    expect(out.action).toBe('filtered');
    const parsed = JSON.parse(out.body) as { error: { code: number } };
    expect(parsed.error.code).toBe(-32000);
  });
});

describe('isComposioUpstream — auth-header heuristic', () => {
  it('matches apollo.composio.dev URLs', () => {
    expect(isComposioUpstream('https://apollo.composio.dev/v3/mcp/abc?user_id=u1')).toBe(true);
  });
  it('matches backend.composio.dev URLs', () => {
    expect(isComposioUpstream('https://backend.composio.dev/v3/mcp/abc?user_id=u1')).toBe(true);
  });
  it('matches mcp.composio.dev URLs', () => {
    expect(isComposioUpstream('https://mcp.composio.dev/v3/mcp/abc')).toBe(true);
  });
  it('matches composio.ai URLs', () => {
    expect(isComposioUpstream('https://api.composio.ai/v3/mcp/abc')).toBe(true);
  });
  it('matches Vercel-hosted Composio MCP URLs (apollo-<id>-composio.vercel.app)', () => {
    // This was the gap that caused silent 401s before the fix.
    expect(
      isComposioUpstream('https://apollo-9k7vy3-composio.vercel.app/v3/mcp/abc?user_id=u1'),
    ).toBe(true);
  });
  it('matches generic composio-<x>.vercel.app pattern', () => {
    expect(isComposioUpstream('https://composio-prod.vercel.app/v3/mcp/abc')).toBe(true);
  });
  it('does NOT match unrelated hosts', () => {
    expect(isComposioUpstream('https://api.openai.com/v1/foo')).toBe(false);
    expect(isComposioUpstream('https://random.vercel.app/v3/mcp/abc')).toBe(false);
    expect(isComposioUpstream('not-a-url')).toBe(false);
  });
});

describe('isToolsCallToWriteVerb — defense-in-depth block', () => {
  const rpc = (method: string, name?: string) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: name ? { name } : {} });

  it('flags tools/call for a write verb tool', () => {
    expect(isToolsCallToWriteVerb(rpc('tools/call', 'GMAIL_SEND_EMAIL'))).toBe('GMAIL_SEND_EMAIL');
    expect(isToolsCallToWriteVerb(rpc('tools/call', 'GMAIL_DELETE_MESSAGE'))).toBe(
      'GMAIL_DELETE_MESSAGE',
    );
    expect(isToolsCallToWriteVerb(rpc('tools/call', 'OUTLOOK_REPLY_EMAIL'))).toBe(
      'OUTLOOK_REPLY_EMAIL',
    );
  });

  it('does NOT flag read-tool tools/call', () => {
    expect(isToolsCallToWriteVerb(rpc('tools/call', 'GMAIL_FETCH_EMAILS'))).toBeNull();
    expect(isToolsCallToWriteVerb(rpc('tools/call', 'GMAIL_LIST_LABELS'))).toBeNull();
  });

  it('does NOT flag tools/list (only tools/call is gated here)', () => {
    expect(isToolsCallToWriteVerb(rpc('tools/list'))).toBeNull();
  });

  it('handles missing/garbage body gracefully', () => {
    expect(isToolsCallToWriteVerb(undefined)).toBeNull();
    expect(isToolsCallToWriteVerb('')).toBeNull();
    expect(isToolsCallToWriteVerb('not json')).toBeNull();
  });
});

describe('resolveSokosumiTarget — userid+env override', () => {
  const PATRICK_RAW = '019e1de5-1c27-711b-9918-da5b601d48b1';
  const PATRICK_PREPROD = '993Sp1dOvyn4CFCEHIQPu1vn4ZVI0Dh4';

  it('redirects Patrick to preprod when Sokosumi UI provisions on development', () => {
    const out = resolveSokosumiTarget(PATRICK_RAW, 'development');
    expect(out.userId).toBe(PATRICK_PREPROD);
    expect(out.env).toBe('preprod');
  });

  it('redirects Patrick to preprod when Sokosumi UI provisions on mainnet', () => {
    const out = resolveSokosumiTarget(PATRICK_RAW, 'mainnet');
    expect(out.userId).toBe(PATRICK_PREPROD);
    expect(out.env).toBe('preprod');
  });

  it('redirects Patrick to preprod when Sokosumi UI provisions on null env', () => {
    const out = resolveSokosumiTarget(PATRICK_RAW, null);
    expect(out.userId).toBe(PATRICK_PREPROD);
    expect(out.env).toBe('preprod');
  });

  it('leaves unknown users + envs unchanged', () => {
    const out = resolveSokosumiTarget('some-other-user', 'mainnet');
    expect(out.userId).toBe('some-other-user');
    expect(out.env).toBe('mainnet');
  });

  it('leaves a real preprod user unchanged', () => {
    const out = resolveSokosumiTarget(PATRICK_PREPROD, 'preprod');
    expect(out.userId).toBe(PATRICK_PREPROD);
    expect(out.env).toBe('preprod');
  });
});
