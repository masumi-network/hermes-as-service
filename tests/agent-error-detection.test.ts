import { describe, expect, it } from 'vitest';
import { parseChatCompletion } from '../src/llm/hermes-chat.js';
import { looksLikeMonitor } from '../src/schedules/monitor-cron-reaper.js';

/** The 2026-07-28 outage shape: Hermes reports agent-loop failure INSIDE an
 *  HTTP 200 body. Sweeps that treat it as a clean reply permanently drop the
 *  items they claimed for the turn. */
describe('parseChatCompletion — agent-level failure surfaces as an error', () => {
  const outageBody = JSON.stringify({
    choices: [{ message: { content: 'HTTP 401: Missing Authentication header' }, finish_reason: 'error' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: 'hermes-agent',
    hermes: { completed: false, failed: true, error: 'HTTP 401: Missing Authentication header' },
  });

  it('flags the exact outage response as failed', () => {
    const p = parseChatCompletion(outageBody);
    expect(p.errorMessage).toContain('401');
  });

  it('flags finish_reason=error even without a hermes block', () => {
    const p = parseChatCompletion(
      JSON.stringify({ choices: [{ message: { content: 'boom' }, finish_reason: 'error' }] }),
    );
    expect(p.errorMessage).toBe('boom');
  });

  it('leaves a healthy reply untouched', () => {
    const p = parseChatCompletion(
      JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }),
    );
    expect(p.errorMessage).toBeNull();
    expect(p.content).toBe('pong');
  });
});

describe('monitor-cron reaper — conservative matching', () => {
  const uuid = '019fa44c-c4ec-75f9-9a82-7c2480c19a63';
  it('matches by monitor- name prefix regardless of schedule', () => {
    expect(looksLikeMonitor('monitor-x402-aioncardano-post', '*/15 * * * *', null)).toBe(true);
  });
  it('matches high-frequency crons only when the prompt names a task', () => {
    expect(looksLikeMonitor('check-thing', '*/15 * * * *', `poll task ${uuid}`)).toBe(true);
    expect(looksLikeMonitor('check-thing', '*/15 * * * *', 'poll the board')).toBe(false);
  });
  it('never matches routines: hourly/daily crons are not monitors', () => {
    expect(looksLikeMonitor('weekly-wrap', '0 14 * * 5', `mentions ${uuid}`)).toBe(false);
    expect(looksLikeMonitor('daily-brief', '0 7 * * *', `mentions ${uuid}`)).toBe(false);
  });
  it('is not state-corrupted by repeated calls (the /g lastIndex trap)', () => {
    for (let i = 0; i < 4; i++) {
      expect(looksLikeMonitor('check-thing', '*/15 * * * *', `poll ${uuid}`)).toBe(true);
    }
  });
});
