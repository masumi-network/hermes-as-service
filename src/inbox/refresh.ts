import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { listIntegrations } from '../integrations/manager.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

const REFRESH_INTERVAL_MS = 6 * 60 * 60_000; // 6h
const RETRY_BACKOFF_MS = 2 * 60 * 60_000; // failed attempts retry after ~2h, not hourly

/**
 * Silent inbox refresh — keep Hermes' memory current with the user's mail.
 *
 * For each instance with connected mail/calendar MCPs (Gmail, Outlook,
 * Google Calendar, Outlook Calendar), send Hermes a quiet prompt to scan
 * new mail since lastInboxRefreshAt and update memory. The reply is
 * discarded; this never produces a user-visible message.
 *
 * Triggered by an hourly cron sweep. Per-user cadence is gated on
 * lastInboxRefreshAt > REFRESH_INTERVAL_MS so we don't hammer Hermes for
 * users we just synced.
 *
 * Returns true on a successful run, false on graceful skip (no machine,
 * no connected providers, destroyed instance, etc.).
 */
export async function refreshInboxForInstance(instanceId: string): Promise<boolean> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return false;
  if (row.destroyedAt) return false;
  if (!row.endpointUrl) return false;
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') return false;
  if (!(await isSystemSweepEnabled(row.id, 'inbox-refresh'))) return false;

  // Skip if no mail/calendar MCPs are connected — there's nothing to scan.
  const integrations = await listIntegrations(row.userId);
  // 'connected' ONLY: 'pending' explicitly means the MCP is NOT on the
  // machine yet (queued while it was down) — prompting the agent to scan
  // mail with tools it doesn't have burns an LLM turn and confuses memory.
  const mailProviders = integrations
    .filter(
      (i) =>
        i.status === 'connected' &&
        (i.provider === 'gmail' ||
          i.provider === 'outlook' ||
          i.provider === 'google_calendar' ||
          i.provider === 'outlook_calendar'),
    )
    .map((i) => i.provider);
  if (mailProviders.length === 0) return false;

  const log = logger.child({ instanceId, userId: row.userId, fn: 'inbox_refresh' });
  log.info({ providers: mailProviders, since: row.lastInboxRefreshAt }, 'starting inbox refresh');

  const apiKey = await decryptSecret(row.apiServerKey);
  const since = row.lastInboxRefreshAt
    ? row.lastInboxRefreshAt.toISOString()
    : new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  const prompt = buildInboxRefreshPrompt(mailProviders, since);

  // Stamp the ATTEMPT before calling: failed attempts back off ~2h via the
  // sweep's attempt filter instead of retrying every hourly tick. The
  // success watermark (lastInboxRefreshAt) is deliberately untouched on
  // failure — it doubles as the "scan mail since X" boundary, and moving
  // it forward would permanently skip the unscanned mail window.
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastInboxRefreshAttemptAt: new Date() },
  });

  try {
    await callHermesChat(row.endpointUrl, apiKey, prompt, 5 * 60_000);
  } catch (err) {
    log.warn({ err }, 'inbox_refresh_call_failed');
    await recordEvent({
      userId: row.userId,
      instanceId,
      event: 'onboarding_step',
      detail: { step: 'inbox_refresh', status: 'failed', providers: mailProviders },
    });
    return false;
  }

  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastInboxRefreshAt: new Date() },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'onboarding_step',
    detail: { step: 'inbox_refresh', status: 'done', providers: mailProviders },
  });
  log.info('inbox refresh done');
  return true;
}

/**
 * Hourly sweep — picks instances overdue for an inbox refresh and runs
 * them sequentially. Capped per tick so a backlog doesn't stall the
 * orchestrator.
 */
let sweepInFlight = false;

export async function runInboxRefreshSweep(): Promise<{ scanned: number; refreshed: number }> {
  // Re-entrancy guard (same pattern as the pool sweep): a worst-case tick
  // (50 instances x 5-min timeout) exceeds the hourly cron interval, and an
  // overlapping sweep would re-select the same in-flight instances and pay
  // for duplicate agent turns.
  if (sweepInFlight) return { scanned: 0, refreshed: 0 };
  sweepInFlight = true;
  try {
    return await runInboxRefreshSweepInner();
  } finally {
    sweepInFlight = false;
  }
}

async function runInboxRefreshSweepInner(): Promise<{ scanned: number; refreshed: number }> {
  const cutoff = new Date(Date.now() - REFRESH_INTERVAL_MS);
  const attemptCutoff = new Date(Date.now() - RETRY_BACKOFF_MS);
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
      OR: [{ lastInboxRefreshAt: null }, { lastInboxRefreshAt: { lt: cutoff } }],
      // Failed attempts back off: skip anyone attempted in the last ~2h.
      AND: [{ OR: [{ lastInboxRefreshAttemptAt: null }, { lastInboxRefreshAttemptAt: { lt: attemptCutoff } }] }],
    },
    select: { id: true, userId: true },
    take: 50,
  });

  let refreshed = 0;
  for (const instance of due) {
    try {
      const ok = await refreshInboxForInstance(instance.id);
      if (ok) refreshed++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'inbox_refresh_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, refreshed }, 'inbox_refresh_sweep_done');
  }
  return { scanned: due.length, refreshed };
}

// ---------- prompt + helper ----------

function buildInboxRefreshPrompt(providers: string[], sinceIso: string): string {
  const list = providers.map(providerLabel).join(', ');
  return `Internal background task — your reply is discarded and not \
shown to the user. Do not draft a chat reply.

Use your connected MCPs (${list}) to scan for new mail and calendar \
activity since ${sinceIso}. For each thread or event of substance:

- Update your memory with sender / participants, subject or title, and a \
  one-line gist of what changed or is needed.
- Note any deadlines, action items, or stalled threads that have become \
  unstalled (e.g., someone you'd been waiting on finally replied).
- If nothing notable arrived, that's fine — just say so in memory.

Do NOT push any user-visible notifications from this task. This is purely \
memory hygiene. The proactive-notification path handles user-facing pings \
separately and decides on its own bar.

Once memory is updated, reply with just "ok".`;
}

function providerLabel(p: string): string {
  switch (p) {
    case 'gmail':
      return 'Gmail';
    case 'google_calendar':
      return 'Google Calendar';
    case 'outlook':
      return 'Outlook mail';
    case 'outlook_calendar':
      return 'Outlook Calendar';
    default:
      return p;
  }
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
