import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  perInstanceEnv,
  staticMachineEnv,
  buildMachineConfig,
} from '../src/provision/machine-spec.js';

const cfg = loadConfig();

const args = {
  instanceId: 'inst-123',
  apiServerKey: 'apikey-abc',
  llmProxyToken: 'llmtok-xyz',
  mcpServersJson: '[]',
};

describe('perInstanceEnv', () => {
  const env = perInstanceEnv(cfg, args);

  it('carries exactly the six per-instance keys', () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        'API_SERVER_KEY',
        'INSTANCE_ID',
        'MCP_SERVERS_JSON',
        'OPENROUTER_API_KEY',
        'OPENROUTER_BASE_URL',
        'ORCHESTRATOR_OUTBOX_TOKEN',
      ].sort(),
    );
  });

  it('routes the LLM proxy at this instance', () => {
    expect(env.OPENROUTER_BASE_URL).toBe(`${cfg.ORCHESTRATOR_PUBLIC_URL}/v1/llm/inst-123`);
    expect(env.INSTANCE_ID).toBe('inst-123');
    expect(env.OPENROUTER_API_KEY).toBe('llmtok-xyz');
    expect(env.ORCHESTRATOR_OUTBOX_TOKEN).toBe('llmtok-xyz');
    expect(env.API_SERVER_KEY).toBe('apikey-abc');
  });
});

describe('staticMachineEnv', () => {
  it('never overlaps with the per-instance keys', () => {
    const staticKeys = new Set(Object.keys(staticMachineEnv(cfg)));
    const perKeys = Object.keys(perInstanceEnv(cfg, args));
    for (const k of perKeys) expect(staticKeys.has(k)).toBe(false);
  });

  it('pins the always-on runtime knobs', () => {
    const env = staticMachineEnv(cfg);
    expect(env.API_SERVER_ENABLED).toBe('true');
    expect(env.API_SERVER_PORT).toBe('8642');
    expect(env.HERMES_HOME).toBe('/opt/data');
    expect(env.GATEWAY_ALLOW_ALL_USERS).toBe('true');
  });
});

describe('buildMachineConfig', () => {
  const req = buildMachineConfig(cfg, {
    region: 'fra',
    image: 'registry.fly.io/hermes-user-image:test',
    volumeId: 'vol_1',
    ...args,
  });

  it('mounts the data volume and pins the always-on service', () => {
    expect(req.region).toBe('fra');
    expect(req.config.image).toBe('registry.fly.io/hermes-user-image:test');
    expect(req.config.mounts).toEqual([{ volume: 'vol_1', path: '/opt/data' }]);
    const svc = req.config.services![0];
    expect(svc.internal_port).toBe(8642);
    expect(svc.auto_stop_machines).toBe('off');
    expect(svc.auto_start_machines).toBe(false);
    expect(svc.min_machines_running).toBe(1);
    expect(req.config.restart).toEqual({ policy: 'always' });
  });

  it('env is exactly static ∪ per-instance — so a claimed machine (built with '
    + 'placeholders, then patched with perInstanceEnv) equals a cold one', () => {
    const env = req.config.env!;
    const staticE = staticMachineEnv(cfg);
    const perE = perInstanceEnv(cfg, args);
    // Full env is the union...
    expect(env).toEqual({ ...staticE, ...perE });
    // ...and the patch keys are precisely the per-instance ones, so patching
    // them onto a placeholder-warmed machine reproduces this exact env.
    const patchKeys = Object.keys(perE);
    const nonPatchKeys = Object.keys(env).filter((k) => !patchKeys.includes(k));
    expect(nonPatchKeys.sort()).toEqual(Object.keys(staticE).sort());
  });
});
