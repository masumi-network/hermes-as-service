// Builds the .env file written into /opt/data/.env inside a user sprite.
// Hermes loads this on every startup (HERMES_HOME=/opt/data).

interface DotenvInputs {
  apiServerKey: string;
  /** Per-instance bearer the sprite uses to talk to the orchestrator's LLM proxy. */
  llmProxyToken: string;
  /** Orchestrator's public hostname, used to construct OPENROUTER_BASE_URL. */
  orchestratorPublicUrl: string;
  /** The instance's UUID (path component of the OpenRouter base URL). */
  instanceId: string;
  /** Real Exa key (orchestrator-owned). Empty/undefined to skip injection. */
  exaApiKey?: string;
  extra?: Record<string, string>;
}

export function buildHermesDotenv(args: DotenvInputs): string {
  const baseUrl = `${args.orchestratorPublicUrl.replace(/\/$/, '')}/v1/llm/${args.instanceId}`;
  const base: Record<string, string> = {
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '0.0.0.0',
    API_SERVER_PORT: '8642',
    API_SERVER_KEY: args.apiServerKey,
    API_SERVER_MODEL_NAME: 'hermes-agent',

    // CRITICAL: real OpenRouter key never lands on the sprite. Instead the
    // sprite talks to the orchestrator's LLM proxy with a per-instance
    // bearer. The orchestrator swaps in the real key when forwarding.
    OPENROUTER_API_KEY: args.llmProxyToken,
    OPENROUTER_BASE_URL: baseUrl,

    HERMES_HOME: '/opt/data',
    TERMINAL_ENV: 'local',
    HERMES_QUIET: '1',
    GATEWAY_ALLOW_ALL_USERS: 'true',
  };

  // Exa is the one third-party key we DO put on the sprite — Hermes' Exa
  // client doesn't accept a base URL override. Spend cap on the Exa dashboard
  // is the safety net.
  if (args.exaApiKey) base['EXA_API_KEY'] = args.exaApiKey;

  const merged = { ...base, ...(args.extra ?? {}) };
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${escapeEnvValue(v)}`)
    .join('\n') + '\n';
}

export function mergeDotenv(existing: string, updates: Record<string, string>): string {
  const trimmed = existing.replace(/\n$/, '');
  const lines = trimmed === '' ? [] : trimmed.split('\n');
  const keysSeen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (!match) {
      out.push(line);
      continue;
    }
    const key = match[1] as string;
    if (key in updates) {
      out.push(`${key}=${escapeEnvValue(updates[key]!)}`);
      keysSeen.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!keysSeen.has(k)) out.push(`${k}=${escapeEnvValue(v)}`);
  }
  return out.join('\n') + '\n';
}

function escapeEnvValue(value: string): string {
  if (/[\s#"]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
