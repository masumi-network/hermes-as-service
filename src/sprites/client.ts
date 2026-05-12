import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { upstream } from '../errors.js';
import type {
  CreateSpriteRequest,
  ExecOptions,
  ExecResult,
  ServiceDefinition,
  Sprite,
  UpdateSpriteRequest,
} from './types.js';

export class SpritesClient {
  private readonly base: string;
  private readonly token: string;

  constructor() {
    const cfg = loadConfig();
    this.base = cfg.SPRITES_API_BASE.replace(/\/$/, '');
    this.token = cfg.SPRITES_API_TOKEN;
  }

  // -------- sprite CRUD --------

  async createSprite(req: CreateSpriteRequest): Promise<Sprite> {
    return this.json<Sprite>('POST', '/v1/sprites', { body: req });
  }

  async getSprite(name: string): Promise<Sprite | null> {
    const res = await this.raw('GET', `/v1/sprites/${encodeURIComponent(name)}`);
    if (res.status === 404) return null;
    return this.expectJson<Sprite>(res, 'getSprite');
  }

  async updateSprite(name: string, req: UpdateSpriteRequest): Promise<Sprite> {
    return this.json<Sprite>('PUT', `/v1/sprites/${encodeURIComponent(name)}`, { body: req });
  }

  async deleteSprite(name: string): Promise<void> {
    const res = await this.raw('DELETE', `/v1/sprites/${encodeURIComponent(name)}`);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw upstream(undefined, `deleteSprite failed: ${res.status}`, {
        body: await res.text().catch(() => null),
      });
    }
  }

  // -------- filesystem --------

  /** Write raw bytes (string here) to an arbitrary path inside the sprite. */
  async writeFile(spriteName: string, path: string, content: string, mode = '0600'): Promise<void> {
    const qs = new URLSearchParams({ path, mode, mkdir: 'true' });
    const res = await this.raw(
      'PUT',
      `/v1/sprites/${encodeURIComponent(spriteName)}/fs/write?${qs}`,
      {
        rawBody: content,
        contentType: 'application/octet-stream',
      },
    );
    if (!res.ok) {
      throw upstream(undefined, `writeFile failed: ${res.status}`, {
        body: await res.text().catch(() => null),
      });
    }
  }

  async readFile(spriteName: string, path: string): Promise<string> {
    const qs = new URLSearchParams({ path });
    const res = await this.raw(
      'GET',
      `/v1/sprites/${encodeURIComponent(spriteName)}/fs/read?${qs}`,
    );
    if (!res.ok) {
      throw upstream(undefined, `readFile failed: ${res.status}`);
    }
    return res.text();
  }

  // -------- exec (synchronous, non-TTY) --------

  /**
   * Execute a binary inside the sprite. `cmd` is the *full executable path* —
   * NOT a shell command. To run a shell script, pass the script's absolute
   * path (the script's shebang line picks the interpreter). To run an inline
   * shell snippet, write it to a file first via `writeFile` then exec the
   * path.
   *
   * The endpoint is synchronous: the HTTP response only returns once the
   * process exits. The body is the combined stdout/stderr stream.
   */
  async exec(spriteName: string, cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const qs = new URLSearchParams();
    qs.set('cmd', cmd);
    if (opts.dir) qs.set('dir', opts.dir);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) qs.append('env', `${k}=${v}`);
    }
    const res = await this.raw(
      'POST',
      `/v1/sprites/${encodeURIComponent(spriteName)}/exec?${qs}`,
      {
        rawBody: opts.stdin ?? '',
        contentType: 'application/octet-stream',
        timeoutMs: opts.timeoutMs ?? 900_000,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw upstream(undefined, `exec http ${res.status}: ${text.slice(0, 500)}`, { cmd });
    }
    // Sprites returns plain-text combined stdout/stderr with no structured
    // envelope. We surface the raw output and treat HTTP 200 as success;
    // callers can grep the text for failure markers (the bootstrap writes a
    // marker file, which is the authoritative success signal).
    return { stdout: text, stderr: '', exit_code: 0 };
  }

  // -------- services --------

  async upsertService(
    spriteName: string,
    serviceName: string,
    def: ServiceDefinition,
  ): Promise<void> {
    const res = await this.raw(
      'PUT',
      `/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}`,
      { body: def },
    );
    if (!res.ok) {
      throw upstream(undefined, `upsertService failed: ${res.status}`, {
        body: await res.text().catch(() => null),
        serviceName,
      });
    }
  }

  async restartService(spriteName: string, serviceName: string): Promise<void> {
    // Sprites has no /restart endpoint (returns 404). Issue stop + start
    // separately — both return 200 with an NDJSON progress stream we discard.
    const base = `/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}`;
    const stop = await this.raw('POST', `${base}/stop`, { timeoutMs: 30_000 });
    if (!stop.ok && stop.status !== 404) {
      throw upstream(undefined, `restartService(stop) failed: ${stop.status}`);
    }
    // Drain the NDJSON body so the connection completes before we issue start.
    await stop.text().catch(() => null);
    const start = await this.raw('POST', `${base}/start`, { timeoutMs: 30_000 });
    if (!start.ok && start.status !== 404) {
      throw upstream(undefined, `restartService(start) failed: ${start.status}`);
    }
    await start.text().catch(() => null);
  }

  /**
   * Tail the service's log output. Sprites returns one JSON object per line,
   * each with `{type: "stdout"|"stderr"|"complete", data?, timestamp}`. We
   * collapse them into a plain text tail for human display.
   */
  async tailServiceLogs(
    spriteName: string,
    serviceName: string,
    lines: number = 200,
  ): Promise<string> {
    const qs = new URLSearchParams({ lines: String(lines) });
    const res = await this.raw(
      'GET',
      `/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/logs?${qs}`,
      { timeoutMs: 15_000 },
    );
    if (!res.ok) {
      throw upstream(undefined, `tailServiceLogs failed: ${res.status}`);
    }
    const text = await res.text();
    const out: string[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { type?: string; data?: string };
        if (obj.type === 'stdout' || obj.type === 'stderr') {
          if (typeof obj.data === 'string') out.push(obj.data.replace(/\r$/, ''));
        }
      } catch {
        out.push(trimmed);
      }
    }
    return out.join('\n');
  }

  // -------- internals --------

  private async json<T>(
    method: string,
    path: string,
    init: { body?: unknown } = {},
  ): Promise<T> {
    const res = await this.raw(method, path, {
      body: init.body,
    });
    return this.expectJson<T>(res, path);
  }

  private async expectJson<T>(res: Response, context: string): Promise<T> {
    if (!res.ok) {
      throw upstream(undefined, `Sprites API ${context} failed: ${res.status}`, {
        body: await res.text().catch(() => null),
      });
    }
    return (await res.json()) as T;
  }

  private async raw(
    method: string,
    path: string,
    init: {
      body?: unknown;
      rawBody?: string;
      contentType?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (init.rawBody !== undefined) {
      headers['Content-Type'] = init.contentType ?? 'application/octet-stream';
      body = init.rawBody;
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      logger.debug({ method, path, status: res.status }, 'sprites_api');
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }
}
