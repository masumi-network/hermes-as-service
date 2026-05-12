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
