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
): { baseUrl: string; apiKey: string } | null {
  const cfg = loadConfig();
  const effective: SokosumiEnv = env ?? 'mainnet';
  const cfgFor = (e: SokosumiEnv): { baseUrl?: string; apiKey: string } => {
    switch (e) {
      case 'development':
        return { baseUrl: cfg.SOKOSUMI_API_BASE_DEV, apiKey: cfg.SOKOSUMI_COWORKER_API_KEY_DEV };
      case 'preprod':
        return { baseUrl: cfg.SOKOSUMI_API_BASE_PREPROD, apiKey: cfg.SOKOSUMI_COWORKER_API_KEY_PREPROD };
      case 'mainnet':
        return { baseUrl: cfg.SOKOSUMI_API_BASE_MAINNET, apiKey: cfg.SOKOSUMI_COWORKER_API_KEY_MAINNET };
    }
  };
  const primary = cfgFor(effective);
  if (primary.baseUrl && primary.apiKey) {
    return { baseUrl: primary.baseUrl, apiKey: primary.apiKey };
  }
  // Graceful fallback for "development": if no dev backend is configured
  // on this orchestrator, silently use preprod. This handles the case
  // where Sokosumi's UI provisions a user with sokosumiEnv="development"
  // even though only a preprod backend exists. We never silently fall
  // back FROM mainnet — a missing mainnet key is a real misconfig that
  // should surface.
  if (effective === 'development') {
    const fallback = cfgFor('preprod');
    if (fallback.baseUrl && fallback.apiKey) {
      if (!loggedDevFallback) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'sokosumi_dev_to_preprod_fallback',
            note: 'no DEV key configured; serving preprod for development env',
          }),
        );
        loggedDevFallback = true;
      }
      return { baseUrl: fallback.baseUrl, apiKey: fallback.apiKey };
    }
  }
  return null;
}

let loggedDevFallback = false;
