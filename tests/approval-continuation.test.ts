import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When a write raises a confirmation card the agent's turn ends there, so a
 * planned follow-up ("create the task, THEN comment on it") was lost — approval
 * only ran the create. runApprovalContinuation resumes the agent: replays the
 * recent conversation + a note that the action is done, and lets it finish.
 */

const findMany = vi.fn();
vi.mock('../src/db.js', () => ({
  prisma: { chatMessage: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
vi.mock('../src/crypto.js', () => ({ decryptSecret: async () => 'api-key' }));

let fetchMock: ReturnType<typeof vi.fn>;
const inst = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  userId: 'u1',
  endpointUrl: 'https://machine.test',
  apiServerKey: 'enc',
  autonomyLevel: 'medium',
  ...over,
});

beforeEach(() => {
  vi.resetModules();
  // Newest-first (the code orders desc then reverses to chronological).
  findMany.mockReset().mockResolvedValue([
    { role: 'assistant', content: "I've queued the task. I'll comment right after." },
    { role: 'user', content: 'create a task then comment on it for hannah' },
  ]);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function agentReplies(text: string) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
}
async function run(args: { instance: ReturnType<typeof inst>; toolName: string; resultText: string }) {
  const { runApprovalContinuation } = await import('../src/confirmations/continuation.js');
  return runApprovalContinuation(args);
}

describe('runApprovalContinuation', () => {
  it('replays history + a nudge naming the approved tool, returns the agent summary', async () => {
    agentReplies('Created "Test Task" for Hannah and added a comment on it.');
    const out = await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{"id":"tsk_1","name":"Test Task"}' });

    expect(out).toBe('Created "Test Task" for Hannah and added a comment on it.');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toHaveLength(3); // 2 history + 1 nudge
    // history came through in chronological order
    expect(body.messages[0].content).toContain('create a task then comment');
    // the nudge is last and tells the agent the action was approved + done
    const nudge = body.messages.at(-1);
    expect(nudge.role).toBe('user');
    expect(nudge.content).toContain('sokosumi_create_task');
    expect(nudge.content).toContain('APPROVED');
    expect(nudge.content).toContain('tsk_1'); // the result is included
  });

  it('history query is bounded + newest-first (take 10, desc)', async () => {
    agentReplies('done.');
    await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{}' });
    const arg = findMany.mock.calls[0]![0] as { take: number; orderBy: { createdAt: string }; where: Record<string, unknown> };
    expect(arg.take).toBe(10);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.where.role).toEqual({ in: ['user', 'assistant'] });
  });

  it('returns null (→ canned fallback) when the agent replies [SILENT]', async () => {
    agentReplies('[SILENT]');
    expect(await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{}' })).toBeNull();
  });

  it('returns null on empty / whitespace agent reply', async () => {
    agentReplies('   ');
    expect(await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{}' })).toBeNull();
  });

  it('never fires at low autonomy, or without an endpoint (no agent call)', async () => {
    expect(await run({ instance: inst({ autonomyLevel: 'low' }), toolName: 'x', resultText: '{}' })).toBeNull();
    expect(await run({ instance: inst({ endpointUrl: null }), toolName: 'x', resultText: '{}' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows machine errors and returns null (caller falls back to canned)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{}' })).toBeNull();
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await run({ instance: inst(), toolName: 'sokosumi_create_task', resultText: '{}' })).toBeNull();
  });
});
