import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { fetchWorkspaceSnapshot, SokosumiClient } from './client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

/**
 * One-shot sync of a single user's Sokosumi workspace into Hermes' memory.
 *
 * Used by:
 *   - sokosumi_sync onboarding step (fresh user, runs synchronously inline)
 *   - daily recurring cron (returning user, runs in the background once/day)
 *
 * Returns true on a successful run (snapshot fetched + memory write
 * attempted), false on graceful skip (no API key configured, instance
 * destroyed, no endpoint), throws on hard failure.
 */
export async function syncSokosumiWorkspaceForInstance(instanceId: string): Promise<boolean> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return false;
  if (row.destroyedAt) return false;
  if (!row.endpointUrl) return false;
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') return false;
  if (!(await isSystemSweepEnabled(row.id, 'sokosumi-sync'))) return false;

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env)) return false;

  const log = logger.child({ instanceId, userId: row.userId, env: env ?? '(default mainnet)', fn: 'sokosumi_sync' });
  log.info('starting workspace sync');

  const snapshot = await fetchWorkspaceSnapshot(row.userId, env);
  if (!snapshot) {
    log.warn('snapshot null — skipping');
    return false;
  }

  const summary = formatSnapshotForMemory(snapshot);
  const apiKey = await decryptSecret(row.apiServerKey);
  const prompt = `Internal task — your reply is discarded. Refresh your \
memory with this latest Sokosumi workspace snapshot. Update only the facts \
that have changed; keep any stable memories about who the user is.

<snapshot>
${summary}
</snapshot>

Reply with just "ok".`;

  try {
    await callHermesChat(row.endpointUrl, apiKey, prompt, 4 * 60_000);
  } catch (err) {
    log.warn({ err }, 'memory_write_failed_continuing');
  }

  const now = new Date();
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastSokosumiSyncAt: now },
  });
  // Keep the system ScheduledTask row's timestamps fresh so Sokosumi's
  // settings panel shows accurate "last ran" / "next run" info.
  await prisma.scheduledTask
    .update({
      where: { id: `system-sokosumi-sync-${instanceId}` },
      data: {
        lastRunAt: now,
        nextRunAt: new Date(now.getTime() + 24 * 60 * 60_000),
        lastError: null,
      },
    })
    .catch(() => {
      // Row may not exist yet for instances created before this feature.
      // Best-effort — non-fatal.
    });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'onboarding_step',
    detail: { step: 'sokosumi_sync', status: 'done', source: 'cron' },
  });
  log.info(
    {
      orgs: snapshot.organizations.length,
      totalTasks: snapshot.organizations.reduce((s, o) => s + o.tasks.length, 0),
      totalCompletedJobs: snapshot.organizations.reduce((s, o) => s + o.completedJobs.length, 0),
    },
    'workspace sync done',
  );
  return true;
}

/**
 * Picks every instance whose lastSokosumiSyncAt is older than ~23h (or
 * null, meaning never synced) and syncs them. Called from the hourly
 * cron. Limits per-tick concurrency so we don't hammer Sokosumi.
 */
export async function runSokosumiDailySweep(): Promise<{ scanned: number; synced: number }> {
  // No global "is configured" gate anymore — each env is independent.
  // syncSokosumiWorkspaceForInstance per-instance skips if its env's key
  // isn't set, so a fully unconfigured orchestrator just no-ops.
  const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000);
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
      OR: [{ lastSokosumiSyncAt: null }, { lastSokosumiSyncAt: { lt: cutoff } }],
    },
    select: { id: true, userId: true },
    take: 100, // cap per tick
  });

  let synced = 0;
  for (const instance of due) {
    try {
      const ok = await syncSokosumiWorkspaceForInstance(instance.id);
      if (ok) synced++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'sokosumi_daily_sync_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, synced }, 'sokosumi_daily_sweep_done');
  }
  return { scanned: due.length, synced };
}

// ---------- helpers ----------

function formatSnapshotForMemory(snapshot: {
  organizations: Array<{
    organization: { id: string; name?: string; slug?: string };
    tasks: unknown[];
    completedJobs: unknown[];
    conversations: unknown[];
    coworkers: unknown[];
  }>;
  credits: unknown | null;
  agents: unknown[];
  fetchedAt: string;
}): string {
  // Same enriched format as the onboarding snapshot — descriptions, larger
  // job result snippets (1800 chars), used-agents-first. Daily refresh
  // uses the same template so Hermes' memory stays consistent.
  const lines: string[] = [];
  lines.push(`Fetched at: ${snapshot.fetchedAt}`);
  lines.push(`Organizations: ${snapshot.organizations.length}`);
  lines.push('');
  const usedAgentIds = new Set<string>();
  for (const ws of snapshot.organizations) {
    const orgLabel = `${ws.organization.name ?? ws.organization.slug ?? '(unnamed)'} (id=${ws.organization.id})`;
    lines.push(`# Org: ${orgLabel}`);
    lines.push('');
    if (Array.isArray(ws.coworkers) && ws.coworkers.length > 0) {
      lines.push(`## Coworkers (${ws.coworkers.length}) — tasks get assigned to these`);
      for (const c of ws.coworkers as Array<{
        id?: string;
        slug?: string;
        name?: string;
        caption?: string | null;
        capabilities?: string[];
      }>) {
        const capabilities = (c.capabilities ?? []).join(',');
        lines.push(`- id=${c.id ?? '?'} slug=${c.slug ?? '?'} "${c.name ?? '?'}" — ${c.caption ?? ''} [${capabilities}]`);
      }
      lines.push('');
    }
    lines.push(`## Tasks (${ws.tasks.length})`);
    for (const t of ws.tasks.slice(0, 15) as Array<{
      id?: string;
      name?: string;
      status?: string;
      description?: string | null;
      jobs?: Array<{ name?: string; status?: string; agentId?: string }>;
    }>) {
      lines.push(`### [${t.status ?? '?'}] ${t.name ?? '(unnamed)'}`);
      if (t.description) {
        const d = t.description.slice(0, 500).replace(/\s+/g, ' ');
        lines.push(`  ${d}${t.description.length > 500 ? '…' : ''}`);
      }
      if (Array.isArray(t.jobs)) {
        for (const j of t.jobs.slice(0, 3)) {
          if (j.agentId) usedAgentIds.add(j.agentId);
        }
      }
    }
    lines.push('');
    lines.push(`## Completed jobs (${ws.completedJobs.length})`);
    for (const j of ws.completedJobs.slice(0, 8) as Array<{
      name?: string;
      agentId?: string;
      completedAt?: string;
      result?: string;
    }>) {
      const snippet = (j.result ?? '').slice(0, 1800).replace(/\s+/g, ' ');
      lines.push(`### ${j.name ?? '(unnamed)'} (${j.completedAt ?? '?'})`);
      if (j.agentId) usedAgentIds.add(j.agentId);
      if (snippet) {
        lines.push(`> ${snippet}${(j.result ?? '').length > 1800 ? '… [truncated]' : ''}`);
      }
    }
    lines.push('');
  }
  if (snapshot.credits) {
    const cr = snapshot.credits as { balance?: number };
    lines.push(`Credits (user-level): ${cr.balance ?? '?'}`);
  }
  return lines.join('\n');
}

async function callHermesChat(
  endpointUrl: string,
  apiKey: string,
  userMessage: string,
  timeoutMs: number,
): Promise<void> {
  const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: userMessage }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`callHermesChat ${res.status}: ${body.slice(0, 200)}`);
  }
}
