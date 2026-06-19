import { FlyClient } from '../fly/client.js';
import { logger } from '../logger.js';

/**
 * Write a marketplace (skills.sh) skill onto a RUNNING Hermes machine.
 *
 * The orchestrator cannot push files into a Fly machine directly — but the
 * Machines `exec` endpoint can run a command inside it. We base64-encode each
 * audited file and have a single `sh -c` invocation decode + write them into a
 * staging dir, then atomically `mv` into place under /opt/data/skills/. Hermes
 * discovers the new skill on the next conversation turn (no restart).
 *
 * Target dir: /opt/data/skills/mkt-<slug>/ — a `mkt-` prefix that can never
 * collide with a baked curated skill name, so the launcher's "copy if newer"
 * sync loop never touches (or clobbers) it.
 *
 * Security: this writes untrusted third-party content, so the slug and every
 * file path are strictly validated (no traversal / no shell metacharacters)
 * and, by default, executable scripts are stripped (instructions-only).
 */

export interface SkillFile {
  path: string;
  contents: string;
}

export interface PreparedSkill {
  /** sanitized slug (also the suffix of the on-disk dir name) */
  slug: string;
  /** on-disk dir name under /opt/data/skills, e.g. "mkt-find-skills" */
  dir: string;
  files: SkillFile[];
}

export const SKILLS_ROOT = '/opt/data/skills';
export const MARKETPLACE_PREFIX = 'mkt-';
export const MAX_SKILL_BYTES = 256 * 1024;
export const MAX_SKILL_FILES = 50;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function sanitizeSlug(slug: string): string {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64 || slug.includes('..') || !SLUG_RE.test(slug)) {
    throw new Error(`invalid skill slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/** Validate a file path is a safe RELATIVE path (no traversal, no absolute, no
 *  funny segments) and return it normalized with forward slashes. */
export function safeRelPath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('empty file path');
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.includes('..') || norm.includes('\0') || norm.length > 200) {
    throw new Error(`unsafe file path: ${JSON.stringify(p)}`);
  }
  const segs = norm.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || !SEGMENT_RE.test(seg)) {
      throw new Error(`unsafe path segment in: ${JSON.stringify(p)}`);
    }
  }
  return norm;
}

/** Instructions-only posture (default): drop scripts/ and executable-looking
 *  files so a 1-click install can only deliver text the agent reads, never code
 *  it runs. Allowing scripts is a deliberate opt-in reserved for vetted skills. */
export function stripScripts(files: SkillFile[]): SkillFile[] {
  return files.filter((f) => {
    const p = (f.path ?? '').replace(/\\/g, '/').toLowerCase();
    if (p === 'scripts' || p.startsWith('scripts/') || p.includes('/scripts/')) return false;
    if (/\.(sh|bash|zsh|fish|py|rb|js|mjs|cjs|ts|pl|php|exe|bin|cmd|ps1)$/.test(p)) return false;
    return true;
  });
}

/**
 * Validate + sanitize a skill for install. Throws on anything unsafe. Returns
 * the on-disk dir name and the (scripts-stripped, unless allowScripts) files.
 */
export function prepareSkill(
  slug: string,
  files: SkillFile[],
  opts: { allowScripts?: boolean } = {},
): PreparedSkill {
  const safeSlug = sanitizeSlug(slug);
  let fs = Array.isArray(files) ? files : [];
  if (!opts.allowScripts) fs = stripScripts(fs);
  fs = fs.map((f) => ({ path: safeRelPath(f.path), contents: String(f.contents ?? '') }));
  if (fs.length === 0) throw new Error('skill has no installable files after filtering');
  if (fs.length > MAX_SKILL_FILES) throw new Error(`skill has too many files (${fs.length} > ${MAX_SKILL_FILES})`);
  if (!fs.some((f) => f.path.toLowerCase() === 'skill.md')) {
    throw new Error('skill is missing a top-level SKILL.md');
  }
  const total = fs.reduce((n, f) => n + Buffer.byteLength(f.contents, 'utf8'), 0);
  if (total > MAX_SKILL_BYTES) throw new Error(`skill too large (${total} bytes > ${MAX_SKILL_BYTES})`);
  return { slug: safeSlug, dir: `${MARKETPLACE_PREFIX}${safeSlug}`, files: fs };
}

/**
 * Build a single `/bin/sh -c` command that atomically materializes the skill:
 * write every file into a staging dir from base64, chmod readable for the
 * `hermes` user (exec runs as root), then `mv` over the live dir and print a
 * sentinel. base64 payloads contain only [A-Za-z0-9+/=]; dir/paths are
 * pre-validated to a safe charset — so nothing here is shell-injectable.
 */
export function buildInstallCommand(prepared: PreparedSkill): string {
  const dir = `${SKILLS_ROOT}/${prepared.dir}`;
  const staging = `${SKILLS_ROOT}/.staging-${prepared.dir}`;
  const lines: string[] = ['set -e', `rm -rf "${staging}"`, `mkdir -p "${staging}"`];
  for (const f of prepared.files) {
    const b64 = Buffer.from(f.contents, 'utf8').toString('base64');
    const slash = f.path.lastIndexOf('/');
    if (slash !== -1) lines.push(`mkdir -p "${staging}/${f.path.slice(0, slash)}"`);
    lines.push(`printf %s '${b64}' | base64 -d > "${staging}/${f.path}"`);
  }
  lines.push(`chmod -R a+rX "${staging}"`);
  lines.push(`rm -rf "${dir}"`);
  lines.push(`mv "${staging}" "${dir}"`);
  lines.push('echo SKILL_INSTALL_OK');
  return lines.join('\n');
}

/** Push a prepared skill onto the running machine via exec. Throws on failure. */
export async function writeSkillToMachine(
  appName: string,
  machineId: string,
  prepared: PreparedSkill,
): Promise<void> {
  const res = await new FlyClient().execMachine(
    appName,
    machineId,
    ['/bin/sh', '-c', buildInstallCommand(prepared)],
    { timeoutSec: 30 },
  );
  if (res.exitCode !== 0 || !res.stdout.includes('SKILL_INSTALL_OK')) {
    const msg = (res.stderr || res.stdout || '').slice(0, 300);
    throw new Error(`skill install exec failed (exit ${res.exitCode}): ${msg}`);
  }
  logger.info({ appName, machineId, dir: prepared.dir }, 'skill_written_to_machine');
}

/** Remove a marketplace skill dir from the running machine. Best-effort. */
export async function removeSkillFromMachine(
  appName: string,
  machineId: string,
  slug: string,
): Promise<void> {
  const dir = `${SKILLS_ROOT}/${MARKETPLACE_PREFIX}${sanitizeSlug(slug)}`;
  await new FlyClient().execMachine(
    appName,
    machineId,
    ['/bin/sh', '-c', `rm -rf "${dir}" && echo SKILL_REMOVE_OK`],
    { timeoutSec: 20 },
  );
}
