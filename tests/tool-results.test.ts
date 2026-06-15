import { describe, it, expect } from 'vitest';
import { extractTrailingToolResults } from '../src/routes/llm-proxy.js';

describe('extractTrailingToolResults', () => {
  it('returns the trailing tool round, named via tool_call_id', () => {
    const messages = [
      { role: 'user', content: 'research MoE and summarize' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'web_search' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Top results: A, B, C about mixture-of-experts' },
    ];
    const r = extractTrailingToolResults(messages);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('web_search');
    expect(r[0]!.id).toBe('call_1');
    expect(r[0]!.summary).toContain('mixture-of-experts');
  });

  it('only returns the LATEST round, not earlier tool results', () => {
    const messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'web_search' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'round 1 results' },
      { role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'GMAIL_FETCH_EMAILS' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'round 2 results' },
    ];
    const r = extractTrailingToolResults(messages);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('c2');
    expect(r[0]!.name).toBe('GMAIL_FETCH_EMAILS');
    expect(r[0]!.summary).toBe('round 2 results');
  });

  it('handles multiple parallel tool results in one round', () => {
    const messages = [
      { role: 'assistant', tool_calls: [
        { id: 'a', function: { name: 'web_search' } },
        { id: 'b', function: { name: 'sokosumi_list_jobs' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'web stuff' },
      { role: 'tool', tool_call_id: 'b', content: 'jobs stuff' },
    ];
    const r = extractTrailingToolResults(messages);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.map((x) => x.name)).toEqual(['web_search', 'sokosumi_list_jobs']);
  });

  it('returns [] when the conversation does not end in tool results', () => {
    expect(extractTrailingToolResults([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])).toEqual([]);
    expect(extractTrailingToolResults([])).toEqual([]);
    expect(extractTrailingToolResults(undefined)).toEqual([]);
  });

  it('falls back to the tool message name when id is unmapped', () => {
    const r = extractTrailingToolResults([
      { role: 'tool', name: 'some_tool', content: 'done' },
    ]);
    expect(r[0]!.name).toBe('some_tool');
    expect(r[0]!.id).toBeUndefined();
  });
});
