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
   * Restart a machine. Faster than stop+start (Fly preserves the disk + IP
   * and just bounces the process). Takes ~3–6 seconds for our image.
   */
  async restartMachine(appName: string, machineId: string): Promise<void> {
    const res = await this.raw(
      'POST',
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/restart`,
    );
    if (!res.ok && res.status !== 404) {
      throw upstream(undefined, `restartMachine failed: ${res.status}`, {
        body: await res.text().catch(() => null),
      });
    }
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
