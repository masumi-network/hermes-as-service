import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { upstream } from '../errors.js';
import type {
  CreateMachineRequest,
  CreateVolumeRequest,
  FlyApp,
  FlyMachine,
  FlyMachineConfig,
  FlyVolume,
} from './types.js';

/**
 * Fly Machines REST API client. Auth via FLY_API_TOKEN.
 *
 * Reference: https://docs.machines.dev/
 */
export class FlyClient {
  private readonly base: string;
  private readonly token: string;
  private readonly orgSlug: string;

  constructor() {
    const cfg = loadConfig();
    this.base = cfg.FLY_API_BASE.replace(/\/$/, '');
    this.token = cfg.FLY_API_TOKEN;
    this.orgSlug = cfg.FLY_ORG_SLUG;
  }

  // ---------- apps ----------

  async createApp(appName: string): Promise<FlyApp> {
    const res = await this.raw('POST', '/v1/apps', {
      body: { app_name: appName, org_slug: this.orgSlug, network: 'default' },
    });
    if (res.status === 201 || res.status === 200) {
      return { name: appName, organization_slug: this.orgSlug };
    }
    if (res.status === 409) {
      // already exists; that's fine
      return { name: appName, organization_slug: this.orgSlug };
    }
    throw upstream(undefined, `createApp failed: ${res.status}`, {
      body: await res.text().catch(() => null),
    });
  }

  async deleteApp(appName: string): Promise<void> {
    const res = await this.raw('DELETE', `/v1/apps/${encodeURIComponent(appName)}`);
    if (res.status !== 202 && res.status !== 200 && res.status !== 404) {
      throw upstream(undefined, `deleteApp failed: ${res.status}`);
    }
  }

  // ---------- volumes ----------

  async createVolume(appName: string, req: CreateVolumeRequest): Promise<FlyVolume> {
    return this.json<FlyVolume>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/volumes`,
      { body: req },
    );
  }

  async listVolumes(appName: string): Promise<FlyVolume[]> {
    return this.json<FlyVolume[]>('GET', `/v1/apps/${encodeURIComponent(appName)}/volumes`);
  }

  // ---------- machines ----------

  async createMachine(appName: string, req: CreateMachineRequest): Promise<FlyMachine> {
    return this.json<FlyMachine>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines`,
      { body: req },
    );
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine | null> {
    const res = await this.raw(
      'GET',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
    );
    if (res.status === 404) return null;
    return this.expectJson<FlyMachine>(res, 'getMachine');
  }

  async listMachines(appName: string): Promise<FlyMachine[]> {
    return this.json<FlyMachine[]>('GET', `/v1/apps/${encodeURIComponent(appName)}/machines`);
  }

  /**
   * Wait until a machine reaches the target state. Polls getMachine instead
   * of using Fly's `/wait` endpoint because the wait endpoint returns 400
   * when the machine is in a state from which it can't reach the target
   * (notably "created" before flyd has even tried to start it). Polling is
   * more permissive.
   */
  async waitForState(
    appName: string,
    machineId: string,
    state: 'started' | 'stopped' | 'destroyed',
    timeoutSeconds: number = 180,
  ): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const m = await this.getMachine(appName, machineId);
      if (!m) {
        if (state === 'destroyed') return;
        throw upstream(undefined, `waitForState: machine ${machineId} disappeared`);
      }
      if (m.state === state) return;
      // Treat "stopping" as effectively "stopped" for our purposes.
      if (state === 'stopped' && m.state === 'stopping') return;
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw upstream(undefined, `waitForState(${state}) timed out for ${machineId}`);
  }

  /**
   * Allocate public IPs (shared v4 + dedicated v6) to an app so its
   * `<app>.fly.dev` hostname resolves and Fly's edge can route traffic to
   * the machine. Idempotent — calling twice doesn't double-allocate.
   *
   * Uses Fly's GraphQL API (api.fly.io/graphql) because the REST Machines
   * API doesn't expose IP allocation.
   */
  async ensurePublicIps(appName: string): Promise<void> {
    const cfg = loadConfig();
    const endpoint = 'https://api.fly.io/graphql';

    const post = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        throw upstream(undefined, `Fly GraphQL ${res.status}`, {
          body: await res.text().catch(() => null),
        });
      }
      const json = (await res.json()) as { errors?: { message: string }[]; data?: unknown };
      if (json.errors && json.errors.length > 0) {
        // "already allocated" errors are fine — they mean idempotent reentry.
        const benign = json.errors.every((e) => /already/i.test(e.message));
        if (!benign) {
          throw upstream(undefined, `Fly GraphQL: ${json.errors[0]?.message}`);
        }
      }
      return json.data;
    };

    const mutation = `
      mutation($input: AllocateIPAddressInput!) {
        allocateIpAddress(input: $input) { ipAddress { id address type } }
      }
    `;
    await post(mutation, { input: { appId: appName, type: 'shared_v4' } });
    await post(mutation, { input: { appId: appName, type: 'v6' } });
    // Suppress unused config var warning if cfg isn't used elsewhere
    void cfg;
  }

  /**
   * Patch a machine's config in-place. Fly's POST /machines/:id replaces the
   * whole machine spec (image, guest, env, mounts, services). We fetch the
   * current machine, merge the supplied env patch, and PUT it back.
   *
   * Returns the new machine object (post-update, may include a `nonce` Fly
   * uses to detect drift if you do follow-up writes).
   */
  async patchMachineEnv(
    appName: string,
    machineId: string,
    envPatch: Record<string, string | null>,
  ): Promise<FlyMachine> {
    const current = await this.getMachine(appName, machineId);
    if (!current) {
      throw upstream(undefined, `patchMachineEnv: machine ${machineId} not found`);
    }
    const nextEnv: Record<string, string> = { ...(current.config.env ?? {}) };
    for (const [k, v] of Object.entries(envPatch)) {
      if (v === null) delete nextEnv[k];
      else nextEnv[k] = v;
    }
    const nextConfig: FlyMachineConfig = { ...current.config, env: nextEnv };
    return this.json<FlyMachine>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      { body: { config: nextConfig } },
    );
  }

  /**
   * Update a machine to a new image, keeping the rest of its spec (env,
   * guest, mounts, services). Fly replaces the machine in-place
   * (`started → replacing → started`), which reboots it — on our user
   * image that re-runs the launcher, re-syncing SOUL.md / config.yaml /
   * skills from the image filesystem onto /opt/data.
   */
  async updateMachineImage(
    appName: string,
    machineId: string,
    image: string,
  ): Promise<FlyMachine> {
    const current = await this.getMachine(appName, machineId);
    if (!current) {
      throw upstream(undefined, `updateMachineImage: machine ${machineId} not found`);
    }
    const nextConfig: FlyMachineConfig = { ...current.config, image };
    return this.json<FlyMachine>(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      { body: { config: nextConfig } },
    );
  }

  /**
   * Restart a machine, state-aware. Fly's POST /restart 412s when the
   * machine is in any state other than `started` or `stopped` (in particular
   * `suspended`, which is where idle Fly machines end up by default). We
   * dispatch on the current state so this always succeeds when the machine
   * exists at all:
   *
   *   started    → stop → wait → start
   *   stopped    → start
   *   suspended  → start
   *   starting   → wait for terminal → recurse once
   *   stopping   → wait for stopped → start
   *   created    → start (machine was never started; rare race)
   */
  /**
   * Start a machine, tolerating the 412 Fly returns while it's still settling
   * an async transition — most commonly the brief window right after a stop,
   * or mid config-update. Polls for a startable state and retries the start
   * until it takes or a 90s deadline passes. Mirrors the resilient-start loop
   * in provision.ensureMachineStarted, but as a client primitive so
   * restartMachine (and anyone else) is 412-safe too. Returns once the machine
   * is started or confirmed on its way (state `starting`).
   */
  async startMachineSettling(appName: string, machineId: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const m = await this.getMachine(appName, machineId);
      if (!m) throw upstream(undefined, `startMachineSettling: machine ${machineId} vanished`);
      if (m.state === 'started' || m.state === 'starting') return;
      if (m.state === 'stopped' || m.state === 'suspended' || m.state === 'created') {
        try {
          await this.startMachine(appName, machineId);
          return;
        } catch (err) {
          // 412 / transient reject while Fly settles — poll + retry below.
          if (Date.now() > deadline) throw err;
        }
      } else if (Date.now() > deadline) {
        throw upstream(undefined, `startMachineSettling: machine ${machineId} stuck in '${m.state}'`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async restartMachine(appName: string, machineId: string): Promise<void> {
    const m = await this.getMachine(appName, machineId);
    if (!m) {
      throw upstream(undefined, `restartMachine: machine ${machineId} not found`);
    }
    const state = m.state;
    if (state === 'started') {
      await this.stopMachine(appName, machineId);
      await this.waitForState(appName, machineId, 'stopped', 30);
      await this.startMachineSettling(appName, machineId);
      await this.waitForState(appName, machineId, 'started', 60);
      return;
    }
    if (state === 'stopped' || state === 'suspended' || state === 'created') {
      await this.startMachineSettling(appName, machineId);
      await this.waitForState(appName, machineId, 'started', 60);
      return;
    }
    if (state === 'stopping') {
      await this.waitForState(appName, machineId, 'stopped', 30);
      await this.startMachineSettling(appName, machineId);
      await this.waitForState(appName, machineId, 'started', 60);
      return;
    }
    if (state === 'starting') {
      await this.waitForState(appName, machineId, 'started', 60);
      // Already started — caller wanted a restart, so bounce it.
      await this.stopMachine(appName, machineId);
      await this.waitForState(appName, machineId, 'stopped', 30);
      await this.startMachineSettling(appName, machineId);
      await this.waitForState(appName, machineId, 'started', 60);
      return;
    }
    if (state === 'replacing') {
      // Fly is already replacing the machine (likely from a recent config
      // update). The replace IS a restart with new config — just wait it
      // out and we're done.
      await this.waitForState(appName, machineId, 'started', 120);
      return;
    }
    throw upstream(undefined, `restartMachine: machine ${machineId} in unsupported state '${state}'`);
  }

  async stopMachine(appName: string, machineId: string): Promise<void> {
    const res = await this.raw(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`,
    );
    if (!res.ok && res.status !== 404) {
      throw upstream(undefined, `stopMachine failed: ${res.status}`);
    }
  }

  async startMachine(appName: string, machineId: string): Promise<void> {
    const res = await this.raw(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`,
    );
    if (!res.ok && res.status !== 404) {
      throw upstream(undefined, `startMachine failed: ${res.status}`);
    }
  }

  async destroyMachine(appName: string, machineId: string, force: boolean = true): Promise<void> {
    const qs = force ? '?force=true' : '';
    const res = await this.raw(
      'DELETE',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}${qs}`,
    );
    if (!res.ok && res.status !== 404) {
      throw upstream(undefined, `destroyMachine failed: ${res.status}`);
    }
  }

  /**
   * Run a command inside a RUNNING machine via the Machines `exec` endpoint.
   * Used to drop marketplace skill files onto /opt/data without a reboot.
   * Synchronous and capped by Fly at 60s — only for fast, non-backgrounding
   * commands (a mkdir + base64-decode write finishes in well under a second).
   * Runs as ROOT, so callers that write files must chmod them readable for the
   * `hermes` user. Returns the process exit code + captured stdout/stderr.
   */
  async execMachine(
    appName: string,
    machineId: string,
    command: string[],
    opts: { stdin?: string; timeoutSec?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeoutSec = Math.min(opts.timeoutSec ?? 30, 60);
    const body: Record<string, unknown> = { command, timeout: timeoutSec };
    if (opts.stdin !== undefined) body['stdin'] = opts.stdin;
    const res = await this.raw(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/exec`,
      { body, timeoutMs: (timeoutSec + 15) * 1000 },
    );
    const parsed = await this.expectJson<{ exit_code?: number; stdout?: string; stderr?: string }>(
      res,
      'execMachine',
    );
    return { exitCode: parsed.exit_code ?? -1, stdout: parsed.stdout ?? '', stderr: parsed.stderr ?? '' };
  }

  // ---------- internals ----------

  private async json<T>(
    method: string,
    path: string,
    init: { body?: unknown } = {},
  ): Promise<T> {
    const res = await this.raw(method, path, init);
    return this.expectJson<T>(res, path);
  }

  private async expectJson<T>(res: Response, ctx: string): Promise<T> {
    if (!res.ok) {
      throw upstream(undefined, `Fly API ${ctx} failed: ${res.status}`, {
        body: await res.text().catch(() => null),
      });
    }
    return (await res.json()) as T;
  }

  private async raw(
    method: string,
    path: string,
    init: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      logger.debug({ method, path, status: res.status }, 'fly_api');
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }
}
