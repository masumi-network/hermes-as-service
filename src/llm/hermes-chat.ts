/** Shared helpers for driving a single Hermes agent turn over the machine's
 *  OpenAI-compatible endpoint. Extracted from byte-identical copies in
 *  sokosumi/sync.ts and inbox/refresh.ts (callHermesChat) and the duplicated
 *  response-parse blocks in schedules/scheduler.ts and
 *  notifications/cron-agent-turn.ts (parseChatCompletion). */

/** Fire one user-message turn and throw on non-2xx. Callers pick the timeout. */
export async function callHermesChat(
  endpointUrl: string,
  apiKey: string,
  userMessage: string,
  timeoutMs: number,
): Promise<void> {
  const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: userMessage }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`callHermesChat ${res.status}: ${body.slice(0, 200)}`);
  }
}

export interface ParsedChatCompletion {
  content: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  errorMessage: string | null;
}

/** Pure text-in/fields-out parse of a non-streaming chat completion body.
 *  Unparseable input yields content = first 4000 chars + the sentinel error.
 *  HTTP-status handling stays with the callers. */
export function parseChatCompletion(text: string): ParsedChatCompletion {
  const out: ParsedChatCompletion = {
    content: '',
    model: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    finishReason: null,
    errorMessage: null,
  };
  try {
    const json = JSON.parse(text) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
      error?: { message?: string };
    };
    if (json.error?.message) out.errorMessage = json.error.message;
    out.content = json.choices?.[0]?.message?.content ?? '';
    out.finishReason = json.choices?.[0]?.finish_reason ?? null;
    out.model = json.model ?? null;
    out.promptTokens = json.usage?.prompt_tokens ?? null;
    out.completionTokens = json.usage?.completion_tokens ?? null;
    out.totalTokens = json.usage?.total_tokens ?? null;
  } catch {
    out.content = text.slice(0, 4000);
    out.errorMessage = 'unparseable_response';
  }
  return out;
}
