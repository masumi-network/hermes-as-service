// Hand-maintained registry of the Hermes user-image versions we ship.
//
// Why hand-maintained: images are built and pushed manually (no CI), and the
// running orchestrator has neither the Docker build context nor the git tree
// at runtime — so it can't introspect an image. Instead, whenever a new image
// is cut, add an entry here (newest first) describing what changed. The admin
// "Images" page reads this to list versions, mark the live one, and diff any
// two of them.
//
// An image's identity is its registry tag suffix (vN). The full ref the
// orchestrator deploys to is the FLY_MACHINE_IMAGE env var, e.g.
// "registry.fly.io/hermes-user-image:v21" — we match the live version by tag.

export interface ImageVersion {
  /** Registry tag suffix, e.g. "v21". Unique. Newest entries first. */
  tag: string;
  /** ISO date the image was built/pushed. */
  releasedAt: string;
  /** Upstream base the image is FROM. */
  baseImage: string;
  /** Default LLM model baked into config.yaml. */
  defaultModel: string;
  /** Whether agent.tool_use_enforcement is forced on (the anti-narration fix). */
  toolUseEnforcement: boolean;
  /**
   * Skills REMOVED from the bundled base set in this image (the denylist).
   * A longer list = fewer skills shipped. Diffing two versions' lists shows
   * which skills were newly removed or restored between them.
   */
  deniedSkills: string[];
  /** One-line headline for the version list. */
  summary: string;
  /** Changelog bullets describing what this version changed vs the prior one. */
  changes: string[];
  /** Short git SHA for the commit that cut this image (for linking out). */
  commit?: string;
}

// The current denylist (docker/hermes-user/skill-denylist.txt). Kept here as a
// constant so the v21 entry and future entries can reference it without drift.
const DENYLIST_V21 = [
  'macos-computer-use', 'apple-notes', 'apple-reminders', 'imessage', 'findmy', 'openhue',
  'claude-code', 'codex', 'opencode', 'hermes-agent', 'hermes-agent-skill-authoring',
  'github-auth', 'github-code-review', 'github-issues', 'github-pr-workflow',
  'github-repo-management', 'codebase-inspection', 'python-debugpy', 'node-inspect-debugger',
  'debugging-hermes-tui-commands', 'systematic-debugging', 'test-driven-development',
  'subagent-driven-development', 'requesting-code-review', 'jupyter-live-kernel', 'native-mcp',
  'webhook-subscriptions', 'plan', 'writing-plans', 'spike', 'dogfood', 'kanban-orchestrator',
  'kanban-worker', 'huggingface-hub', 'research-paper-writing', 'arxiv', 'llm-wiki',
  'pokemon-player', 'minecraft-modpack-server', 'spotify', 'songsee', 'heartmula',
  'songwriting-and-ai-music', 'polymarket', 'comfyui', 'touchdesigner-mcp', 'p5js', 'pixel-art',
  'ascii-art', 'ascii-video', 'manim-video', 'pretext', 'godmode', 'himalaya', 'yuanbao',
  'baoyu-comic', 'baoyu-infographic',
];

/**
 * Version history, NEWEST FIRST. When you cut a new image, prepend an entry.
 */
export const IMAGE_VERSIONS: ImageVersion[] = [
  {
    tag: 'v21',
    releasedAt: '2026-06-24',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'deepseek/deepseek-v4-flash',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'Marketing-PA skill trim — removed 57 off-product bundled skills.',
    changes: [
      'Pruned 57 off-product skills from the bundle (dev tooling, ML/research, games/media, macOS-only, jailbreak, Chinese-locale) via skill-denylist.txt.',
      'Applied at build time (bundle source) and on every boot (persisted volume) so existing instances clean up too.',
      'Same base, model, and tool-use enforcement as v20.',
    ],
    commit: 'e636f6a',
  },
  {
    tag: 'v20',
    releasedAt: '2026-06-16',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'deepseek/deepseek-v4-flash',
    toolUseEnforcement: true,
    deniedSkills: [],
    summary: 'Tool-call hallucination fix — pinned to v2026.5.16 + forced tool-use enforcement.',
    changes: [
      'Pinned base to nousresearch/hermes-agent:v2026.5.16 — the newest pre-s6 (tini) tag that also supports agent.tool_use_enforcement.',
      'Forced agent.tool_use_enforcement on for ALL models, fixing the intermittent "narrate a tool call as text" hallucination on multi-turn requests.',
      'Ships the full ~87-skill bundle (no denylist yet).',
    ],
    commit: '1e72cdd',
  },
  {
    tag: 'v19',
    releasedAt: '2026-06-10',
    baseImage: 'nousresearch/hermes-agent:v17 (overlay)',
    defaultModel: 'deepseek/deepseek-v4-flash',
    toolUseEnforcement: false,
    deniedSkills: [],
    summary: 'Pre-fix image — v17 overlay, no tool-use enforcement (had the hallucination bug).',
    changes: [
      'Built as an overlay on the v17 base after upstream :latest switched to s6-overlay (which crashes our tini launcher).',
      'v17 predates the agent.tool_use_enforcement config key, so tool-call narration could not be suppressed.',
      'Superseded by v20.',
    ],
  },
];

/** Look up a version by tag. */
export function findImageVersion(tag: string): ImageVersion | undefined {
  return IMAGE_VERSIONS.find((v) => v.tag === tag);
}

/**
 * Resolve the tag the orchestrator is currently provisioning (matches the
 * FLY_MACHINE_IMAGE ref against known tags by suffix). Returns null if the
 * configured image doesn't match any manifest entry.
 */
export function currentImageTag(flyMachineImage: string | undefined | null): string | null {
  if (!flyMachineImage) return null;
  // Match the ":vN" suffix, else an exact tag token anywhere in the ref.
  for (const v of IMAGE_VERSIONS) {
    if (flyMachineImage.endsWith(`:${v.tag}`) || flyMachineImage === v.tag) return v.tag;
  }
  return null;
}

/**
 * Extract the tag from an image ref. Handles:
 *   - "registry.fly.io/hermes-user-image:v21" → "v21"
 *   - "v21" (bare tag)                          → "v21"
 *   - "registry.fly.io:5000/img:v21"            → "v21" (ignores the port colon)
 *   - "registry.fly.io/img@sha256:abc…"         → null  (a digest carries no tag)
 *   - "registry.fly.io/img" (no tag)            → null
 * Returns null when there is no real tag, so callers fall back to "unknown".
 */
export function tagFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // A digest (…@sha256:…) has no tag — strip it before looking for one.
  const at = ref.indexOf('@');
  const base = at >= 0 ? ref.slice(0, at) : ref;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  // A tag colon must come AFTER the last '/' (otherwise it's a registry port).
  if (colon > slash) return base.slice(colon + 1) || null;
  // No tag segment. A bare token (no registry path, no digest) is itself a tag.
  if (slash < 0 && at < 0) return base || null;
  return null;
}

export interface FieldDiff<T> {
  a: T;
  b: T;
  changed: boolean;
}

export interface ImageDiff {
  a: string;
  b: string;
  baseImage: FieldDiff<string>;
  defaultModel: FieldDiff<string>;
  toolUseEnforcement: FieldDiff<boolean>;
  /** Skills removed in B that were present (not denied) in A. */
  skillsRemovedInB: string[];
  /** Skills restored in B that were denied in A. */
  skillsRestoredInB: string[];
  /** B's changelog (what B introduced). */
  changelogB: string[];
}

/**
 * Structured field-by-field diff between two image versions. `a` is the older
 * baseline, `b` is the newer/compared version. Throws if either tag is unknown.
 */
export function diffImageVersions(aTag: string, bTag: string): ImageDiff {
  const a = findImageVersion(aTag);
  const b = findImageVersion(bTag);
  if (!a) throw new Error(`unknown image version: ${aTag}`);
  if (!b) throw new Error(`unknown image version: ${bTag}`);
  const aDenied = new Set(a.deniedSkills);
  const bDenied = new Set(b.deniedSkills);
  // Removed in B = denied in B but not in A.
  const skillsRemovedInB = b.deniedSkills.filter((s) => !aDenied.has(s)).sort();
  // Restored in B = denied in A but not in B.
  const skillsRestoredInB = a.deniedSkills.filter((s) => !bDenied.has(s)).sort();
  return {
    a: aTag,
    b: bTag,
    baseImage: { a: a.baseImage, b: b.baseImage, changed: a.baseImage !== b.baseImage },
    defaultModel: { a: a.defaultModel, b: b.defaultModel, changed: a.defaultModel !== b.defaultModel },
    toolUseEnforcement: {
      a: a.toolUseEnforcement,
      b: b.toolUseEnforcement,
      changed: a.toolUseEnforcement !== b.toolUseEnforcement,
    },
    skillsRemovedInB,
    skillsRestoredInB,
    changelogB: b.changes,
  };
}
