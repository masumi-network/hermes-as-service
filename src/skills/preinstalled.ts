import { FlyClient } from '../fly/client.js';
import { logger } from '../logger.js';

/**
 * Lists the skills BAKED INTO the Hermes image (the curated packs synced from
 * the image filesystem on boot) — as opposed to skills.sh marketplace installs
 * (which live under the `mkt-` prefix and are tracked in the InstalledSkill
 * table). Sokosumi shows these as "your agent already ships with…".
 *
 * Source of truth is the running image's filesystem, read once per image
 * version via `exec` and cached — the list is identical for every user on a
 * given image, so the {userId} is only used to find a started machine to read.
 */

export interface PreinstalledSkill {
  slug: string;
  name: string;
  description: string | null;
}

interface InstanceRef {
  spriteName: string | null;
  spriteId: string | null;
  destroyedAt: Date | null;
}

// Internal plumbing skills baked for the agent↔orchestrator wiring — not
// user-facing capabilities, so we don't surface them in the marketplace shelf.
const INTERNAL_SLUGS = new Set(['outbox-send', 'schedule-task']);

const cache = new Map<string, { skills: PreinstalledSkill[]; at: number }>();
const TTL_MS = 60 * 60 * 1000; // 1h; also keyed by image so a roll busts it

// Read the image's skill SOURCES — the bundled packs (/opt/hermes/skills) plus
// our baked marketing packs (/opt/hermes-user-config/skills). This is exactly
// "what the image ships with": it's stable (unlike the runtime /opt/data merge,
// which is briefly inconsistent while the launcher syncs/prunes on boot) and it
// naturally excludes `mkt-` marketplace installs (those only live in /opt/data).
// Emit a delimited record per skill carrying its YAML frontmatter block.
const SKILL_SOURCE_DIRS = '/opt/hermes/skills /opt/hermes-user-config/skills';
const ENUM_SCRIPT =
  `find ${SKILL_SOURCE_DIRS} -name SKILL.md 2>/dev/null | while IFS= read -r f; do ` +
  `d=$(dirname "$f"); b=$(basename "$d"); ` +
  `case "$b" in .*) continue ;; esac; ` +
  `case "$d" in *"/."*) continue ;; esac; ` +
  `printf '\\n===SKILL:%s===\\n' "$b"; ` +
  `awk 'BEGIN{n=0} /^---[[:space:]]*$/{n++; next} n==1{print}' "$f"; ` +
  `done`;

function cleanScalar(s: string): string | null {
  let v = (s ?? '').trim();
  if (v === '' || v === '>' || v === '|' || v === '>-' || v === '|-') return null;
  v = v.replace(/^["']/, '').replace(/["']$/, '').trim();
  return v || null;
}

function humanize(slug: string): string {
  return slug
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

/** Parse the exec output into a deduped, internal-filtered skill list.
 *  Exported for unit tests. */
export function parseEnumOutput(stdout: string): PreinstalledSkill[] {
  const blocks = stdout.split(/\n===SKILL:/).slice(1);
  const seen = new Set<string>();
  const out: PreinstalledSkill[] = [];
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const slug = (nl === -1 ? block : block.slice(0, nl)).replace(/===\s*$/, '').trim();
    if (!slug || !/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) continue;
    if (seen.has(slug) || INTERNAL_SLUGS.has(slug)) continue;
    seen.add(slug);
    const body = nl === -1 ? '' : block.slice(nl + 1);
    let name: string | null = null;
    let description: string | null = null;
    for (const raw of body.split('\n')) {
      const nm = raw.match(/^name:\s*(.*)$/i);
      const dm = raw.match(/^description:\s*(.*)$/i);
      if (nm && name === null) name = cleanScalar(nm[1] ?? '');
      else if (dm && description === null) description = cleanScalar(dm[1] ?? '');
    }
    out.push({
      slug,
      // prefer a display-looking frontmatter name; else humanize the slug
      name: name && /[ A-Z]/.test(name) ? name : humanize(slug),
      description: description ? description.slice(0, 280) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return the image's pre-installed skills, or null if it can't be determined
 * right now (no machine / not started / exec failed and nothing cached). The
 * route treats null as "none".
 */
export async function listPreinstalledSkills(instance: InstanceRef): Promise<PreinstalledSkill[] | null> {
  if (!instance.spriteName || !instance.spriteId || instance.destroyedAt) return null;
  const fly = new FlyClient();
  const machine = await fly.getMachine(instance.spriteName, instance.spriteId);
  if (!machine || machine.state !== 'started') return null;
  const image = machine.config?.image ?? 'unknown';

  const hit = cache.get(image);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skills;

  try {
    const res = await fly.execMachine(instance.spriteName, instance.spriteId, ['/bin/sh', '-c', ENUM_SCRIPT], {
      timeoutSec: 30,
    });
    if (res.exitCode !== 0) {
      logger.warn({ image, stderr: res.stderr.slice(0, 200) }, 'preinstalled_enum_nonzero');
    }
    const skills = parseEnumOutput(res.stdout);
    cache.set(image, { skills, at: Date.now() });
    return skills;
  } catch (err) {
    logger.warn({ err, image }, 'preinstalled_enum_failed');
    return hit ? hit.skills : null;
  }
}

/** True if `slug` is one of the image's pre-installed (non-removable) skills. */
export async function isPreinstalledSlug(instance: InstanceRef, slug: string): Promise<boolean> {
  const list = await listPreinstalledSkills(instance);
  return !!list?.some((s) => s.slug === slug);
}
