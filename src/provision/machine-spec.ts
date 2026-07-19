import type { Config } from '../config.js';
import type { CreateMachineRequest, FlyMachineConfig } from '../fly/types.js';

/**
 * The per-instance env vars — the only ones that differ between users. These
 * are baked in on the cold path and PATCHED onto a warm pool machine at claim
 * time. Everything else (staticMachineEnv) is identical across all instances.
 *
 * The launcher (docker/hermes-user/hermes-user-launcher) rewrites
 * /opt/data/.env from these Fly env vars on EVERY boot, so patching + starting
 * a pooled machine fully replaces its placeholder values.
 */
export function perInstanceEnv(
  cfg: Config,
  args: {
    instanceId: string;
    apiServerKey: string;
    llmProxyToken: string;
    mcpServersJson: string;
  },
): Record<string, string> {
  const orch = cfg.ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, '');
  return {
    API_SERVER_KEY: args.apiServerKey,
    // LLM proxy (orchestrator-side; the real OpenRouter key never lands here)
    OPENROUTER_API_KEY: args.llmProxyToken,
    OPENROUTER_BASE_URL: `${orch}/v1/llm/${args.instanceId}`,
    INSTANCE_ID: args.instanceId,
    ORCHESTRATOR_OUTBOX_TOKEN: args.llmProxyToken,
    // Composio MCP servers (empty array if the user hasn't connected anything)
    MCP_SERVERS_JSON: args.mcpServersJson,
  };
}

/** Env identical for every instance — baked once, never patched. */
export function staticMachineEnv(cfg: Config): Record<string, string> {
  return {
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '0.0.0.0',
    API_SERVER_PORT: '8642',
    API_SERVER_MODEL_NAME: 'hermes-agent',
    HERMES_HOME: '/opt/data',
    TERMINAL_ENV: 'local',
    HERMES_QUIET: '1',
    GATEWAY_ALLOW_ALL_USERS: 'true',
    EXA_API_KEY: cfg.EXA_API_KEY,
    ORCHESTRATOR_BASE: cfg.ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, ''),
  };
}

/**
 * Build the full CreateMachineRequest — the single source of truth for the
 * per-user Hermes machine spec (guest, mount, env, always-on service, restart
 * policy). Used by BOTH the cold provision path and pool warming so a claimed
 * pool machine is byte-for-byte identical to a cold-provisioned one apart from
 * the per-instance env (which is patched in at claim time).
 */
export function buildMachineConfig(
  cfg: Config,
  args: {
    region: string;
    image: string;
    volumeId: string;
    instanceId: string;
    apiServerKey: string;
    llmProxyToken: string;
    mcpServersJson: string;
  },
): CreateMachineRequest {
  const config: FlyMachineConfig = {
    image: args.image,
    guest: {
      cpu_kind: cfg.FLY_CPU_KIND,
      cpus: cfg.FLY_CPUS,
      memory_mb: cfg.FLY_MEMORY_MB,
    },
    mounts: [{ volume: args.volumeId, path: '/opt/data' }],
    env: {
      ...staticMachineEnv(cfg),
      ...perInstanceEnv(cfg, {
        instanceId: args.instanceId,
        apiServerKey: args.apiServerKey,
        llmProxyToken: args.llmProxyToken,
        mcpServersJson: args.mcpServersJson,
      }),
    },
    services: [
      {
        ports: [
          { port: 443, handlers: ['tls', 'http'] },
          { port: 80, handlers: ['http'] },
        ],
        protocol: 'tcp',
        internal_port: 8642,
        // Always-on. Fly's default auto-stops idle machines, which breaks
        // Hermes' built-in cron and leaves the machine `suspended` (restart
        // then 412s). Pin everything on.
        auto_stop_machines: 'off',
        auto_start_machines: false,
        min_machines_running: 1,
      },
    ],
    restart: { policy: 'always' },
  };
  return { region: args.region, config };
}
