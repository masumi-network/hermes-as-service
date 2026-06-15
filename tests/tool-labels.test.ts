import { describe, it, expect } from 'vitest';
import { labelForBuiltinTool, summarizeResult } from '../src/routes/tool-labels.js';

describe('labelForBuiltinTool', () => {
  it('labels a coworker hand-off with the agent name and topic', () => {
    const r = labelForBuiltinTool(
      'create_coworker_task',
      JSON.stringify({ agent: 'Hannah', topic: 'Mixture-of-Experts routing' }),
    );
    expect(r.label).toBe('Asking Hannah');
    expect(r.detail).toBe('Mixture-of-Experts routing');
  });

  it('handles a coworker hand-off when only a topic-ish field is present', () => {
    const r = labelForBuiltinTool('create_job', JSON.stringify({ input: 'Make a 1x1 infographic' }));
    expect(r.label).toBe('Handing off to a coworker');
    expect(r.detail).toBe('Make a 1x1 infographic');
  });

  it('extracts agent + topic from create_job shape (agent_id, name, nested input_data)', () => {
    const r = labelForBuiltinTool(
      'create_job',
      JSON.stringify({ agent: 'Hepha', name: 'Weekly digest', input_data: { prompt: 'Make a 1x1 infographic' } }),
    );
    expect(r.label).toBe('Asking Hepha');
    expect(r.detail).toBe('Make a 1x1 infographic');
  });

  it('does not render a raw UUID/opaque id as the agent name', () => {
    const uuid = labelForBuiltinTool(
      'create_coworker_task',
      JSON.stringify({ coworker: '7f3a1c9e-2b44-4d0e-9c1a-1b2c3d4e5f60', description: 'Research MoE' }),
    );
    expect(uuid.label).toBe('Handing off to a coworker');
    expect(uuid.detail).toBe('Research MoE');

    const token = labelForBuiltinTool('create_job', JSON.stringify({ agent_id: 'cwk_01h9z3k7q2x8m4n5p6r7s8t9v0' }));
    expect(token.label).toBe('Handing off to a coworker');
  });

  it('maps Composio mail/calendar tool names to friendly labels', () => {
    expect(labelForBuiltinTool('GMAIL_FETCH_EMAILS').label).toBe('Working with your email');
    expect(labelForBuiltinTool('OUTLOOK_SEND_EMAIL').label).toBe('Working with your email');
    expect(labelForBuiltinTool('GOOGLECALENDAR_LIST_EVENTS').label).toBe('Checking your calendar');
  });

  it('falls back to generic coworker label with no parseable args', () => {
    expect(labelForBuiltinTool('create_coworker_task').label).toBe('Handing off to a coworker');
  });

  it('ignores partial (mid-stream) JSON args without throwing', () => {
    const r = labelForBuiltinTool('create_coworker_task', '{"agent":"Han');
    expect(r.label).toBe('Handing off to a coworker');
  });

  it('labels web search and surfaces the query', () => {
    const r = labelForBuiltinTool('web_search', JSON.stringify({ query: 'agentic workflows 2026' }));
    expect(r.label).toBe('Searching the web');
    expect(r.detail).toBe('agentic workflows 2026');
  });

  it('labels scheduling, memory, code, sokosumi, outbox families', () => {
    expect(labelForBuiltinTool('cronjob_create').label).toBe('Setting up your schedule');
    expect(labelForBuiltinTool('recall_memory').label).toBe('Checking what I remember');
    expect(labelForBuiltinTool('execute_python').label).toBe('Running some code');
    expect(labelForBuiltinTool('list_agents').label).toBe('Checking your Sokosumi workspace');
    expect(labelForBuiltinTool('sokosumi_list_jobs').label).toBe('Checking your Sokosumi workspace');
    expect(labelForBuiltinTool('outbox_send').label).toBe('Preparing a message for you');
  });

  it('humanises an unknown tool name as a last resort', () => {
    expect(labelForBuiltinTool('SOME_WEIRD_TOOL').label).toBe('Some weird tool');
    expect(labelForBuiltinTool('camelCaseTool').label).toBe('Camel case tool');
  });

  it('truncates very long detail to one line', () => {
    const long = 'x'.repeat(200);
    const r = labelForBuiltinTool('web_search', JSON.stringify({ query: long }));
    expect(r.detail!.length).toBeLessThanOrEqual(80);
    expect(r.detail!.endsWith('…')).toBe(true);
  });
});

describe('summarizeResult', () => {
  it('truncates long string content to one line', () => {
    const r = summarizeResult('a'.repeat(300));
    expect(r.length).toBeLessThanOrEqual(100);
    expect(r.endsWith('…')).toBe(true);
  });
  it('collapses whitespace/newlines', () => {
    expect(summarizeResult('line one\n\n  line two')).toBe('line one line two');
  });
  it('extracts text from OpenAI array content', () => {
    expect(summarizeResult([{ type: 'text', text: 'found 5 results' }])).toBe('found 5 results');
  });
  it('stringifies objects/other as a fallback', () => {
    expect(summarizeResult({ ok: true })).toBe('{"ok":true}');
    expect(summarizeResult(null)).toBe('');
  });
});

