import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  ORCHESTRATOR_API_TOKEN: z.string().min(16),
  DATABASE_URL: z.string().url(),

  // ----- Fly Machines (per-user Hermes hosts) -----
  FLY_API_TOKEN: z.string().min(20),
  FLY_API_BASE: z.string().url().default('https://api.machines.dev'),
  FLY_ORG_SLUG: z.string().min(1),
  FLY_REGION: z.string().default('fra'),
  FLY_MACHINE_IMAGE: z.string().min(1),
  FLY_CPU_KIND: z.enum(['shared', 'performance']).default('shared'),
  FLY_CPUS: z.coerce.number().int().positive().default(2),
  FLY_MEMORY_MB: z.coerce.number().int().positive().default(2048),
  FLY_VOLUME_GB: z.coerce.number().int().positive().default(5),

  // Legacy Sprites support kept for migration window. Will be removed.
  SPRITES_API_TOKEN: z.string().optional().default(''),
  SPRITES_API_BASE: z.string().url().default('https://api.sprites.dev'),
  SPRITES_DEFAULT_REGION: z.string().optional().default(''),

  DEFAULT_IDLE_SUSPEND_MINUTES: z.coerce.number().int().positive().default(30),
  PER_USER_INSTANCE_CAP: z.coerce.number().int().positive().default(1),

  OPENROUTER_API_KEY: z.string().min(8),
  EXA_API_KEY: z.string().optional().default(''),
  // Composio API key (single org-wide secret). Injected as the x-api-key
  // header on every Composio MCP request the Hermes agent makes. Per-user
  // identity is scoped via the ?user_id= query param Composio bakes into
  // each connection URL.
  COMPOSIO_API_KEY: z.string().optional().default(''),
  // Sokosumi "Hermes Coworker" API keys — one per env. Used by the
  // sokosumi_sync step to pull each user's tasks/jobs/conversations into
  // Hermes' memory. The HermesInstance row carries a sokosumiEnv field
  // that picks which key to use per request. Per-user scoping via the
  // X-Delegation-User-Id header.
  //
  // Set only the env(s) you have access to. Missing keys → sokosumi_sync
  // gracefully skips for users in that env (logged, no error surfaced).
  SOKOSUMI_COWORKER_API_KEY_DEV: z.string().optional().default(''),
  SOKOSUMI_API_BASE_DEV: z.string().url().optional(),
  SOKOSUMI_COWORKER_API_KEY_PREPROD: z.string().optional().default(''),
  SOKOSUMI_API_BASE_PREPROD: z.string().url().default('https://api.preprod.sokosumi.com/v1'),
  SOKOSUMI_COWORKER_API_KEY_MAINNET: z.string().optional().default(''),
  SOKOSUMI_API_BASE_MAINNET: z.string().url().default('https://api.sokosumi.com/v1'),
  // First-party ORCHESTRATOR (orch_) API keys — Hermes is now a Sokosumi
  // "orchestrator" actor (not a coworker), with user-like workspace access and
  // NO vendor grants. When set, these take precedence over the coworker key for
  // that env; unsetting reverts to the coworker key. Minted via the admin API
  // POST /v1/orchestrators/{id}/api-keys.
  SOKOSUMI_ORCHESTRATOR_API_KEY_DEV: z.string().optional().default(''),
  SOKOSUMI_ORCHESTRATOR_API_KEY_PREPROD: z.string().optional().default(''),
  SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET: z.string().optional().default(''),
  MASTER_ENCRYPTION_KEY: z.string().min(40),
  ADMIN_PASSWORD: z.string().min(8),
  // Public base URL of the orchestrator itself. Used to construct the
  // OPENROUTER_BASE_URL we inject into each sprite. Must be reachable from
  // sprites (i.e., the public Railway URL, not the private/internal one).
  ORCHESTRATOR_PUBLIC_URL: z.string().url(),
  LLM_RATE_LIMIT_RPM: z.coerce.number().int().positive().default(60),
  // Hard per-user monthly spend cap (USD). Requests are rejected with HTTP 402
  // once a user's current-month LLM cost (computed from OpenRouter pricing)
  // exceeds this value.
  MONTHLY_USD_CAP_PER_USER: z.coerce.number().positive().default(50),
  // Model the LLM proxy uses when the request contains image_url parts.
  // The default text model (MiMo) has no vision endpoint on OpenRouter, so
  // we transparently swap when images are detected.
  VISION_MODEL: z.string().default('anthropic/claude-haiku-4.5'),
  // Optional A/B override: force the TEXT model the agent uses, regardless of
  // what the gateway sends — for testing a stronger model's tool-call
  // reliability without rebuilding the sprite image. Empty = passthrough.
  // Vision requests still use VISION_MODEL.
  TEXT_MODEL_OVERRIDE: z.string().optional().default(''),
  // Upstream LLM endpoint the proxy forwards to. Default = OpenRouter. Point
  // at any OpenAI-compatible base (e.g. https://maas.phoeniqs.com/v1) to route
  // the whole fleet through a different provider — pair with TEXT_MODEL_OVERRIDE
  // to name that provider's model. OpenRouter-only extras (provider routing,
  // HTTP-Referer/X-Title) are auto-suppressed for non-OpenRouter upstreams.
  LLM_UPSTREAM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  // API key for LLM_UPSTREAM_BASE_URL. Empty = fall back to OPENROUTER_API_KEY.
  LLM_UPSTREAM_API_KEY: z.string().optional().default(''),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export type SokosumiEnv = 'development' | 'preprod' | 'mainnet';

export const SOKOSUMI_ENVS: SokosumiEnv[] = ['development', 'preprod', 'mainnet'];

export function isValidSokosumiEnv(v: unknown): v is SokosumiEnv {
  return v === 'development' || v === 'preprod' || v === 'mainnet';
}

/**
 * Resolve the base URL + coworker API key for a given Sokosumi env.
 * Returns null if the env's key isn't configured (caller graceful-skips).
 *
 * Defaults: undefined sokosumiEnv → 'mainnet' (backwards compat with
 * instances provisioned before the sokosumiEnv column existed).
 */
export function getSokosumiConfig(
  env: SokosumiEnv | null | undefined,
): { baseUrl: string; apiKey: string; actor: 'orchestrator' | 'coworker' } | null {
  const cfg = loadConfig();
  const effective: SokosumiEnv = env ?? 'mainnet';
  let baseUrl: string | undefined;
  let coworkerKey = '';
  let orchestratorKey = '';
  switch (effective) {
    case 'development':
      baseUrl = cfg.SOKOSUMI_API_BASE_DEV;
      coworkerKey = cfg.SOKOSUMI_COWORKER_API_KEY_DEV;
      orchestratorKey = cfg.SOKOSUMI_ORCHESTRATOR_API_KEY_DEV;
      break;
    case 'preprod':
      baseUrl = cfg.SOKOSUMI_API_BASE_PREPROD;
      coworkerKey = cfg.SOKOSUMI_COWORKER_API_KEY_PREPROD;
      orchestratorKey = cfg.SOKOSUMI_ORCHESTRATOR_API_KEY_PREPROD;
      break;
    case 'mainnet':
      baseUrl = cfg.SOKOSUMI_API_BASE_MAINNET;
      coworkerKey = cfg.SOKOSUMI_COWORKER_API_KEY_MAINNET;
      orchestratorKey = cfg.SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET;
      break;
  }
  // Prefer the first-party orchestrator (orch_) key when configured. It gives
  // user-like workspace access with no vendor grants; unsetting it reverts to
  // the legacy coworker key cleanly.
  const apiKey = orchestratorKey || coworkerKey;
  const actor: 'orchestrator' | 'coworker' = orchestratorKey ? 'orchestrator' : 'coworker';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, actor };
}
