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
  /**
   * Third-party skill packs cloned into the image at build time (unpinned
   * `--depth 1` of HEAD, so the exact contents depend on build date).
   * Undefined = not recorded for this version.
   */
  skillPacks?: string[];
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

// v28 adds the two skills upstream newly bundled between v2026.5.16 and
// v2026.7.20 that are off-product for a Marketing PA. Note that 16 of the
// inherited entries are now no-ops: upstream moved those skills from bundled
// to optional in v2026.6.5, so the `find -name <slug>` prune simply matches
// nothing. Harmless, and left in place so a future upstream re-bundle is
// still covered.
const DENYLIST_V28 = [...DENYLIST_V21, 'simplify-code', 'petdex'];

/**
 * Version history, NEWEST FIRST. When you cut a new image, prepend an entry.
 */
export const IMAGE_VERSIONS: ImageVersion[] = [
  {
    tag: 'v36',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'SOUL: never retain an unverified event — memory poisoning made one lie permanent.',
    changes: [
      'SOUL "Ground truth" gains a memory-integrity block. Root cause of a multi-hour incident: the agent invented a Sokosumi error ("Pricing 25 (Fixed) is invalid for job creation") and RETAINED it to long-term memory twice. It then recalled its own fiction as background truth on every later turn, re-asserted the outage, proposed a retry cron for it, and diagnosed an empty org wallet — none of it real (zero sokosumi_create_job calls in 24h; balance read fine at 4,064.84). Ten poisoned memories were invalidated by operator audit.',
      'New rules: never retain an event a tool result this turn does not prove — specifically never an error string not received verbatim, an inferred outage/"known issue", an unread balance, or an unconfirmed action; a real tool error is retainable only WITH provenance (verbatim message + tool name); and never diagnose an unobservable cause — "the wallet is empty" / "the platform is down" are theories, so report the raw error or say you do not know yet.',
      'Pairs with the orchestrator-side guard extension for specimen #7 (invented error strings and platform-outage framing).',
    ],
  },
  {
    tag: 'v35',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'SOUL: task lifecycle rules — archive deletes drafts; rejections are answers, not outages.',
    changes: [
      'SOUL "How Sokosumi tasks work" gains explicit lifecycle rules: which statuses the assistant can set; DRAFT → CANCELED is always rejected and sokosumi_archive_task is THE draft-cleanup path; INPUT_REQUIRED/RUNNING move only when the assigned coworker resumes (unstick by answering, not transitioning); and a rejected transition must be reported as the rule it is — never as "the API is down / rate-limited" unless a plain read also fails.',
      'Motivated by a live cleanup request: the agent hit three real DRAFT→CANCELED rejections (422s), then told the user draft deletion "can only be done in the UI" (false — DELETE /tasks/{id} archive existed all along, we had not exposed it) and that the API "went down" (false — the next sweep ran all-200 two minutes later). Pairs with the orchestrator-side sokosumi_archive_task tool and the reworded workspace-cleanup native prompt (NATIVE_PROMPTS_VERSION 4).',
      'No other change from v34.',
    ],
  },
  {
    tag: 'v34',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'Add ste-writing (distilled ASD-STE100 anti-slop prose skill), user-requested.',
    changes: [
      'New baked skill ste-writing: distilled ASD-STE100 Simplified Technical English rules for docs/READMEs/PR text/error messages/release notes — explicitly NOT marketing copy (it strips voice by design). Complements avoid-ai-writing. Source: woosal1337/blog, videos/ep01-the-cure-for-ai-slop.',
      'Shipped as exactly ONE reviewed file (ste-writing-skill.md -> skills/ste-writing/SKILL.md), fetched at a pinned commit with a frontmatter sanity check in the build — not a repo clone; the rest of that repo is video-companion experiment data and scripts we do not want on machines.',
      'No other change from v33.',
    ],
  },
  {
    tag: 'v33',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'SOUL: scheduling hygiene — loops must end (--repeat, no per-task polling crons).',
    changes: [
      'New SOUL section "Scheduling hygiene — loops must end": watching a single task needs NO cron (the 5-minute board sweep already wakes the agent); temporary checks must use `cronjob --repeat N` so they self-expire; only real routines get unbounded crons; and when a monitored task reaches a terminal state the monitor gets deleted that same turn.',
      'Motivated by monitor-x402-aioncardano-post: the agent promised "up to 4 checks", created an unbounded */15 cron, and it was still firing ~96×/day days after the watched task COMPLETED. The orchestrator now also reaps such monitors hourly (monitor-cron-reaper), but the SOUL rule is the prevention; the reaper is the backstop.',
      'No other change from v32 — same base, same LLM-proxy pin, same denylist.',
    ],
  },
  {
    tag: 'v32',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'Pin model.base_url to the LLM proxy — v30/v31 turns died at OpenRouter with 401.',
    changes: [
      'v30 could boot but NO TURN could complete: on the v2026.7.20 base the runtime routes models through its provider catalog and no longer consults OPENROUTER_BASE_URL per-request, so every call went straight to https://openrouter.ai/api/v1/ carrying our proxy token — rejected in 40ms, usage.prompt_tokens=0, surfaced to users as "Your assistant returned an empty response".',
      'The working lever (verified with a fake URL locally before shipping): model.base_url + model.api_key in config.yaml with model.provider left unset — the runtime_provider issue-#3846 path honours a config base_url whose host is not a known cloud root. The launcher injects the per-instance proxy URL via a python3 YAML round-trip (a heredoc append would duplicate the existing top-level model: key).',
      'Two plausible-looking surfaces that DO NOT work on this base, both tested and rejected: a config.yaml providers: entry (consulted for provider lookup by name only, not catalog-routed models — this was v31, which is dead: never deploy it), and `hermes auth add openrouter` (persists under credential_pool["custom:openrouter"], which the openrouter runtime path never reads).',
      'Verified locally from clean boot: agent calls the pinned URL; config round-trip preserves tool_use_enforcement, hooks, cron, gateway; combined output parses with the hindsight memory and mcp_servers appends active.',
    ],
  },
  {
    tag: 'v30',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'Bypass s6-overlay entirely — it cannot run on Fly. v28/v29 were unbootable there.',
    changes: [
      'v28 and v29 CANNOT BOOT ON FLY and must never be deployed. They boot perfectly under `docker run`, which is why every local test passed. s6-overlay\'s suexec hard-requires PID 1; under Docker /init IS pid 1, but on Fly flyd\'s init owns pid 1 and runs the image entrypoint as a child, so /init aborts immediately: "s6-overlay-suexec: fatal: can only run as pid 1", exit code 100, 13 restarts, machine stopped. Observed on a live instance 2026-07-27. Pre-s6 tini only WARNED about not being pid 1, which is why v27 was unaffected.',
      'This image REPLACES upstream\'s ENTRYPOINT (/init + main-wrapper.sh) with the launcher itself, which now starts as root and re-creates the pre-s6 contract: run upstream stage2-hook.sh (uid/gid remap, volume chown, first-boot seeding), apply the orchestrator profile, chown what it wrote, then drop via /command/s6-setuidgid and exec the gateway in the foreground.',
      'The launcher must prepend /command and /package/admin/s6/command to PATH before calling stage2-hook: the hook invokes `s6-setuidgid` by bare name and /init normally supplies that PATH. Without it the hook dies "s6-setuidgid: not found" and the container exits 127 (caught locally before deploy).',
      'Removes the 018-foreground-gateway-reset cont-init hook v28 added. With /init bypassed, cont-init never runs at all, so 02-reconcile-profiles cannot auto-start a competing supervised gateway — the collision it worked around no longer exists.',
      'VERIFIED ON FLY, not just Docker: throwaway app hermes-v30-canary, real volume, three boots, HTTP 401 on the public gateway each time (401 = serving, auth required), machine events exit_code=0 restarts=0, no s6 fatal. Local Docker additionally confirmed gateway running as the hermes user with zero s6 services.',
      'Lesson for future base bumps: a passing `docker run` test says nothing about Fly. Any change touching the entrypoint or init model must be canaried on a throwaway Fly machine before any live instance.',
    ],
  },
  {
    tag: 'v29',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'Re-add creative-ideation, which the v28 base bump would have deleted.',
    changes: [
      'Bakes creative-ideation back into the curated packs. Upstream unbundled it in v2026.6.5 (skills/ -> optional-skills/), so a NEW machine on the v2026.7.20 base never gets it.',
      'CORRECTION to the v28 entry: existing machines do NOT lose it. Bundled skills live under category dirs on the volume (skills/creative/creative-ideation), the v28 check looked for a flat skills/creative-ideation that never existed, and Hermes does not prune skills that leave the bundle. Re-verified on an upgraded volume: creative-ideation, linear, research, training and vector-databases are all still present under their categories. The v28 note claiming five skills disappear applies to fresh volumes only.',
      'Because the old copy survives on upgraded volumes, the launcher now deletes skills/creative/creative-ideation so our 28-file version does not sit alongside the stale 2-file one under the same name. The denylist cannot express this — `find -name creative-ideation` would match ours too.',
      'Copied out of the base image (/opt/hermes/optional-skills/creative/creative-ideation) rather than fetched, so it always matches the pinned upstream tag exactly and adds no build-time network dependency.',
      'The v2026.7.20 copy is substantially richer than what we shipped pre-v28: 28 files vs 5, adding anti-slop, heuristics, method-catalog and exercises references alongside the prompt library.',
      'No other change from v28 — same base, same denylist, same s6 wiring.',
    ],
  },
  {
    tag: 'v28',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.7.20',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V28,
    summary: 'Base bumped 9 releases (v0.14.0 -> v0.19.0) — the s6 blocker was never real.',
    changes: [
      'Base moves v2026.5.16 -> v2026.7.20. We had been pinned since May on the belief that s6-overlay ignores the container CMD and crash-loops. It does not: upstream ships ENTRYPOINT ["/init","/opt/hermes/docker/main-wrapper.sh"] with an EMPTY CMD, so a downstream CMD is appended as main-wrapper argv. main-wrapper routes a first-arg-that-is-an-executable straight through and drops to the hermes user via s6-setuidgid — the same contract the pre-s6 entrypoint.sh gave us via gosu.',
      'Launcher now ends in `hermes gateway run --no-supervise`. Inside the s6 image a plain `gateway run` is auto-redirected to the supervised s6 service; that redirect returns, which would let the main program exit and take the container down. --no-supervise restores the documented foreground contract (gateway IS the main process, container exits with its code) that Fly restart:always and the machine-roll path already assume. The flag only exists on s6 bases, so the launcher and the FROM must move together.',
      'No competing gateway: upstream docker/s6-rc.d/main-hermes/run is `exec sleep infinity`, a deliberate no-op slot that exists only because s6-rc requires a non-empty user bundle.',
      'No extra process: the new `dashboard` s6 service self-disables unless HERMES_DASHBOARD is truthy (run exits 0, finish returns 125). We never set it.',
      'Fly machine spec needed no change — buildMachineConfig sets no init.entrypoint / init.cmd, so the image contract applies as-is.',
      'Carried in from upstream: ~80% agent cold-start cut (~4.3s -> ~0.9s) that applies to cron turns; partial-stream stub responses now treated as length truncation rather than a clean stop (a candidate cause of the "agent goes silent" reports); ~195ms off every tool call; MCP tools exposed to the agent between turns without a gateway restart; Node 22 LTS; Debian 13; hindsight-client baked into the image so it survives image rolls.',
      'HERMES_SKIP_CONFIG_MIGRATION=1. Upstream stage2-hook runs a config-schema migration on every boot; because our launcher rewrites config.yaml from the image each boot the persisted config is always schema 0 again, so the migration re-ran "0 -> 33" forever, wrote a timestamped config.yaml.bak-<ts> to the DURABLE volume each time, and had its output discarded. Measured one leaked backup file per boot on a volume that outlives every roll. Verified 0 after the skip.',
      'Skill set shrinks 36 -> 33. Upstream trimmed its bundle 91 -> 74 (v2026.6.5 moved many skills bundled -> optional). Five we ship today disappear: creative-ideation, linear, research, training, vector-databases — none are deleted upstream, they are one `hermes skills install` away. creative-ideation is the one with real Marketing-PA relevance; re-add it to docker/hermes-user/skills/ if the agent misses it. Two newly-bundled skills (simplify-code, petdex) are denylisted here as off-product.',
      'NOT fixed by this bump: the fabricated-tool-call bug (agent says "Task created" with no create_task call). Upstream ships an execution-discipline block that stops exactly that, but it is applied per model family — GPT/Codex, extended to Grok/xai-oauth in v2026.5.28 — and nothing indicates it covers xiaomi/mimo. The orchestrator-side narration guard is still required.',
    ],
  },
  {
    tag: 'v27',
    releasedAt: 'unreleased',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'SOUL: delegation means the TASK is the deliverable, not the work.',
    changes: [
      'SOUL "WHAT YOU DON\'T DO" now covers Hermes\' OWN tools, not just Sokosumi mechanics. The old text only forbade assigning tasks to yourself and running jobs yourself, so "you coordinate, you don\'t execute" read as an object-model rule — nothing stopped the agent from cloning 35 repos and POSTing to a CMS with its own shell.',
      'Explicit rule for "create a task for <coworker> to do X": the deliverable is the TASK, not X; credentials/docs the user supplies in that sentence are FOR the coworker and get passed through in the description, not used by Hermes.',
      'Names the exact observed failure: doing X and then filing a "review and polish what I already did" task, which demotes the specialist to a proofreader. Includes a self-check on the words review/polish/verify.',
      'Closing test: "after you finish, could the coworker still do the whole job the user described?"',
      'Motivated by the 2026-07-26 session — asked to create a task for Bront to write a CMS release entry, the agent wrote the entry itself and gave Bront a review task, then baked that inversion into a weekly cron.',
    ],
  },
  {
    tag: 'v26',
    releasedAt: '2026-07-26',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'Hindsight long-term memory via Hermes\' NATIVE memory provider.',
    changes: [
      'Launcher writes $HERMES_HOME/hindsight/config.json (mode local_external, hybrid, auto_retain + auto_recall on) and appends `memory: provider: hindsight` to config.yaml when HINDSIGHT_API_URL is set.',
      'Replaced the earlier MCP-server approach: memory is now injected pre-turn and synced post-turn by the provider, so it costs no tool calls and never competes for the tool budget.',
      'Per-instance HINDSIGHT_* env points at the orchestrator\'s per-user proxy; the real Hindsight credential never lands on a machine.',
    ],
    commit: 'b1c6f92',
  },
  {
    tag: 'v25',
    releasedAt: '2026-07-25',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'SOUL "Two memories" — the note card vs the archive.',
    changes: [
      'SOUL section distinguishing the always-loaded memory note card from the searchable long-term archive, so the agent stops treating the small file as its only memory.',
    ],
    commit: '5a4ccf5',
  },
  {
    tag: 'v24',
    releasedAt: '2026-07-24',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5-pro',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'MiMo-V2.5-PRO + SOUL failure-honesty rules.',
    changes: [
      'Default model → xiaomi/mimo-v2.5-pro (we had been on plain mimo-v2.5; Pro was the intended tier).',
      'SOUL "Ground truth": report observed errors verbatim (never invent a cause like "link expired"), re-check evidence when challenged (never confess to errors not made), read deliverables fully before summarizing — the three failure modes from the 2026-07-24 log analysis.',
      'Same base, tool-use enforcement, denylist, and skill packs as v23.',
    ],
    commit: '05cf381',
    skillPacks: [
      'coreyhaines31/marketingskills',
      'conorbronsdon/avoid-ai-writing',
      'Romanescu11/hermes-skill-factory',
      'AgriciDaniel/claude-ads',
      'nowork-studio/toprank (seo, google-ads, meta-ads, gemini)',
    ],
  },
  {
    tag: 'v23',
    releasedAt: '2026-07-24',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'SOUL refresh — orgs enumerable + personal credits readable (Sokosumi #3408).',
    changes: [
      'Rewrote the SOUL org/credits sections for Sokosumi PR #3408: orgs ARE enumerable (sokosumi_list_organizations), list_tasks/list_jobs span all workspaces, and the personal credit balance is readable via sokosumi_get_credits (org balances still judged by price). Cleared the stale "can\'t enumerate orgs / balances not visible" claims (some contradicted the cost rules that already said to check the balance).',
      'Same base, model, tool-use enforcement, denylist, and skill packs as v22.',
    ],
    commit: 'b1bfce8',
    skillPacks: [
      'coreyhaines31/marketingskills',
      'conorbronsdon/avoid-ai-writing',
      'Romanescu11/hermes-skill-factory',
      'AgriciDaniel/claude-ads',
      'nowork-studio/toprank (seo, google-ads, meta-ads, gemini)',
    ],
  },
  {
    tag: 'v22',
    releasedAt: '2026-07-24',
    baseImage: 'nousresearch/hermes-agent:v2026.5.16',
    defaultModel: 'xiaomi/mimo-v2.5',
    toolUseEnforcement: true,
    deniedSkills: DENYLIST_V21,
    summary: 'Default model → xiaomi/mimo-v2.5 (clean, un-confounded MiMo swap).',
    changes: [
      'Baked config.yaml model.default = xiaomi/mimo-v2.5 so the gateway self-reports the right model and keys its tool-enforcement / reasoning-echo handling to MiMo — the orchestrator TEXT_MODEL_OVERRIDE swap is invisible to the gateway, which made it a confounded A/B.',
      'Same base, tool-use enforcement, denylist, and skill packs as v21.',
    ],
    commit: '12257fb',
    skillPacks: [
      'coreyhaines31/marketingskills',
      'conorbronsdon/avoid-ai-writing',
      'Romanescu11/hermes-skill-factory',
      'AgriciDaniel/claude-ads',
      'nowork-studio/toprank (seo, google-ads, meta-ads, gemini)',
    ],
  },
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
    skillPacks: [
      'coreyhaines31/marketingskills',
      'conorbronsdon/avoid-ai-writing',
      'Romanescu11/hermes-skill-factory',
      'AgriciDaniel/claude-ads',
      'nowork-studio/toprank (seo, google-ads, meta-ads, gemini)',
    ],
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
