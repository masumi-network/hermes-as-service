import { logger } from '../logger.js';
import { SokosumiClient, resolveSokosumiTarget } from '../sokosumi/client.js';
import { isValidSokosumiEnv, type SokosumiEnv } from '../config.js';

/**
 * Mirror each Hermes cron firing as a Sokosumi task on the user's
 * personal scope, assigned to the Hermes coworker. Lifecycle:
 *
 *   create(name, prompt) → READY
 *     ↓
 *   markRunning() → status=RUNNING + "Cron started…" comment
 *     ↓
 *   comment(text) (zero or more) — intermediate status notes
 *     ↓
 *   markCompleted(summary) → status=COMPLETED + result summary comment
 *     OR
 *   markFailed(error) → status=FAILED + error comment
 *
 * Gated to preprod only (per Patrick's request). On mainnet, all calls
 * are silent no-ops — the cron still runs as before, just without the
 * Sokosumi task mirror.
 *
 * Silent failures are deliberate: if Sokosumi rejects a status transition
 * or we can't find a Hermes coworker, we log and skip. Cron must keep
 * running regardless of whether the mirror succeeded.
 */

const ENABLED_ENVS: SokosumiEnv[] = ['preprod'];

interface StartArgs {
  userId: string;
  sokosumiEnv: string | null;
  cronName: string;
  cronExpr: string;
  prompt: string;
}

export interface CronTaskHandle {
  taskId: string;
  client: SokosumiClient;
  markRunning(): Promise<void>;
  comment(text: string): Promise<void>;
  markCompleted(summary: string): Promise<void>;
  markFailed(error: string): Promise<void>;
}

/**
 * Create the Sokosumi task and return a handle the scheduler uses to
 * drive the lifecycle. Returns null if we're not on an enabled env,
 * no Hermes coworker is reachable, or task creation fails. Callers
 * must tolerate null — the cron runs either way.
 */
export async function startCronTask(args: StartArgs): Promise<CronTaskHandle | null> {
  const rawEnv: SokosumiEnv | null = isValidSokosumiEnv(args.sokosumiEnv) ? args.sokosumiEnv : null;
  // Resolve through the override so Patrick's dev→preprod redirect counts.
  const resolved = resolveSokosumiTarget(args.userId, rawEnv);
  const effectiveEnv = resolved.env;
  if (!effectiveEnv || !ENABLED_ENVS.includes(effectiveEnv)) {
    return null;
  }
  if (!SokosumiClient.isConfigured(effectiveEnv, args.userId)) {
    return null;
  }

  const log = logger.child({ fn: 'cron_task_logger', userId: args.userId, cron: args.cronName });
  const client = new SokosumiClient(args.userId, effectiveEnv);
  const hermesCoworkerId = await findHermesCoworkerId(client, log);
  if (!hermesCoworkerId) {
    log.warn('hermes_coworker_not_found_skipping_task_mirror');
    return null;
  }

  const description = `Automatic cron mirror.\n\nSchedule: \`${args.cronExpr}\`\n\nPrompt:\n${truncate(args.prompt, 1200)}`;

  let taskId: string;
  try {
    const created = (await client.createTask({
      name: `Cron · ${args.cronName}`,
      description,
      coworkerId: hermesCoworkerId,
      status: 'READY',
    })) as { data?: { id?: string }; id?: string };
    taskId =
      created?.data?.id ??
      created?.id ??
      '';
    if (!taskId) {
      log.warn({ created }, 'cron_task_create_no_id');
      return null;
    }
    log.info({ taskId, hermesCoworkerId }, 'cron_task_created');
  } catch (err) {
    log.warn({ err }, 'cron_task_create_failed');
    return null;
  }

  return {
    taskId,
    client,
    async markRunning() {
      await client
        .addTaskEvent(taskId, {
          status: 'RUNNING',
          comment: `Cron started at ${new Date().toISOString()}.`,
        })
        .catch((err) => log.warn({ err, taskId }, 'cron_task_mark_running_failed'));
    },
    async comment(text: string) {
      await client
        .addTaskEvent(taskId, { comment: truncate(text, 4000) })
        .catch((err) => log.warn({ err, taskId }, 'cron_task_comment_failed'));
    },
    async markCompleted(summary: string) {
      await client
        .addTaskEvent(taskId, {
          status: 'COMPLETED',
          comment: `Cron completed at ${new Date().toISOString()}.\n\n${truncate(summary, 4000)}`,
        })
        .catch((err) => log.warn({ err, taskId }, 'cron_task_mark_completed_failed'));
    },
    async markFailed(error: string) {
      await client
        .addTaskEvent(taskId, {
          status: 'FAILED',
          comment: `Cron failed at ${new Date().toISOString()}.\n\n${truncate(error, 4000)}`,
        })
        .catch((err) => log.warn({ err, taskId }, 'cron_task_mark_failed_failed'));
    },
  };
}

/**
 * Locate the Hermes coworker in personal scope first, then fall back
 * to scanning the user's orgs. Returns null if no slug=hermes coworker
 * is reachable anywhere.
 */
async function findHermesCoworkerId(
  client: SokosumiClient,
  log: { debug: (data: unknown, msg: string) => void },
): Promise<string | null> {
  // Personal scope (no org delegation) first.
  try {
    const coworkers = (await client.listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
      id?: string;
      slug?: string;
    }>;
    const hermes = coworkers.find((c) => c.slug === 'hermes');
    if (hermes?.id) return hermes.id;
  } catch (err) {
    log.debug({ err }, 'cron_task_personal_coworkers_failed');
  }

  // Fall back to orgs.
  try {
    const orgs = await client.listOrganizations();
    for (const org of orgs.slice(0, 5)) {
      try {
        const coworkers = (await client
          .withOrganization(org.id)
          .listCoworkers({ scope: 'whitelisted', limit: 50 })) as Array<{
          id?: string;
          slug?: string;
        }>;
        const hermes = coworkers.find((c) => c.slug === 'hermes');
        if (hermes?.id) return hermes.id;
      } catch {
        // try next org
      }
    }
  } catch (err) {
    log.debug({ err }, 'cron_task_org_coworkers_failed');
  }

  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
