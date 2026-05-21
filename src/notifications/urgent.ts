import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';

const COOLDOWN_MS = 2 * 60 * 60_000; // 2h between urgent interrupts per user
const MAX_EVENTS_TO_GATE = 10; // cap on candidate events fed to Hermes per tick

/**
 * Proactive urgent-interrupt path.
 *
 * Hourly sweep checks each instance for new Sokosumi job completions since
 * lastJobNoticeAt. If any exist AND the user is past their 2h cooldown
 * (lastUrgentInterruptAt + COOLDOWN_MS), we ask Hermes to decide whether
 * the events are worth interrupting the user about right now.
 *
 * Hermes' gating call returns one of:
 *   YES <one-line reason>
 *   <drafted notification message body>
 *
 *   OR
 *
 *   NO
 *
 * Only YES events fire a message to outbox. Cooldown advances either way.
 *
 * If multiple events accumulate in a window, they get batched into one
 * gating call → one possible notification covering all of them. Prevents
 * a "5 job completions in 5 minutes" cascade.
 */
export async function checkUrgentInterruptsForInstance(instanceId: string): Promise<{ fired: boolean; reason?: string }> {
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) return { fired: false, reason: 'no_row' };
  if (row.destroyedAt) return { fired: false, reason: 'destroyed' };
  if (!row.endpointUrl) return { fired: false, reason: 'no_endpoint' };
  if (row.status !== 'ready' && row.status !== 'running' && row.status !== 'suspended') {
    return { fired: false, reason: `status=${row.status}` };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env)) return { fired: false, reason: 'no_sokosumi_key' };

  // Cooldown check.
  if (row.lastUrgentInterruptAt && row.lastUrgentInterruptAt.getTime() > Date.now() - COOLDOWN_MS) {
    return { fired: false, reason: 'cooldown' };
  }

  const log = logger.child({ instanceId, userId: row.userId, fn: 'urgent_check' });

  // Fetch new completions since lastJobNoticeAt. The Sokosumi client
  // doesn't expose a since filter on /jobs, so we list recent COMPLETED
  // jobs and filter client-side by completedAt.
  const client = new SokosumiClient(row.userId, env);
  let orgs: Array<{ id: string }> = [];
  try {
    orgs = (await client.listOrganizations()).map((o) => ({ id: o.id }));
  } catch (err) {
    log.warn({ err }, 'urgent_check_list_orgs_failed');
    return { fired: false, reason: 'list_orgs_failed' };
  }

  const since = row.lastJobNoticeAt ?? new Date(Date.now() - 24 * 60 * 60_000);
  const candidates: Array<{
    name: string;
    agentId: string;
    completedAt: string;
    resultSnippet: string;
    orgId: string;
  }> = [];

  for (const org of orgs.slice(0, 5)) {
    const orgClient = client.withOrganization(org.id);
    try {
      const jobs = (await orgClient.listJobs({ status: 'COMPLETED', limit: 15 })) as Array<{
        name?: string;
        agentId?: string;
        completedAt?: string;
        result?: string;
      }>;
      for (const j of jobs) {
        if (!j.completedAt) continue;
        const done = new Date(j.completedAt);
        if (isNaN(done.getTime())) continue;
        if (done.getTime() <= since.getTime()) continue;
        candidates.push({
          name: j.name ?? '(unnamed job)',
          agentId: j.agentId ?? '?',
          completedAt: j.completedAt,
          resultSnippet: (j.result ?? '').slice(0, 800).replace(/\s+/g, ' '),
          orgId: org.id,
        });
      }
    } catch (err) {
      log.warn({ err, orgId: org.id }, 'urgent_check_list_jobs_failed');
    }
  }

  if (candidates.length === 0) {
    // Still advance lastJobNoticeAt so we don't keep re-scanning the same window.
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: { lastJobNoticeAt: new Date() },
    });
    return { fired: false, reason: 'no_new_jobs' };
  }

  // Sort newest-first, cap.
  candidates.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const events = candidates.slice(0, MAX_EVENTS_TO_GATE);

  // Ask Hermes to gate.
  const apiKey = await decryptSecret(row.apiServerKey);
  const decision = await runGatingPrompt(row.endpointUrl, apiKey, events, log).catch((err) => {
    log.warn({ err }, 'urgent_gating_call_failed');
    return null;
  });

  // Always advance the watermark to the newest event we considered.
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastJobNoticeAt: new Date(events[0]!.completedAt) },
  });

  if (!decision || decision.verdict === 'NO') {
    return { fired: false, reason: 'gated_NO' };
  }

  // Push the drafted notification to outbox.
  await enqueueOutboxMessage({
    instanceId: row.id,
    userId: row.userId,
    content: decision.message,
    kind: 'job_complete',
  });
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { lastUrgentInterruptAt: new Date() },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: { source: 'urgent_interrupt', events: events.length, reason: decision.reason },
  });
  log.info({ events: events.length, reason: decision.reason }, 'urgent_interrupt_fired');
  return { fired: true, reason: decision.reason };
}

export async function runUrgentInterruptSweep(): Promise<{ scanned: number; fired: number }> {
  const due = await prisma.hermesInstance.findMany({
    where: {
      destroyedAt: null,
      onboardedAt: { not: null },
      status: { in: ['ready', 'running', 'suspended'] },
    },
    select: { id: true },
    take: 100,
  });
  let fired = 0;
  for (const instance of due) {
    try {
      const res = await checkUrgentInterruptsForInstance(instance.id);
      if (res.fired) fired++;
    } catch (err) {
      logger.error({ err, instanceId: instance.id }, 'urgent_sweep_item_failed');
    }
  }
  if (due.length > 0) {
    logger.info({ scanned: due.length, fired }, 'urgent_sweep_done');
  }
  return { scanned: due.length, fired };
}

// ---------- gating prompt + parser ----------

interface GatingDecision {
  verdict: 'YES' | 'NO';
  reason: string;
  message: string;
}

async function runGatingPrompt(
  endpointUrl: string,
  apiKey: string,
  events: Array<{ name: string; agentId: string; completedAt: string; resultSnippet: string }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<GatingDecision | null> {
  const eventsBlock = events
    .map(
      (e, i) =>
        `${i + 1}. Job "${e.name}" finished at ${e.completedAt} (agent=${e.agentId}). Result snippet: ${e.resultSnippet || '(empty)'}`,
    )
    .join('\n\n');

  const prompt = `Internal gating decision — your output is parsed by code, \
not shown to the user directly unless you produce a notification.

${events.length} Sokosumi job(s) just completed for your user. You decide \
whether ANY of them are worth interrupting the user RIGHT NOW (vs. waiting \
for tomorrow's morning brief). The bar is HIGH:

Interrupt only if at least one of these is true for at least one event:
  (a) The user is clearly waiting on this result (recent context, time-sensitive deadline, follow-up they explicitly asked for).
  (b) Action needs to be taken before tomorrow morning (e.g., a meeting tonight, a partner thread that needs response in hours).
  (c) The result contains a clear blocker or anomaly that costs the user money / breaks a plan if left unread.

Default to NO. The morning brief covers everything anyway. Only fire YES \
if you'd genuinely thank yourself for the ping.

Events:
${eventsBlock}

Reply format — EXACTLY ONE of these, no extra prose:

NO

  OR

YES
<one-sentence reason for the interrupt>
<the actual notification message body — 1-3 sentences, warm but tight, \
addressed to the user as Hermes' voice>

End of instructions.`;

  const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(2 * 60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gating ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = (json.choices?.[0]?.message?.content ?? '').trim();
  if (!reply) return null;

  // Parse.
  const firstLine = reply.split('\n')[0]!.trim().toUpperCase();
  if (firstLine === 'NO') {
    log.info({ reply: reply.slice(0, 200) }, 'urgent_gated_NO');
    return { verdict: 'NO', reason: '', message: '' };
  }
  if (firstLine === 'YES') {
    const lines = reply.split('\n').slice(1);
    const reason = (lines[0] ?? '').trim();
    const message = lines
      .slice(1)
      .join('\n')
      .trim();
    if (!message) {
      log.warn({ reply: reply.slice(0, 200) }, 'urgent_gating_YES_no_message');
      return { verdict: 'NO', reason: 'YES without message body', message: '' };
    }
    return { verdict: 'YES', reason, message };
  }
  log.warn({ reply: reply.slice(0, 200) }, 'urgent_gating_unparseable');
  return null;
}
