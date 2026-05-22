import { Hono } from 'hono';
import type { Context } from 'hono';
import { prisma } from '../db.js';
import { SpritesClient } from '../sprites/client.js';
import { esc, layout, relTime, statCard, statusPill } from './html.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { userMonthlySpend } from '../llm/spend.js';
import { describe as describeCron } from '../schedules/cron.js';
import { runDueOnce } from '../schedules/scheduler.js';

const router = new Hono();

// ---------- Overview ----------

router.get('/admin', async (c) => {
  const cfg = loadConfig();
  const [total, running, suspended, provisioning, errored, last24hMsgs, last24hInstances, recentEvents, mtdSpend, mtdTokens, atOrNearCap] =
    await Promise.all([
      prisma.hermesInstance.count(),
      prisma.hermesInstance.count({ where: { status: 'running' } }),
      prisma.hermesInstance.count({ where: { status: 'suspended' } }),
      prisma.hermesInstance.count({ where: { status: 'provisioning' } }),
      prisma.hermesInstance.count({ where: { status: 'error' } }),
      prisma.chatMessage.count({ where: { createdAt: { gt: dayAgo() } } }),
      prisma.hermesInstance.count({ where: { createdAt: { gt: dayAgo() } } }),
      prisma.provisionEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      prisma.llmUsage.aggregate({
        where: { createdAt: { gte: startOfMonthUtc() } },
        _sum: { costUsd: true },
      }),
      prisma.llmUsage.aggregate({
        where: { createdAt: { gte: startOfMonthUtc() } },
        _sum: { promptTokens: true, completionTokens: true },
      }),
      perUserMonthlyAtCap(cfg.MONTHLY_USD_CAP_PER_USER),
    ]);

  const errorRate24h = await prisma.provisionEvent.count({
    where: { event: { in: ['provision_failed', 'chat_failed'] }, createdAt: { gt: dayAgo() } },
  });

  const totalCost = Number(mtdSpend._sum.costUsd ?? 0);
  const totalTokens = (mtdTokens._sum.promptTokens ?? 0) + (mtdTokens._sum.completionTokens ?? 0);

  const body = `
    <h1>Overview</h1>
    <div class="stats">
      ${statCard('Total instances', total)}
      ${statCard('Running', running)}
      ${statCard('Suspended', suspended)}
      ${statCard('Provisioning', provisioning)}
      ${statCard('Errored', errored)}
      ${statCard('Chats (24h)', last24hMsgs)}
      ${statCard('Errors (24h)', errorRate24h)}
      ${statCard('MTD spend', '$' + totalCost.toFixed(2), `${totalTokens.toLocaleString()} tokens · cap $${cfg.MONTHLY_USD_CAP_PER_USER}/user`)}
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

  const where: Record<string, unknown> = {};
  if (q) where['OR'] = [
    { userId: { contains: q, mode: 'insensitive' } },
    { spriteName: { contains: q, mode: 'insensitive' } },
    { id: { equals: q } },
  ];
  if (status) where['status'] = status;

  const rows = await prisma.hermesInstance.findMany({
    where,
    orderBy: { lastActivityAt: 'desc' },
    take: 200,
  });

  const body = `
    <h1>Instances</h1>
    <form method="get" action="/admin/instances" class="actions">
      <input type="search" name="q" placeholder="Search userId, sprite name, instance id" value="${esc(q)}" style="background:var(--surface);border:1px solid var(--border-strong);border-radius:6px;padding:6px 10px;color:var(--text);min-width:320px;font-size:13px;font-family:inherit" />
      <select name="status" style="background:var(--surface);border:1px solid var(--border-strong);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;font-family:inherit">
        <option value="">all statuses</option>
        ${['running', 'suspended', 'provisioning', 'error']
          .map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s}</option>`)
          .join('')}
      </select>
      <button type="submit">Filter</button>
    </form>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Status</th>
            <th>Last activity</th>
            <th>Region</th>
            <th>Age</th>
            <th>Sprite</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="6" class="empty">No instances match.</td></tr>` : rows.map(rowToInstanceRow).join('')}
        </tbody>
      </table>
    </div>
    <p style="color:var(--muted);font-size:12px;margin-top:12px">Showing ${rows.length} of up to 200. Refine with search/filter.</p>
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
}): string {
  return `<tr>
    <td><a href="/admin/instances/${encodeURIComponent(r.userId)}" class="mono">${esc(r.userId)}</a></td>
    <td>${statusPill(r.status)}</td>
    <td>${esc(relTime(r.lastActivityAt))}</td>
    <td class="mono">${esc(r.region || '—')}</td>
    <td>${esc(relTime(r.createdAt))}</td>
    <td class="mono">${r.endpointUrl ? `<a href="${esc(r.endpointUrl)}" target="_blank">${esc(r.spriteName)}</a>` : esc(r.spriteName)}</td>
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
  const [messages, events, mtdSpend, usageByModel, schedules] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { instanceId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
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
      orderBy: { _sum: { costUsd: 'desc' } },
    }),
    prisma.scheduledTask.findMany({
      where: { instanceId: row.id },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const outboxPending = await prisma.outboxMessage.findMany({
    where: { instanceId: row.id },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  const capPct = (mtdSpend / cfg.MONTHLY_USD_CAP_PER_USER) * 100;
  const capPill =
    capPct >= 100
      ? `<span class="pill err">capped</span>`
      : capPct >= 80
        ? `<span class="pill warn">${capPct.toFixed(0)}%</span>`
        : `<span class="pill ok">${capPct.toFixed(0)}%</span>`;

  const body = `
    <h1 class="mono" style="font-size:18px">${esc(row.userId)}</h1>
    <div class="row" style="margin-bottom:16px">
      <div class="card flex-1">
        <h3>Instance</h3>
        <dl class="kv">
          <dt>Status</dt><dd>${statusPill(row.status)}</dd>
          <dt>Endpoint</dt><dd>${row.endpointUrl ? `<a class="mono" href="${esc(row.endpointUrl)}" target="_blank">${esc(row.endpointUrl)}</a>` : '—'}</dd>
          <dt>Sprite</dt><dd class="mono">${esc(row.spriteName)}</dd>
          <dt>Region</dt><dd class="mono">${esc(row.region || '—')}</dd>
          <dt>Created</dt><dd>${esc(relTime(row.createdAt))} (${esc(row.createdAt.toISOString())})</dd>
          <dt>Last activity</dt><dd>${esc(relTime(row.lastActivityAt))}</dd>
          ${row.errorMessage ? `<dt>Last error</dt><dd style="color:var(--err)">${esc(row.errorMessage)}</dd>` : ''}
        </dl>
      </div>
      <div class="card flex-1">
        <h3>Monthly spend</h3>
        <dl class="kv">
          <dt>MTD</dt><dd>$${mtdSpend.toFixed(4)} / $${cfg.MONTHLY_USD_CAP_PER_USER.toFixed(2)} ${capPill}</dd>
          ${usageByModel.length === 0 ? '<dt>By model</dt><dd>—</dd>' : usageByModel.map(u => {
            const tokens = (u._sum.promptTokens ?? 0) + (u._sum.completionTokens ?? 0);
            const cost = Number(u._sum.costUsd ?? 0);
            return `<dt class="mono">${esc(u.model)}</dt><dd>$${cost.toFixed(4)} (${tokens.toLocaleString()} tok)</dd>`;
          }).join('')}
        </dl>
        <h3 style="margin-top:24px">Actions</h3>
        <div class="actions" style="margin-top:8px">
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/resume" class="inline"><button type="submit">Resume</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/suspend" class="inline"><button type="submit">Suspend</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/sync-config" class="inline"><button type="submit" title="Re-push config.yaml + SOUL.md from the orchestrator, restart Hermes">Sync config</button></form>
          <form method="post" action="/admin/instances/${encodeURIComponent(row.userId)}/destroy" class="inline" onsubmit="return confirm('Destroy sprite + DB row for this user? Cannot be undone.')"><button type="submit" class="danger">Destroy</button></form>
        </div>
        <h3 style="margin-top:24px">Sprite process logs</h3>
        <pre class="log" id="sprite-log">loading…</pre>
        <script>
          async function refreshLog() {
            try {
              const r = await fetch('/admin/instances/${encodeURIComponent(row.userId)}/sprite-logs', { headers: { Accept: 'text/plain' } });
              const t = await r.text();
              document.getElementById('sprite-log').textContent = t || '(no output)';
            } catch (e) {
              document.getElementById('sprite-log').textContent = 'error: ' + e.message;
            }
          }
          refreshLog();
          setInterval(refreshLog, 8000);
        </script>
      </div>
    </div>

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

    <h2>Chat history (latest 200)</h2>
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
  const sprites = new SpritesClient();
  try {
    const text = await sprites.tailServiceLogs(row.spriteName, 'hermes', 200);
    return c.text(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (err) {
    logger.warn({ err, userId }, 'sprite_log_fetch_failed');
    return c.text(`(log fetch failed: ${err instanceof Error ? err.message : String(err)})`, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
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
 * For testing / dev only. Accepts POST + GET for convenience from a
 * browser address bar.
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
router.get('/admin/instances/:userId/hard-reset', hardReset);

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
 * Admin-only — seed a personal-scope Sokosumi task assigned to the
 * Hermes coworker so the executor sweep has something to pick up.
 * Body: { name: string, description: string }
 */
router.post('/admin/instances/:userId/test/seed-hermes-task', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
  const taskName = body.name ?? `E2E test ${Date.now()}`;
  const description = body.description ?? 'What is 2 + 2? Reply with just the number.';

  const { SokosumiClient } = await import('../sokosumi/client.js');
  const { isValidSokosumiEnv } = await import('../config.js');
  const env = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  const client = new SokosumiClient(row.userId, env);

  let hermesCoworkerId: string | null = null;
  try {
    const coworkers = (await client.listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
      id?: string;
      slug?: string;
    }>;
    hermesCoworkerId = coworkers.find((c) => c.slug === 'hermes')?.id ?? null;
  } catch (err) {
    return c.json({ error: 'list_coworkers failed', detail: String(err) }, 502);
  }
  if (!hermesCoworkerId) {
    return c.json({ error: 'hermes coworker not found in personal scope' }, 404);
  }
  try {
    const created = (await client.createTask({
      name: taskName,
      description,
      coworkerId: hermesCoworkerId,
      status: 'READY',
    })) as { data?: { id?: string }; id?: string };
    const taskId = created?.data?.id ?? created?.id;
    return c.json({ ok: true, taskId, hermesCoworkerId });
  } catch (err) {
    return c.json({ error: 'createTask failed', detail: String(err) }, 502);
  }
});

/**
 * Admin-only — run the Hermes-executor sweep against a single instance
 * right now. Returns the sweep result counts. Useful for testing without
 * waiting on the 5-minute cron.
 */
router.post('/admin/instances/:userId/test/run-hermes-executor', async (c) => {
  const userId = c.req.param('userId');
  const row = await prisma.hermesInstance.findUnique({ where: { userId } });
  if (!row) return c.json({ error: 'instance not found' }, 404);
  const { runHermesExecutorForInstance } = await import('../notifications/hermes-executor.js');
  try {
    const res = await runHermesExecutorForInstance(row.id);
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: 'sweep failed', detail: String(err) }, 500);
  }
});

// One-off (but idempotent) maintenance: capitalize the first letter of
// every quoted prompt in existing welcomeMessage rows. Sokosumi UI uses
// those quoted strings as clickable action buttons and lowercase looked
// wrong on the rendered buttons. Safe to call repeatedly.
router.post('/admin/maintenance/fix-welcome-casing', async (c) => {
  const rows = await prisma.hermesInstance.findMany({
    where: { destroyedAt: null, welcomeMessage: { not: null } },
    select: { id: true, welcomeMessage: true },
  });
  let updated = 0;
  for (const r of rows) {
    const before = r.welcomeMessage ?? '';
    const after = before.replace(/(["“])([a-z])/g, (_, q, ch) => `${q}${ch.toUpperCase()}`);
    if (after !== before) {
      await prisma.hermesInstance.update({ where: { id: r.id }, data: { welcomeMessage: after } });
      updated++;
    }
  }
  return c.json({ scanned: rows.length, updated });
});

router.post('/admin/instances/:userId/outbox/:messageId/delete', async (c) => {
  const userId = c.req.param('userId');
  const messageId = c.req.param('messageId');
  await prisma.outboxMessage.deleteMany({ where: { id: messageId, userId } });
  return c.redirect(`/admin/instances/${encodeURIComponent(userId)}`);
});

// ---------- Events firehose ----------

router.get('/admin/events', async (c) => {
  const events = await prisma.provisionEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const body = `
    <h1>Events</h1>
    <div class="card">${events.length === 0 ? '<div class="empty">No events.</div>' : events.map(renderEventRow).join('')}</div>
  `;
  return c.html(layout({ title: 'Events', body, active: '/admin/events' }));
});

// ---------- helpers ----------

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

function dayAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
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
