import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { recordEvent } from '../audit.js';
import { listIntegrations } from '../integrations/manager.js';
import { fetchWorkspaceSnapshot, SokosumiClient } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';
import { buildPersonaDirective } from './profile.js';

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

  const sokosumiEnv: SokosumiEnv | null = isValidSokosumiEnv(row.sokosumiEnv) ? row.sokosumiEnv : null;
  const sokosumiConfigured = SokosumiClient.isConfigured(sokosumiEnv, row.userId);
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
      buildBootPrompt(
        row.name,
        row.email,
        row.role,
        row.company,
        buildPersonaDirective({ personaName: row.personaName, verbosity: row.verbosity, tone: row.tone }),
      ),
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
  // First pass uses a generous 7-minute budget and the full prompt
  // (~30 messages + 21 days of calendar). If that aborts on timeout —
  // typically a slow Gmail OAuth path or a large mailbox racing the
  // outbound fetch — we retry once with a trimmed prompt (~10 messages,
  // 7 days of calendar) and a tighter 4-minute budget. Onboarding never
  // fails on inbox_scan alone; the surrounding intro_draft falls back
  // to web-only research when both attempts whiff.
  let inboxSummary = '';
  if (hasInbox && mcpsLoaded) {
    await markStep(instanceId, 'inbox_scan', 'running');
    try {
      inboxSummary = await callHermes(
        row.endpointUrl,
        apiKey,
        buildInboxScanPrompt(connectedProviders, row.name, row.role, row.company),
        7 * 60_000,
      );
      await markStep(instanceId, 'inbox_scan', 'done');
    } catch (err) {
      const wasTimeout = isAbortTimeout(err);
      log.warn(
        { err, wasTimeout },
        wasTimeout ? 'inbox_scan_timeout_retrying' : 'inbox_scan_failed_no_retry',
      );
      if (wasTimeout) {
        try {
          inboxSummary = await callHermes(
            row.endpointUrl,
            apiKey,
            buildInboxScanPromptFast(connectedProviders, row.name, row.role, row.company),
            4 * 60_000,
          );
          await markStep(instanceId, 'inbox_scan', 'done');
        } catch (retryErr) {
          log.error({ err: retryErr }, 'inbox_scan_failed_after_retry');
          await markStep(instanceId, 'inbox_scan', 'failed', errToMessage(retryErr));
        }
      } else {
        await markStep(instanceId, 'inbox_scan', 'failed', errToMessage(err));
      }
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
      buildWebResearchPrompt(row.name, row.email, row.role, row.company),
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
      const snapshot = await fetchWorkspaceSnapshot(row.userId, sokosumiEnv);
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
        row.role,
        row.company,
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
  // Sync the full set of system schedules — both the orchestrator-sweep
  // mirror rows (sokosumi-sync, inbox-refresh, urgent-interrupts,
  // task-augmentation) and the autonomy-gated recurring prompts
  // (morning-brief, weekly-wrap, etc.). Idempotent.
  try {
    const { syncSystemSchedules } = await import('../schedules/system-schedules.js');
    const integrationProviders = new Set(connectedProviders);
    const hasMailOrCalendar =
      integrationProviders.has('gmail') ||
      integrationProviders.has('outlook') ||
      integrationProviders.has('google_calendar') ||
      integrationProviders.has('outlook_calendar');
    const autonomy =
      row.autonomyLevel === 'low' || row.autonomyLevel === 'high' ? row.autonomyLevel : 'medium';
    await syncSystemSchedules({
      instanceId: row.id,
      userId: row.userId,
      autonomy: autonomy as 'low' | 'medium' | 'high',
      timezone: row.timezone ?? 'UTC',
      sokosumiConfigured,
      hasMailOrCalendar,
    });
  } catch (err) {
    log.warn({ err }, 'system_schedules_sync_failed');
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
      buildReturningBootPrompt(
        row.name,
        row.email,
        row.role,
        row.company,
        buildPersonaDirective({ personaName: row.personaName, verbosity: row.verbosity, tone: row.tone }),
      ),
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
  let clipped = capitalizeQuotedPrompts(content);
  if (Buffer.byteLength(clipped, 'utf8') > MAX_BYTES) {
    const buf = Buffer.from(clipped, 'utf8');
    clipped = buf.subarray(0, MAX_BYTES - 32).toString('utf8') + '… [truncated]';
  }
  await prisma.hermesInstance.update({
    where: { id: instanceId },
    data: { welcomeMessage: clipped, welcomeKind: kind },
  });
}

// Sokosumi UI renders quoted prompts ("...") in the welcome message as
// clickable action buttons. The model sometimes emits them lowercase,
// which looks wrong on the buttons. Uppercase the first letter of each
// quoted prompt — covers both ASCII straight quotes and curly quotes.
function capitalizeQuotedPrompts(text: string): string {
  return text.replace(/(["“])([a-z])/g, (_, q, c) => `${q}${c.toUpperCase()}`);
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

function buildBootPrompt(
  name: string | null,
  email: string | null,
  role: string | null = null,
  company: string | null = null,
  persona: string = '',
): string {
  const identityParts: string[] = [];
  if (name) identityParts.push(`their name is "${name}"`);
  if (email) identityParts.push(`their email is "${email}"`);
  if (role) identityParts.push(`their role is "${role}"`);
  if (company) identityParts.push(`they work at "${company}"`);
  const identityLine =
    identityParts.length > 0
      ? `The user identity: ${identityParts.join(', ')}. Save all of this to your memory under explicit keys (user.name, user.email, user.role, user.company) so subsequent threads can reference them without re-fetching.`
      : 'The user has not given any identity details yet.';
  // Opt-in persona block. Empty string when the user set nothing, so this
  // line vanishes and onboarding behaves exactly as before.
  const personaLine = persona ? `\n\n${persona}` : '';

  return `Onboarding setup. This message is orchestration, not a user-visible \
chat. Your response is discarded — do not greet me.

1. **Memory** — ${identityLine}${personaLine}

2. **Daily-brief task** — schedule a cronjob firing every day at \
07:00 UTC (cron expression "0 7 * * *"). Set name to "daily-brief" and \
deliver to "local". Prompt content:

   <prompt>
   Daily brief for ${name ?? 'the user'}. Pull together what's actually \
   worth their attention this morning. Use memory + your sokosumi_* and \
   mail/calendar tools as needed.

   Structure the brief like this — concise prose, no markdown headings, \
   skip any section that has nothing real to say:

   1. One-sentence overview: "Here's the shape of today: ..."
   2. Sokosumi workspace — any tasks with status changes, jobs that \
      completed overnight (call sokosumi_list_jobs with status=COMPLETED \
      to check), anything stalled or needing input. Per item, one-sentence \
      summary of the result + whether it needs the user to read/act.
   3. Mail since yesterday — highlight 2-4 threads that need their \
      attention (sender, subject, one-line gist + suggested action). \
      Use your Gmail/Outlook tools if connected.
   4. Today's calendar — only mention meetings that need prep or that \
      they might forget. Skip routine recurring blocks.
   5. One concrete next action — the single most valuable thing they \
      could do in the next hour, with the exact prompt they could send \
      you to start it.

   Tone: warm but tight. Lead with what's interesting. No corporate \
   filler ("I hope this finds you well", "as your AI assistant"). \
   Address them by first name. 200-350 words total.

   If literally nothing notable arrived (truly quiet day), say so \
   honestly in two sentences and stop. Don't pad.
   </prompt>

Run the cronjob.create call now.

3. **Register the schedule with the orchestrator** — immediately after \
the cronjob.create call succeeds, make this HTTP request so the user can \
see the schedule in their Sokosumi settings panel:

   POST \${ORCHESTRATOR_BASE}/v1/llm/\${INSTANCE_ID}/schedules
   Authorization: Bearer \${ORCHESTRATOR_OUTBOX_TOKEN}
   Content-Type: application/json
   Body: {
     "name": "daily-brief",
     "prompt": "Daily morning brief — Sokosumi changes, mail, calendar, next action.",
     "cron_expr": "0 7 * * *",
     "timezone": "UTC",
     "enabled": true
   }

These env vars are in your environment. If the request fails, the cronjob \
still runs — this is for UI visibility only.

Once both steps are done, reply "ok".`;
}

function buildInboxScanPrompt(
  providers: string[],
  name: string | null,
  role: string | null = null,
  company: string | null = null,
): string {
  const list = providers.join(', ');
  const roleLine = role ? `Role: ${role}.` : '';
  const companyLine = company ? `Company: ${company}.` : '';
  const roleWeighting = role
    ? `\n\nWeight signals by their relevance to a ${role}. For engineering \
roles, surface GitHub/Linear/Jira-style threads, technical incidents, and \
deploys first. For sales/CS roles, surface customer threads, deals, and \
support escalations. For marketing/product, surface launch threads, \
content reviews, and stakeholder communications. For founders/exec, \
surface investor updates, board threads, and strategic decisions.`
    : '';
  return `Internal task — your response will be passed verbatim to the next \
step, NOT shown to the user. Do not greet, do not format as a chat reply.

Use your connected MCPs (${list}) to scan the user's recent activity. \
${roleLine}${companyLine ? ' ' + companyLine : ''}

Specifically:
- For Gmail / Outlook (mail): read the most recent ~30 messages they have \
sent or received. Identify the 3–5 most relevant ongoing threads or topics. \
Note people they correspond with often.
- For calendar (Google / Outlook): read upcoming events for the next 14 days \
plus the last 7. Identify recurring meetings, time-blocked focus work, and \
any notable upcoming events.${roleWeighting}

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

/**
 * Retry variant: cut tool-call volume roughly in half so a sluggish
 * Gmail/Composio path or a large mailbox doesn't blow the orchestrator's
 * outbound budget twice. Same output shape so intro_draft doesn't care.
 */
function buildInboxScanPromptFast(
  providers: string[],
  name: string | null,
  role: string | null = null,
  company: string | null = null,
): string {
  const list = providers.join(', ');
  const roleLine = role ? `Role: ${role}.` : '';
  const companyLine = company ? `Company: ${company}.` : '';
  return `Internal task — your response will be passed verbatim to the next \
step, NOT shown to the user. Do not greet, do not format as a chat reply.

This is a RETRY after a previous slower scan timed out. Stay tight — \
fewer tool calls, faster summary.

Use your connected MCPs (${list}) to scan the user's recent activity. \
${roleLine}${companyLine ? ' ' + companyLine : ''}

Specifically:
- For Gmail / Outlook (mail): read at most the 10 most recent messages they \
have sent or received. Identify the 2–3 most relevant ongoing threads.
- For calendar (Google / Outlook): read upcoming events for the next 7 days. \
Note any standout meetings.

Output a tight prose summary (150–250 words) in the structure:

  ## Current focus
  ...
  ## Recurring threads / people
  ...
  ## Upcoming
  ...

Be honest if a tool fails or returns nothing — don't invent. The user's \
name${name ? ` is "${name}"` : ' is unknown'}.`;
}

/**
 * AbortSignal.timeout throws a DOMException with name === "TimeoutError"
 * (Node 20+ fetch wraps it). Anything else is a real failure that we
 * should NOT retry — retrying a 401 or a Composio 5xx just wastes time.
 */
function isAbortTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /aborted due to timeout|timed out/i.test(msg);
}

function buildWebResearchPrompt(
  name: string | null,
  email: string | null,
  role: string | null = null,
  company: string | null = null,
): string {
  const identity: string[] = [];
  if (name) identity.push(`Name: ${name}`);
  if (email) identity.push(`Email: ${email}`);
  if (role) identity.push(`Role: ${role}`);
  if (company) identity.push(`Company: ${company}`);
  const idLine = identity.length > 0 ? identity.join('. ') + '.' : '(no identity given)';

  const companyBias = company
    ? `\n\nThe user told us they work at "${company}" — prioritise the public \
research pass on that company's official site, recent news/press about it, \
their funding/positioning, and their public team. That context shapes \
everything else you'll do for this user.`
    : '';

  return `Internal task — response feeds the next step, not the user. No \
greeting, no chat framing.

Do a brief public-web pass on the user. ${idLine}${companyBias}

Use web_search to find: LinkedIn, the company's public footprint, public \
projects the user is associated with, recent talks / posts / press. 4–8 \
search queries max. Be honest about what you can't verify — do not invent.

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
  role: string | null = null,
  company: string | null = null,
): string {
  const firstNameStr = name ? firstName(name) : null;
  const greeting = firstNameStr ? `Hey ${firstNameStr},` : 'Hey,';
  const integrationsLine =
    providers.length > 0
      ? `Connected: ${providers.join(', ')}.`
      : 'No mail/calendar integrations connected.';
  const roleCompanyLine =
    role || company
      ? `Role: ${role ?? '(unknown)'}, Company: ${company ?? '(unknown)'}.`
      : '';
  const groundingHint =
    role || company
      ? `\nGROUND THE OPENER: when role/company are set, weave them into the \
opening sentence naturally — e.g. "Hi ${firstNameStr ?? 'there'} — I had a look at \
${company ?? 'your company'} and your ${role ?? 'work'} inbox. Here's what I \
think matters this week." Don't force it if it'd feel awkward, but use \
this context to make the welcome feel personal, not generic.`
      : '';

  return `Write the user's first message from Hermes. Shown VERBATIM as \
Hermes' opening turn — no meta, no JSON, no "here's the draft".

THE AGENT'S PRIMARY JOB: help the user manage their Sokosumi workspace \
(open tasks, agent jobs, results). Everything else (mail, calendar, web \
research) is supporting context. This framing matters for the message.${groundingHint}

Context:
- Name: ${name ?? '(unknown)'}, Email: ${email ?? '(unknown)'}
${roleCompanyLine ? '- ' + roleCompanyLine + '\n' : ''}- ${integrationsLine}

SOKOSUMI WORKSPACE (primary context):
"""
${sokosumiSummary.slice(0, 5000) || '(empty — user has no workspace data yet)'}
"""

Inbox scan:
"""
${inboxSummary.slice(0, 3000) || '(none)'}
"""

Public-web research:
"""
${webSummary.slice(0, 2000) || '(none)'}
"""

STRUCTURE — exactly this, in this order:

1. **Greeting + 1-sentence role** (2 short sentences total).
   Open with "${greeting}". One line: you are Hermes — their private agent \
   for managing Sokosumi work. Dedicated VM, persistent memory across \
   sessions. That's it. No "I'm not a chatbot" / "I don't just answer \
   questions" — assume they know.

2. **What's in their Sokosumi workspace right now** (1 short paragraph).
   MANDATORY if the workspace has any tasks or jobs. Lead with their open \
   tasks (names + status). Mention 1–2 recent completed jobs with what the \
   result actually contains (you have ~1800-char excerpts above — quote or \
   paraphrase the substance, not just the title). If workspace is empty, \
   say so in one honest sentence and skip ahead.

3. **What else you've noticed** (1 short paragraph, OPTIONAL).
   Mail threads, calendar items, public profile — only if something is \
   genuinely worth surfacing. If nothing notable, SKIP THIS SECTION \
   ENTIRELY. Don't pad.

4. **What you can do** (3–4 markdown bullets, bold lead + the exact \
   prompt in quotes).
   At least ONE bullet must be a Sokosumi action: fetch a job result, \
   summarize a completed task, run a new job, organize their workspace. \
   You have live tools — sokosumi_get_job returns full results, \
   sokosumi_list_tasks filters by status, etc. Other bullets can cover \
   drafting / research / scheduling.
   CASING — strict: every quoted prompt MUST start with a capital letter \
   (sentence case). The Sokosumi UI renders these quoted strings as \
   clickable action buttons, and lowercase looks wrong. Example: \
   "Pull up Hannah's report and summarize the top 3 risks" — NOT \
   "pull up hannah's report…". Same rule applies to the quoted prompt \
   in section 5.

5. **One recurring task to schedule** (1 sentence + exact prompt, \
   sentence case — same rule as section 4).
   Tied to their actual context. Skip if nothing fits.

6. **Open close** (1 short sentence). "Or tell me what's on your mind."

OBVIOUS ADAMS RULES — strict:
- Lead with the answer. No "you might want to consider…" / "perhaps it \
  could be helpful…" Just say the thing.
- Plain words: "use" not "utilize", "help" not "facilitate", "about" not \
  "regarding".
- No flattery. No "I see you're working on impressive things". No \
  AI-assistant filler.
- If a section has no real content to put in it, SKIP IT. Don't pad.
- The simple answer is usually right. Don't dress it up.

LENGTH: 180–280 words total. Tight. If you can say it in 200, say it in 200.

Address by first name only. No sign-off. Markdown only in the capability bullets.`;
}

function buildReturningBootPrompt(
  name: string | null,
  email: string | null,
  role: string | null = null,
  company: string | null = null,
  persona: string = '',
): string {
  const idParts: string[] = [];
  if (name) idParts.push(name);
  if (email) idParts.push(`email ${email}`);
  if (role) idParts.push(`role: ${role}`);
  if (company) idParts.push(`at ${company}`);
  const idLine = idParts.length > 0 ? ` (${idParts.join(', ')})` : '';
  // Re-assert persona on every fresh machine so it survives the volume
  // wipe between sessions. Empty when unset → no behavior change.
  const personaLine = persona ? `\n\n${persona}` : '';
  return `Internal — your reply is discarded. Briefly re-read your memory. \
The user${idLine} is returning for a new session. The Fly machine is fresh, \
so any in-flight state from last time is gone; only your memory file \
survived.${personaLine} Reply "ok".`;
}

function returningWelcome(name: string | null): string {
  const greeting = name ? `Hey ${firstName(name)},` : 'Hey,';
  return `${greeting}

Welcome back. Picking up where we left off — what's on your mind?`;
}

function fallbackWelcome(name: string | null): string {
  const greeting = name ? `Hey ${firstName(name)},` : 'Hey,';
  return `${greeting}

I'm Hermes — your private agent for managing Sokosumi work. Dedicated VM, \
persistent memory across sessions. Couldn't pull personalized context for \
this intro, but I'm online and ready.

A few things I can do:

- **Manage your Sokosumi workspace** — fetch the full result of any \
  completed job, summarize a task, kick off a new agent job. Try: \
  "List my open Sokosumi tasks."
- **Draft and research** — emails, briefs, competitive landscapes. Tell \
  me once what tone or angle and I'll keep it.
- **Schedule recurring work** — daily briefs, weekly digests, anything \
  cron-shaped. Try: "Set up a Monday morning digest of my Sokosumi job \
  completions."
- **Use connected tools** — Gmail, Outlook, Calendar etc. once you wire \
  them up, I can read, draft, and act inside them.

What's on your plate?`;
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
    coworkers: unknown[];
  }>;
  credits: unknown | null;
  agents: unknown[];
  fetchedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`Fetched at: ${snapshot.fetchedAt}`);
  lines.push(`Organizations: ${snapshot.organizations.length}`);
  lines.push('');

  // Track which agents the user has actually used so we can prioritize
  // them in the agent catalog section (and prune the noise).
  const usedAgentIds = new Set<string>();

  for (const ws of snapshot.organizations) {
    const orgLabel = `${ws.organization.name ?? ws.organization.slug ?? '(unnamed)'} (id=${ws.organization.id})`;
    lines.push(`# Org: ${orgLabel}`);
    lines.push('');

    // ---- COWORKERS: who can actually do tasks in this org. Hermes
    // assigns work to these (not to itself).
    if (Array.isArray(ws.coworkers) && ws.coworkers.length > 0) {
      lines.push(`## Coworkers in this org (${ws.coworkers.length})`);
      lines.push('These are the workers Hermes can assign tasks to. Hermes is one of them — but should NEVER assign tasks to itself; Hermes is the coordinator, not the executor.');
      for (const c of ws.coworkers as Array<{
        id?: string;
        slug?: string;
        name?: string;
        caption?: string | null;
        description?: string | null;
        capabilities?: string[];
      }>) {
        const capabilities = (c.capabilities ?? []).join(',') || 'unknown';
        const caption = c.caption ?? '';
        const desc = (c.description ?? '').slice(0, 200).replace(/\s+/g, ' ');
        lines.push(`- id=${c.id ?? '?'} slug=${c.slug ?? '?'} name="${c.name ?? '?'}" caps=${capabilities}`);
        if (caption) lines.push(`  caption: ${caption}`);
        if (desc) lines.push(`  about: ${desc}${(c.description ?? '').length > 200 ? '…' : ''}`);
      }
      lines.push('');
    }

    // ---- TASKS: now enriched with description + events from GET /tasks/{id}
    lines.push(`## Tasks (${ws.tasks.length})`);
    lines.push('');
    for (const t of ws.tasks.slice(0, 15) as Array<{
      id?: string;
      name?: string;
      status?: string;
      description?: string | null;
      credits?: number;
      events?: Array<{ createdAt?: string; comment?: string | null; status?: string | null }>;
      jobs?: Array<{ id?: string; name?: string; status?: string; agentId?: string }>;
      coworker?: { name?: string };
    }>) {
      lines.push(`### [${t.status ?? '?'}] ${t.name ?? '(unnamed)'}`);
      if (t.id) lines.push(`id: ${t.id}`);
      if (t.description) {
        const desc = t.description.slice(0, 600).replace(/\s+/g, ' ');
        lines.push(`description: ${desc}${t.description.length > 600 ? '…' : ''}`);
      }
      if (t.coworker?.name) lines.push(`coworker: ${t.coworker.name}`);
      if (Array.isArray(t.jobs) && t.jobs.length > 0) {
        lines.push(`jobs (${t.jobs.length}):`);
        for (const j of t.jobs.slice(0, 5)) {
          lines.push(`  - [${j.status ?? '?'}] ${j.name ?? '(unnamed)'} (agent=${j.agentId ?? '?'})`);
          if (j.agentId) usedAgentIds.add(j.agentId);
        }
      }
      if (Array.isArray(t.events) && t.events.length > 0) {
        const recent = t.events.slice(-3).reverse();
        lines.push(`recent events:`);
        for (const e of recent) {
          const c = (e.comment ?? '').slice(0, 120).replace(/\s+/g, ' ');
          lines.push(`  - ${e.createdAt ?? '?'} [${e.status ?? '?'}]${c ? ` "${c}"` : ''}`);
        }
      }
      lines.push('');
    }

    // ---- COMPLETED JOBS: bumped result snippet 400 → 1800 chars (key fix)
    lines.push(`## Completed jobs (${ws.completedJobs.length})`);
    lines.push('');
    for (const j of ws.completedJobs.slice(0, 8) as Array<{
      id?: string;
      name?: string;
      agentId?: string;
      completedAt?: string;
      result?: string;
    }>) {
      lines.push(`### ${j.name ?? '(unnamed)'}`);
      lines.push(`agent: ${j.agentId ?? '?'}  |  completed: ${j.completedAt ?? '?'}  |  id: ${j.id ?? '?'}`);
      if (j.agentId) usedAgentIds.add(j.agentId);
      const result = (j.result ?? '').slice(0, 1800).replace(/\s+/g, ' ');
      if (result) {
        lines.push(`result:`);
        lines.push(`> ${result}${(j.result ?? '').length > 1800 ? '… [truncated, full text via sokosumi_get_job]' : ''}`);
      }
      lines.push('');
    }

    if (ws.conversations.length > 0) {
      lines.push(`## Recent conversations (${ws.conversations.length})`);
      for (const c of ws.conversations.slice(0, 5) as Array<{
        id?: string;
        title?: string | null;
        metadata?: { coworker?: string; useCase?: string };
      }>) {
        const meta: string[] = [];
        if (c.metadata?.coworker) meta.push(`with ${c.metadata.coworker}`);
        if (c.metadata?.useCase) meta.push(c.metadata.useCase);
        lines.push(`- ${c.title ?? '(untitled)'}${meta.length ? ` (${meta.join(', ')})` : ''}`);
      }
      lines.push('');
    }
  }

  if (snapshot.credits) {
    const cr = snapshot.credits as { balance?: number; currency?: string };
    lines.push(`## Credits (user-level): ${cr.balance ?? '?'} ${cr.currency ?? ''}`);
    lines.push('');
  }

  // ---- AGENTS: the full marketplace catalog Hermes can reach for. We
  // surface up to 40 (used-first) with the agent id so Hermes can call
  // sokosumi_get_agent_input_schema for price + input schema when picking
  // one. Without this list in memory the agent only knows about agents
  // it has previously seen used; with it, it can proactively suggest
  // "this looks like a job for X" without a live MCP roundtrip.
  if (snapshot.agents.length > 0) {
    const allAgents = snapshot.agents as Array<{ id?: string; name?: string; summary?: string }>;
    const usedFirst = allAgents.filter((a) => a.id && usedAgentIds.has(a.id));
    const rest = allAgents.filter((a) => !a.id || !usedAgentIds.has(a.id));
    const top = [...usedFirst, ...rest].slice(0, 40);
    lines.push(
      `## Agent catalog (showing ${top.length} of ${allAgents.length}, used ones first)`,
    );
    lines.push(
      'These are the marketplace agents available to run jobs. Pick one by capability + cost fit. Call sokosumi_get_agent_input_schema with the agent id to learn the exact inputs and credit price before sokosumi_create_job.',
    );
    for (const a of top) {
      const used = a.id && usedAgentIds.has(a.id) ? ' [USED]' : '';
      const summary = (a.summary ?? '').slice(0, 240).replace(/\s+/g, ' ');
      lines.push(`- ${a.name ?? '(unnamed)'}${used} (id=${a.id ?? '?'}): ${summary}`);
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
