import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Prisma } from '@prisma/client';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../db.js';
import { MCP_TOOLS_VERSION, callTool } from '../routes/sokosumi-mcp.js';
import { esc, layout, relTime, statCard, statusPill } from './html.js';
import { logger } from '../logger.js';
import { loadConfig, normalizeAutonomy, isValidSokosumiEnv } from '../config.js';
import { userMonthlySpend } from '../llm/spend.js';
import { describe as describeCron } from '../schedules/cron.js';
import { runDueOnce } from '../schedules/scheduler.js';
import {
  IMAGE_VERSIONS,
  findImageVersion,
  currentImageTag,
  tagFromRef,
  diffImageVersions,
} from '../images/manifest.js';
import { reconcileImageTags } from '../images/reconcile.js';
import { TEST_SUITES, findSuite } from '../bench/suites.js';
import { startSuiteRun } from '../bench/runner.js';
import { IMAGE_TAG_RE, imageTagWhere, userLabel } from './helpers.js';

const router = new Hono();

// ---------- Images: versions + diff (view-only) ----------

router.get('/admin/images', async (c) => {
  const cfg = loadConfig();
  const liveTag = currentImageTag(cfg.FLY_MACHINE_IMAGE);
  const rows = await prisma.hermesInstance.findMany({
    where: { destroyedAt: null },
    select: { imageTag: true },
  });
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const r of rows) {
    const t = tagFromRef(r.imageTag);
    if (!t) {
      unknown += 1;
      continue;
    }
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const versionRows = IMAGE_VERSIONS.map((v) => {
    const isCurrent = v.tag === liveTag;
    const n = counts.get(v.tag) ?? 0;
    return `<tr>
      <td><a class="mono" href="/admin/images/${encodeURIComponent(v.tag)}">${esc(v.tag)}</a> ${isCurrent ? '<span class="badge ok">live</span>' : ''}</td>
      <td>${esc(v.releasedAt)}</td>
      <td class="mono" style="font-size:11px">${esc(v.baseImage)}</td>
      <td class="mono" style="font-size:11px">${esc(v.defaultModel)}</td>
      <td>${v.toolUseEnforcement ? '<span class="pill ok">on</span>' : '<span class="pill err">off</span>'}</td>
      <td class="num">${esc(String(v.deniedSkills.length))} cut</td>
      <td class="num">${n > 0 ? `<a href="/admin/instances?image=${encodeURIComponent(v.tag)}">${esc(String(n))}</a>` : '0'}</td>
      <td class="dim">${esc(v.summary)}</td>
    </tr>`;
  }).join('');

  const optionsFor = (sel: string): string =>
    IMAGE_VERSIONS.map(
      (v) => `<option value="${esc(v.tag)}"${v.tag === sel ? ' selected' : ''}>${esc(v.tag)}</option>`,
    ).join('');
  const defaultB = IMAGE_VERSIONS[0]?.tag ?? '';
  const defaultA = IMAGE_VERSIONS[1]?.tag ?? defaultB;

  const body = `
    <h1>Hermes images</h1>
    <p class="dim">Versions of the per-user Hermes image we ship. The <span class="badge ok">live</span> version (what new + synced instances get) is set by the <span class="mono">FLY_MACHINE_IMAGE</span> env var${liveTag ? '' : ' (no manifest entry matches it — add one)'}. When you cut a new image, prepend an entry to <span class="mono">src/images/manifest.ts</span>.</p>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Tag</th><th>Released</th><th>Base image</th><th>Model</th><th>Tool enforce</th><th>Skills</th><th>Instances</th><th>Summary</th></tr></thead>
        <tbody>${versionRows}</tbody>
      </table>
    </div>
    ${
      unknown > 0
        ? `<p class="dim" style="margin-top:12px;display:flex;gap:8px;align-items:center"><span><a href="/admin/instances?image=unknown">${esc(String(unknown))} active instance(s)</a> have no recorded image.</span><form method="post" action="/admin/images/reconcile" class="inline"><button type="submit">Reconcile from Fly</button></form></p>`
        : ''
    }

    <h2>Compare two versions</h2>
    <form method="get" action="/admin/images/compare" class="actions">
      <label class="dim">Base&nbsp;<select name="a">${optionsFor(defaultA)}</select></label>
      <label class="dim">Against&nbsp;<select name="b">${optionsFor(defaultB)}</select></label>
      <button type="submit" class="primary">Compare</button>
    </form>
  `;
  return c.html(layout({ title: 'Images', body, active: '/admin/images' }));
});

router.get('/admin/images/compare', (c) => {
  const a = c.req.query('a') ?? '';
  const b = c.req.query('b') ?? '';
  let diff;
  try {
    diff = diffImageVersions(a, b);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.html(
      layout({
        title: 'Compare',
        body: `<h1>Compare images</h1><p class="dim">${esc(msg)}</p><p><a href="/admin/images">← Back to images</a></p>`,
        active: '/admin/images',
      }),
      400,
    );
  }
  const scalar = (label: string, fd: { a: string; b: string; changed: boolean }): string =>
    `<dt>${esc(label)}</dt><dd class="mono">${esc(fd.a)} <span class="dim">→</span> ${esc(fd.b)} ${fd.changed ? '<span class="badge warn">changed</span>' : '<span class="unchanged">· same</span>'}</dd>`;
  const boolFd = diff.toolUseEnforcement;
  const skillChips = (list: string[], cls: string): string =>
    list.length === 0
      ? '<span class="tool-none">none</span>'
      : list.map((s) => `<span class="badge ${cls}">${esc(s)}</span>`).join(' ');

  const body = `
    <h1>${esc(diff.a)} <span class="dim">→</span> ${esc(diff.b)}</h1>
    <p class="dim"><a href="/admin/images">← All images</a></p>
    <div class="card">
      <h3>Configuration</h3>
      <dl class="kv">
        ${scalar('Base image', diff.baseImage)}
        ${scalar('Default model', diff.defaultModel)}
        <dt>Tool enforcement</dt><dd>${boolFd.a ? 'on' : 'off'} <span class="dim">→</span> ${boolFd.b ? 'on' : 'off'} ${boolFd.changed ? '<span class="badge warn">changed</span>' : '<span class="unchanged">· same</span>'}</dd>
      </dl>
    </div>
    <div class="row" style="margin-top:16px">
      <div class="card flex-1">
        <h3>Skills removed in ${esc(diff.b)}</h3>
        <div>${skillChips(diff.skillsRemovedInB, 'danger')}</div>
      </div>
      <div class="card flex-1">
        <h3>Skills restored in ${esc(diff.b)}</h3>
        <div>${skillChips(diff.skillsRestoredInB, 'ok')}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>What ${esc(diff.b)} changed</h3>
      <ul class="dim" style="margin:0;padding-left:18px">${diff.changelogB.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
  `;
  return c.html(layout({ title: `${diff.a} → ${diff.b}`, body, active: '/admin/images' }));
});

router.post('/admin/images/reconcile', async (c) => {
  try {
    const res = await reconcileImageTags();
    logger.info(res, 'admin_image_reconcile');
  } catch (err) {
    logger.error({ err }, 'admin_image_reconcile_failed');
  }
  return c.redirect('/admin/images');
});

/**
 * Per-image detail: manifest metadata + the instances running it, and — for
 * the LIVE tag only — the actual image-defining artifacts (SOUL.md system
 * prompt, config.yaml, skill denylist, orchestrator skills) read from the
 * copy bundled into this orchestrator deploy. Historical tags can't show
 * artifacts (they only exist as the working tree at build time); the
 * manifest commit SHA is the pointer for those.
 */
router.get('/admin/images/:tag', async (c) => {
  const tag = c.req.param('tag');
  if (!IMAGE_TAG_RE.test(tag)) return c.text('invalid tag', 404);
  const version = findImageVersion(tag);
  const cfg = loadConfig();
  const liveTag = currentImageTag(cfg.FLY_MACHINE_IMAGE);
  const isLive = tag === liveTag;

  const instancesTotal = await prisma.hermesInstance.count({
    where: { AND: [{ destroyedAt: null }, imageTagWhere(tag)] },
  });
  const instances = await prisma.hermesInstance.findMany({
    where: { AND: [{ destroyedAt: null }, imageTagWhere(tag)] },
    orderBy: { lastActivityAt: 'desc' },
    take: 50,
    select: {
      userId: true, name: true, email: true, status: true, sokosumiEnv: true,
      isTestBench: true, imageRolledAt: true, lastActivityAt: true,
    },
  });

  if (!version && instances.length === 0) {
    return c.html(
      layout({
        title: 'Image',
        body: `<h1>Image ${esc(tag)}</h1><div class="empty">Unknown tag — not in the manifest and no instance runs it.</div><p><a href="/admin/images">← Images</a></p>`,
        active: '/admin/images',
      }),
      404,
    );
  }

  // Live-image artifacts, best-effort — the deploy may predate the bundling.
  const artifactBase = join(process.cwd(), 'docker', 'hermes-user');
  const artifact = async (rel: string): Promise<string | null> => {
    try {
      return await readFile(join(artifactBase, rel), 'utf8');
    } catch {
      return null;
    }
  };
  let soul: string | null = null;
  let configYaml: string | null = null;
  let denylist: string | null = null;
  let orchestratorSkills: string[] = [];
  if (isLive) {
    [soul, configYaml, denylist] = await Promise.all([
      artifact('SOUL.md'),
      artifact('config.yaml'),
      artifact('skill-denylist.txt'),
    ]);
    try {
      const cats = await readdir(join(artifactBase, 'skills'), { withFileTypes: true });
      for (const cat of cats) {
        if (!cat.isDirectory()) continue;
        const skills = await readdir(join(artifactBase, 'skills', cat.name), { withFileTypes: true });
        orchestratorSkills.push(...skills.filter((s) => s.isDirectory()).map((s) => `${cat.name}/${s.name}`));
      }
    } catch {
      orchestratorSkills = [];
    }
  }

  const artifactBlock = (title: string, content: string | null, note?: string): string =>
    content === null
      ? ''
      : `<h2>${esc(title)}${note ? ` <span class="dim" style="font-weight:400;font-size:12px">${esc(note)}</span>` : ''}</h2>
         <pre class="log" style="max-height:420px">${esc(content)}</pre>
         <div style="height:8px"></div>`;

  const metaCard = version
    ? `<div class="card flex-1">
        <h3>Manifest</h3>
        <dl class="kv">
          <dt>Released</dt><dd>${esc(version.releasedAt)}</dd>
          <dt>Base image</dt><dd class="mono">${esc(version.baseImage)}</dd>
          <dt>Default model</dt><dd class="mono">${esc(version.defaultModel)}</dd>
          <dt>Tool enforcement</dt><dd>${version.toolUseEnforcement ? '<span class="pill ok">on</span>' : '<span class="pill err">off</span>'}</dd>
          <dt>Skills cut</dt><dd>${esc(version.deniedSkills.length)} (denylist)</dd>
          ${version.skillPacks ? `<dt>Skill packs</dt><dd>${version.skillPacks.map((p) => `<div class="mono" style="font-size:12px">${esc(p)}</div>`).join('')}</dd>` : '<dt>Skill packs</dt><dd class="dim">not recorded for this version</dd>'}
          ${version.commit ? `<dt>Cut at commit</dt><dd class="mono">${esc(version.commit)}</dd>` : ''}
        </dl>
        <h3 style="margin-top:20px">Changes</h3>
        <ul class="dim" style="margin:0;padding-left:18px;font-size:13px">${version.changes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>`
    : `<div class="card flex-1"><h3>Manifest</h3><div class="empty" style="padding:12px">No manifest entry for this tag — add one to <span class="mono">src/images/manifest.ts</span>.</div></div>`;

  const instancesCard = `<div class="card flex-1" style="padding:0;overflow:hidden">
    <table>
      <thead><tr><th>Instance (${instancesTotal > instances.length ? `showing ${esc(instances.length)} of ${esc(instancesTotal)}` : esc(instancesTotal)})</th><th>Status</th><th>Env</th><th>Rolled</th><th>Activity</th></tr></thead>
      <tbody>
        ${instances.length === 0 ? '<tr><td colspan="5" class="empty">No active instances on this image.</td></tr>' : instances.map((r) => `
          <tr>
            <td><a href="/admin/instances/${encodeURIComponent(r.userId)}">${userLabel(r)}</a>${r.isTestBench ? ' <span class="badge ok">bench</span>' : ''}</td>
            <td>${statusPill(r.status)}</td>
            <td><span class="badge">${esc(r.sokosumiEnv ?? 'mainnet')}</span></td>
            <td class="mono">${r.imageRolledAt ? esc(relTime(r.imageRolledAt)) : '—'}</td>
            <td class="mono">${esc(relTime(r.lastActivityAt))}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

  const artifactsSection = isLive
    ? (soul === null && configYaml === null && denylist === null
        ? '<h2>Image contents</h2><p class="dim">Artifacts not bundled into this orchestrator deploy yet (needs a deploy with the docker/ COPY in the Dockerfile).</p>'
        : `
          ${orchestratorSkills.length > 0 ? `<h2>Orchestrator-owned skills</h2><div>${orchestratorSkills.map((s) => `<span class="badge">${esc(s)}</span>`).join(' ')}</div>` : ''}
          ${artifactBlock('System prompt — SOUL.md', soul, 'as currently deployed; the launcher re-syncs this onto every machine at boot')}
          ${artifactBlock('config.yaml', configYaml)}
          ${artifactBlock('Skill denylist', denylist, 'pruned from the bundle at build AND from volumes on every boot')}
        `)
    : `<h2>Image contents</h2><p class="dim">Artifacts are only shown for the <span class="badge ok">live</span> image — historical image contents aren't tracked in the repo${version?.commit ? `; the closest pointer is commit <span class="mono">${esc(version.commit)}</span>` : ''}. The third-party skill packs are cloned unpinned at build time, so even a rebuild from that commit wouldn't reproduce them exactly.</p>`;

  const body = `
    <h1 class="mono">${esc(tag)} ${isLive ? '<span class="badge ok">live</span>' : ''}</h1>
    <p class="dim"><a href="/admin/images">← All images</a>${version ? ` · ${esc(version.summary)}` : ''}</p>
    <div class="row" style="margin-bottom:16px">
      ${metaCard}
      ${instancesCard}
    </div>
    ${artifactsSection}
  `;
  return c.html(layout({ title: `Image ${tag}`, body, active: '/admin/images' }));
});

export { router as imagesAdminRouter };
