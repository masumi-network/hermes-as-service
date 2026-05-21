import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { listIntegrations } from '../integrations/manager.js';
import { fetchWorkspaceSnapshot, SokosumiClient } from '../sokosumi/client.js';

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

  const sokosumiConfigured = SokosumiClient.isConfigured();
  const steps: OnboardingStep[] = [
    { id: 'memory', label: 'Saving your details', status: 'pending' },
    ...(connectedProviders.length > 0
      ? [{ id: 'verify_mcps', label: 'Connecting to your integrations', status: 'pending' as const }]
      : []),
    {
      id: 'inbox_scan',
      label: hasInbox ? 'Reading your inbox' : 'Inbox not connected',
      status: hasInbox ? 'pending' : 'skipped',
    },
    { id: 'web_research', label: 'Checking your public profile', status: 'pending' },
    ...(sokosumiConfigured
      ? [{ id: 'sokosumi_sync', label: 'Reading your Sokosumi workspace', status: 'pending' as const }]
      : []),
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

  // ---- 1.5 verify MCPs are loaded ----
  // Hermes' API server becoming reachable doesn't mean its MCP client has
  // actually registered the Composio tools yet — the gateway daemon loads
  // MCPs async, can take 10–60s after gateway boot. If we run inbox_scan
  // before that, Hermes correctly reports "I don't have Gmail" and the
  // generated welcome reflects a state the user wouldn't expect.
  //
  // Probe Hermes with a short structured prompt; retry until it confirms
  // tool access or we time out (~90s). If we time out, skip the inbox
  // scan and degrade to web-only — the intro_draft prompt will know.
  let mcpsLoaded = true;
  if (connectedProviders.length > 0) {
    await markStep(instanceId, 'verify_mcps', 'running');
    const result = await verifyMcpsReady(row.endpointUrl, apiKey, connectedProviders, log);
    if (result.ready) {
      await markStep(instanceId, 'verify_mcps', 'done');
    } else {
      mcpsLoaded = false;
      await markStep(
        instanceId,
        'verify_mcps',
        'failed',
        `Integrations didn't come online within 90s: ${result.missing.join(', ')}`,
      );
    }
  }

  // ---- 2. inbox scan (only if integrations connected AND MCPs loaded) ----
  let inboxSummary = '';
  if (hasInbox && mcpsLoaded) {
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
  } else if (hasInbox && !mcpsLoaded) {
    // Mark the inbox_scan step as skipped so the loader UI shows
    // a sensible state (instead of stuck on "pending").
    await markStep(instanceId, 'inbox_scan', 'skipped');
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

  // ---- 3b. Sokosumi workspace sync (only if API key configured) ----
  // Pulls the user's tasks, completed jobs, conversations, credits, and
  // agent catalog into Hermes' memory. Lets the intro mention real
  // workspace state ("you have 3 open tasks", "your last completed job
  // returned …") instead of generic capability ads.
  let sokosumiSummary = '';
  if (sokosumiConfigured) {
    await markStep(instanceId, 'sokosumi_sync', 'running');
    try {
      const snapshot = await fetchWorkspaceSnapshot(row.userId);
      if (snapshot) {
        sokosumiSummary = formatSokosumiSnapshotForMemory(snapshot);
        // Push as a silent memory-write to Hermes so the agent's persistent
        // memory file picks it up. Hermes responds with "ok"; we discard.
        try {
          await callHermes(
            row.endpointUrl,
            apiKey,
            buildSokosumiMemoryPrompt(sokosumiSummary),
            5 * 60_000,
          );
        } catch (err) {
          log.warn({ err }, 'sokosumi_memory_write_failed');
        }
        await prisma.hermesInstance.update({
          where: { id: instanceId },
          data: { lastSokosumiSyncAt: new Date() },
        });
        await markStep(instanceId, 'sokosumi_sync', 'done');
      } else {
        await markStep(instanceId, 'sokosumi_sync', 'skipped');
      }
    } catch (err) {
      log.error({ err }, 'sokosumi_sync_failed');
      await markStep(instanceId, 'sokosumi_sync', 'failed', errToMessage(err));
    }
  }

  // ---- 4. intro draft ----
  // Only claim integration access if we actually verified MCPs loaded.
  // Otherwise the welcome message would tell the user "your Gmail is
  // connected" while the agent secretly can't see it.
  const introProviders = mcpsLoaded ? connectedProviders : [];
  await markStep(instanceId, 'intro_draft', 'running');
  try {
    const intro = await callHermes(
      row.endpointUrl,
      apiKey,
      buildIntroDraftPrompt(
        row.name,
        row.email,
        inboxSummary,
        webSummary,
        sokosumiSummary,
        introProviders,
      ),
      4 * 60_000,
    );
    if (intro && intro.trim().length > 30) {
      await setWelcomeMessage(instanceId, intro, 'research_intro');
      await markStep(instanceId, 'intro_draft', 'done');
    } else {
      // Fall back to a generic welcome — we still don't want a blank chat.
      await setWelcomeMessage(instanceId, fallbackWelcome(row.name), 'welcome');
      await markStep(instanceId, 'intro_draft', 'done');
    }
  } catch (err) {
    log.error({ err }, 'intro_draft_failed');
    await markStep(instanceId, 'intro_draft', 'failed', errToMessage(err));
    await setWelcomeMessage(instanceId, fallbackWelcome(row.name), 'welcome');
  }

  // ---- finalize ----
  // System-managed scheduled task entry for the daily Sokosumi-workspace
  // refresh. Idempotent — created once per user, never recreated. Surfaced
  // via GET /v1/instances/:userId/schedules so Sokosumi's settings panel
  // can render it alongside any user-scheduled tasks.
  if (sokosumiConfigured) {
    const nextRunAt = new Date(Date.now() + 24 * 60 * 60_000);
    try {
      await prisma.scheduledTask.upsert({
        where: { id: `system-sokosumi-sync-${row.id}` },
        create: {
          id: `system-sokosumi-sync-${row.id}`,
          instanceId: row.id,
          userId: row.userId,
          name: 'sokosumi-sync',
          prompt: '[orchestrator] Daily refresh of Sokosumi workspace state (tasks, completed jobs, conversations, credits) into Hermes memory.',
          cronExpr: '0 9 * * *',
          timezone: 'UTC',
          enabled: true,
          nextRunAt,
        },
        update: { enabled: true },
      });
    } catch (err) {
      log.warn({ err }, 'sokosumi_schedule_upsert_failed');
    }
  }

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

  await setWelcomeMessage(row.id, returningWelcome(row.name), 'returning');
  log.info('returning-user welcome set');
}

/**
 * Persist the one-shot welcome on the HermesInstance row. Replaces the
 * old "enqueue to outbox with kind=welcome|research_intro" pattern —
 * Sokosumi now reads this inline from GET /v1/instances/:userId, no
 * polling race between status=ready and inbox drain.
 *
 * Clipped to 32 KB to match the old outbox cap, though research_intro
 * outputs are typically <2 KB.
 */
async function setWelcomeMessage(
  instanceId: string,
  content: string,
  kind: 'research_intro' | 'welcome' | 'returning',
): Promise<void> {
  const MAX_BYTES = 32 * 1024;
  let clipped = content;
  if (Buffer.byteLength(clipped, 'utf8') > MAX_BYTES) {
    const buf = Buffer.from(clipped, 'utf8');
    clipped = buf.subarray(0, MAX_BYTES - 32).toString('utf8') + '… [truncated]';
  }
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { welcomeMessage: clipped, welcomeKind: kind },
  });
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

/**
 * Probe Hermes to confirm it has registered the MCP tools for the user's
 * connected integrations. The gateway daemon registers MCPs async after
 * the API server starts listening, so /v1/chat/completions can 200 while
 * the tools still aren't usable.
 *
 * We ask Hermes a structured yes/no — single token expected — and retry
 * with a short interval. ~90s budget; if we don't get confirmation, the
 * caller falls back to a non-MCP onboarding path (web-only research).
 *
 * Returns { ready: true } on success, or { ready: false, missing } on
 * timeout. `missing` is the list of providers we asked about — we don't
 * know which specifically didn't load, just that the probe never
 * succeeded.
 */
async function verifyMcpsReady(
  endpointUrl: string,
  apiKey: string,
  providers: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any,
): Promise<{ ready: boolean; missing: string[] }> {
  const tools = providers.map(providerToolLabel).join(', ');
  const probe = `INTERNAL READINESS CHECK — your reply will not be shown to \
the user. Reply with ONLY the single uppercase word READY if you currently \
have working tool access to all of: ${tools}. If any are missing or \
your MCP client hasn't connected to them yet, reply with ONLY the single \
uppercase word NOTREADY. No other text, no markdown, no explanation.`;

  const deadline = Date.now() + 90_000;
  let attempt = 0;
  let lastReply = '';
  while (Date.now() < deadline) {
    attempt++;
    try {
      const reply = await callHermes(endpointUrl, apiKey, probe, 30_000);
      lastReply = reply.trim();
      if (/^READY$/i.test(lastReply)) {
        log.info({ attempt }, 'mcps_ready');
        return { ready: true, missing: [] };
      }
      log.info({ attempt, reply: lastReply.slice(0, 80) }, 'mcps_not_ready_yet');
    } catch (err) {
      log.warn({ err, attempt }, 'mcp_probe_failed');
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  log.warn({ attempts: attempt, lastReply: lastReply.slice(0, 120) }, 'mcps_never_became_ready');
  return { ready: false, missing: providers };
}

function providerToolLabel(provider: string): string {
  switch (provider) {
    case 'gmail':
      return 'Gmail';
    case 'google_calendar':
      return 'Google Calendar';
    case 'outlook':
      return 'Outlook mail';
    case 'outlook_calendar':
      return 'Outlook Calendar';
    case 'slack':
      return 'Slack';
    case 'linear':
      return 'Linear';
    case 'github':
      return 'GitHub';
    case 'notion':
      return 'Notion';
    case 'hubspot':
      return 'HubSpot';
    case 'twitter':
      return 'X (Twitter)';
    default:
      return provider;
  }
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
  sokosumiSummary: string,
  providers: string[],
): string {
  const firstNameStr = name ? firstName(name) : null;
  const greeting = firstNameStr ? `Hey ${firstNameStr},` : 'Hey,';
  const integrationsLine =
    providers.length > 0
      ? `You have direct access to: ${providers.join(', ')}.`
      : 'No integrations are connected yet.';

  return `Write the user's first message from Hermes — the chat-opening \
welcome they see the moment their personal agent comes online. The text \
you produce will be shown VERBATIM as Hermes' opening turn. No meta, no \
"here is the draft", no JSON. Just the message body itself.

Context you have:
- Name: ${name ?? '(unknown)'}, Email: ${email ?? '(unknown)'}
- ${integrationsLine}

Inbox scan summary (may be empty):
"""
${inboxSummary.slice(0, 4000) || '(nothing — inbox not connected or scan failed)'}
"""

Public-web research summary (may be empty):
"""
${webSummary.slice(0, 3000) || '(nothing — no public footprint found)'}
"""

Sokosumi workspace snapshot (may be empty — open tasks, completed jobs, \
recent conversations, credit balance, agents the user has access to):
"""
${sokosumiSummary.slice(0, 5000) || '(no Sokosumi workspace data available)'}
"""

STRUCTURE — follow this exact order. Write the sections as natural prose \
paragraphs (no section headings in the output), with the capability list \
as the only bulleted block.

1. **Greeting + who you are** (2–3 sentences, prose).
   Open with "${greeting}". Introduce yourself: you are Hermes, the user's \
   *private* agent — not a shared chatbot. You run on a dedicated microVM \
   that belongs only to them, 24/7, with persistent memory that carries \
   across sessions. Mention the integrations they've connected (Gmail / \
   Outlook / Calendar / etc., only those actually in the list above). One \
   short line on what makes you different: you don't just answer, you do \
   things — draft and send mail, schedule recurring tasks, run research \
   while they sleep.

2. **What you've picked up about them** (1 short paragraph, prose).
   Synthesize 3–5 specific things you learned from the inbox, web research, \
   AND their Sokosumi workspace. The workspace data is the highest-signal \
   source — reference open tasks they're working on, recent completed jobs \
   (and what those jobs returned, if interesting), agents they use often, \
   how many credits they have. Name actual people, projects, events, \
   deadlines you spotted. This isn't a status report — it's how you show \
   them you actually *get* their world, so they'll trust you with real \
   work. If all three sources are empty, keep this honest and brief: "I \
   don't know much about you yet — tell me what you do and I'll remember \
   it across every future session." Do NOT invent facts.

3. **What you can do, grounded in their context** (markdown bullet list, \
   3–4 items).
   Each bullet: a bold capability lead, then ONE specific example using \
   something concrete you actually learned about them. Include the exact \
   prompt they could paste in quotes. Avoid generic capabilities — every \
   bullet should reference a real person, project, deadline, or thread from \
   their context. Cover a mix: drafting/writing, research, automating with \
   their tools, scheduled tasks.

4. **One recurring task worth scheduling** (1–2 sentences, prose).
   Pick ONE cronjob that would genuinely help THIS user — tied to their \
   actual projects/people, not a generic morning brief. End with the exact \
   phrase they should send to set it up.

5. **Open close** (1 sentence).
   Invite them to just talk: "Or tell me what's actually on your mind and \
   we'll go from there."

CONSTRAINTS:
- Length: 280–450 words. Don't pad; don't repeat yourself between sections.
- Tone: warm but direct. Confident, not deferential. No flattery, no \
  AI-assistant boilerplate ("I'm here to help with whatever you need"), no \
  apologies, no hedging.
- Address them by first name only. No sign-off, no "— Hermes".
- Markdown OK for the capability bullets. Everything else is prose.
- If the inbox/web summaries are empty, the bullets are allowed to be more \
  generic, but stay warm and concrete — never pretend to know things you \
  don't.
- Only reference integrations actually in the connected list above; never \
  claim Gmail access if Gmail isn't in that list.`;
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

I'm Hermes — your *private* agent. Not a chatbot, not a shared assistant. \
I run on a microVM that belongs only to you, 24/7, with persistent memory \
that carries across every session. Anything you tell me, I'll remember next \
time we talk.

I couldn't pull together a personalized intro just now — the research pass \
didn't complete. But I'm fully online and ready to go. A few things I'm \
genuinely good at:

- **Drafting and writing** — emails, outreach, copy, briefs. Tell me the \
  context once and I'll get the tone right going forward.
- **Research with depth** — give me a topic and I'll dig through the web, \
  pull sources, and come back with a synthesis instead of a list of links.
- **Scheduled tasks** — anything recurring (a Monday digest, a weekly \
  competitor check, a daily 9am brief on a topic) I can run in the \
  background and ping you with the result.
- **Tool use** — once you connect Gmail / Outlook / Calendar etc., I can \
  read, draft, schedule, and act inside them on your behalf.

Tell me what you're actually working on right now, or what you wish you had \
an extra pair of hands for, and we'll go from there.`;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full.trim();
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Render the Sokosumi workspace snapshot as a compact text block suitable
 * for both (a) writing into Hermes' memory file and (b) including in the
 * intro_draft prompt as additional context.
 *
 * We keep this lightly structured rather than fully prose-summarized to
 * avoid wasting tokens on a prefix LLM call — Hermes itself will distill
 * what matters when it writes memory.
 */
function formatSokosumiSnapshotForMemory(snapshot: {
  organizations: Array<{
    organization: { id: string; name?: string; slug?: string };
    tasks: unknown[];
    completedJobs: unknown[];
    conversations: unknown[];
  }>;
  credits: unknown | null;
  agents: unknown[];
  fetchedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`Fetched at: ${snapshot.fetchedAt}`);
  lines.push(`Organizations: ${snapshot.organizations.length}`);
  lines.push('');

  for (const ws of snapshot.organizations) {
    const orgLabel = `${ws.organization.name ?? ws.organization.slug ?? '(unnamed)'} (id=${ws.organization.id})`;
    lines.push(`# Org: ${orgLabel}`);
    lines.push('');

    lines.push(`## Tasks (${ws.tasks.length})`);
    for (const t of ws.tasks.slice(0, 20) as Array<{
      id?: string;
      name?: string;
      status?: string;
      createdAt?: string;
    }>) {
      lines.push(`- [${t.status ?? '?'}] ${t.name ?? '(unnamed)'} (id=${t.id ?? '?'})`);
    }
    lines.push('');

    lines.push(`## Completed jobs (${ws.completedJobs.length})`);
    for (const j of ws.completedJobs.slice(0, 10) as Array<{
      id?: string;
      name?: string;
      agentId?: string;
      completedAt?: string;
      result?: string;
    }>) {
      const resultSnippet = (j.result ?? '').slice(0, 400).replace(/\s+/g, ' ');
      lines.push(`- ${j.name ?? '(unnamed)'} (agent=${j.agentId ?? '?'}, ${j.completedAt ?? '?'})`);
      if (resultSnippet) {
        lines.push(`  → ${resultSnippet}${(j.result ?? '').length > 400 ? '…' : ''}`);
      }
    }
    lines.push('');

    lines.push(`## Recent conversations (${ws.conversations.length})`);
    for (const c of ws.conversations.slice(0, 5) as Array<{
      id?: string;
      title?: string | null;
      metadata?: { coworker?: string };
    }>) {
      lines.push(
        `- ${c.title ?? '(untitled)'}${c.metadata?.coworker ? ` with ${c.metadata.coworker}` : ''}`,
      );
    }
    lines.push('');
  }

  if (snapshot.credits) {
    const cr = snapshot.credits as { balance?: number; currency?: string };
    lines.push(`## Credits (user-level, all orgs): ${cr.balance ?? '?'} ${cr.currency ?? ''}`);
  }
  if (snapshot.agents.length > 0) {
    lines.push('');
    lines.push(`## Agents available (global, ${snapshot.agents.length})`);
    for (const a of snapshot.agents.slice(0, 20) as Array<{
      id?: string;
      name?: string;
      summary?: string;
    }>) {
      lines.push(`- ${a.name ?? '(unnamed)'}: ${a.summary?.slice(0, 100) ?? ''}`);
    }
  }
  return lines.join('\n');
}

function buildSokosumiMemoryPrompt(summary: string): string {
  return `Internal task — your reply is discarded and not user-visible.

I'm syncing your user's Sokosumi workspace state into your memory. Read
the snapshot below carefully and use your memory tool to save the
high-signal facts: what the user is currently working on (open tasks),
what agents they've used recently, anything notable from completed job
results, and the credit balance.

This snapshot will be refreshed daily; treat it as your view of the user's
current state, not a one-time read.

<snapshot>
${summary}
</snapshot>

Once you've written the relevant facts to memory, reply with just "ok".`;
}
