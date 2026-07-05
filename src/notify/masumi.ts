import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileP = promisify(execFile);

// Posts orchestrator alerts into a private Masumi channel (the "Masumi Team
// Channel") via the masumi-agent-messenger CLI. Best-effort and fully inert
// until the identity + channel are configured, so it is safe to ship before
// the messenger account is wired up.
//
// Config (all from env, set once the bot identity + channel exist):
//   MASUMI_AGENT_SLUG    — owned agent slug we send AS (e.g. hermes-orchestrator)
//   MASUMI_CHANNEL_SLUG  — the channel slug to post into
//   MASUMI_PROFILE       — CLI profile that holds the imported identity (default hermes-orch)
//   MASUMI_BIN           — CLI binary name/path (default masumi-agent-messenger)

const AGENT = process.env.MASUMI_AGENT_SLUG?.trim() || '';
const CHANNEL = process.env.MASUMI_CHANNEL_SLUG?.trim() || '';
const PROFILE = process.env.MASUMI_PROFILE?.trim() || 'hermes-orch';
const BIN = process.env.MASUMI_BIN?.trim() || 'masumi-agent-messenger';

// Where the restored CLI profile lives. Scoped to the CLI subprocess via
// XDG_CONFIG_HOME so we don't repoint config lookups for the whole container.
export const MASUMI_CONFIG_HOME = process.env.MASUMI_CONFIG_HOME?.trim() || '/app/.mam-config';

const DEFAULT_THROTTLE_MS = 5 * 60_000;
const MAX_BODY = 1500;

/** True when a bot identity + target channel are configured. */
export function masumiConfigured(): boolean {
  return Boolean(AGENT && CHANNEL);
}

// Collapse repeats of the same alert (by key) within a window so a flapping
// instance or a capped user hammering the API can't flood the channel.
const lastSent = new Map<string, number>();

/**
 * Fire-and-forget a message into the Masumi channel. Never throws; never
 * blocks the caller. No-op when the identity/channel aren't configured.
 *
 * @param opts.key        throttle key (defaults to the message text)
 * @param opts.throttleMs suppress an identical key for this long (default 5m)
 */
export function notifyMasumi(text: string, opts: { key?: string; throttleMs?: number } = {}): void {
  if (!masumiConfigured()) return;
  const key = opts.key ?? text;
  const window = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < window) return;
  lastSent.set(key, now);
  if (lastSent.size > 1000) {
    for (const [k, t] of lastSent) if (now - t > DEFAULT_THROTTLE_MS) lastSent.delete(k);
  }

  const body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
  // execFile (no shell) — event detail can't inject shell metacharacters.
  execFile(
    BIN,
    ['--json', '--profile', PROFILE, 'channel', 'send', CHANNEL, body, '--agent', AGENT],
    { timeout: 20_000, env: { ...process.env, XDG_CONFIG_HOME: MASUMI_CONFIG_HOME } },
    (err, _stdout, stderr) => {
      if (err) {
        logger.warn(
          { err: err.message, stderr: String(stderr).slice(0, 300) },
          'masumi_notify_failed',
        );
      }
    },
  );
}

/** Short, log-safe user id for messages. */
export function shortId(id: string): string {
  return id.length > 14 ? id.slice(0, 14) + '…' : id;
}

/**
 * Awaited send that reports the real CLI result — for the admin "test channel"
 * button and health checks. Unlike notifyMasumi it is not throttled and surfaces
 * the error so an operator can see exactly why a send failed.
 */
export async function sendMasumiTest(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!masumiConfigured()) return { ok: false, error: 'not configured (MASUMI_AGENT_SLUG / MASUMI_CHANNEL_SLUG unset)' };
  try {
    await execFileP(
      BIN,
      ['--json', '--profile', PROFILE, 'channel', 'send', CHANNEL, text, '--agent', AGENT],
      { timeout: 20_000, env: { ...process.env, XDG_CONFIG_HOME: MASUMI_CONFIG_HOME } },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
