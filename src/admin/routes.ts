import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Prisma } from '@prisma/client';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../db.js';
import { esc, layout, relTime, statCard, statusPill } from './html.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
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

const router = new Hono();

// ---------- Version (build identity) ----------

/**
 * Tiny ping endpoint that returns the git SHA we built with + the time
 * the orchestrator booted. Lets the dashboard / external scripts confirm
 * which commit is actually live after a Railway deploy — useful when
 * we ship a change and want to verify it's serving before testing.
 *
 * Mounted under /admin so it inherits Basic Auth.
 */
const BOOTED_AT = new Date().toISOString();
router.get('/admin/version', (c) => {
  return c.json({
    sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    branch: process.env.RAILWAY_GIT_BRANCH ?? null,
    bootedAt: BOOTED_AT,
    nodeEnv: process.env.NODE_ENV ?? null,
  });
});

// ---------- Overview ----------

router.get('/admin', async (c) => {
  const cfg = loadConfig();
  const liveImage = tagFromRef(cfg.FLY_MACHINE_IMAGE) ?? cfg.FLY_MACHINE_IMAGE;
  const [
    total,
    running,
    ready,
    suspended,
    provisioning,
    onboarding,
    infraReady,
    errored,
    last24hMsgs,
    last24hInstances,
    recentEvents,
    recentFailures,
    mtdSpend,
    mtdTokens,
    atOrNearCap,
    pendingConfirmations,
    pendingOutbox,
    integrationIssues,
    failedSchedules,
    staleSokosumiSync,
    staleInboxRefresh,
    recentChats,
    attentionRows,
  ] =
    await Promise.all([
      prisma.hermesInstance.count(),
      prisma.hermesInstance.count({ where: { status: 'running' } }),
      prisma.hermesInstance.count({ where: { status: 'ready' } }),
      prisma.hermesInstance.count({ where: { status: 'suspended' } }),
      prisma.hermesInstance.count({ where: { status: 'provisioning' } }),
      prisma.hermesInstance.count({ where: { status: 'onboarding' } }),
      prisma.hermesInstance.count({ where: { status: 'infrastructure_ready' } }),
      prisma.hermesInstance.count({ where: { status: 'error' } }),
      prisma.chatMessage.count({ where: { createdAt: { gt: dayAgo() } } }),
      prisma.hermesInstance.count({ where: { createdAt: { gt: dayAgo() } } }),
      prisma.provisionEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.provisionEvent.findMany({
        where: { event: { in: ['provision_failed', 'chat_failed'] }, createdAt: { gt: dayAgo() } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      prisma.llmUsage.aggregate({
        where: { createdAt: { gte: startOfMonthUtc() } },
        _sum: { costUsd: true },
      }),
      prisma.llmUsage.aggregate({
        where: { createdAt: { gte: startOfMonthUtc() } },
        _sum: { promptTokens: true, completionTokens: true },
      }),
      perUserMonthlyAtCap(cfg.MONTHLY_USD_CAP_PER_USER),
      prisma.pendingConfirmation.count({ where: { status: 'pending' } }),
      prisma.outboxMessage.count(),
      prisma.integration.count({ where: { status: { in: ['failed', 'error', 'disconnected'] } } }),
      prisma.scheduledTask.count({ where: { lastError: { not: null } } }),
      prisma.hermesInstance.count({
        where: {
          destroyedAt: null,
          onboardedAt: { not: null },
          OR: [{ lastSokosumiSyncAt: null }, { lastSokosumiSyncAt: { lt: hoursAgo(24) } }],
        },
      }),
      // Flag at >7h against the sweep's 6h cadence (1h slack for the hourly
      // cron tick, mirroring the 23h-sweep/24h-flag pattern on Sokosumi sync),
      // and only for instances the sweep actually touches (onboarded + alive).
      prisma.hermesInstance.count({
        where: {
          destroyedAt: null,
          onboardedAt: { not: null },
          status: { in: ['ready', 'running', 'suspended'] },
          integrations: {
            some: {
              status: 'connected',
              provider: { in: ['gmail', 'outlook', 'google_calendar', 'outlook_calendar'] },
            },
          },
          OR: [{ lastInboxRefreshAt: null }, { lastInboxRefreshAt: { lt: hoursAgo(7) } }],
        },
      }),
      prisma.chatMessage.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          requestId: true,
          userId: true,
          role: true,
          content: true,
          errorMessage: true,
          latencyMs: true,
          totalTokens: true,
          createdAt: true,
        },
      }),
      prisma.hermesInstance.findMany({
        where: {
          OR: [
            { status: { in: ['error', 'provisioning', 'onboarding', 'infrastructure_ready'] } },
            { integrations: { some: { status: { in: ['failed', 'error', 'disconnected'] } } } },
            { schedules: { some: { lastError: { not: null } } } },
            { outbox: { some: {} } },
            { pendingConfirmations: { some: { status: 'pending' } } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: {
          userId: true,
          name: true,
          email: true,
          status: true,
          sokosumiEnv: true,
          autonomyLevel: true,
          lastActivityAt: true,
          updatedAt: true,
          integrations: { select: { provider: true, status: true }, take: 6 },
          schedules: { where: { lastError: { not: null } }, select: { name: true, lastError: true }, take: 2 },
          _count: { select: { outbox: true, pendingConfirmations: { where: { status: 'pending' } } } },
        },
      }),
    ]);

  const [errorRate24h, poolCounts] = await Promise.all([
    prisma.provisionEvent.count({
      where: { event: { in: ['provision_failed', 'chat_failed'] }, createdAt: { gt: dayAgo() } },
    }),
    prisma.hermesPoolMachine.groupBy({ by: ['status'], _count: { status: true } }),
  ]);
  const poolByStatus = new Map(poolCounts.map((p) => [p.status, p._count.status]));
  const poolReady = poolByStatus.get('ready') ?? 0;
  const poolWarming = poolByStatus.get('warming') ?? 0;
  const poolFailed = poolByStatus.get('failed') ?? 0;
  const poolTarget = cfg.WARM_POOL_TARGET;

  const totalCost = Number(mtdSpend._sum.costUsd ?? 0);
  const totalTokens = (mtdTokens._sum.promptTokens ?? 0) + (mtdTokens._sum.completionTokens ?? 0);
  const actionableTotal =
    errored +
    pendingConfirmations +
    pendingOutbox +
    integrationIssues +
    failedSchedules +
    infraReady +
    staleSokosumiSync +
    staleInboxRefresh;

  const statusLine = [
    ['ready', ready, '/admin/instances?status=ready'],
    ['running', running, '/admin/instances?status=running'],
    ['suspended', suspended, '/admin/instances?status=suspended'],
    ['provisioning', provisioning, '/admin/instances?status=provisioning'],
    ['onboarding', onboarding, '/admin/instances?status=onboarding'],
    ['waiting onboard', infraReady, '/admin/instances?status=infrastructure_ready'],
    ['error', errored, '/admin/instances?status=error'],
  ]
    .map(([label, count, href]) => `<a class="status-link" href="${href}">${esc(label)} <strong>${esc(count)}</strong></a>`)
    .join('');

  const opsLinks = [
    {
      label: 'Pending approvals',
      value: pendingConfirmations,
      href: '/admin/confirmations?status=pending',
      tone: pendingConfirmations > 0 ? 'warn' : '',
    },
    {
      label: 'Outbox backlog',
      value: pendingOutbox,
      href: '/admin/instances?problem=outbox',
      tone: pendingOutbox > 0 ? 'warn' : '',
    },
    {
      label: 'Integration issues',
      value: integrationIssues,
      href: '/admin/instances?problem=integrations',
      tone: integrationIssues > 0 ? 'danger' : '',
    },
    {
      label: 'Schedule errors',
      value: failedSchedules,
      href: '/admin/instances?problem=schedules',
      tone: failedSchedules > 0 ? 'danger' : '',
    },
    {
      label: 'Stale Sokosumi sync',
      value: staleSokosumiSync,
      href: '/admin/instances?problem=sokosumi-sync',
      tone: staleSokosumiSync > 0 ? 'warn' : '',
    },
    {
      label: 'Stale inbox refresh',
      value: staleInboxRefresh,
      href: '/admin/instances?problem=inbox-refresh',
      tone: staleInboxRefresh > 0 ? 'warn' : '',
    },
  ];

  const body = `
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <div class="subtle-line">Production · ${esc(process.env.RAILWAY_SERVICE_NAME ?? 'orchestrator')} · image <span class="mono">${esc(liveImage)}</span>${process.env.RAILWAY_GIT_COMMIT_SHA ? ` · sha <span class="mono">${esc(process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7))}</span>` : ''}</div>
      </div>
      <div class="actions no-margin">
        <a class="btn" href="/admin/instances">Instances</a>
        <a class="btn" href="/admin/usage">Usage</a>
        <a class="btn" href="/admin/chats">Chats</a>
        <a class="btn" href="/admin/events">Events</a>
        <a class="btn" href="/admin/version" target="_blank">Version JSON</a>
      </div>
    </div>

    <div class="stats">
      ${statCard('Needs attention', actionableTotal, 'errors, approvals, backlog, failed jobs', actionableTotal > 0 ? 'warn' : 'ok')}
      ${statCard('Total instances', total, `${last24hInstances} new in 24h`)}
      ${statCard('Ready/running', ready + running, `${ready} ready · ${running} running`, ready + running > 0 ? 'ok' : undefined)}
      ${statCard('In progress', provisioning + onboarding + infraReady, `${provisioning} provisioning · ${onboarding} onboarding · ${infraReady} waiting`, provisioning + onboarding + infraReady > 0 ? 'warn' : undefined)}
      ${statCard('Errored', errored, undefined, errored > 0 ? 'danger' : undefined)}
      ${statCard('Warm pool', `${poolReady}/${poolTarget}`, poolTarget === 0 ? 'disabled (WARM_POOL_TARGET=0)' : `${poolWarming} warming${poolFailed > 0 ? ` · ${poolFailed} failed` : ''}`, poolTarget > 0 && poolReady === 0 ? 'warn' : poolFailed > 0 ? 'warn' : undefined)}
      ${statCard('Chats (24h)', last24hMsgs, errorRate24h > 0 ? `${errorRate24h} failure event(s)` : undefined, errorRate24h > 0 ? 'danger' : undefined)}
      ${statCard('MTD spend', '$' + totalCost.toFixed(2), `${totalTokens.toLocaleString()} tokens · cap $${cfg.MONTHLY_USD_CAP_PER_USER}/user`)}
    </div>
    ${errorRate24h > 0 ? `<p class="dim" style="margin:-12px 0 20px;font-size:12px"><a href="/admin/events?filter=failures">${esc(errorRate24h)} provision/chat failure event(s) in the last 24h →</a></p>` : ''}

    <div class="status-strip">${statusLine}</div>

    <h2>Operator queue</h2>
    <div class="ops-grid">
      ${opsLinks.map((x) => `
        <a class="op-card ${esc(x.tone)}" href="${esc(x.href)}">
          <span>${esc(x.label)}</span>
          <strong>${esc(x.value)}</strong>
        </a>
      `).join('')}
    </div>

    <h2>Users to check first</h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${attentionRows.length === 0 ? '<div class="empty">No active instance-level issues.</div>' : `
        <table>
          <thead><tr><th>User</th><th>Status</th><th>Env · Autonomy</th><th>Signals</th><th>Last activity</th></tr></thead>
          <tbody>
            ${attentionRows.map((r) => {
              const who = userLabel(r);
              const integrationBadges = r.integrations
                .filter((i) => i.status !== 'connected')
                .map((i) => `<span class="badge danger">${esc(i.provider)} ${esc(i.status)}</span>`)
                .join(' ');
              const scheduleBadges = r.schedules
                .map((s) => `<span class="badge danger" title="${esc(s.lastError ?? '')}">${esc(s.name)}</span>`)
                .join(' ');
              const backlog = r._count.outbox > 0 ? `<span class="badge warn">${esc(r._count.outbox)} outbox</span>` : '';
              const confirmations = r._count.pendingConfirmations > 0 ? `<span class="badge warn">${esc(r._count.pendingConfirmations)} confirmations</span>` : '';
              const signals = [integrationBadges, scheduleBadges, backlog, confirmations].filter(Boolean).join(' ') || '<span class="dim">status needs attention</span>';
              return `<tr>
                <td><a href="/admin/instances/${encodeURIComponent(r.userId)}">${who}</a></td>
                <td>${statusPill(r.status)}</td>
                <td><span class="badge${r.sokosumiEnv === 'mainnet' ? ' danger' : ''}">${esc(r.sokosumiEnv ?? 'mainnet')}</span> <span class="badge${r.autonomyLevel === 'high' ? ' warn' : ''}">${esc(r.autonomyLevel)}</span></td>
                <td>${signals}</td>
                <td class="mono" title="${esc(r.updatedAt.toISOString())}">${esc(relTime(r.lastActivityAt))}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>

    ${atOrNearCap.length === 0 ? '' : `
      <h2>Users near or at monthly cap</h2>
      <div class="card" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>User</th><th>MTD spend</th><th>% of cap</th></tr></thead>
          <tbody>
            ${atOrNearCap.map(u => `
              <tr>
                <td><a class="mono" href="/admin/instances/${encodeURIComponent(u.userId)}">${esc(u.userId)}</a></td>
                <td>$${u.spend.toFixed(4)}</td>
                <td>${u.pct.toFixed(0)}%${u.pct >= 100 ? ' · <span class="pill err">capped</span>' : u.pct >= 80 ? ' · <span class="pill warn">approaching</span>' : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}

    <h2>Latest chats</h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${recentChats.length === 0 ? '<div class="empty">No chats yet.</div>' : `
        <table>
          <thead><tr><th>When</th><th>User</th><th>Role</th><th>Message</th><th>Cost signal</th></tr></thead>
          <tbody>
            ${recentChats.map((m) => `
              <tr>
                <td class="mono" title="${esc(m.createdAt.toISOString())}">${esc(relTime(m.createdAt))}</td>
                <td><a class="mono" href="/admin/instances/${encodeURIComponent(m.userId)}">${esc(m.userId.slice(0, 14))}</a></td>
                <td><span class="badge ${m.errorMessage ? 'danger' : ''}">${esc(m.errorMessage ? 'error' : m.role)}</span></td>
                <td><a href="/admin/chats/${encodeURIComponent(m.requestId)}">${esc(compactText(m.content, 180))}</a>${m.errorMessage ? `<div class="dim" style="color:var(--err);font-size:11px">${esc(m.errorMessage)}</div>` : ''}</td>
                <td class="mono">${m.totalTokens ? `${esc(m.totalTokens)} tok` : '—'}${m.latencyMs !== null ? ` · ${esc(m.latencyMs)}ms` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <h2>Recent events</h2>
    <div class="card">
      ${recentEvents.length === 0 ? '<div class="empty">No events yet.</div>' : recentEvents.map(renderEventRow).join('')}
    </div>
  `;
  return c.html(layout({ title: 'Overview', body, active: '/admin' }));
});

// ---------- Instances list ----------

router.get('/admin/instances', async (c) => {
  const q = c.req.query('q') ?? '';
  const status = c.req.query('status') ?? '';
  const env = c.req.query('env') ?? '';
  const autonomy = c.req.query('autonomy') ?? '';
  const onboarded = c.req.query('onboarded') ?? '';
  const problem = c.req.query('problem') ?? '';
  const image = c.req.query('image') ?? '';

  const and: Prisma.HermesInstanceWhereInput[] = [];
  if (q) {
    and.push({
      OR: [
        { userId: { contains: q, mode: 'insensitive' } },
        { spriteName: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { role: { contains: q, mode: 'insensitive' } },
        { company: { contains: q, mode: 'insensitive' } },
        { id: { equals: q } },
      ],
    });
  }
  if (env) {
    and.push(
      env === 'mainnet'
        ? { OR: [{ sokosumiEnv: 'mainnet' }, { sokosumiEnv: null }] }
        : { sokosumiEnv: env },
    );
  }
  if (autonomy) and.push({ autonomyLevel: autonomy });
  if (onboarded === 'yes') and.push({ onboardedAt: { not: null } });
  if (onboarded === 'no') and.push({ onboardedAt: null });
  if (image === 'unknown') and.push({ imageTag: null });
  else if (image) and.push(imageTagWhere(image));
  if (problem === 'outbox') and.push({ outbox: { some: {} } });
  if (problem === 'integrations') and.push({ integrations: { some: { status: { in: ['failed', 'error', 'disconnected'] } } } });
  if (problem === 'schedules') and.push({ schedules: { some: { lastError: { not: null } } } });
  if (problem === 'pending-confirmations') and.push({ pendingConfirmations: { some: { status: 'pending' } } });
  if (problem === 'sokosumi-sync') {
    and.push({
      destroyedAt: null,
      onboardedAt: { not: null },
      OR: [{ lastSokosumiSyncAt: null }, { lastSokosumiSyncAt: { lt: hoursAgo(24) } }],
    });
  }
  if (problem === 'inbox-refresh') {
    and.push({
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
      integrations: {
        some: {
          status: 'connected',
          provider: { in: ['gmail', 'outlook', 'google_calendar', 'outlook_calendar'] },
        },
      },
      OR: [{ lastInboxRefreshAt: null }, { lastInboxRefreshAt: { lt: hoursAgo(7) } }],
    });
  }

  // The status filter is applied to the rows/count but NOT to the status
  // chips — otherwise selecting a status collapses the chip switcher to a
  // single chip and you can't jump to another status.
  const chipWhere: Prisma.HermesInstanceWhereInput = and.length > 0 ? { AND: [...and] } : {};
  if (status) and.push({ status });
  const where: Prisma.HermesInstanceWhereInput = and.length > 0 ? { AND: and } : {};
  const [rows, totalMatching, statusCounts] = await Promise.all([
    prisma.hermesInstance.findMany({
      where,
      orderBy: [{ status: 'asc' }, { lastActivityAt: 'desc' }],
      take: 200,
      include: {
        integrations: {
          select: { provider: true, status: true, mode: true },
          orderBy: [{ status: 'asc' }, { provider: 'asc' }],
        },
        _count: {
          select: {
            outbox: true,
            schedules: true,
            pendingConfirmations: { where: { status: 'pending' } },
            installedSkills: true,
          },
        },
      },
    }),
    prisma.hermesInstance.count({ where }),
    prisma.hermesInstance.groupBy({
      by: ['status'],
      where: chipWhere,
      _count: { status: true },
      orderBy: { status: 'asc' },
    }),
  ]);

  const currentParams = new URLSearchParams();
  if (q) currentParams.set('q', q);
  if (env) currentParams.set('env', env);
  if (autonomy) currentParams.set('autonomy', autonomy);
  if (onboarded) currentParams.set('onboarded', onboarded);
  if (problem) currentParams.set('problem', problem);
  if (image) currentParams.set('image', image);
  const statusFilterLinks = statusCounts
    .map((s) => {
      const params = new URLSearchParams(currentParams);
      params.set('status', s.status);
      const active = s.status === status ? ' active' : '';
      return `<a class="filter-chip${active}" href="/admin/instances?${esc(params.toString())}">${esc(s.status)} <strong>${esc(s._count.status)}</strong></a>`;
    })
    .join('');

  const body = `
    <div class="page-head">
      <div>
        <h1>Instances</h1>
        <div class="subtle-line">Showing ${esc(rows.length)} of ${esc(totalMatching)} matching users. Use filters to narrow before taking action.</div>
      </div>
      <div class="actions no-margin">
        <a class="btn" href="/admin/instances?problem=integrations">Integration issues</a>
        <a class="btn" href="/admin/instances?problem=outbox">Outbox</a>
        <a class="btn" href="/admin/instances?status=error">Errors</a>
      </div>
    </div>
    <form method="get" action="/admin/instances" class="actions filter-bar">
      <input type="search" name="q" placeholder="Search name, email, company, role, userId, app…" value="${esc(q)}" />
      <select name="status">
        <option value="">all statuses</option>
        ${['running', 'ready', 'onboarding', 'suspended', 'provisioning', 'infrastructure_ready', 'error']
          .map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <select name="env">
        <option value="">all envs</option>
        ${['development', 'preprod', 'mainnet']
          .map((s) => `<option value="${s}" ${s === env ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <select name="autonomy">
        <option value="">all autonomy</option>
        ${['low', 'medium', 'high']
          .map((s) => `<option value="${s}" ${s === autonomy ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <select name="onboarded">
        <option value="">any onboarding</option>
        <option value="yes" ${onboarded === 'yes' ? 'selected' : ''}>onboarded</option>
        <option value="no" ${onboarded === 'no' ? 'selected' : ''}>not onboarded</option>
      </select>
      <select name="problem">
        <option value="">any problem</option>
        ${[
          ['outbox', 'outbox backlog'],
          ['integrations', 'integration issue'],
          ['schedules', 'schedule error'],
          ['pending-confirmations', 'pending confirmation'],
          ['sokosumi-sync', 'stale Sokosumi sync'],
          ['inbox-refresh', 'stale inbox refresh'],
        ].map(([value, label]) => `<option value="${value}" ${value === problem ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select name="image">
        <option value="">any image</option>
        ${IMAGE_VERSIONS.map((v) => `<option value="${esc(v.tag)}" ${v.tag === image ? 'selected' : ''}>${esc(v.tag)}</option>`).join('')}
        <option value="unknown" ${image === 'unknown' ? 'selected' : ''}>unknown</option>
      </select>
      <button type="submit">Filter</button>
      <a href="/admin/instances">Reset</a>
    </form>
    ${statusFilterLinks ? `<div class="filter-chips">${statusFilterLinks}</div>` : ''}
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Status</th>
            <th>Env</th>
            <th>Autonomy</th>
            <th>Integrations</th>
            <th>Backlog</th>
            <th>Image</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="8" class="empty">No instances match.</td></tr>` : rows.map(rowToInstanceRow).join('')}
        </tbody>
      </table>
    </div>
    ${totalMatching > rows.length ? `<p class="dim" style="font-size:12px;margin-top:12px">Limited to 200 rows. Refine with search/filter to narrow the set.</p>` : ''}
  `;
  return c.html(layout({ title: 'Instances', body, active: '/admin/instances' }));
});

function rowToInstanceRow(r: {
  id: string;
  userId: string;
  status: string;
  region: string;
  lastActivityAt: Date;
  createdAt: Date;
  spriteName: string;
  endpointUrl: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  company: string | null;
  autonomyLevel: string;
  sokosumiEnv: string | null;
  onboardedAt: Date | null;
  imageTag: string | null;
  integrations: Array<{ provider: string; status: string; mode: string }>;
  _count: {
    outbox: number;
    schedules: number;
    pendingConfirmations: number;
    installedSkills: number;
  };
}): string {
  const who = userLabel(r);
  const roleCompany = r.role || r.company
    ? `<div class="dim" style="font-size:11px">${esc(r.role ?? '')}${r.role && r.company ? ' · ' : ''}${r.company ? `<strong>${esc(r.company)}</strong>` : ''}</div>`
    : '';
  const integrations = r.integrations.length === 0
    ? '<span class="dim">none</span>'
    : r.integrations
        .map((i) => {
          const cls = i.status === 'connected' ? 'ok' : i.status === 'pending' || i.status === 'connecting' ? 'warn' : 'danger';
          return `<span class="badge ${cls}" title="${esc(i.mode)}">${esc(shortProvider(i.provider))}</span>`;
        })
        .join(' ');
  const backlog = [
    r._count.outbox > 0 ? `<a class="badge warn" href="/admin/instances?problem=outbox&q=${encodeURIComponent(r.userId)}">${esc(r._count.outbox)} outbox</a>` : '',
    r._count.pendingConfirmations > 0 ? `<a class="badge warn" href="/admin/confirmations?status=pending&user=${encodeURIComponent(r.userId)}">${esc(r._count.pendingConfirmations)} approvals</a>` : '',
    r._count.schedules > 0 ? `<span class="badge">${esc(r._count.schedules)} schedules</span>` : '',
    r._count.installedSkills > 0 ? `<span class="badge">${esc(r._count.installedSkills)} skills</span>` : '',
  ].filter(Boolean).join(' ') || '<span class="dim">—</span>';
  const tag = tagFromRef(r.imageTag);
  const imageCell = tag
    ? `<a class="mono" href="/admin/images/${encodeURIComponent(tag)}">${esc(tag)}</a>`
    : r.imageTag
      ? `<span class="mono" title="${esc(r.imageTag)}">${esc(r.imageTag.length > 24 ? r.imageTag.slice(0, 24) + '…' : r.imageTag)}</span>`
      : '<span class="dim">unknown</span>';
  return `<tr>
    <td><a href="/admin/instances/${encodeURIComponent(r.userId)}">${who}</a>${roleCompany}</td>
    <td>${statusPill(r.status)}</td>
    <td><span class="badge${r.sokosumiEnv === 'mainnet' ? ' danger' : ''}">${esc(r.sokosumiEnv ?? 'mainnet')}</span></td>
    <td><span class="badge${r.autonomyLevel === 'high' ? ' warn' : ''}">${esc(r.autonomyLevel)}</span>${r.onboardedAt ? '' : ' <span class="badge warn">not onboarded</span>'}</td>
    <td>${integrations}</td>
    <td>${backlog}</td>
    <td>${imageCell}</td>
    <td class="mono" title="created ${esc(r.createdAt.toISOString())}">${esc(relTime(r.lastActivityAt))}<div class="dim" style="font-size:11px">age ${esc(relTime(r.createdAt))}</div></td>
  </tr>`;
}

// ---------- Instance detail ----------

router.get('/admin/instances/:userId', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) {
    return c.html(
      layout({
        title: 'Instance',
        body: `<h1>Instance</h1><div class="empty">No instance for user <span class="mono">${esc(userId)}</span>.</div>`,
        active: '/admin/instances',
      }),
      404,
    );
  }

  const cfg = loadConfig();
  const [messages, events, mtdSpend, usageByModel, schedules, integrations, confirmations, skills, dailyUsage, usageTotals] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { instanceId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.provisionEvent.findMany({
      where: { OR: [{ instanceId: row.id }, { userId: row.userId }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    userMonthlySpend(row.userId),
    prisma.llmUsage.groupBy({
      by: ['model'],
      where: { userId: row.userId, createdAt: { gte: startOfMonthUtc() } },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costUsd: 'desc' } },
    }),
    prisma.scheduledTask.findMany({
      where: { instanceId: row.id },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.integration.findMany({
      where: { userId: row.userId },
      orderBy: { provider: 'asc' },
    }),
    prisma.pendingConfirmation.findMany({
      where: { userId: row.userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.installedSkill.findMany({
      where: { userId: row.userId },
      orderBy: { createdAt: 'desc' },
    }),
    usageByDay(14, row.userId),
    prisma.llmUsage.aggregate({
      where: { userId: row.userId },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true },
    }),
  ]);
  const outboxPending = await prisma.outboxMessage.findMany({
    where: { instanceId: row.id },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  // This user's cron-driven activity: sweep agent turns, memory refreshes,
  // and native cronjob deliveries (durable outbox_pushed previews).
  const cronActivity = (
    await prisma.provisionEvent.findMany({
      where: {
        userId: row.userId,
        event: { in: ['chat_proxied', 'onboarding_step', 'eod_report_sent', 'outbox_pushed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 120,
    })
  )
    .filter(isCronDrivenEvent)
    .slice(0, 25);
  const capPct = (mtdSpend / cfg.MONTHLY_USD_CAP_PER_USER) * 100;
  const capPill =
    capPct >= 100
      ? `<span class="pill err">capped</span>`
      : capPct >= 80
        ? `<span class="pill warn">${capPct.toFixed(0)}%</span>`
        : `<span class="pill ok">${capPct.toFixed(0)}%</span>`;

  const imageTag = tagFromRef(row.imageTag);
  const steps = (row.onboardingSteps as Array<{ id: string; label?: string; status: string }> | null) ?? [];
  const stepBadge = (s: { id: string; status: string }): string => {
    const cls = s.status === 'done' ? 'ok' : s.status === 'failed' ? 'danger' : s.status === 'running' ? 'warn' : '';
    return `<span class="badge ${cls}" title="${esc(s.status)}">${esc(s.id)}</span>`;
  };
  const persona = [
    row.personaName ? `name "${row.personaName}"` : '',
    row.verbosity ? `verbosity ${row.verbosity}` : '',
    row.tone ? `tone ${row.tone}` : '',
  ].filter(Boolean).join(' · ');
  const p3 = row.personality as { tone?: number; detail?: number; style?: number } | null;
  const canRetryOnboarding = ['error', 'onboarding', 'infrastructure_ready'].includes(row.status);
  const allTokens = (usageTotals._sum.promptTokens ?? 0) + (usageTotals._sum.completionTokens ?? 0);
  const maxDailyCost = Math.max(...dailyUsage.map((d) => d.cost), 0.000001);

  const body = `
    <div class="page-head">
      <div>
        <h1 style="font-size:18px">${esc(row.name ?? row.userId)}</h1>
        <div class="subtle-line mono">${esc(row.userId)}${row.email ? ` · ${esc(row.email)}` : ''}</div>
      </div>
      <div class="actions no-margin">
        <a class="btn" href="/admin/chats?user=${encodeURIComponent(row.userId)}">Chats</a>
        <a class="btn" href="/admin/confirmations?user=${encodeURIComponent(row.userId)}">Confirmations</a>
        ${row.spriteName ? `<a class="btn" href="https://fly.io/apps/${encodeURIComponent(row.spriteName)}" target="_blank">Fly dashboard ↗</a>` : ''}
      </div>
    </div>
    <div class="row" style="margin-bottom:16px">
      <div class="card flex-1">
        <h3>Instance</h3>
        <dl class="kv">
          <dt>Status</dt><dd>${statusPill(row.status)}${row.onboardedAt ? '' : ' <span class="badge warn">not onboarded</span>'}</dd>
          <dt>Endpoint</dt><dd>${row.endpointUrl ? `<a class="mono" href="${esc(row.endpointUrl)}" target="_blank">${esc(row.endpointUrl)}</a>` : '—'}</dd>
          <dt>Fly app</dt><dd class="mono">${esc(row.spriteName)} <span class="dim">(${esc(row.region || '—')})</span></dd>
          <dt>Image</dt><dd>${imageTag ? `<a class="mono" href="/admin/images/${encodeURIComponent(imageTag)}">${esc(imageTag)}</a>` : row.imageTag ? `<span class="mono">${esc(row.imageTag)}</span>` : '<span class="dim">unknown</span>'}${row.imageRolledAt ? ` <span class="dim">rolled ${esc(relTime(row.imageRolledAt))}</span>` : ''}${row.isTestBench ? ' <span class="badge ok">bench</span>' : ''}</dd>
          <dt>Env</dt><dd><span class="badge${row.sokosumiEnv === 'mainnet' ? ' danger' : ''}">${esc(row.sokosumiEnv ?? 'mainnet')}</span> <span class="badge${row.autonomyLevel === 'high' ? ' warn' : ''}">autonomy ${esc(row.autonomyLevel)}</span></dd>
          <dt>Created</dt><dd>${esc(relTime(row.createdAt))} <span class="dim mono">${esc(row.createdAt.toISOString().slice(0, 16))}Z</span></dd>
          <dt>Last activity</dt><dd>${esc(relTime(row.lastActivityAt))}</dd>
          <dt>Sokosumi sync</dt><dd>${esc(relTime(row.lastSokosumiSyncAt))}</dd>
          <dt>Inbox refresh</dt><dd>${esc(relTime(row.lastInboxRefreshAt))}</dd>
          ${row.errorMessage ? `<dt>Last error</dt><dd style="color:var(--err)">${esc(row.errorMessage)}</dd>` : ''}
        </dl>
        <h3 style="margin-top:20px">Profile</h3>
        <dl class="kv">
          ${row.role || row.company ? `<dt>Role</dt><dd>${esc(row.role ?? '—')}${row.company ? ` at <strong>${esc(row.company)}</strong>` : ''}</dd>` : ''}
          <dt>Timezone</dt><dd class="mono">${esc(row.timezone ?? 'UTC')}</dd>
          ${persona ? `<dt>Persona</dt><dd>${esc(persona)}</dd>` : ''}
          ${p3 && typeof p3 === 'object' ? `<dt>Voice</dt><dd class="mono">tone ${esc(p3.tone ?? 50)} · detail ${esc(p3.detail ?? 50)} · style ${esc(p3.style ?? 50)}</dd>` : ''}
          ${row.welcomeKind ? `<dt>Welcome</dt><dd>${esc(row.welcomeKind)}${row.onboardedAt ? ` · onboarded ${esc(relTime(row.onboardedAt))}` : ''}</dd>` : ''}
          ${steps.length > 0 ? `<dt>Onboarding</dt><dd>${steps.map(stepBadge).join(' ')}</dd>` : ''}
        </dl>
      </div>
      <div class="card flex-1">
        <h3>Usage</h3>
        <dl class="kv">
          <dt>MTD</dt><dd>$${mtdSpend.toFixed(4)} / $${cfg.MONTHLY_USD_CAP_PER_USER.toFixed(2)} ${capPill}</dd>
          <dt>All-time</dt><dd>$${Number(usageTotals._sum.costUsd ?? 0).toFixed(4)} · ${allTokens.toLocaleString()} tok · ${esc(usageTotals._count._all)} LLM calls</dd>
          ${usageByModel.length === 0 ? '' : usageByModel.map(u => {
            const tokens = (u._sum.promptTokens ?? 0) + (u._sum.completionTokens ?? 0);
            const cost = Number(u._sum.costUsd ?? 0);
            return `<dt class="mono" style="font-size:11px">${esc(u.model)}</dt><dd>$${cost.toFixed(4)} · ${tokens.toLocaleString()} tok · ${esc(u._count._all)} calls</dd>`;
          }).join('')}
        </dl>
        ${dailyUsage.length === 0 ? '' : `
        <h3 style="margin-top:20px">Spend by day (14d)</h3>
        <div>
          ${dailyUsage.map((d) => `
            <div class="bar-row">
              <span class="bar-label">${esc(d.day)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Math.round((d.cost / maxDailyCost) * 100))}%"></div></div>
              <span class="bar-value">$${d.cost.toFixed(4)} · ${esc(d.calls)} calls</span>
            </div>`).join('')}
        </div>`}
        <h3 style="margin-top:20px">Actions</h3>
        <div class="actions" style="margin-top:8px">
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/resume" class="inline"><button type="submit">Resume</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/suspend" class="inline"><button type="submit">Suspend</button></form>
          ${canRetryOnboarding ? `<form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/retry-onboarding" class="inline"><button type="submit" class="primary" title="Reset the stuck step and re-kick the onboarding pipeline">Retry onboarding</button></form>` : ''}
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/sync-config" class="inline"><button type="submit" title="Replace the machine onto the current FLY_MACHINE_IMAGE — launcher re-syncs SOUL.md, config.yaml + skills on boot">Sync config</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/toggle-bench" class="inline"><button type="submit" title="Mark this instance as a test bench so it shows up on the Tests page">${row.isTestBench ? 'Unmark bench' : 'Mark as bench'}</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/destroy" class="inline" onsubmit="return confirm('Destroy sprite + DB row for this user? Cannot be undone.')"><button type="submit" class="danger">Destroy</button></form>
        </div>
        <p class="dim" style="font-size:11px;margin:12px 0 0">Machine logs: <span class="mono">fly logs -a ${esc(row.spriteName)}</span> or the Fly dashboard link above.</p>
      </div>
    </div>

    <div class="row" style="margin-bottom:16px">
      <div class="card flex-1">
        <h3>Integrations</h3>
        ${integrations.length === 0 ? '<div class="empty" style="padding:12px">None connected.</div>' : `
          <table>
            <thead><tr><th>Provider</th><th>Status</th><th>Mode</th><th>Connected</th></tr></thead>
            <tbody>
              ${integrations.map((i) => {
                const cls = i.status === 'connected' ? 'ok' : i.status === 'pending' || i.status === 'connecting' ? 'warn' : 'danger';
                return `<tr>
                  <td class="mono">${esc(i.provider)}</td>
                  <td><span class="badge ${cls}">${esc(i.status)}</span>${i.lastError ? `<div class="dim" style="color:var(--err);font-size:11px">${esc(i.lastError.slice(0, 120))}</div>` : ''}</td>
                  <td class="mono">${esc(i.mode)}</td>
                  <td class="mono">${i.connectedAt ? esc(relTime(i.connectedAt)) : '—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`}
      </div>
      <div class="card flex-1">
        <h3>Installed skills <span class="dim" style="text-transform:none;letter-spacing:0">(marketplace)</span></h3>
        ${skills.length === 0 ? '<div class="empty" style="padding:12px">No marketplace skills installed.</div>' : `
          <table>
            <thead><tr><th>Skill</th><th>Source</th><th>Risk</th><th>Status</th></tr></thead>
            <tbody>
              ${skills.map((s) => `<tr>
                <td class="mono">${esc(s.slug)}</td>
                <td class="dim" style="font-size:12px">${esc(s.source)}</td>
                <td>${s.auditRisk ? `<span class="badge ${s.auditRisk === 'NONE' || s.auditRisk === 'LOW' ? '' : 'warn'}">${esc(s.auditRisk)}</span>` : '—'}</td>
                <td><span class="badge ${s.status === 'installed' ? 'ok' : s.status === 'failed' ? 'danger' : 'warn'}">${esc(s.status)}</span>${s.lastError ? `<div class="dim" style="color:var(--err);font-size:11px">${esc(s.lastError.slice(0, 100))}</div>` : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
      </div>
    </div>

    ${confirmations.length === 0 ? '' : `
    <h2>Recent confirmations <a href="/admin/confirmations?user=${encodeURIComponent(row.userId)}" style="font-weight:400;font-size:12px">all →</a></h2>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Tool</th><th>Status</th><th>Summary</th><th>When</th></tr></thead>
        <tbody>
          ${confirmations.map((cf) => `<tr>
            <td class="mono" style="font-size:12px"><a href="/admin/confirmations/${encodeURIComponent(cf.id)}">${esc(cf.toolName)}</a></td>
            <td><span class="badge ${cf.status === 'pending' ? 'warn' : cf.status === 'approved' ? 'ok' : 'danger'}">${esc(cf.status)}</span></td>
            <td>${esc(cf.summary.slice(0, 180))}</td>
            <td class="mono">${esc(relTime(cf.createdAt))}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`}

    <h2>Outbox <span style="color:var(--muted);font-weight:400;font-size:13px">(unacked messages waiting for Sokosumi to pull)</span></h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${outboxPending.length === 0 ? '<div class="empty">Outbox empty.</div>' : `
        <table>
          <thead><tr><th>Created</th><th>Kind</th><th>Content</th><th></th></tr></thead>
          <tbody>
            ${outboxPending.map(m => `
              <tr>
                <td>${esc(relTime(m.createdAt))}</td>
                <td class="mono">${esc(m.kind)}</td>
                <td style="max-width:520px;white-space:pre-wrap">${esc(m.content.length > 240 ? m.content.slice(0, 240) + '…' : m.content)}</td>
                <td><form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/outbox/${m.id}/delete" class="inline" onsubmit="return confirm('Drop this outbox message (Sokosumi will never see it)?')"><button type="submit" class="danger">Drop</button></form></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <h2>Scheduled tasks</h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${schedules.length === 0 ? '<div class="empty">No scheduled tasks. The agent can create them when the user asks.</div>' : `
        <table>
          <thead><tr><th>Name</th><th>Cron</th><th>Next run</th><th>Last run</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${schedules.map(s => `
              <tr>
                <td>${esc(s.name)}</td>
                <td class="mono" title="${esc(describeCron(s.cronExpr))}">${esc(s.cronExpr)} ${s.timezone === 'UTC' ? '' : `<span style="color:var(--muted)">${esc(s.timezone)}</span>`}</td>
                <td>${esc(relTime(s.nextRunAt))} <span style="color:var(--muted)">${esc(s.nextRunAt.toISOString().slice(0, 16))}Z</span></td>
                <td>${s.lastRunAt ? esc(relTime(s.lastRunAt)) : '—'}${s.lastError ? `<br><span style="color:var(--err);font-size:11px">${esc(s.lastError)}</span>` : ''}</td>
                <td>${s.enabled ? '<span class="pill ok">enabled</span>' : '<span class="pill muted">disabled</span>'}</td>
                <td>
                  <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/schedules/${s.id}/toggle" class="inline"><button type="submit">${s.enabled ? 'Pause' : 'Resume'}</button></form>
                  <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/schedules/${s.id}/delete" class="inline" onsubmit="return confirm('Delete this schedule?')"><button type="submit" class="danger">Delete</button></form>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <h2>Cron activity <a href="/admin/crons?user=${encodeURIComponent(row.userId)}" style="font-weight:400;font-size:12px">full history →</a></h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${cronActivity.length === 0 ? '<div class="empty">No cron-driven activity for this user yet — briefs, sweep agent turns and native cron deliveries appear here as they happen.</div>' : `
        <table>
          <thead><tr><th>When</th><th>What</th><th>Detail / preview</th></tr></thead>
          <tbody>
            ${cronActivity.map((e) => `<tr>
              <td class="mono" title="${esc(e.createdAt.toISOString())}">${esc(relTime(e.createdAt))}</td>
              <td>${cronEventLabel(e)}</td>
              <td class="mono" style="font-size:11px;max-width:560px;word-break:break-word">${cronEventDetail(e)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `}
    </div>

    <h2>Chat history (latest 100) <a href="/admin/chats?user=${encodeURIComponent(row.userId)}" style="font-weight:400;font-size:12px">browse all →</a></h2>
    <div class="chat-list">
      ${messages.length === 0 ? '<div class="empty">No messages yet for this user.</div>' : messages.map(renderChatMsg).join('')}
    </div>

    <h2>Provision events</h2>
    <div class="card">
      ${events.length === 0 ? '<div class="empty">No events.</div>' : events.map(renderEventRow).join('')}
    </div>
  `;
  return c.html(layout({ title: row.userId, body, active: '/admin/instances' }));
});

router.get('/admin/instances/:userId/sprite-logs', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.text('not found', 404);
  // The agent runs on a Fly machine; live process logs aren't streamed into the
  // dashboard. Point operators at the Fly tooling rather than the dead
  // Sprites-era tail (which always 404'd and surfaced a raw stack trace here).
  const msg = `Live process logs aren't streamed into this dashboard — the agent runs on a Fly machine.

View them with the Fly CLI:
  fly logs -a ${row.spriteName}

…or open the machine in the Fly dashboard.`;
  return c.text(msg, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

router.post('/admin/instances/:userId/resume', async (c) => {
  const userId = c.req.param('userId');
  const { resumeInstance } = await import('../provision/provision.js');
  try {
    await resumeInstance(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'admin_resume_failed');
  }
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

router.post('/admin/instances/:userId/suspend', async (c) => {
  const userId = c.req.param('userId');
  const { suspendInstance } = await import('../provision/provision.js');
  try {
    await suspendInstance(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'admin_suspend_failed');
  }
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

router.post('/admin/instances/:userId/destroy', async (c) => {
  const userId = c.req.param('userId');
  const { destroyInstance } = await import('../provision/provision.js');
  try {
    await destroyInstance(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'admin_destroy_failed');
  }
  return c.redirect('/admin/instances');
});

/**
 * Hard reset: destroy the Fly app + remove all DB rows for this user
 * (HermesInstance, Integration, ChatMessage, OutboxMessage, ScheduledTask
 * all cascade off the HermesInstance delete). Next POST /v1/instances
 * is treated as a fresh first-time provision — no inherited onboardedAt,
 * no preserved integrations.
 *
 * For testing / dev only. POST-only — a GET with side effects is a
 * cross-site-request foot-gun behind cookie-persisted Basic Auth.
 */
const hardReset = async (c: Context) => {
  const userId = c.req.param('userId');
  const { prisma } = await import('../db.js');
  const { FlyClient } = await import('../fly/client.js');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ ok: true, userId, note: 'no row to delete' });
  if (row.spriteName) {
    try {
      await new FlyClient().deleteApp(row.spriteName);
    } catch (err) {
      logger.warn({ err, userId, appName: row.spriteName }, 'admin_hard_reset_fly_delete_failed');
    }
  }
  await prisma.hermesInstance.delete({ where: { id: row.id } });
  return c.json({ ok: true, userId, appDeleted: row.spriteName });
};
router.post('/admin/instances/:userId/hard-reset', hardReset);

/**
 * Recover an instance whose onboarding pipeline died mid-flight (typical
 * cause: orchestrator pod restart while a step was running). Flips
 * status back to a state that /onboard accepts, resets the running
 * step to pending, and re-kicks runOnboarding. Idempotent.
 */
const retryOnboarding = async (c: Context) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const steps = ((row.onboardingSteps as Array<{ id: string; status: string; finishedAt?: string }> | null) ?? []).map(
    (s) => (s.status === 'running' || s.status === 'pending' ? { ...s, status: 'pending' } : s),
  );
  await prisma.hermesInstance.update({
    where: { id: row.id },
    data: { status: 'infrastructure_ready', onboardingSteps: steps as object, errorMessage: null },
  });
  const { runOnboarding } = await import('../provision/onboarding.js');
  void runOnboarding(row.id, {}).catch((err) =>
    logger.error({ err, userId, instanceId: row.id }, 'admin_retry_onboarding_failed'),
  );
  // Form posts (the detail-page button) want to land back on the page;
  // API callers (curl) get JSON.
  if ((c.req.header('accept') ?? '').includes('text/html')) {
    return c.redirect(`/admin/instances/${encodeURIComponent(userId ?? '')}`);
  }
  return c.json({ ok: true, userId, retried: true });
};
router.post('/admin/instances/:userId/retry-onboarding', retryOnboarding);

router.post('/admin/instances/:userId/sync-config', async (c) => {
  const userId = c.req.param('userId');
  const { syncConfig } = await import('../provision/sync-config.js');
  try {
    await syncConfig(userId);
  } catch (err) {
    logger.warn({ err, userId }, 'admin_sync_config_failed');
  }
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

router.post('/admin/instances/:userId/schedules/:scheduleId/toggle', async (c) => {
  const userId = c.req.param('userId');
  const scheduleId = c.req.param('scheduleId');
  const task = await prisma.scheduledTask.findFirst({ where: { id: scheduleId, userId } });
  if (task) await prisma.scheduledTask.update({ where: { id: scheduleId }, data: { enabled: !task.enabled } });
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

router.post('/admin/instances/:userId/schedules/:scheduleId/delete', async (c) => {
  const userId = c.req.param('userId');
  const scheduleId = c.req.param('scheduleId');
  await prisma.scheduledTask.deleteMany({ where: { id: scheduleId, userId } });
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

router.post('/admin/scheduler/run-now', async (c) => {
  const count = await runDueOnce();
  return c.json({ ran: count });
});

/**
 * Admin-only smoke test for the MCP gating + pending-confirmation path.
 * Calls the same callTool() Hermes uses, with the row's current
 * autonomyLevel, so the response shows exactly what Hermes would see —
 * "pending_confirmation" at medium, the tool's result at high, or
 * "not available at autonomy level low" at low.
 *
 * Body: { toolName: string, args: object }
 * Returns: { autonomy, response }
 */
router.post('/admin/instances/:userId/test/mcp-call', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { toolName?: string; args?: Record<string, unknown> };
  const toolName = body.toolName ?? '';
  const args = body.args ?? {};
  if (!toolName) return c.json({ error: 'toolName required' }, 400);

  const { callTool } = await import('../routes/sokosumi-mcp.js');
  const { isValidSokosumiEnv } = await import('../config.js');
  const autonomy = row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
  const ctx = {
    instanceId: row.id,
    userId: row.userId,
    env: isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null,
    autonomyLevel: autonomy as 'low' | 'medium' | 'high',
  };
  try {
    const text = await callTool(toolName, args, ctx);
    return c.json({ autonomy, response: text });
  } catch (err) {
    return c.json({ autonomy, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * Admin-only smoke test for a Composio MCP integration. Sends a
 * tools/list JSON-RPC request to the integration's stored mcpUrl,
 * exactly as Hermes' MCP client would, including the x-api-key auth
 * header our proxy injects. Returns the upstream status, content-type,
 * and (if parseable) the filtered tool catalog Hermes would see.
 *
 * Body: { provider: "gmail" | "outlook" | "google_calendar" | "outlook_calendar" }
 */
router.post('/admin/instances/:userId/test/mcp-integration', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  if (!provider) return c.json({ error: 'provider required' }, 400);

  const integ = await prisma.integration.findUnique({
    where: { userId_provider: { userId: row.userId, provider } },
  });
  if (!integ) return c.json({ error: `no integration for ${provider}` }, 404);

  const { decryptSecret } = await import('../crypto.js');
  const { isComposioUpstream, handleToolsListResponse } = await import('../routes/mcp-proxy.js');
  const { loadConfig } = await import('../config.js');
  const mcpUrl = await decryptSecret(integ.mcpUrl);
  const cfg = loadConfig();
  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (cfg.COMPOSIO_API_KEY && isComposioUpstream(mcpUrl)) {
    upstreamHeaders['x-api-key'] = cfg.COMPOSIO_API_KEY;
  }
  const t0 = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(mcpUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  } catch (err) {
    return c.json({ error: 'upstream fetch failed', detail: String(err) }, 502);
  }
  const ms = Date.now() - t0;
  const upstreamText = await upstream.text();
  const handled = handleToolsListResponse(upstreamText, upstream.status, provider);
  const upstreamToolNames = extractToolNamesAnyFormat(upstreamText);
  const filteredToolNames = extractToolNamesAnyFormat(handled.body);
  const droppedTools = upstreamToolNames.filter((n) => !filteredToolNames.includes(n));
  return c.json({
    provider,
    mcpUrlHost: new URL(mcpUrl).hostname,
    authHeaderAdded: 'x-api-key' in upstreamHeaders,
    upstreamStatus: upstream.status,
    upstreamContentType: upstream.headers.get('content-type'),
    upstreamBodyHead: upstreamText.slice(0, 240),
    ms,
    proxyAction: handled.action,
    upstreamToolCount: upstreamToolNames.length,
    filteredToolCount: filteredToolNames.length,
    droppedToolCount: droppedTools.length,
    droppedTools, // every write tool we stripped — easy to audit
    filteredTools: filteredToolNames,
  });
});

/**
 * Extract tool names from any tools/list response body — handles bare
 * JSON, SSE-framed `event: message\ndata: ...`, or multi-line SSE with
 * multiple `data:` lines. Returns [] if the body has no recognizable
 * tools array.
 */
function extractToolNamesAnyFormat(body: string): string[] {
  if (!body || !body.trim()) return [];
  const candidates: string[] = [];
  // Pull every `data: ...` line.
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice(5).trim());
  }
  // If no SSE data lines, treat the whole body as a single JSON candidate.
  if (candidates.length === 0) candidates.push(body.trim());
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as {
        result?: { tools?: Array<{ name?: string }> };
      };
      const tools = parsed?.result?.tools;
      if (Array.isArray(tools) && tools.length > 0) {
        return tools.map((t) => t.name ?? '?');
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

/**
 * Admin-only — run the EOD report sweep for a single instance right now,
 * bypassing the 22:00-local-hour gate and the already-sent gate so we
 * can verify the report shape without waiting until tonight. Pass
 * ?dry=1 to return the rendered markdown without enqueuing.
 */
/**
 * Admin-only — re-run syncSystemSchedules for a user (or every active
 * user with ?all=1). Needed to push updated system_prompt/sweep specs
 * (e.g. a reworded morning-brief) to EXISTING instances, since the
 * scheduler dispatches the prompt stored on the ScheduledTask row and
 * that row only refreshes when this sync runs. Idempotent.
 */
router.post('/admin/maintenance/resync-system-schedules', async (c) => {
  const all = c.req.query('all') === '1';
  const oneUser = c.req.query('userId') ?? undefined;
  const { syncSystemSchedules } = await import('../schedules/system-schedules.js');
  const where = all
    ? { destroyedAt: null, onboardedAt: { not: null } }
    : { userId: oneUser, destroyedAt: null };
  if (!all && !oneUser) {
    return c.json({ error: 'pass ?all=1 or ?userId=<id>' }, 400);
  }
  const rows = await prisma.hermesInstance.findMany({
    where,
    select: { id: true, userId: true, autonomyLevel: true, timezone: true },
  });
  let synced = 0;
  const failures: Array<{ userId: string; error: string }> = [];
  for (const row of rows) {
    try {
      const integrations = await prisma.integration.findMany({
        where: { instanceId: row.id, status: 'connected' },
        select: { provider: true },
      });
      const providers = new Set(integrations.map((i) => i.provider));
      const hasMailOrCalendar =
        providers.has('gmail') ||
        providers.has('outlook') ||
        providers.has('google_calendar') ||
        providers.has('outlook_calendar');
      const autonomy =
        row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
      await syncSystemSchedules({
        instanceId: row.id,
        userId: row.userId,
        autonomy: autonomy as 'low' | 'medium' | 'high',
        timezone: row.timezone ?? 'UTC',
        sokosumiConfigured: true,
        hasMailOrCalendar,
      });
      // ?native=1 also reconciles each machine's native prompt cronjobs
      // (one agent turn per instance — sequential, so an all-fleet resync
      // with native takes a while; run it when rolling out prompt changes).
      if (c.req.query('native') === '1') {
        const { syncNativePromptCrons } = await import('../schedules/native-prompts.js');
        await syncNativePromptCrons(row.id);
      }
      synced++;
    } catch (err) {
      failures.push({ userId: row.userId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return c.json({ ok: true, scanned: rows.length, synced, failures });
});

/**
 * Admin-only — manually nudge the running Hermes agent that an
 * integration is connected, in case it learned the opposite before
 * we wired the automatic post-connect nudge. One-shot recovery for
 * users stuck in "Gmail isn't connected" state.
 *
 * Body: { provider: "gmail" | ... }
 */
router.post('/admin/instances/:userId/test/notify-integration', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider;
  if (!provider) return c.json({ error: 'provider required' }, 400);
  const { notifyIntegrationConnected } = await import('../integrations/notify-connected.js');
  try {
    await notifyIntegrationConnected(row.id, provider);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: 'notify failed', detail: String(err) }, 500);
  }
});

router.post('/admin/instances/:userId/test/run-eod-report', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const dry = c.req.query('dry') === '1';
  const { runEodReportForInstance } = await import('../eod-report/sweep.js');
  try {
    const res = await runEodReportForInstance(row.id, { force: true, dryRun: dry });
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: 'eod report failed', detail: String(err) }, 500);
  }
});

router.post('/admin/instances/:userId/outbox/:messageId/delete', async (c) => {
  const userId = c.req.param('userId');
  const messageId = c.req.param('messageId');
  await prisma.outboxMessage.deleteMany({ where: { id: messageId, userId } });
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

// ---------- Chats — read-only monitor of all chat traffic ----------

router.get('/admin/chats', async (c) => {
  const userFilter = c.req.query('user') ?? '';
  const kindFilter = c.req.query('kind') ?? '';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 80), 10), 500);

  const where: { userId?: string; kind?: string } = {};
  if (userFilter) where.userId = userFilter;
  if (kindFilter && (kindFilter === 'chat' || kindFilter === 'scheduled' || kindFilter === 'cron')) {
    where.kind = kindFilter;
  }

  const msgs = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit * 2, // user + assistant pair per requestId
  });

  // Pair user+assistant by requestId. Newest pair first.
  type Pair = {
    requestId: string;
    userId: string;
    instanceId: string;
    kind: string;
    userMsg?: typeof msgs[number];
    asstMsg?: typeof msgs[number];
  };
  const byReq = new Map<string, Pair>();
  for (const m of msgs) {
    const pair = byReq.get(m.requestId) ?? {
      requestId: m.requestId,
      userId: m.userId,
      instanceId: m.instanceId,
      kind: m.kind,
    };
    if (m.role === 'user') pair.userMsg = m;
    else if (m.role === 'assistant') pair.asstMsg = m;
    byReq.set(m.requestId, pair);
  }
  const pairs = Array.from(byReq.values())
    .sort((a, b) => {
      const at = (a.userMsg?.createdAt ?? a.asstMsg?.createdAt ?? new Date(0)).getTime();
      const bt = (b.userMsg?.createdAt ?? b.asstMsg?.createdAt ?? new Date(0)).getTime();
      return bt - at;
    })
    .slice(0, limit);

  // Look up display names for the listed users.
  const userIds = Array.from(new Set(pairs.map((p) => p.userId)));
  const users = await prisma.hermesInstance.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, name: true, email: true },
  });
  const nameByUser = new Map(users.map((u) => [u.userId, u.name ?? u.email ?? u.userId]));

  const renderPair = (p: Pair): string => {
    const ts = (p.userMsg?.createdAt ?? p.asstMsg?.createdAt) ?? new Date();
    const userHead = esc((p.userMsg?.content ?? '(no user message captured)').slice(0, 180));
    const asstHead = esc((p.asstMsg?.content ?? '(no reply / pending)').slice(0, 240));
    const tokens = (p.asstMsg?.totalTokens ?? 0) || (p.asstMsg?.promptTokens ?? 0) + (p.asstMsg?.completionTokens ?? 0);
    const lat = p.asstMsg?.latencyMs ?? null;
    const err = p.asstMsg?.errorMessage ?? null;
    const errCell = err ? `<span class="badge danger">${esc(err.slice(0, 60))}</span>` : '';
    return `<tr>
      <td class="mono" title="${esc(ts.toISOString())}">${esc(relTime(ts))}</td>
      <td><a class="mono" href="/admin/instances/${encodeURIComponent(p.userId)}">${esc(nameByUser.get(p.userId) ?? p.userId.slice(0, 14))}</a></td>
      <td><span class="badge ${p.kind === 'scheduled' ? 'warn' : ''}">${esc(p.kind)}</span></td>
      <td><a href="/admin/chats/${encodeURIComponent(p.requestId)}">${esc(userHead)}</a></td>
      <td style="color:var(--muted)">${esc(asstHead)}</td>
      <td class="mono">${tokens ? esc(tokens) : '—'}</td>
      <td class="mono">${lat !== null ? esc(lat + 'ms') : '—'}</td>
      <td>${errCell}</td>
    </tr>`;
  };

  const filterForm = `
    <form method="get" action="/admin/chats" class="actions">
      <input name="user" placeholder="filter by userId" value="${esc(userFilter)}" />
      <select name="kind">
        <option value="">all kinds</option>
        <option value="chat" ${kindFilter === 'chat' ? 'selected' : ''}>chat</option>
        <option value="scheduled" ${kindFilter === 'scheduled' ? 'selected' : ''}>scheduled</option>
        <option value="cron" ${kindFilter === 'cron' ? 'selected' : ''}>cron</option>
      </select>
      <input name="limit" placeholder="limit" value="${esc(limit)}" style="width:80px" />
      <button type="submit">Apply</button>
      <a href="/admin/chats" style="margin-left:8px">Reset</a>
    </form>`;

  const body = `
    <h1>Chats</h1>
    <p class="dim">Most recent ${pairs.length} chat exchanges across all users. Click a row to see the full conversation.</p>
    ${filterForm}
    <div class="card">
      ${
        pairs.length === 0
          ? '<div class="empty">No chats yet.</div>'
          : `<table>
              <thead><tr>
                <th>When</th><th>User</th><th>Kind</th><th>User message</th><th>Assistant reply</th><th>Tokens</th><th>Latency</th><th>Error</th>
              </tr></thead>
              <tbody>${pairs.map(renderPair).join('')}</tbody>
            </table>`
      }
    </div>`;
  return c.html(layout({ title: 'Chats', body, active: '/admin/chats' }));
});

router.get('/admin/chats/:requestId', async (c) => {
  const requestId = c.req.param('requestId');
  const msgs = await prisma.chatMessage.findMany({
    where: { requestId },
    orderBy: { createdAt: 'asc' },
  });
  const first = msgs[0];
  if (!first) {
    return c.html(layout({ title: 'Chat', body: '<h1>Chat</h1><div class="empty">Not found.</div>', active: '/admin/chats' }), 404);
  }
  const userMeta = await prisma.hermesInstance.findUnique({
    where: { userId: first.userId },
    select: { name: true, email: true, role: true, company: true, autonomyLevel: true, sokosumiEnv: true },
  });
  const renderFull = (m: (typeof msgs)[number]): string => `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <div>
          <strong>${esc(m.role)}</strong>
          ${m.kind !== 'chat' ? ` <span class="badge warn">${esc(m.kind)}</span>` : ''}
          ${m.model ? ` <span class="badge">${esc(m.model)}</span>` : ''}
          ${m.errorMessage ? ` <span class="badge danger">${esc(m.errorMessage)}</span>` : ''}
        </div>
        <div class="dim mono">${esc(m.createdAt.toISOString())} · ${m.totalTokens ? m.totalTokens + ' tok' : ''} ${m.latencyMs !== null ? '· ' + m.latencyMs + 'ms' : ''}</div>
      </div>
      <pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font-size:13px">${esc(m.content || '(empty)')}</pre>
    </div>
    <div style="height:12px"></div>`;
  // Pending/resolved confirmations created within ±60s of this chat
  // exchange. Helps map "user asked X" → "Hermes proposed tool call Y"
  // → outcome. Best-effort timestamp correlation since we don't have a
  // hard requestId link from tool calls to chat messages.
  const windowMs = 60_000;
  const winStart = new Date(first.createdAt.getTime() - windowMs);
  const winEnd = new Date((msgs[msgs.length - 1]?.createdAt ?? first.createdAt).getTime() + windowMs);
  const relatedConfs = await prisma.pendingConfirmation.findMany({
    where: {
      userId: first.userId,
      createdAt: { gte: winStart, lte: winEnd },
    },
    orderBy: { createdAt: 'asc' },
  });
  const confSection = relatedConfs.length === 0
    ? ''
    : `<h2>Tool calls / confirmations during this turn</h2>
       <div class="card">
         <table>
           <thead><tr><th>Tool</th><th>Status</th><th>Summary</th><th>When</th></tr></thead>
           <tbody>
             ${relatedConfs.map((c) => `
               <tr>
                 <td class="mono" style="font-size:12px">${esc(c.toolName)}</td>
                 <td><span class="badge ${c.status === 'pending' ? 'warn' : c.status === 'approved' ? '' : 'danger'}">${esc(c.status)}</span></td>
                 <td>${esc(c.summary.slice(0, 220))}${c.errorMessage ? `<div class="dim" style="font-size:11px">err: ${esc(c.errorMessage.slice(0, 120))}</div>` : ''}</td>
                 <td class="mono" style="font-size:11px">${esc(relTime(c.createdAt))}${c.resolvedAt ? ` → ${esc(relTime(c.resolvedAt))}` : ''}</td>
               </tr>`).join('')}
           </tbody>
         </table>
       </div>
       <div style="height:12px"></div>`;

  const body = `
    <h1>Chat detail</h1>
    <p class="dim">
      requestId <span class="mono">${esc(requestId)}</span> ·
      user <a class="mono" href="/admin/instances/${encodeURIComponent(first.userId)}">${esc(userMeta?.name ?? userMeta?.email ?? first.userId)}</a>
      ${userMeta?.role ? ` · ${esc(userMeta.role)}` : ''}
      ${userMeta?.company ? ` at ${esc(userMeta.company)}` : ''}
      ${userMeta?.autonomyLevel ? ` · autonomy=${esc(userMeta.autonomyLevel)}` : ''}
      ${userMeta?.sokosumiEnv ? ` · env=${esc(userMeta.sokosumiEnv)}` : ''}
    </p>
    ${msgs.map(renderFull).join('')}
    ${confSection}
    <p class="dim"><a href="/admin/chats">← Back to chats</a></p>`;
  return c.html(layout({ title: 'Chat detail', body, active: '/admin/chats' }));
});

// ---------- Pending / resolved confirmations firehose ----------

router.get('/admin/confirmations', async (c) => {
  const statusFilter = c.req.query('status') ?? '';
  const userFilter = c.req.query('user') ?? '';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 10), 500);

  const where: { status?: string; userId?: string } = {};
  if (statusFilter) where.status = statusFilter;
  if (userFilter) where.userId = userFilter;

  const rows = await prisma.pendingConfirmation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  const users = await prisma.hermesInstance.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, name: true, email: true, autonomyLevel: true, sokosumiEnv: true },
  });
  const byUser = new Map(users.map((u) => [u.userId, u]));

  const STATUS_COLORS: Record<string, string> = {
    pending: 'warn',
    approved: '',
    rejected: 'danger',
    errored: 'danger',
    expired: 'danger',
  };

  const renderRow = (r: typeof rows[number]): string => {
    const u = byUser.get(r.userId);
    const who = u?.name
      ? `<strong>${esc(u.name)}</strong><div class="dim mono" style="font-size:11px">${esc(u.email ?? '')}</div>`
      : `<span class="mono dim">${esc(r.userId.slice(0, 14))}…</span>`;
    const statusCls = STATUS_COLORS[r.status] ?? '';
    const resolvedInfo = r.resolvedAt
      ? `<div class="dim" style="font-size:11px">${esc(relTime(r.resolvedAt))} · ${esc(r.resolvedBy ?? '?')}</div>`
      : '';
    const errBadge = r.errorMessage ? `<div><span class="badge danger">${esc(r.errorMessage.slice(0, 80))}</span></div>` : '';
    return `<tr>
      <td><a href="/admin/instances/${encodeURIComponent(r.userId)}">${who}</a></td>
      <td><span class="badge ${statusCls}">${esc(r.status)}</span>${resolvedInfo}</td>
      <td class="mono" style="font-size:12px"><a href="/admin/confirmations/${encodeURIComponent(r.id)}">${esc(r.toolName)}</a></td>
      <td>${esc(r.summary.slice(0, 240))}${errBadge}</td>
      <td class="mono" title="${esc(r.createdAt.toISOString())}">${esc(relTime(r.createdAt))}</td>
      <td class="mono" style="font-size:11px">${esc(u?.sokosumiEnv ?? '?')} · ${esc(u?.autonomyLevel ?? '?')}</td>
    </tr>`;
  };

  const filterForm = `
    <form method="get" action="/admin/confirmations" class="actions">
      <input name="user" placeholder="filter by userId" value="${esc(userFilter)}" style="min-width:280px" />
      <select name="status">
        <option value="">all statuses</option>
        ${['pending', 'approved', 'rejected', 'errored', 'expired']
          .map((s) => `<option value="${s}" ${s === statusFilter ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <button type="submit">Apply</button>
      <a href="/admin/confirmations" style="margin-left:8px">Reset</a>
    </form>`;

  const counts = await prisma.pendingConfirmation.groupBy({
    by: ['status'],
    _count: { status: true },
  });
  const countsLine = counts
    .map((c) => `<span class="badge ${STATUS_COLORS[c.status] ?? ''}">${esc(c.status)}: ${c._count.status}</span>`)
    .join(' ');

  const body = `
    <h1>Confirmations</h1>
    <p class="dim">Medium-autonomy write/spend tool calls Hermes wanted to make, with the user-approval outcome. Pending = task NOT yet created on Sokosumi.</p>
    <p>${countsLine || '<span class="dim">no confirmations yet</span>'}</p>
    ${filterForm}
    <div class="card" style="padding:0;overflow:hidden">
      ${rows.length === 0 ? '<div class="empty">No confirmations match.</div>' : `
        <table>
          <thead><tr>
            <th>User</th><th>Status</th><th>Tool</th><th>Summary</th><th>Created</th><th>Env · Autonomy</th>
          </tr></thead>
          <tbody>${rows.map(renderRow).join('')}</tbody>
        </table>`}
    </div>
    <p class="dim" style="font-size:12px;margin-top:12px">Showing ${rows.length} of up to ${limit}.</p>`;
  return c.html(layout({ title: 'Confirmations', body, active: '/admin/confirmations' }));
});

// Admin: inspect a specific PendingConfirmation including resultPayload
router.get('/admin/confirmations/:id', async (c) => {
  const id = c.req.param('id');
  const row = await prisma.pendingConfirmation.findUnique({ where: { id } });
  if (!row) {
    return c.html(layout({ title: 'Confirmation', body: '<h1>Not found</h1>', active: '/admin/confirmations' }), 404);
  }
  const u = await prisma.hermesInstance.findUnique({
    where: { userId: row.userId },
    select: { name: true, email: true, autonomyLevel: true, sokosumiEnv: true },
  });
  const dump = (label: string, value: unknown): string =>
    `<h2>${esc(label)}</h2>
     <div class="card"><pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font-size:12px">${esc(JSON.stringify(value, null, 2))}</pre></div>
     <div style="height:12px"></div>`;
  const body = `
    <h1>Confirmation ${esc(id.slice(0, 8))}…</h1>
    <p class="dim">User <a href="/admin/instances/${encodeURIComponent(row.userId)}">${esc(u?.name ?? row.userId)}</a> ${u?.email ? `· ${esc(u.email)}` : ''} · ${esc(row.status)} · created ${esc(relTime(row.createdAt))}${row.resolvedAt ? ` · resolved ${esc(relTime(row.resolvedAt))}` : ''}</p>
    ${dump('Tool', { toolName: row.toolName, summary: row.summary })}
    ${dump('Args (what Hermes wanted to do)', row.toolArgs)}
    ${row.resultPayload ? dump('Result payload (what Sokosumi UI parses for the TaskCard id)', row.resultPayload) : ''}
    ${row.errorMessage ? dump('Error', row.errorMessage) : ''}
    <p class="dim"><a href="/admin/confirmations">← Back</a></p>`;
  return c.html(layout({ title: 'Confirmation', body, active: '/admin/confirmations' }));
});

// ---------- Events firehose ----------

router.get('/admin/events', async (c) => {
  const filter = c.req.query('filter') ?? '';
  const eventName = c.req.query('event') ?? '';
  const user = c.req.query('user') ?? '';

  const where: Prisma.ProvisionEventWhereInput = {};
  if (filter === 'failures') where.event = { in: ['provision_failed', 'chat_failed', 'hermes_task_failed', 'integration_failed'] };
  else if (eventName) where.event = eventName;
  if (user) where.userId = user;

  const [events, eventNames] = await Promise.all([
    prisma.provisionEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.provisionEvent.groupBy({
      by: ['event'],
      where: { createdAt: { gt: hoursAgo(24 * 7) } },
      _count: { event: true },
      orderBy: { _count: { event: 'desc' } },
    }),
  ]);

  const filterForm = `
    <form method="get" action="/admin/events" class="actions">
      <input name="user" placeholder="filter by userId" value="${esc(user)}" style="min-width:280px" />
      <select name="event">
        <option value="">all events</option>
        ${eventNames.map((e) => `<option value="${esc(e.event)}" ${e.event === eventName ? 'selected' : ''}>${esc(e.event)} (${e._count.event})</option>`).join('')}
      </select>
      <button type="submit">Apply</button>
      <a class="filter-chip${filter === 'failures' ? ' active' : ''}" href="/admin/events?filter=failures">failures only</a>
      <a href="/admin/events" style="margin-left:4px">Reset</a>
    </form>`;

  const body = `
    <h1>Events</h1>
    <p class="dim">Append-only audit trail. Showing the latest ${esc(events.length)}${filter === 'failures' ? ' failure' : eventName ? ` <span class="mono">${esc(eventName)}</span>` : ''} event(s)${user ? ` for <span class="mono">${esc(user)}</span>` : ''}. Event counts in the dropdown are 7-day totals.</p>
    ${filterForm}
    <div class="card">${events.length === 0 ? '<div class="empty">No events match.</div>' : events.map(renderEventRow).join('')}</div>
  `;
  return c.html(layout({ title: 'Events', body, active: '/admin/events' }));
});

// ---------- Crons: what the background sweeps actually do ----------

/** Human cadence for the fixed set of sweep cron expressions. describeCron
 * is built for daily/weekly named crons and mangles step/range exprs. */
function cadenceLabel(expr: string): string {
  const map: Record<string, string> = {
    '*/2 * * * *': 'every 2 min',
    '*/5 * * * *': 'every 5 min',
    '2-59/5 * * * *': 'every 5 min',
    '0 * * * *': 'hourly (:00)',
    '15 * * * *': 'hourly (:15)',
    '20 * * * *': 'hourly (:20)',
    '30 * * * *': 'hourly (:30)',
    '45 * * * *': 'hourly (:45)',
    '50 * * * *': 'hourly (:50)',
  };
  return map[expr] ?? expr;
}

const CRON_EVENT_SOURCES = new Set([
  'urgent_interrupt',
  'urgent',
  'input_responder',
  'followup_continuation',
  'task_augmentation',
  'taskboard_assistant',
  'scheduler',
  'cron',
]);

/** Events attributable to background cron work (the chat proxy also records
 * chat_proxied for normal user chats — those carry no source marker). */
function isCronDrivenEvent(e: { event: string; detail: unknown }): boolean {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.event === 'eod_report_sent' || e.event === 'outbox_pushed') return true;
  if (e.event === 'chat_proxied') return typeof d['source'] === 'string' && CRON_EVENT_SOURCES.has(String(d['source']));
  if (e.event === 'onboarding_step') {
    return d['step'] === 'inbox_refresh' || (d['step'] === 'sokosumi_sync' && d['source'] === 'cron');
  }
  return false;
}

function cronEventLabel(e: { event: string; detail: unknown }): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.event === 'outbox_pushed') return `pushed to chat (${esc(String(d['kind'] ?? 'text'))})`;
  if (e.event === 'eod_report_sent') return 'EOD report delivered';
  if (e.event === 'onboarding_step') return `${esc(String(d['step']))} ${esc(String(d['status'] ?? ''))}`;
  // Sweep agent turns capture the full prompt+response under requestId —
  // link straight to the chat-detail view so the operator can read exactly
  // what the cron sent and what the agent did.
  const label = `${esc(String(d['source']))} agent turn`;
  const reqId = d['requestId'];
  return typeof reqId === 'string' && reqId
    ? `<a href="/admin/chats/${encodeURIComponent(reqId)}">${label} — view prompt + response →</a>`
    : label;
}

function cronEventDetail(e: { event: string; detail: unknown }): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.event === 'outbox_pushed') return esc(String(d['preview'] ?? ''));
  const rest = { ...d };
  delete rest['source'];
  delete rest['preview'];
  return esc(JSON.stringify(rest));
}

router.get('/admin/crons', async (c) => {
  const user = c.req.query('user') ?? '';
  const sweepFilter = c.req.query('sweep') ?? '';

  const [ticks, rawEvents] = await Promise.all([
    prisma.sweepRun.findMany({
      where: sweepFilter ? { sweep: sweepFilter } : {},
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    prisma.provisionEvent.findMany({
      where: {
        event: { in: ['chat_proxied', 'onboarding_step', 'eod_report_sent', 'outbox_pushed'] },
        ...(user ? { userId: user } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 400,
    }),
  ]);

  const cronEvents = rawEvents.filter(isCronDrivenEvent).slice(0, 150);

  const { getCronRegistry } = await import('../cron.js');
  const registry = getCronRegistry();

  // Last time each sweep actually DID something (all SweepRun rows are
  // acted-or-errored by construction) — shown next to the heartbeat so the
  // two timestamps live in ONE row instead of two tables that disagree.
  const lastWork = new Map(
    (
      await prisma.sweepRun.groupBy({
        by: ['sweep'],
        _max: { startedAt: true },
      })
    ).map((g) => [g.sweep, g._max.startedAt]),
  );

  const registryRows = registry
    .map((r) => {
      const status = r.lastTickAt === null
        ? '<span class="pill muted">not ticked yet</span>'
        : r.lastOk
          ? '<span class="pill ok">ok</span>'
          : `<span class="pill err" title="${esc(r.lastError ?? '')}">error</span>`;
      const worked = lastWork.get(r.name);
      const result = r.lastResult ? esc(JSON.stringify(r.lastResult)) : '<span class="dim">—</span>';
      return `<tr>
        <td class="mono">${esc(r.name)}</td>
        <td class="mono">${esc(cadenceLabel(r.expr))}</td>
        <td class="mono" title="Every scheduled wake-up, including ones that found nothing to do">${r.lastTickAt ? esc(relTime(r.lastTickAt)) : '—'}</td>
        <td>${status}</td>
        <td class="mono" title="Last tick that actually did work (prompted an agent, delivered something, warmed a machine, …)">${worked ? `<a href="/admin/crons?sweep=${encodeURIComponent(r.name)}">${esc(relTime(worked))}</a>` : '<span class="dim">never</span>'}</td>
        <td class="mono" style="font-size:11px">${result}</td>
      </tr>`;
    })
    .join('');

  const sweepNames = Array.from(new Set(registry.map((r) => r.name)));
  const tickRows = ticks
    .map((t) => `<tr>
      <td class="mono" title="${esc(t.startedAt.toISOString())}">${esc(relTime(t.startedAt))}</td>
      <td class="mono"><a href="/admin/crons?sweep=${encodeURIComponent(t.sweep)}">${esc(t.sweep)}</a></td>
      <td class="mono">${esc(t.durationMs)}ms</td>
      <td class="num">${esc(t.scanned)}</td>
      <td class="num">${esc(t.acted)}</td>
      <td>${t.ok ? '<span class="pill ok">ok</span>' : `<span class="pill err" title="${esc(t.error ?? '')}">error</span>`}</td>
      <td class="mono" style="font-size:11px">${t.detail ? esc(JSON.stringify(t.detail)) : ''}</td>
    </tr>`)
    .join('');

  const eventRows = cronEvents
    .map((e) => `<tr>
      <td class="mono" title="${esc(e.createdAt.toISOString())}">${esc(relTime(e.createdAt))}</td>
      <td><a class="mono" href="/admin/instances/${encodeURIComponent(e.userId)}">${esc(e.userId.slice(0, 14))}</a></td>
      <td>${cronEventLabel(e)}</td>
      <td class="mono" style="font-size:11px;max-width:520px;word-break:break-word">${cronEventDetail(e)}</td>
    </tr>`)
    .join('');

  const body = `
    <h1>Crons</h1>
    <p class="dim">The orchestrator's background jobs — fleet-wide, one process serves every instance. Each row shows two different times: <strong>last tick</strong> = the most recent scheduled wake-up (proves the cron is alive, even when there was nothing to do) and <strong>last did work</strong> = the most recent tick that actually acted. Most ticks find nothing — that's normal, not a stalled cron. Per-instance results live on each instance's detail page.</p>

    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>Job</th><th>Schedule</th><th>Last tick</th><th>Status</th><th>Last did work</th><th>Last tick result</th></tr></thead>
        <tbody>${registryRows || '<tr><td colspan="6" class="empty">No crons registered.</td></tr>'}</tbody>
      </table>
    </div>

    <h2>Work log <span class="dim" style="font-weight:400;font-size:12px">(only ticks that acted or failed — routine empty ticks aren't listed)</span></h2>
    <form method="get" action="/admin/crons" class="actions">
      <select name="sweep">
        <option value="">all sweeps</option>
        ${sweepNames.map((n) => `<option value="${esc(n)}" ${n === sweepFilter ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select>
      <input name="user" placeholder="filter activity by userId" value="${esc(user)}" style="min-width:280px" />
      <button type="submit">Apply</button>
      <a href="/admin/crons" style="margin-left:8px">Reset</a>
    </form>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>When</th><th>Sweep</th><th>Duration</th><th>Scanned</th><th>Acted</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>${tickRows || '<tr><td colspan="7" class="empty">No non-idle ticks recorded yet.</td></tr>'}</tbody>
      </table>
    </div>

    <h2>Cron-driven agent activity <span class="dim" style="font-weight:400;font-size:12px">(incl. native cronjob deliveries — durable even after Sokosumi acks them)</span></h2>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr><th>When</th><th>User</th><th>What</th><th>Detail / preview</th></tr></thead>
        <tbody>${eventRows || '<tr><td colspan="4" class="empty">Nothing yet — activity appears as the sweeps and native crons run.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  return c.html(layout({ title: 'Crons', body, active: '/admin/crons' }));
});

// ---------- Usage: LLM spend/token analytics ----------

router.get('/admin/usage', async (c) => {
  const cfg = loadConfig();
  const [mtd, today, daily, byModel, topUsers, zeroCost] = await Promise.all([
    prisma.llmUsage.aggregate({
      where: { createdAt: { gte: startOfMonthUtc() } },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true },
    }),
    prisma.llmUsage.aggregate({
      where: { createdAt: { gte: startOfDayUtc() } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    usageByDay(30),
    prisma.llmUsage.groupBy({
      by: ['model'],
      where: { createdAt: { gte: startOfMonthUtc() } },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costUsd: 'desc' } },
    }),
    prisma.llmUsage.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: startOfMonthUtc() } },
      _sum: { costUsd: true, promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 25,
    }),
    // Data-quality signal: rows with real tokens but $0 recorded cost mean the
    // model was missing from the OpenRouter price map at write time — MTD
    // spend is undercounted while this is non-zero.
    prisma.llmUsage.count({
      where: {
        createdAt: { gte: startOfMonthUtc() },
        costUsd: 0,
        OR: [{ promptTokens: { gt: 0 } }, { completionTokens: { gt: 0 } }],
      },
    }),
  ]);

  const users = await prisma.hermesInstance.findMany({
    where: { userId: { in: topUsers.map((u) => u.userId) } },
    select: { userId: true, name: true, email: true },
  });
  const nameByUser = new Map(users.map((u) => [u.userId, u.name ?? u.email ?? null]));

  const mtdCost = Number(mtd._sum.costUsd ?? 0);
  const mtdTok = (mtd._sum.promptTokens ?? 0) + (mtd._sum.completionTokens ?? 0);
  const maxDaily = Math.max(...daily.map((d) => d.cost), 0.000001);

  const body = `
    <h1>Usage</h1>
    <p class="dim">LLM spend across all instances, recorded per upstream completion at the proxy (one agent turn = several calls). Costs use live OpenRouter pricing at write time.</p>

    <div class="stats">
      ${statCard('MTD spend', '$' + mtdCost.toFixed(2), `${mtdTok.toLocaleString()} tokens`)}
      ${statCard('MTD LLM calls', mtd._count._all.toLocaleString())}
      ${statCard('Today', '$' + Number(today._sum.costUsd ?? 0).toFixed(2), `${today._count._all.toLocaleString()} calls`)}
      ${statCard('Cap per user', '$' + cfg.MONTHLY_USD_CAP_PER_USER.toFixed(2), 'MONTHLY_USD_CAP_PER_USER')}
      ${zeroCost > 0 ? statCard('Unpriced calls (MTD)', zeroCost, 'tokens>0 but $0 recorded — model missing from price map; spend is undercounted', 'warn') : ''}
    </div>

    <h2>Spend by day (30d, UTC)</h2>
    <div class="card">
      ${daily.length === 0 ? '<div class="empty">No usage recorded yet.</div>' : daily.map((d) => `
        <div class="bar-row">
          <span class="bar-label">${esc(d.day)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Math.round((d.cost / maxDaily) * 100))}%"></div></div>
          <span class="bar-value">$${d.cost.toFixed(3)} · ${d.tokens.toLocaleString()} tok · ${esc(d.calls)} calls</span>
        </div>`).join('')}
    </div>

    <div class="row" style="margin-top:24px">
      <div class="card flex-1" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>Model (MTD)</th><th>Cost</th><th>Tokens</th><th>Calls</th></tr></thead>
          <tbody>
            ${byModel.length === 0 ? '<tr><td colspan="4" class="empty">No usage.</td></tr>' : byModel.map((m) => `
              <tr>
                <td class="mono" style="font-size:12px">${esc(m.model)}</td>
                <td class="mono">$${Number(m._sum.costUsd ?? 0).toFixed(4)}</td>
                <td class="mono">${((m._sum.promptTokens ?? 0) + (m._sum.completionTokens ?? 0)).toLocaleString()}</td>
                <td class="mono">${esc(m._count._all)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card flex-1" style="padding:0;overflow:hidden">
        <table>
          <thead><tr><th>Top users (MTD)</th><th>Cost</th><th>% cap</th><th>Tokens</th><th>Calls</th></tr></thead>
          <tbody>
            ${topUsers.length === 0 ? '<tr><td colspan="5" class="empty">No usage.</td></tr>' : topUsers.map((u) => {
              const cost = Number(u._sum.costUsd ?? 0);
              const pct = (cost / cfg.MONTHLY_USD_CAP_PER_USER) * 100;
              const label = nameByUser.get(u.userId);
              return `<tr>
                <td><a href="/admin/instances/${encodeURIComponent(u.userId)}">${label ? esc(label) : `<span class="mono">${esc(u.userId.slice(0, 14))}…</span>`}</a></td>
                <td class="mono">$${cost.toFixed(4)}</td>
                <td class="mono">${pct.toFixed(0)}%${pct >= 100 ? ' <span class="pill err">capped</span>' : ''}</td>
                <td class="mono">${((u._sum.promptTokens ?? 0) + (u._sum.completionTokens ?? 0)).toLocaleString()}</td>
                <td class="mono">${esc(u._count._all)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  return c.html(layout({ title: 'Usage', body, active: '/admin/usage' }));
});

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
      <thead><tr><th>Instance (${esc(instances.length)})</th><th>Status</th><th>Env</th><th>Rolled</th><th>Activity</th></tr></thead>
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

router.post('/admin/instances/:userId/toggle-bench', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({
    where: { userId },
    select: { id: true, isTestBench: true },
  });
  if (!row) return c.text('not found', 404);
  await prisma.hermesInstance.update({
    where: { id: row.id },
    data: { isTestBench: !row.isTestBench },
  });
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

/**
 * Admin — re-drive stuck skill installs (status='installing') onto the live
 * machine without rebooting it. Use after a fix to the install path, or when
 * a skill's live write failed at install time. Returns the replay counts.
 */
router.post('/admin/instances/:userId/skills/replay', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId }, select: { id: true } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const { replayInstalledSkills } = await import('../skills/manager.js');
  try {
    const res = await replayInstalledSkills(row.id);
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------- Tests: run standard-chat suites + compare across images ----------

router.get('/admin/tests', async (c) => {
  const [eligible, recentRuns] = await Promise.all([
    prisma.hermesInstance.findMany({
      where: {
        destroyedAt: null,
        isTestBench: true,
        endpointUrl: { not: null },
        status: { in: ['ready', 'running', 'suspended'] },
      },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, userId: true, name: true, imageTag: true, isTestBench: true },
    }),
    prisma.testRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 25,
      include: { _count: { select: { turns: true } }, instance: { select: { userId: true } } },
    }),
  ]);

  const instanceOpts = eligible
    .map((e) => {
      const tag = tagFromRef(e.imageTag) ?? 'unknown';
      const label = `${e.name || e.userId.slice(0, 12)} · ${tag}`;
      return `<option value="${esc(e.id)}">${esc(label)}</option>`;
    })
    .join('');
  const suiteOpts = TEST_SUITES.map(
    (s) => `<option value="${esc(s.id)}">${esc(s.name)} (${s.cases.length} chats)</option>`,
  ).join('');

  const suiteCards = TEST_SUITES.map(
    (s) => `<div class="card flex-1">
      <h3>${esc(s.name)} <a href="/admin/tests/compare?suiteId=${encodeURIComponent(s.id)}" style="float:right;font-size:12px">compare across images →</a></h3>
      <p class="dim" style="font-size:12px">${esc(s.description)}</p>
      <div>${s.cases.map((tc) => `<span class="badge" title="${esc(tc.probes)}">${esc(tc.name)}</span>`).join(' ')}</div>
    </div>`,
  ).join('');

  const runRows = recentRuns
    .map((r) => {
      const tag = tagFromRef(r.imageTag) ?? '—';
      const pill =
        r.status === 'done'
          ? '<span class="pill ok">done</span>'
          : r.status === 'running'
            ? '<span class="pill warn">running</span>'
            : '<span class="pill err">error</span>';
      return `<tr>
        <td>${esc(relTime(r.startedAt))}</td>
        <td><a href="/admin/instances/${encodeURIComponent(r.instance.userId)}">${esc(r.instance.userId.slice(0, 14))}</a></td>
        <td class="mono">${esc(tag)}</td>
        <td>${esc(r.suiteName)}</td>
        <td class="num">${esc(String(r._count.turns))}</td>
        <td>${pill}</td>
        <td><a href="/admin/tests/runs/${encodeURIComponent(r.id)}">view →</a></td>
      </tr>`;
    })
    .join('');

  const body = `
    <h1>Tests</h1>
    <p class="dim">Run a fixed suite of standard chats against a <strong>bench</strong> instance and capture exactly how it reacts — full reply, the tools it called, latency, and tokens. Run the same suite against bench instances on different images to compare. A suite spends the bench's own LLM budget, so runs are limited to instances you've marked as a bench (from the instance detail page).</p>

    <h2>Run a suite</h2>
    ${
      eligible.length === 0
        ? '<div class="empty">No bench instances yet. Open an instance (Instances → pick one) and click <strong>Mark as bench</strong> — ideally one per image version you want to compare.</div>'
        : `<form method="post" action="/admin/tests/run" class="actions">
        <label class="dim">Bench instance&nbsp;<select name="instanceId">${instanceOpts}</select></label>
        <label class="dim">Suite&nbsp;<select name="suiteId">${suiteOpts}</select></label>
        <button type="submit" class="primary">Run</button>
      </form>`
    }

    <h2>Suites</h2>
    <div class="row">${suiteCards}</div>

    <h2>Recent runs</h2>
    <div class="card" style="padding:0;overflow:hidden">
      ${
        recentRuns.length === 0
          ? '<div class="empty">No runs yet.</div>'
          : `<table>
        <thead><tr><th>When</th><th>Instance</th><th>Image</th><th>Suite</th><th>Turns</th><th>Status</th><th></th></tr></thead>
        <tbody>${runRows}</tbody>
      </table>`
      }
    </div>
  `;
  return c.html(layout({ title: 'Tests', body, active: '/admin/tests' }));
});

router.post('/admin/tests/run', async (c) => {
  const form = await c.req.parseBody();
  const instanceId = String(form['instanceId'] ?? '');
  const suiteId = String(form['suiteId'] ?? '');
  try {
    const runId = await startSuiteRun(instanceId, suiteId);
    return c.redirect(`/admin/tests/runs/${runId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.html(
      layout({
        title: 'Run',
        body: `<h1>Couldn't start run</h1><p class="dim">${esc(msg)}</p><p><a href="/admin/tests">← Tests</a></p>`,
        active: '/admin/tests',
      }),
      400,
    );
  }
});

// Kill a run stuck in status=running (e.g. orchestrator restarted mid-suite —
// the runner's in-process loop is gone but the row still says running, which
// blocks new runs on that instance and makes the run page reload forever).
router.post('/admin/tests/runs/:runId/cancel', async (c) => {
  const runId = c.req.param('runId');
  await prisma.testRun.updateMany({
    where: { id: runId, status: 'running' },
    data: { status: 'error', note: 'canceled by admin', finishedAt: new Date() },
  });
  return c.redirect(`/admin/tests/runs/${encodeURIComponent(runId)}`);
});

router.get('/admin/tests/runs/:runId', async (c) => {
  const runId = c.req.param('runId');
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    include: {
      turns: { orderBy: { order: 'asc' } },
      instance: { select: { userId: true } },
    },
  });
  if (!run) return c.text('not found', 404);
  const running = run.status === 'running';
  const tag = tagFromRef(run.imageTag) ?? 'unknown';
  const statusPillHtml =
    run.status === 'done'
      ? '<span class="pill ok">done</span>'
      : running
        ? '<span class="pill warn">running…</span>'
        : '<span class="pill err">error</span>';

  const body = `
    <h1>${esc(run.suiteName)} <span class="dim" style="font-size:14px">on ${esc(tag)}</span></h1>
    <p class="dim"><a href="/admin/instances/${encodeURIComponent(run.instance.userId)}">${esc(run.instance.userId)}</a> · ${statusPillHtml} · started ${esc(relTime(run.startedAt))}${run.finishedAt ? ` · finished ${esc(relTime(run.finishedAt))}` : ''} · ${esc(String(run.turns.length))} turn(s)</p>
    ${running ? `<p class="dim" style="display:flex;gap:12px;align-items:center"><span>Auto-refreshing while the suite runs…</span><form method="post" action="/admin/tests/runs/${encodeURIComponent(run.id)}/cancel" class="inline" onsubmit="return confirm('Mark this run as canceled? Only do this if it is stuck (e.g. after an orchestrator restart).')"><button type="submit" class="danger">Cancel stuck run</button></form></p>` : ''}
    ${
      run.turns.length === 0
        ? '<div class="empty">No turns recorded yet.</div>'
        : run.turns.map(renderTestTurn).join('')
    }
    <p style="margin-top:20px"><a href="/admin/tests">← Tests</a> · <a href="/admin/tests/compare?suiteId=${encodeURIComponent(run.suiteId)}">Compare this suite across images →</a></p>
    ${running ? '<script>setTimeout(function(){location.reload();},4000);</script>' : ''}
  `;
  return c.html(layout({ title: `Run ${run.suiteName}`, body, active: '/admin/tests' }));
});

router.get('/admin/tests/compare', async (c) => {
  const suiteId = c.req.query('suiteId') ?? 'core';
  const suite = findSuite(suiteId);
  if (!suite) return c.text('unknown suite', 404);
  const runs = await prisma.testRun.findMany({
    where: { suiteId, status: 'done' },
    orderBy: { startedAt: 'desc' },
    include: { turns: { orderBy: { order: 'asc' } } },
  });
  // Keep the latest done run per image tag.
  const latestByImage = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const t = tagFromRef(r.imageTag) ?? 'unknown';
    if (!latestByImage.has(t)) latestByImage.set(t, r);
  }
  const images = [...latestByImage.keys()];

  let body: string;
  if (images.length === 0) {
    body = `<h1>Compare — ${esc(suite.name)}</h1><p class="dim">No completed runs for this suite yet. Run it against a couple of instances on different images first.</p><p><a href="/admin/tests">← Tests</a></p>`;
  } else {
    const header = `<tr><th>Test</th>${images.map((t) => `<th class="mono">${esc(t)}</th>`).join('')}</tr>`;
    const rows = suite.cases
      .map((tc) => {
        const cells = images
          .map((t) => {
            const run = latestByImage.get(t)!;
            const turn = run.turns.find((x) => x.caseId === tc.id);
            if (!turn) return '<td class="dim">—</td>';
            const head =
              turn.errorMessage
                ? `<span style="color:var(--err)">⚠ ${esc(turn.errorMessage)}</span>`
                : esc((turn.responseText ?? '').slice(0, 400) + ((turn.responseText ?? '').length > 400 ? '…' : ''));
            return `<td>
              <div class="chat-content">${head}</div>
              <div style="margin-top:6px">${renderToolChips(turn.toolCalls)}</div>
              <div class="faint" style="margin-top:6px;font-size:11px">${turn.latencyMs != null ? `${esc(String(turn.latencyMs))}ms` : ''}${turn.totalTokens ? ` · ${esc(String(turn.totalTokens))} tok` : ''}</div>
            </td>`;
          })
          .join('');
        return `<tr><th style="white-space:nowrap" title="${esc(tc.probes)}">${esc(tc.name)}</th>${cells}</tr>`;
      })
      .join('');
    body = `
      <h1>Compare — ${esc(suite.name)}</h1>
      <p class="dim">Latest completed run per image, side by side. ${esc(suite.description)}</p>
      <div style="overflow:auto"><table class="cmp">${header}${rows}</table></div>
      <p style="margin-top:20px"><a href="/admin/tests">← Tests</a></p>
    `;
  }
  return c.html(layout({ title: `Compare ${suite.name}`, body, active: '/admin/tests' }));
});

// ---------- helpers ----------

function renderToolChips(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0)
    return '<span class="tool-none">no tool calls</span>';
  return (toolCalls as Array<{ name?: string; detail?: string }>)
    .map((t) => `<span class="tool-chip" title="${esc(t.detail ?? '')}">${esc(t.name ?? '?')}</span>`)
    .join('');
}

function renderTestTurn(t: {
  caseName: string;
  prompt: string;
  responseText: string | null;
  toolCalls: unknown;
  model: string | null;
  totalTokens: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}): string {
  return `<div class="card" style="margin-bottom:10px">
    <div class="chat-meta">
      <span class="chat-role">${esc(t.caseName)}</span>
      ${t.latencyMs != null ? `<span>${esc(String(t.latencyMs))}ms</span>` : ''}
      ${t.totalTokens ? `<span>${esc(String(t.totalTokens))} tok</span>` : ''}
      ${t.model ? `<span class="mono">${esc(t.model)}</span>` : ''}
    </div>
    <div class="chat-content" style="color:var(--info);margin-bottom:8px">${esc(t.prompt)}</div>
    ${
      t.errorMessage
        ? `<div class="chat-content" style="color:var(--err)">⚠ ${esc(t.errorMessage)}</div>`
        : `<div class="chat-content">${esc(t.responseText ?? '')}</div>`
    }
    <div style="margin-top:8px">${renderToolChips(t.toolCalls)}</div>
  </div>`;
}

function renderChatMsg(m: {
  role: string;
  content: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  finishReason: string | null;
  createdAt: Date;
  requestId: string;
}): string {
  const role = m.errorMessage ? 'error' : m.role;
  const tokens = m.totalTokens
    ? `${m.totalTokens} tok (${m.promptTokens ?? '?'} in / ${m.completionTokens ?? '?'} out)`
    : '';
  return `<div class="chat-msg ${esc(m.role)}">
    <div class="chat-meta">
      <span class="chat-role ${esc(role)}">${esc(m.role)}${m.errorMessage ? ' · error' : ''}</span>
      <span>${esc(relTime(m.createdAt))}</span>
      ${m.model ? `<span class="mono">${esc(m.model)}</span>` : ''}
      ${tokens ? `<span>${esc(tokens)}</span>` : ''}
      ${m.latencyMs != null ? `<span>${esc(m.latencyMs)}ms</span>` : ''}
      ${m.finishReason ? `<span>finish: ${esc(m.finishReason)}</span>` : ''}
      <span class="mono" style="color:var(--muted)">req ${esc(m.requestId.slice(0, 8))}</span>
    </div>
    <div class="chat-content">${esc(m.content)}</div>
    ${m.errorMessage ? `<div class="chat-content" style="color:var(--err);margin-top:6px">⚠ ${esc(m.errorMessage)}</div>` : ''}
  </div>`;
}

function renderEventRow(e: {
  event: string;
  userId: string;
  detail: unknown;
  createdAt: Date;
}): string {
  const detail = e.detail ? JSON.stringify(e.detail) : '';
  return `<div class="event-row ev-${esc(e.event)}">
    <span class="event-time">${esc(relTime(e.createdAt))}</span>
    <span class="event-name"><a href="/admin/instances/${encodeURIComponent(e.userId)}">${esc(e.userId.slice(0, 16))}</a> · ${esc(e.event)}</span>
    <span class="event-detail">${esc(detail)}</span>
  </div>`;
}

function userLabel(u: { userId: string; name: string | null; email: string | null }): string {
  if (u.name) {
    return `<strong>${esc(u.name)}</strong>${u.email ? `<div class="dim mono" style="font-size:11px">${esc(u.email)}</div>` : ''}`;
  }
  if (u.email) return `<span class="mono">${esc(u.email)}</span>`;
  return `<span class="mono dim" title="${esc(u.userId)}">${esc(u.userId.slice(0, 14))}…</span>`;
}

function compactText(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function shortProvider(provider: string): string {
  const names: Record<string, string> = {
    gmail: 'gmail',
    google_calendar: 'gcal',
    outlook: 'outlook',
    outlook_calendar: 'ocal',
  };
  return names[provider] ?? provider;
}

/**
 * Valid docker-tag token. Also blocks Prisma LIKE wildcards (% _) so a
 * crafted ?image= can't silently match everything.
 */
const IMAGE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Match instances whose imageTag carries this tag, in every stored form:
 * full ref ("registry…/img:v21"), bare tag ("v21", from reconcile), or
 * digest-suffixed ref ("registry…/img:v21@sha256:…").
 */
function imageTagWhere(tag: string): Prisma.HermesInstanceWhereInput {
  if (!IMAGE_TAG_RE.test(tag)) return { id: '__invalid_image_tag__' };
  return {
    OR: [
      { imageTag: { endsWith: `:${tag}` } },
      { imageTag: tag },
      { imageTag: { contains: `:${tag}@` } },
    ],
  };
}

function dayAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfDayUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Daily LLM spend buckets, newest first. Raw SQL because Prisma's groupBy
 * can't truncate timestamps. `userId` narrows to one user; omit for global.
 */
async function usageByDay(
  days: number,
  userId?: string,
): Promise<Array<{ day: string; cost: number; tokens: number; calls: number }>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = userId
    ? await prisma.$queryRaw<Array<{ day: Date; cost: number; tokens: bigint; calls: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("costUsd"), 0)::float8 AS cost,
               COALESCE(SUM("promptTokens" + "completionTokens"), 0)::bigint AS tokens,
               COUNT(*)::bigint AS calls
        FROM "LlmUsage"
        WHERE "createdAt" >= ${since} AND "userId" = ${userId}
        GROUP BY 1 ORDER BY 1 DESC`
    : await prisma.$queryRaw<Array<{ day: Date; cost: number; tokens: bigint; calls: bigint }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COALESCE(SUM("costUsd"), 0)::float8 AS cost,
               COALESCE(SUM("promptTokens" + "completionTokens"), 0)::bigint AS tokens,
               COUNT(*)::bigint AS calls
        FROM "LlmUsage"
        WHERE "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1 DESC`;
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    cost: Number(r.cost),
    tokens: Number(r.tokens),
    calls: Number(r.calls),
  }));
}

async function perUserMonthlyAtCap(
  capUsd: number,
): Promise<{ userId: string; spend: number; pct: number }[]> {
  const rows = await prisma.llmUsage.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: startOfMonthUtc() } },
    _sum: { costUsd: true },
  });
  const out = rows
    .map((r) => {
      const spend = Number(r._sum.costUsd ?? 0);
      return { userId: r.userId, spend, pct: (spend / capUsd) * 100 };
    })
    .filter((x) => x.pct >= 50)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 20);
  return out;
}

export { router as adminRouter };
