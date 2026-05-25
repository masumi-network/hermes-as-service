import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';

/**
 * Tell the running Hermes agent that an integration just came online so
 * its memory stops claiming "<provider> isn't connected" — the most
 * common UX complaint after Sokosumi's OAuth completes successfully.
 *
 * Why this is needed: when an integration is added mid-session, we
 * patch the Fly machine's MCP_SERVERS_JSON and the machine restarts.
 * Hermes' tool list refreshes on the next turn, but its persisted
 * memory file still says "user hasn't connected Gmail" from prior
 * conversations. The agent answers from memory + cached context, not
 * by re-probing MCPs, so it keeps telling the user to reconnect even
 * though the tools are right there.
 *
 * This function POSTs a silent prompt to Hermes' chat endpoint that
 * (a) confirms the new state and (b) instructs the agent to update
 * memory. The reply ("ok") is discarded by the cron-outbox bridge.
 *
 * Best-effort: any failure is logged but never thrown. The integration
 * is already connected in the DB at this point — a flaky memory nudge
 * shouldn't make Sokosumi's POST appear to fail.
 */
export async function notifyIntegrationConnected(
  instanceId: string,
  provider: string,
): Promise<void> {
  const inst = await prisma.hermesInstance.findUnique({
    where: { id: instanceId },
    select: { endpointUrl: true, apiServerKey: true, status: true, userId: true },
  });
  if (!inst || !inst.endpointUrl) return;
  if (inst.status !== 'ready' && inst.status !== 'running' && inst.status !== 'suspended') return;

  let apiKey: string;
  try {
    apiKey = await decryptSecret(inst.apiServerKey);
  } catch (err) {
    logger.warn({ err, instanceId }, 'integration_notify_decrypt_failed');
    return;
  }

  const prompt = buildPrompt(provider);
  try {
    const res = await fetch(`${inst.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(2 * 60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { instanceId, provider, status: res.status, body: body.slice(0, 200) },
        'integration_notify_non_ok',
      );
      return;
    }
    logger.info({ instanceId, provider }, 'integration_notify_done');
  } catch (err) {
    logger.warn({ err, instanceId, provider }, 'integration_notify_call_failed');
  }
}

function buildPrompt(provider: string): string {
  const label = providerLabel(provider);
  return `Internal background task — your reply is discarded and not shown \
to the user. Do not draft a chat reply.

The user just connected their ${label} integration through Sokosumi. \
Your MCP_SERVERS_JSON has been refreshed and the ${label} tools are \
available right now. If your memory contained a previous note that \
${label} was disconnected or that the user needed to connect it, \
clear that note — it is no longer true.

Briefly verify by calling the ${label} MCP's tools/list (or a cheap \
read like fetching recent items), confirm tools respond, then update \
memory to reflect that ${label} is now connected and usable.

Reply with just "ok".`;
}

function providerLabel(p: string): string {
  switch (p) {
    case 'gmail': return 'Gmail';
    case 'google_calendar': return 'Google Calendar';
    case 'outlook': return 'Outlook mail';
    case 'outlook_calendar': return 'Outlook Calendar';
    case 'slack': return 'Slack';
    case 'linear': return 'Linear';
    case 'github': return 'GitHub';
    case 'notion': return 'Notion';
    case 'hubspot': return 'HubSpot';
    case 'twitter': return 'X/Twitter';
    default: return p;
  }
}
