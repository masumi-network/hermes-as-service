import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hermes cron/sweep sessions are history-blind by design, so a task-responding
 * sweep with no context defaults to "ask the user" instead of acting on what it
 * knows. runCronAgentTurn can now prepend recent chat history so the agent has
 * the conversation to reason from.
 */

const findMany = vi.fn();
const create = vi.fn();
vi.mock('../src/db.js', () => ({
  prisma: { chatMessage: { findMany: (...a: unknown[]) => findMany(...a), create: (...a: unknown[]) => create(...a) } },
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  // Newest-first, as the query orders desc; the turn reverses to chronological.
  findMany.mockReset().mockResolvedValue([
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'A1' },
  ]);
  create.mockReset().mockResolvedValue({});
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'reply' } }] }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function run(extra: Record<string, unknown>) {
  const { runCronAgentTurn } = await import('../src/notifications/cron-agent-turn.js');
  return runCronAgentTurn({
    instanceId: 'i',
    userId: 'u',
    endpointUrl: 'https://m.test',
    apiKey: 'k',
    source: 'taskboard_assistant',
    prompt: 'PROMPT',
    timeoutMs: 1000,
    ...extra,
  });
}
const sentMessages = () => JSON.parse(fetchMock.mock.calls[0]![1].body as string).messages;

describe('runCronAgentTurn history injection', () => {
  it('sends the prompt alone by default (no history loaded)', async () => {
    await run({});
    expect(findMany).not.toHaveBeenCalled();
    expect(sentMessages()).toEqual([{ role: 'user', content: 'PROMPT' }]);
  });

  it('prepends recent chat (chronological) then the prompt when includeHistory is set', async () => {
    await run({ includeHistory: 8 });
    expect(sentMessages()).toEqual([
      { role: 'user', content: 'A1' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'PROMPT' },
    ]);
    const q = findMany.mock.calls[0]![0] as { take: number; where: Record<string, unknown>; orderBy: unknown };
    expect(q.take).toBe(8);
    expect(q.where.kind).toBe('chat'); // real conversation only, not prior cron turns
    expect(q.where.role).toEqual({ in: ['user', 'assistant'] });
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('degrades to the prompt alone if history loading fails', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await run({ includeHistory: 8 });
    expect(sentMessages()).toEqual([{ role: 'user', content: 'PROMPT' }]);
  });
});
