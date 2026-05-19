import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';
import { recordEvent } from '../audit.js';
import { listIntegrations } from '../integrations/manager.js';

/** A single step in the onboarding loader UI. Mirrors the JSON we persist. */
export interface OnboardingStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  /** Set when status === 'failed'. Truncated to ~300 chars to keep the
   *  progress payload small. Safe to surface in Sokosumi's UI verbatim. */
  errorMessage?: string;
}

export interface OnboardOptions {
  /** "deep" uses connected MCPs for inbox-scan; "light" only does web research. */
  researchDepth?: 'light' | 'deep';
}

/**
 * Phase 2 of provision: user has clicked "Let's go" on the onboarding screen.
 *
 * Steps tracked in HermesInstance.onboardingSteps so Sokosumi can poll
 * GET /v1/instances/:userId/onboarding for live progress:
 *   1. memory       — boot prompt (memory write + daily cron registration)
 *   2. inbox_scan   — read connected MCPs (Gmail/Outlook inbox + calendar)
 *   3. web_research — public-web pass on name/email
 *   4. intro_draft  — assemble + push research-intro to outbox
 *
 * inbox_scan + web_research run sequentially (single Hermes turn each) so
 * the progress UI feels alive. Once intro_draft pushes the outbox message,
 * status flips to "ready" and onboardedAt is set.
 */
export async function runOnboarding(
  instanceId: string,
  opts: OnboardOptions = {},
): Promise<void> {
  const row = await prisma.hermesInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const log = logger.child({ instanceId, userId: row.userId, fn: 'onboarding' });
  if (!row.endpointUrl) {
    log.warn('no endpointUrl yet — skipping onboarding');
    return;
  }
  const apiKey = await decryptSecret(row.apiServerKey);

  // Hermes' API server can take 30–60s to actually start listening after
  // the Fly machine reaches `started`. Poll until it responds before
  // sending the first boot prompt, otherwise we get 503 storms.
  await waitForHermesReady(row.endpointUrl, apiKey, log);

  const integrations = await listIntegrations(row.userId);
  const connectedProviders = integrations
    .filter((i) => i.status === 'connected' || i.status === 'connecting')
    .map((i) => i.provider);
  const researchDepth = opts.researchDepth ?? 'deep';
  const hasInbox = researchDepth === 'deep' && connectedProviders.length > 0;

  const steps: OnboardingStep[] = [
    { id: 'memory', label: 'Saving your details', status: 'pending' },
    {
      id: 'inbox_scan',
      label: hasInbox ? 'Reading your inbox' : 'Inbox not connected',
      status: hasInbox ? 'pending' : 'skipped',
    },
    { id: 'web_research', label: 'Checking your public profile', status: 'pending' },
    { id: 'intro_draft', label: 'Drafting your intro', status: 'pending' },
  ];

  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { status: 'onboarding', onboardingSteps: steps as object },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'onboarding_started',
    detail: { providers: connectedProviders, researchDepth },
  });

  // ---- 1. memory + boot prompt ----
  await markStep(instanceId, 'memory', 'running');
  try {
    await callHermes(
      row.endpointUrl,
      apiKey,
      buildBootPrompt(row.name, row.email),
      5 * 60_000,
    );
    await markStep(instanceId, 'memory', 'done');
  } catch (err) {
    log.error({ err }, 'boot_prompt_failed');
    await markStep(instanceId, 'memory', 'failed', errToMessage(err));
  }

  // ---- 2. inbox scan (only if integrations connected) ----
  let inboxSummary = '';
  if (hasInbox) {
    await markStep(instanceId, 'inbox_scan', 'running');
    try {
      inboxSummary = await callHermes(
        row.endpointUrl,
        apiKey,
        buildInboxScanPrompt(connectedProviders, row.name),
        4 * 60_000,
      );
      await markStep(instanceId, 'inbox_scan', 'done');
    } catch (err) {
      log.error({ err }, 'inbox_scan_failed');
      await markStep(instanceId, 'inbox_scan', 'failed', errToMessage(err));
    }
  }

  // ---- 3. web research ----
  let webSummary = '';
  await markStep(instanceId, 'web_research', 'running');
  try {
    webSummary = await callHermes(
      row.endpointUrl,
      apiKey,
      buildWebResearchPrompt(row.name, row.email),
      4 * 60_000,
    );
    await markStep(instanceId, 'web_research', 'done');
  } catch (err) {
    log.error({ err }, 'web_research_failed');
    await markStep(instanceId, 'web_research', 'failed', errToMessage(err));
  }

  // ---- 4. intro draft ----
  await markStep(instanceId, 'intro_draft', 'running');
  try {
    const intro = await callHermes(
      row.endpointUrl,
      apiKey,
      buildIntroDraftPrompt(row.name, row.email, inboxSummary, webSummary, connectedProviders),
      4 * 60_000,
    );
    if (intro && intro.trim().length > 30) {
      await enqueueOutboxMessage({
        instanceId: row.id,
        userId: row.userId,
        content: intro,
        kind: 'research_intro',
      });
      await markStep(instanceId, 'intro_draft', 'done');
    } else {
      // Fall back to a generic welcome — we still don't want a blank chat.
      await enqueueOutboxMessage({
        instanceId: row.id,
        userId: row.userId,
        content: fallbackWelcome(row.name),
        kind: 'welcome',
      });
      await markStep(instanceId, 'intro_draft', 'done');
    }
  } catch (err) {
    log.error({ err }, 'intro_draft_failed');
    await markStep(instanceId, 'intro_draft', 'failed', errToMessage(err));
    await enqueueOutboxMessage({
      instanceId: row.id,
      userId: row.userId,
      content: fallbackWelcome(row.name),
      kind: 'welcome',
    });
  }

  // ---- finalize ----
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { status: 'ready', onboardedAt: new Date(), lastActivityAt: new Date() },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'onboarding_done',
    detail: { connectedProviders },
  });
  log.info('onboarding complete');
}

/**
 * Returning-user boot: short welcome-back message, no fresh research pass.
 * Called from runFlyPipeline when onboardedAt is already set on the row.
 */
export async function runReturningUserBoot(instanceId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const log = logger.child({ instanceId, userId: row.userId, fn: 'returning_user_boot' });
  if (!row.endpointUrl) return;
  const apiKey = await decryptSecret(row.apiServerKey);

  // Refresh memory + nudge Hermes to consult its memory before greeting.
  // We discard the response; only the outbox message below is user-visible.
  try {
    await callHermes(
      row.endpointUrl,
      apiKey,
      buildReturningBootPrompt(row.name, row.email),
      3 * 60_000,
    );
  } catch (err) {
    log.warn({ err }, 'returning_boot_prompt_failed');
  }

  await enqueueOutboxMessage({
    instanceId: row.id,
    userId: row.userId,
    content: returningWelcome(row.name),
    kind: 'welcome',
  });
  log.info('returning-user welcome pushed');
}

async function markStep(
  instanceId: string,
  id: string,
  status: OnboardingStep['status'],
  errorMessage?: string,
): Promise<void> {
  const row = await prisma.hermesInstance.findUniqueOrThrow({
    where: { id: instanceId },
    select: { onboardingSteps: true, userId: true },
  });
  const trimmed = errorMessage?.slice(0, 300);
  const steps = ((row.onboardingSteps as OnboardingStep[] | null) ?? []).map((s) =>
    s.id === id
      ? {
          ...s,
          status,
          startedAt: status === 'running' ? new Date().toISOString() : s.startedAt,
          finishedAt:
            status === 'done' || status === 'failed' || status === 'skipped'
              ? new Date().toISOString()
              : s.finishedAt,
          ...(status === 'failed' && trimmed ? { errorMessage: trimmed } : {}),
        }
      : s,
  );
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { onboardingSteps: steps as object },
  });
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'onboarding_step',
    detail: { step: id, status, ...(trimmed ? { errorMessage: trimmed } : {}) },
  });
}

/**
 * Poll Hermes' API server until it responds successfully. The Fly machine
 * reaching `started` doesn't mean Python is fully up — the launcher script
 * has to run (sync skills, write .env, etc.) and `hermes gateway` has to
 * boot before the API server is listening. Usually 20–60s on a cold boot.
 *
 * Probe: a 1-token chat completion. We accept any non-5xx response as
 * "ready" — even 401/400 means the server is alive and can route requests.
 * Only 503/connection-refused/timeout count as not-ready.
 */
async function waitForHermesReady(
  endpointUrl: string,
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastErr: unknown;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'hermes-agent',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status < 500 || res.status === 501) {
        log.info({ attempt, status: res.status }, 'hermes_api_ready');
        return;
      }
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  log.warn({ lastErr, attempts: attempt }, 'hermes_api_never_became_ready_continuing_anyway');
}

async function callHermes(
  endpointUrl: string,
  apiKey: string,
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'hermes-agent',
      messages: [{ role: 'user', content: userMessage }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`callHermes ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? '';
}

// ---------- prompts ----------

function buildBootPrompt(name: string | null, email: string | null): string {
  const identityLine = name || email
    ? `The user's name is "${name ?? ''}"${email ? ` and their email is "${email}"` : ''}. Save this to your memory so you remember them next time.`
    : 'The user has not given a name yet.';

  return `Onboarding setup. This message is orchestration, not a user-visible \
chat. Your response is discarded — do not greet me.

1. **Memory** — ${identityLine}

2. **Daily-suggestions task** — schedule a cronjob firing every day at \
09:00 UTC (cron expression "0 9 * * *"). Set name to "daily-suggestions" \
and deliver to "local". Prompt content:

   <prompt>
   Review what you know about this user from your memory and recent \
   conversations. Suggest 2–3 specific actions they could take today: \
   try a new skill, install a new skill, set up a new automation, or \
   draft something they could use. Be concrete (one paragraph each, \
   include the exact prompt the user could send you).
   </prompt>

Run the cronjob.create call now. Once created, reply "ok".`;
}

function buildInboxScanPrompt(providers: string[], name: string | null): string {
  const list = providers.join(', ');
  return `Internal task — your response will be passed verbatim to the next \
step, NOT shown to the user. Do not greet, do not format as a chat reply.

Use your connected MCPs (${list}) to scan the user's recent activity. \
Specifically:

- For Gmail / Outlook (mail): read the most recent ~30 messages they have \
sent or received. Identify the 3–5 most relevant ongoing threads or topics. \
Note people they correspond with often.
- For calendar (Google / Outlook): read upcoming events for the next 14 days \
plus the last 7. Identify recurring meetings, time-blocked focus work, and \
any notable upcoming events.

Output a tight prose summary (300–500 words) in the structure:

  ## Current focus
  ...
  ## Recurring threads / people
  ...
  ## Upcoming
  ...
  ## Signals
  (anything unusual or worth surfacing — e.g., a partner thread that's gone \
   quiet, a deadline approaching, a new connection)

Be honest if a tool fails or returns nothing — don't invent. The user's \
name${name ? ` is "${name}"` : ' is unknown'}; use that as a focal point for whose mailbox you're reading.`;
}

function buildWebResearchPrompt(name: string | null, email: string | null): string {
  return `Internal task — response feeds the next step, not the user. No \
greeting, no chat framing.

Do a brief public-web pass on the user. Name: ${name ?? '(unknown)'}${email ? ` Email: ${email}` : ''}.

Use web_search to find: LinkedIn, company, public projects, recent talks / \
posts / press. 4–8 search queries max. Be honest about what you can't \
verify — do not invent.

Return a tight summary (200–400 words):

  ## Role
  ## Company / projects
  ## Public footprint
  ## Sources
  (URLs you actually opened)`;
}

function buildIntroDraftPrompt(
  name: string | null,
  email: string | null,
  inboxSummary: string,
  webSummary: string,
  providers: string[],
): string {
  const firstNameStr = name ? firstName(name) : null;
  const greeting = firstNameStr ? `Hey ${firstNameStr},` : 'Hey,';
  const connectedLine =
    providers.length > 0
      ? `Connected integrations: ${providers.join(', ')}.`
      : 'No integrations connected yet.';

  return `Write the user's first message from Hermes. The text you produce \
will be shown VERBATIM to the user as the chat-opening message — no meta, \
no "Here is the draft", no JSON. Just the message body.

Context you have:
- Name: ${name ?? '(unknown)'}, Email: ${email ?? '(unknown)'}
- ${connectedLine}

Inbox scan summary (may be empty):
"""
${inboxSummary.slice(0, 4000) || '(nothing — inbox not connected or scan failed)'}
"""

Public-web research summary (may be empty):
"""
${webSummary.slice(0, 3000) || '(nothing — no public footprint found)'}
"""

Write the message:
- Open with "${greeting}"
- 2–3 short paragraphs.
- If you have inbox context, lead with what's on their plate right now \
  (specific, concrete — name a thread, a meeting, a project). One sentence.
- 3–4 concrete suggestions for what they could ask you to do *next*, each \
  with the EXACT prompt they could paste. Pull from inbox/web context where \
  possible. Use a markdown bulleted list with bold leads.
- Close with one specific recurring task you could schedule for them \
  (cronjob) if they want.
- Tone: direct, helpful, no flattery, no "I'm your AI assistant" boilerplate.
- Address them by first name only. No sign-off, no "Best, Hermes".

Length: 150–250 words. Markdown OK.`;
}

function buildReturningBootPrompt(name: string | null, email: string | null): string {
  return `Internal — your reply is discarded. Briefly re-read your memory. \
The user${name ? ` (${name})` : ''}${email ? `, email ${email}` : ''} is \
returning for a new session. The Fly machine is fresh, so any in-flight \
state from last time is gone; only your memory file survived. Reply "ok".`;
}

function returningWelcome(name: string | null): string {
  const greeting = name ? `Hey ${firstName(name)},` : 'Hey,';
  return `${greeting}

Welcome back. Picking up where we left off — what's on your mind?`;
}

function fallbackWelcome(name: string | null): string {
  const greeting = name ? `Hey ${firstName(name)},` : 'Hey,';
  return `${greeting}

I'm Hermes — your private agent. I had trouble reading your inbox / public \
profile just now, but I'm ready to help. Tell me what you're working on and \
I'll take it from there.`;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full.trim();
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
