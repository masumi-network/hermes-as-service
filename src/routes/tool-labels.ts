// Maps machine tool names (as they appear in OpenRouter `tool_calls`) to the
// short, human labels the chat UI shows while the agent works — "Searching
// the web", "Asking Hannah to research…". The LLM proxy is the single source
// of progress (it sees every tool the agent decides to call, built-in and
// MCP alike), so this handles both Composio-style names (GMAIL_FETCH_EMAILS)
// and built-in ones (web_search, create_coworker_task).
//
// Pure functions, no I/O. Matchers are pattern-based on purpose: the exact
// tool catalog drifts over time, so we recognise families by prefix/verb and
// always fall back to a humanised version of the raw name rather than showing
// nothing.

export interface ToolLabel {
  label: string;
  detail?: string;
}

/** Coworker hand-off tools whose arguments we parse for an agent + topic. */
const COWORKER_TOOLS = new Set(['create_coworker_task', 'create_job', 'add_job_to_task']);

// Field names that may carry the agent identity / the task brief. Different
// coworker tools use different shapes: create_coworker_task → coworker +
// description; create_job / add_job_to_task → agent_id + input_data (object).
const AGENT_KEYS = ['agent', 'agentName', 'agent_name', 'coworker', 'coworkerName', 'agentId', 'agent_id'];
const TOPIC_KEYS = ['topic', 'task', 'prompt', 'message', 'description', 'query', 'instructions', 'input'];

/**
 * Label a tool call the agent decided to make. `rawArgs` is the
 * `function.arguments` JSON string from the tool_call (may be partial during
 * streaming — we parse best-effort and degrade to a generic label).
 */
export function labelForBuiltinTool(name: string, rawArgs?: string): ToolLabel {
  const n = name.toLowerCase();
  const args = safeParseArgs(rawArgs);

  if (COWORKER_TOOLS.has(n)) {
    const agentRaw = pickString(args, AGENT_KEYS);
    // Models often pass the agent by id/slug rather than a display name —
    // don't render a raw UUID at the user.
    const agent = agentRaw && !looksLikeId(agentRaw) ? agentRaw : undefined;
    const topic = pickTopic(args);
    if (agent && topic) return { label: `Asking ${agent}`, detail: truncate(topic) };
    if (agent) return { label: `Handing off to ${agent}` };
    if (topic) return { label: 'Handing off to a coworker', detail: truncate(topic) };
    return { label: 'Handing off to a coworker' };
  }

  // Composio mail / calendar (these reach us as the agent's tool decision,
  // e.g. GMAIL_FETCH_EMAILS, GOOGLECALENDAR_LIST_EVENTS, OUTLOOK_SEND_EMAIL).
  if (/calendar/.test(n)) return { label: 'Checking your calendar' };
  if (/gmail|outlook|(^|_)mail|email/.test(n)) return { label: 'Working with your email' };

  // Web search / browse.
  if (/(^|_)(web_)?search($|_)/.test(n) || n.includes('exa') || n.includes('browse') || n.includes('fetch_url') || n === 'fetch') {
    const q = pickString(args, ['query', 'q', 'search', 'url', 'topic']);
    return { label: 'Searching the web', ...(q ? { detail: truncate(q) } : {}) };
  }

  // Scheduling.
  if (n.includes('cron') || n.includes('schedule')) {
    return { label: 'Setting up your schedule' };
  }

  // Sokosumi workspace reads.
  if (n.startsWith('sokosumi') || /(^|_)(list|get)_(agent|agents|job|jobs|task|tasks|coworker|coworkers|categories)/.test(n)) {
    return { label: 'Checking your Sokosumi workspace' };
  }

  // Memory.
  if (n.includes('memory') || n.includes('remember') || n.includes('recall')) {
    return { label: 'Checking what I remember' };
  }

  // Code / shell execution.
  if (n.includes('exec') || n.includes('shell') || n.includes('python') || n.includes('code') || n.includes('terminal')) {
    return { label: 'Running some code' };
  }

  // Outbox.
  if (n.includes('outbox')) {
    return { label: 'Preparing a message for you' };
  }

  return { label: humanize(name) };
}

// ---------- helpers ----------

function safeParseArgs(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed[0] !== '{') return undefined; // partial streamed args
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function pickString(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Topic from a top-level field, or from a nested `input_data` object. */
function pickTopic(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const top = pickString(args, TOPIC_KEYS);
  if (top) return top;
  const nested = args['input_data'] ?? args['inputData'];
  if (nested && typeof nested === 'object') {
    return pickString(nested as Record<string, unknown>, TOPIC_KEYS);
  }
  return undefined;
}

/** True if a string looks like an opaque id/token rather than a display name. */
function looksLikeId(v: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true; // uuid
  if (!/\s/.test(v) && v.length > 24) return true; // long opaque token
  if (!/\s/.test(v) && v.length >= 16 && /\d/.test(v) && /^[A-Za-z0-9_-]+$/.test(v)) return true; // cuid/nanoid-ish
  return false;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Turn a tool-result payload into a short, single-line summary for a
 * `tool_done` chip. Tool results can be JSON, big text, or arrays; we just
 * want a legible hint, not the whole thing.
 */
export function summarizeResult(content: unknown, max = 100): string {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // OpenAI tool content can be an array of {type:'text', text} parts.
    text = content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join(' ');
    if (!text.trim()) text = JSON.stringify(content);
  } else if (content == null) {
    text = '';
  } else {
    text = JSON.stringify(content);
  }
  return truncate(text, max);
}

/** "GMAIL_FETCH_EMAILS" / "web_search" → "Gmail fetch emails" / "Web search". */
function humanize(name: string): string {
  const words = name
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'Working';
  const first = words[0]!;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}
