import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { enqueueOutboxMessage } from '../outbox/enqueue.js';
import { recordEvent } from '../audit.js';

/**
 * Drives the post-provision onboarding:
 *   1. Welcome message → outbox (immediate)
 *   2. Boot prompt → Hermes (memory write + daily-suggestions cron registration)
 *   3. Research prompt → Hermes, response captured + pushed to outbox as
 *      kind="research_intro" (synchronous, so result is guaranteed to land
 *      regardless of how soon Sokosumi destroys the instance afterward)
 *
 * Called async from the provision pipeline after the machine reaches
 * `started` + Hermes' API server is responsive.
 */
export async function runOnboarding(instanceId: string): Promise<void> {
  const row = await prisma.hermesInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const log = logger.child({ instanceId, userId: row.userId, fn: 'onboarding' });
  const apiKey = await decryptSecret(row.apiServerKey);
  if (!row.endpointUrl) {
    log.warn('no endpointUrl yet — skipping onboarding');
    return;
  }

  // ---- 1. Welcome message ----
  const welcome = welcomeMessage(row.name, row.email);
  await enqueueOutboxMessage({
    instanceId: row.id,
    userId: row.userId,
    content: welcome,
    kind: 'welcome',
  }).catch((err) => log.warn({ err }, 'welcome_enqueue_failed'));
  await recordEvent({
    userId: row.userId,
    instanceId,
    event: 'chat_proxied',
    detail: { source: 'onboarding_welcome' },
  });

  // ---- 2. Boot prompt (memory + daily cron) ----
  const bootPrompt = buildBootPrompt(row.name, row.email);
  try {
    await callHermes(row.endpointUrl, apiKey, bootPrompt, 5 * 60_000);
    log.info('boot prompt sent');
  } catch (err) {
    log.error({ err }, 'boot_prompt_failed');
  }

  // ---- 3. Research-intro (synchronous, only if we have name or email) ----
  if (!row.name && !row.email) return;

  const researchPrompt = buildResearchPrompt(row.name, row.email);
  try {
    const text = await callHermes(row.endpointUrl, apiKey, researchPrompt, 6 * 60_000);
    if (text && text.trim().length > 30) {
      await enqueueOutboxMessage({
        instanceId: row.id,
        userId: row.userId,
        content: text,
        kind: 'research_intro',
      });
      await recordEvent({
        userId: row.userId,
        instanceId,
        event: 'chat_proxied',
        detail: { source: 'onboarding_research' },
      });
      log.info('research-intro delivered to outbox');
    } else {
      log.warn({ length: text?.length }, 'research-intro response too short, skipping');
    }
  } catch (err) {
    log.error({ err }, 'research_prompt_failed');
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

function welcomeMessage(name: string | null, email: string | null): string {
  const greeting = name ? `Hey ${firstName(name)},` : 'Hey,';
  const haveIdentity = Boolean(name || email);
  const researchLine = haveIdentity
    ? "I'll do a quick read on you in the next minute or two and ping you with a few starting points tailored to what I find."
    : "Tell me a bit about you (name, what you do, what you're working on) and I'll personalize from there.";
  return `${greeting}

I'm Hermes — your private agent. I'm not a chatbot; I do things. I run \
inside your own microVM with persistent memory, web search, code execution, \
a real browser, and scheduled tasks. Anything you tell me I'll remember next \
session.

${researchLine}

A few things to try right now:

- **Daily morning brief** — say "give me a daily brief on [topic] at 9am" \
and I'll schedule it.
- **Marketing work** — I have a deep library of marketing skills (CRO, \
copywriting, paid ads, SEO, lifecycle). Try "write me 3 ad hooks for \
[product]" or "audit my landing page at [url]".
- **Research on demand** — "what's new in [topic]?" or "compare X vs Y".
- **Connect a tool** — for now via API keys / app passwords (Gmail, Linear, \
GitHub, etc.). Ask me what's possible.

Or just chat. What's on your mind?`;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full.trim();
}

function buildBootPrompt(name: string | null, email: string | null): string {
  const identityLine = name || email
    ? `The user's name is "${name ?? ''}"${email ? ` and their email is "${email}"` : ''}. Save this to your memory so you remember them next time.`
    : 'The user has not given a name yet.';

  return `Onboarding setup. Treat this message as orchestration, not a \
user-visible chat. Do the following silently — your response back to me is \
discarded.

1. **Memory** — ${identityLine}

2. **Daily-suggestions task** — schedule a cronjob firing every day at \
09:00 UTC (cron expression "0 9 * * *"). Set name to "daily-suggestions" \
and deliver to "local". Prompt content:

   <prompt>
   Review what you know about this user from your memory and recent \
   conversations. Suggest 2–3 specific actions they could take today: \
   try a new skill, install a new skill from the skill library or a \
   public source you can research, set up a new automation, connect a \
   tool they haven't yet. Be concrete (one paragraph each, include the \
   exact prompt the user could send you). If you don't know enough \
   about them yet, suggest things that would help YOU learn more about \
   them. Skip vague platitudes.
   </prompt>

Run the cronjob.create call now. Once created, just reply "ok".`;
}

function buildResearchPrompt(name: string | null, email: string | null): string {
  return `Do a brief public-web research pass on the user. Their name is \
${name ?? '(unknown)'}${email ? ` and email is ${email}` : ''}. Use \
web_search to find their LinkedIn / company / public profile / public \
projects. Be honest if you can't find them — don't invent details.

Write a friendly message in markdown directly to the user containing:
- 2–4 things you learned that you're reasonably confident about (with sources)
- 3–5 concrete suggestions for things they could ask you to do, tailored \
to what you found
- One specific skill (from your installed library or one you could install) \
you think they'd benefit from

Tone: direct, helpful, no flattery. Address them by first name. Your reply \
content here will be shown VERBATIM to the user as a message from you, so \
write it that way — no meta-commentary about doing research, no "Here's \
what I'll do", just the message itself.`;
}
