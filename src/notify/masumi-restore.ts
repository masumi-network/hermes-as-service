import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { logger } from '../logger.js';
import { MASUMI_CONFIG_HOME } from './masumi.js';

const execFileP = promisify(execFile);

/**
 * Rehydrate the masumi-agent-messenger bot identity (file-based keys + OIDC
 * session) from the MASUMI_PROFILE_B64 env secret into XDG_CONFIG_HOME, so the
 * notifier's CLI calls can send as `hermes-orchestrator`.
 *
 * The snapshot was captured on Linux (where the CLI persists tokens + keys as
 * files, not in a macOS Keychain) and is a gzipped tar rooted at
 * `masumi-agent-messenger/`, extracted into $XDG_CONFIG_HOME.
 *
 * Best-effort and idempotent; a no-op when unconfigured, so the orchestrator
 * boots fine without the messenger set up.
 *
 * Caveat: the container refreshes its OIDC token in-place, but that lives on
 * the ephemeral FS and every boot re-restores THIS snapshot. If the login's
 * refresh token ever rotates + is invalidated, re-capture the snapshot.
 */
export async function restoreMasumiProfile(): Promise<void> {
  const b64 = process.env.MASUMI_PROFILE_B64;
  if (!b64) {
    logger.info('masumi_profile_not_configured');
    return;
  }
  const configHome = MASUMI_CONFIG_HOME;
  try {
    await mkdir(configHome, { recursive: true });
    const tgz = `${configHome}/.mam-profile.tgz`;
    await writeFile(tgz, Buffer.from(b64, 'base64'), { mode: 0o600 });
    await execFileP('tar', ['xzf', tgz, '-C', configHome]);
    await rm(tgz, { force: true });
    logger.info({ configHome }, 'masumi_profile_restored');
  } catch (err) {
    logger.error({ err }, 'masumi_profile_restore_failed');
  }
}
