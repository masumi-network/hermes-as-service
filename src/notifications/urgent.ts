import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';
import { SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { isSystemSweepEnabled } from '../schedules/system-schedules.js';

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
  if (!(await isSystemSweepEnabled(row.id, 'urgent-interrupts'))) {
    return { fired: false, reason: 'sweep_disabled' };
  }

  const env: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  if (!SokosumiClient.isConfigured(env, row.userId)) return { fired: false, reason: 'no_sokosumi_key' };

  // Cooldown check — but AWAITING_INPUT bypasses the cooldown because
  // those events are time-critical (the user's job is paused). We still
  // gate via Hermes' judgment below, just don't preemptively skip.
  // (The hasAwaitingInput check happens after we list events; see below.)
  const inCooldown =
    !!row.lastUrgentInterruptAt && row.lastUrgentInterruptAt.getTime() > Date.now() - COOLDOWN_MS;

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

  // Three watermarks now — one per status we care about. Tracked
  // separately so a flood of completions can't hide a fresh
  // AWAITING_INPUT (which is much more urgent).
  const sinceCompleted = row.lastJobNoticeAt ?? new Date(Date.now() - 24 * 60 * 60_000);
  const sinceAwaiting = row.lastAwaitingInputNoticeAt ?? new Date(Date.now() - 24 * 60 * 60_000);
  const sinceFailed = row.lastFailedJobNoticeAt ?? new Date(Date.now() - 24 * 60 * 60_000);

  const candidates: Array<{
    name: string;
    agentId: string;
    timestamp: string;
    resultSnippet: string;
    orgId: string;
    status: 'COMPLETED' | 'AWAITING_INPUT' | 'FAILED';
    jobId: string;
  }> = [];

  for (const org of orgs.slice(0, 5)) {
    const orgClient = client.withOrganization(org.id);
    // For each watched status, list recent jobs and filter by watermark.
    for (const status of ['COMPLETED', 'AWAITING_INPUT', 'FAILED'] as const) {
      try {
        const jobs = (await orgClient.listJobs({ status, limit: 15 })) as Array<{
          id?: string;
          name?: string;
          agentId?: string;
          completedAt?: string;
          updatedAt?: string;
          createdAt?: string;
          result?: string;
        }>;
        const watermark =
          status === 'COMPLETED' ? sinceCompleted : status === 'AWAITING_INPUT' ? sinceAwaiting : sinceFailed;
        for (const j of jobs) {
          // Use completedAt for COMPLETED, updatedAt for the others (which
          // mark state transitions).
          const stampStr =
            status === 'COMPLETED' ? j.completedAt : j.updatedAt ?? j.createdAt;
          if (!stampStr) continue;
          const stamp = new Date(stampStr);
          if (isNaN(stamp.getTime())) continue;
          if (stamp.getTime() <= watermark.getTime()) continue;
          candidates.push({
            name: j.name ?? '(unnamed job)',
            agentId: j.agentId ?? '?',
            timestamp: stampStr,
            resultSnippet: (j.result ?? '').slice(0, 800).replace(/\s+/g, ' '),
            orgId: org.id,
            status,
            jobId: j.id ?? '?',
          });
        }
      } catch (err) {
        log.warn({ err, orgId: org.id, status }, 'urgent_check_list_jobs_failed');
      }
    }
  }

  if (candidates.length === 0) {
    // Advance all three watermarks so we don't keep re-scanning the
    // same empty window.
    const now = new Date();
    await prisma.hermesInstance.update({
      where: { id: instanceId },
      data: {
        lastJobNoticeAt: now,
        lastAwaitingInputNoticeAt: now,
        lastFailedJobNoticeAt: now,
      },
    });
    return { fired: false, reason: 'no_new_jobs' };
  }

  // Sort newest-first, cap.
  candidates.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const events = candidates.slice(0, MAX_EVENTS_TO_GATE);
  const hasAwaitingInput = events.some((e) => e.status === 'AWAITING_INPUT');

  // Now apply cooldown — but allow AWAITING_INPUT to override.
  if (inCooldown && !hasAwaitingInput) {
    // Don't advance watermarks; we'll re-evaluate next tick.
    return { fired: false, reason: 'cooldown' };
  }

  // Ask Hermes to gate.
  const apiKey = await decryptSecret(row.apiServerKey);
  const decision = await runGatingPrompt(row.endpointUrl, apiKey, events, log).catch((err) => {
    log.warn({ err }, 'urgent_gating_call_failed');
    return null;
  });

  // Advance per-status watermarks to the newest event we considered.
  const newest = (status: 'COMPLETED' | 'AWAITING_INPUT' | 'FAILED'): Date | undefined => {
    const filtered = events.filter((e) => e.status === status);
    if (filtered.length === 0) return undefined;
    return new Date(filtered[0]!.timestamp);
  };
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: {
      ...(newest('COMPLETED') ? { lastJobNoticeAt: newest('COMPLETED') } : {}),
      ...(newest('AWAITING_INPUT') ? { lastAwaitingInputNoticeAt: newest('AWAITING_INPUT') } : {}),
      ...(newest('FAILED') ? { lastFailedJobNoticeAt: newest('FAILED') } : {}),
    },
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
  events: Array<{
    name: string;
    agentId: string;
    timestamp: string;
    resultSnippet: string;
    status: 'COMPLETED' | 'AWAITING_INPUT' | 'FAILED';
    jobId: string;
  }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<GatingDecision | null> {
  const eventsBlock = events
    .map(
      (e, i) =>
        `${i + 1}. [${e.status}] Job "${e.name}" (agent=${e.agentId}, job_id=${e.jobId}, ts=${e.timestamp}). Snippet: ${e.resultSnippet || '(empty)'}`,
    )
    .join('\n\n');

  const hasAwaiting = events.some((e) => e.status === 'AWAITING_INPUT');
  const hasFailed = events.some((e) => e.status === 'FAILED');

  const prompt = `Internal gating decision — your output is parsed by code, \
not shown to the user directly unless you produce a notification.

${events.length} Sokosumi job event(s) just happened. You decide whether \
ANY are worth interrupting the user RIGHT NOW (vs. waiting for tomorrow's \
morning brief).

Status-specific bars:

- AWAITING_INPUT — almost always YES. The user's job is paused and won't \
  finish until they respond. If you have any AWAITING_INPUT event, the \
  default is YES unless the user clearly doesn't care about this job.
- FAILED — usually YES, especially if the user kicked it off recently or \
  paid credits. Mention the failure + that they can request a refund \
  ("just say 'refund job X' and I'll handle it"). Skip if it's an obviously \
  trivial / abandoned job.
- COMPLETED — HIGH bar. Only YES if (a) user is clearly waiting on this \
  result, (b) action needs to be taken before morning, (c) the result \
  contains a clear blocker or anomaly. Default NO; morning brief covers \
  the rest.

This batch contains:${hasAwaiting ? ' AWAITING_INPUT (likely fire)' : ''}${hasFailed ? ' FAILED (probably fire)' : ''} \
${events.some((e) => e.status === 'COMPLETED') ? ' COMPLETED (high bar)' : ''}.

Events:
${eventsBlock}

Reply format — EXACTLY ONE of these, no extra prose:

NO

  OR

YES
<one-sentence reason for the interrupt>
<the actual notification message body — 1-3 sentences, warm but tight, \
addressed to the user as Hermes' voice. If multiple events warrant the \
interrupt, you can mention them together. If FAILED, suggest the refund \
flow. If AWAITING_INPUT, lead with what input the job needs.>

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
