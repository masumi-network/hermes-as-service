import { randomUUID } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Drive a single agent turn from a background sweep AND capture it durably
 * as a pair of ChatMessage rows (kind='cron', shared requestId) so the
 * admin can open /admin/chats/:requestId and read exactly what the cron
 * sent and what the agent replied — the prompt/response were previously
 * discarded (only a log snippet survived).
 *
 * Returns the requestId (join key for the admin UI) plus the reply text
 * and ok flag. Never throws — a capture/agent failure still returns a
 * requestId with the error recorded on the assistant row.
 */
export async function runCronAgentTurn(opts: {
  instanceId: string;
  userId: string;
  endpointUrl: string;
  apiKey: string;
  /** Which sweep drove this — stored on the messages for filtering. */
  source: string;
  prompt: string;
  timeoutMs: number;
}): Promise<{ requestId: string; reply: string; ok: boolean }> {
  const { instanceId, userId, endpointUrl, apiKey, source, prompt, timeoutMs } = opts;
  const requestId = randomUUID();
  const t0 = Date.now();

  // Persist the prompt first so it survives even if the call hangs.
  await prisma.chatMessage
    .create({
      data: { instanceId, userId, requestId, role: 'user', content: prompt, kind: 'cron' },
    })
    .catch((err) => logger.warn({ err, source }, 'cron_turn_prompt_persist_failed'));

  let reply = '';
  let errorMessage: string | null = null;
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let finishReason: string | null = null;

  try {
    const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hermes-agent', messages: [{ role: 'user', content: prompt }], stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      errorMessage = `upstream_${res.status}: ${text.slice(0, 200)}`;
    } else {
      try {
        const json = JSON.parse(text) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          model?: string;
          error?: { message?: string };
        };
        if (json.error?.message) errorMessage = json.error.message;
        reply = json.choices?.[0]?.message?.content ?? '';
        finishReason = json.choices?.[0]?.finish_reason ?? null;
        model = json.model ?? null;
        promptTokens = json.usage?.prompt_tokens ?? null;
        completionTokens = json.usage?.completion_tokens ?? null;
        totalTokens = json.usage?.total_tokens ?? null;
      } catch {
        reply = text.slice(0, 4000);
        errorMessage = 'unparseable_response';
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await prisma.chatMessage
    .create({
      data: {
        instanceId,
        userId,
        requestId,
        role: 'assistant',
        content: reply,
        kind: 'cron',
        model: model ?? undefined,
        promptTokens: promptTokens ?? undefined,
        completionTokens: completionTokens ?? undefined,
        totalTokens: totalTokens ?? undefined,
        finishReason: finishReason ?? undefined,
        latencyMs: Date.now() - t0,
        errorMessage: errorMessage ?? undefined,
      },
    })
    .catch((err) => logger.warn({ err, source }, 'cron_turn_reply_persist_failed'));

  if (errorMessage) throw Object.assign(new Error(errorMessage), { requestId });
  return { requestId, reply, ok: true };
}
