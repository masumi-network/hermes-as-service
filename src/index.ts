import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { bearerAuth } from './auth.js';
import { instancesRouter } from './routes/instances.js';
import { proxyRouter } from './routes/proxy.js';
import { llmProxyRouter } from './routes/llm-proxy.js';
import { mcpProxyRouter } from './routes/mcp-proxy.js';
import { sokosumiMcpRouter } from './routes/sokosumi-mcp.js';
import { schedulesSokosumiRouter, schedulesSpriteRouter } from './routes/schedules.js';
import { outboxSokosumiRouter, outboxSpriteRouter } from './routes/outbox.js';
import { confirmationsRouter } from './routes/confirmations.js';
import { skillsSokosumiRouter } from './routes/skills.js';
import { adminAuth } from './admin/auth.js';
import { adminRouter } from './admin/routes.js';
import { restoreMasumiProfile } from './notify/masumi-restore.js';
import { sendMasumiTest, masumiConfigured } from './notify/masumi.js';
import {
  startIdleSuspendCron,
  startSokosumiDailySyncCron,
  startInboxRefreshCron,
  startUrgentInterruptCron,
  startTaskAugmentationCron,
  startHermesExecutorCron,
  startInputResponderCron,
  startEodReportCron,
  startPoolReplenishCron,
} from './cron.js';
// On Fly always-on hosts, Hermes' own gateway daemon ticks its built-in
// cron every 60s. We no longer need the orchestrator-side scheduler.
// import { startScheduler } from './schedules/scheduler.js';

const cfg = loadConfig();

// Rehydrate the masumi-agent-messenger bot identity (best-effort, fast) so the
// notifier can post to the Masumi Team Channel. No-op unless configured.
void restoreMasumiProfile();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

// LLM proxy + sprite-callable schedule API use per-instance bearer auth, not
// the orchestrator bearer — mount BEFORE the bearerAuth middleware so they
// aren't intercepted.
app.route('/', llmProxyRouter);
app.route('/', mcpProxyRouter);
app.route('/', sokosumiMcpRouter);
app.route('/', schedulesSpriteRouter);
app.route('/', outboxSpriteRouter);

// /v1/* is the machine API for Sokosumi (bearer auth).
app.use('/v1/*', bearerAuth);
app.route('/', instancesRouter);
app.route('/', proxyRouter);
app.route('/', schedulesSokosumiRouter);
app.route('/', outboxSokosumiRouter);
app.route('/', confirmationsRouter);
app.route('/', skillsSokosumiRouter);

// /admin/* is the human dashboard (Basic Auth).
app.use('/admin/*', adminAuth);
app.use('/admin', adminAuth);
// Post a test message to the Masumi Team Channel (verifies the bot identity +
// channel end to end). Behind admin Basic Auth like the rest of /admin.
app.post('/admin/test-masumi', async (c) => {
  const res = await sendMasumiTest('🔔 Test alert from the Hermes Orchestrator (admin test).');
  return c.json({ configured: masumiConfigured(), ...res });
});
app.route('/', adminRouter);

// Convenience: send root to /admin so visiting the bare hostname shows the UI.
app.get('/', (c) => c.redirect('/admin'));

app.notFound((c) => c.json({ status: 404, code: 'not_found', title: 'Not found' }, 404));

app.onError((err, c) => {
  logger.error({ err }, 'unhandled_error');
  return c.json({ status: 500, code: 'internal_error', title: 'Internal server error' }, 500);
});

const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: '0.0.0.0' }, (info) => {
  logger.info({ port: info.port }, 'orchestrator_listening');
});

// On Fly always-on the idle-suspend cron is also vestigial (machines never
// idle-suspend), but we keep it: it still flips DB status to 'suspended'
// after 30 min, which Sokosumi uses as a signal for "we haven't heard from
// this user lately" — pure bookkeeping, no Fly side effects.
startIdleSuspendCron();
startSokosumiDailySyncCron();
startInboxRefreshCron();
startUrgentInterruptCron();
startTaskAugmentationCron();
startHermesExecutorCron();
startInputResponderCron();
startEodReportCron();
startPoolReplenishCron();

// On boot, resume any onboarding pipelines that died with a previous pod.
void (async () => {
  try {
    const { recoverStrandedOnboardings } = await import('./provision/onboarding-recovery.js');
    await recoverStrandedOnboardings();
  } catch (err) {
    logger.error({ err }, 'onboarding_recovery_threw');
  }
})();

// On boot, fail any bench test runs orphaned by a previous pod (their executor
// can't survive a restart, so a lingering "running" row is always stale).
void (async () => {
  try {
    const { recoverStrandedTestRuns } = await import('./bench/runner.js');
    await recoverStrandedTestRuns();
  } catch (err) {
    logger.error({ err }, 'test_run_recovery_threw');
  }
})();

// One-off cleanup: instances previously provisioned with
// sokosumiEnv="development" get bumped to "preprod" so they stop
// failing with "env not configured" after we tightened the contract.
void (async () => {
  try {
    const { migrateDevelopmentEnvRows } = await import('./provision/env-migration.js');
    await migrateDevelopmentEnvRows();
  } catch (err) {
    logger.error({ err }, 'sokosumi_env_migration_threw');
  }
})();
// startScheduler();  // see import above

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
