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

// Fly's guest exec endpoint rejects an oversized request body (PayloadTooLarge)
// — a whole skill base64'd into one command (~1.33x its bytes) blows that limit
// for any non-trivial skill. So we materialize the skill across MULTIPLE small
// execs: each file's base64 is appended to a temp in bounded chunks, decoded,
// then all files are atomically swapped into place in the final exec. Every
// exec command stays well under the limit.
//
// A base64 STRING can be split at any offset and concatenated as text, then
// decoded once — so we append raw base64 chunks and `base64 -d` the whole
// temp per file. base64 payloads contain only [A-Za-z0-9+/=]; dir/paths are
// pre-validated to a safe charset — nothing here is shell-injectable.
const MAX_B64_CHUNK = 16 * 1024; // max base64 chars per single printf line
const MAX_EXEC_BYTES = 24 * 1024; // max command length per exec

/** Ordered shell steps that build the skill in `staging` then swap it live.
 *  No single step exceeds MAX_B64_CHUNK+overhead. Pure (testable). */
export function buildInstallSteps(prepared: PreparedSkill): string[] {
  const dir = `${SKILLS_ROOT}/${prepared.dir}`;
  const staging = `${SKILLS_ROOT}/.staging-${prepared.dir}`;
  // The b64 temp lives OUTSIDE the staging tree so it can never collide with
  // a skill file named "<x>.b64" (which would otherwise be truncated/deleted
  // as another file's temp). Reused across files (truncated per file).
  const tmp = `${staging}.b64tmp`;
  const steps: string[] = [`rm -rf "${staging}" "${tmp}"`, `mkdir -p "${staging}"`];
  for (const f of prepared.files) {
    const filePath = `${staging}/${f.path}`;
    const slash = f.path.lastIndexOf('/');
    if (slash !== -1) steps.push(`mkdir -p "${staging}/${f.path.slice(0, slash)}"`);
    steps.push(`: > "${tmp}"`); // create/truncate the temp
    const b64 = Buffer.from(f.contents, 'utf8').toString('base64');
    for (let i = 0; i < b64.length; i += MAX_B64_CHUNK) {
      steps.push(`printf %s '${b64.slice(i, i + MAX_B64_CHUNK)}' >> "${tmp}"`);
    }
    steps.push(`base64 -d < "${tmp}" > "${filePath}"`);
  }
  steps.push(`rm -f "${tmp}"`);
  steps.push(`chmod -R a+rX "${staging}"`);
  // Swap in ONE step so `rm -rf dir` and `mv` can never split across execs
  // (a split could delete the live skill then fail before replacing it).
  steps.push(`rm -rf "${dir}" && mv "${staging}" "${dir}"`);
  return steps;
}

/** Pack ordered steps into `/bin/sh -c` scripts, each ≤ budget, order
 *  preserved. Every script runs under `set -e` and ends with a sentinel so
 *  the caller can confirm it ran to completion. Pure (testable). */
export function packInstallExecs(steps: string[], budget = MAX_EXEC_BYTES): string[] {
  const execs: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    execs.push(`set -e\n${cur.join('\n')}\necho ${BATCH_SENTINEL}`);
    cur = [];
    curLen = 0;
  };
  for (const step of steps) {
    if (curLen + step.length + 1 > budget && cur.length > 0) flush();
    cur.push(step);
    curLen += step.length + 1;
  }
  flush();
  return execs;
}

const BATCH_SENTINEL = 'SKILL_BATCH_OK';

/**
 * Serialize skill mutations per (machine, slug). The staging path is
 * deterministic per slug, so two concurrent write/remove sequences for the
 * same skill would race on it (one truncating the temp another is decoding,
 * or one rm-ing staging another is mv-ing) → corruption. With a single
 * orchestrator replica (see warm-pool design), an in-process mutex is a
 * complete fix. Callers overlap in practice: an install POST, the
 * provision-time replay, and the admin replay endpoint can all fire at once.
 */
const skillLocks = new Map<string, Promise<unknown>>();
function withSkillLock<T>(appName: string, machineId: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const key = `${machineId}:${slug}`;
  const prev = skillLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Tail swallows errors so a failed op doesn't wedge the chain; prune when
  // this op is the last in line so the map doesn't grow unbounded.
  const tail = run.then(
    () => {},
    () => {},
  );
  skillLocks.set(key, tail);
  void tail.then(() => {
    if (skillLocks.get(key) === tail) skillLocks.delete(key);
  });
  return run;
}

/**
 * Push a prepared skill onto the running machine as a sequence of bounded
 * execs. The live dir is only swapped in the FINAL exec, so a mid-sequence
 * failure leaves the existing skill untouched (staging is separate). Throws
 * on the first batch that doesn't report the sentinel. Serialized per skill.
 */
export async function writeSkillToMachine(
  appName: string,
  machineId: string,
  prepared: PreparedSkill,
): Promise<void> {
  return withSkillLock(appName, machineId, prepared.slug, async () => {
    const fly = new FlyClient();
    const execs = packInstallExecs(buildInstallSteps(prepared));
    for (let i = 0; i < execs.length; i++) {
      const res = await fly.execMachine(appName, machineId, ['/bin/sh', '-c', execs[i]!], {
        timeoutSec: 30,
      });
      if (res.exitCode !== 0 || !res.stdout.includes(BATCH_SENTINEL)) {
        const msg = (res.stderr || res.stdout || '').slice(0, 300);
        throw new Error(
          `skill install exec failed (batch ${i + 1}/${execs.length}, exit ${res.exitCode}): ${msg}`,
        );
      }
    }
    logger.info({ appName, machineId, dir: prepared.dir, batches: execs.length }, 'skill_written_to_machine');
  });
}

/** Remove a marketplace skill dir (and any leftover staging/temp) from the
 *  running machine. Best-effort. Serialized against writes for the same skill. */
export async function removeSkillFromMachine(
  appName: string,
  machineId: string,
  slug: string,
): Promise<void> {
  const safe = sanitizeSlug(slug);
  const dir = `${SKILLS_ROOT}/${MARKETPLACE_PREFIX}${safe}`;
  const staging = `${SKILLS_ROOT}/.staging-${MARKETPLACE_PREFIX}${safe}`;
  await withSkillLock(appName, machineId, safe, () =>
    new FlyClient().execMachine(
      appName,
      machineId,
      ['/bin/sh', '-c', `rm -rf "${dir}" "${staging}" "${staging}.b64tmp" && echo SKILL_REMOVE_OK`],
      { timeoutSec: 20 },
    ),
  );
}
