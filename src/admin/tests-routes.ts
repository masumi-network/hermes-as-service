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
import { renderTestTurn, renderToolChips } from './helpers.js';

const router = new Hono();

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


export { router as testsAdminRouter };
