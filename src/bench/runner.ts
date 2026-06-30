import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../crypto.js';
import { subscribeProgress } from '../routes/progress-bus.js';
import { FlyClient } from '../fly/client.js';
import { tagFromRef } from '../images/manifest.js';
import { findSuite, type TestSuite } from './suites.js';

// Kept under undici's 300s default headersTimeout so THIS signal governs the
// cutoff (a non-streaming agentic turn sends no response headers until the loop
// finishes). 4 min is generous for a single standard-chat test turn.
const TURN_TIMEOUT_MS = 240_000;
const GAP_BETWEEN_TURNS_MS = 1_000;

export interface CapturedTool {
  name: string;
  label?: string;
  detail?: string;
}

/**
 * Start a suite run against an instance. Creates the TestRun row, kicks off
 * execution in the background (so the HTTP handler can redirect immediately),
 * and returns the new runId. Throws only on validation (bad instance/suite).
 */
export async function startSuiteRun(instanceId: string, suiteId: string): Promise<string> {
  const suite = findSuite(suiteId);
  if (!suite) throw new Error(`unknown suite: ${suiteId}`);
  const row = await prisma.hermesInstance.findUnique({ where: { id: instanceId } });
  if (!row) throw new Error(`unknown instance: ${instanceId}`);
  if (!row.endpointUrl) throw new Error('instance has no endpoint');
  // Cost guard: a suite is ~7 agentic turns billed to the instance's owner and
  // counted toward their monthly cap. Only ever run against a designated bench
  // so we can't accidentally burn a real user's budget.
  if (!row.isTestBench) {
    throw new Error('refusing to run a suite against a non-bench instance — mark it as a bench first');
  }
  // Concurrency guard: the progress bus is instance-keyed, so two runs on the
  // same instance would cross-attribute tool calls. One run per instance.
  const active = await prisma.testRun.findFirst({
    where: { instanceId, status: 'running' },
    select: { id: true },
  });
  if (active) throw new Error('a suite is already running on this instance — wait for it to finish');

  // Resolve the image this run is exercising. Prefer the recorded ref; fall
  // back to a live Fly read (preferring image_ref.tag, which is a clean tag)
  // so the run is reliably grouped in compare views.
  let imageTag = row.imageTag ?? null;
  if (!imageTag && row.spriteId) {
    try {
      const machine = await new FlyClient().getMachine(row.spriteName, row.spriteId);
      imageTag = machine?.image_ref?.tag ?? tagFromRef(machine?.config?.image) ?? null;
    } catch {
      // best-effort; leave null
    }
  }

  const run = await prisma.testRun.create({
    data: {
      instanceId,
      userId: row.userId,
      suiteId: suite.id,
      suiteName: suite.name,
      imageTag,
      status: 'running',
    },
  });

  // Fire and forget — the orchestrator process stays alive between requests.
  void executeRun(run.id, instanceId, row.endpointUrl, row.apiServerKey, suite).catch((err) => {
    logger.error({ err, runId: run.id }, 'bench_run_threw');
    void prisma.testRun
      .update({ where: { id: run.id }, data: { status: 'error', finishedAt: new Date() } })
      .catch(() => {});
  });

  return run.id;
}

async function executeRun(
  runId: string,
  instanceId: string,
  endpointUrl: string,
  encryptedKey: string,
  suite: TestSuite,
): Promise<void> {
  const log = logger.child({ runId, instanceId, suiteId: suite.id, fn: 'bench_run' });
  const apiKey = await decryptSecret(encryptedKey);
  log.info({ cases: suite.cases.length }, 'bench_run_start');

  let order = 0;
  let runToolTotal = 0;
  let okTurns = 0;
  for (const tc of suite.cases) {
    order += 1;
    // Deduped by tool NAME — we capture "which tools did it call", not call
    // counts (a repeated-call/loop regression isn't surfaced here by design).
    const seen = new Map<string, CapturedTool>();
    // Subscribe BEFORE sending so the gateway's tool decisions (surfaced via
    // the llm-proxy → progress-bus) are captured for this instance. Runs are
    // sequential per instance, so the instance-keyed bus is unambiguous here.
    const unsub = subscribeProgress(instanceId, (ev) => {
      if (ev.phase === 'tool' && ev.tool && !seen.has(ev.tool)) {
        seen.set(ev.tool, { name: ev.tool, label: ev.label, detail: ev.detail });
      }
    });

    const t0 = Date.now();
    let responseText: string | null = null;
    let errorMessage: string | null = null;
    let model: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let totalTokens: number | null = null;

    try {
      const res = await fetch(`${endpointUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'hermes-agent',
          messages: [{ role: 'user', content: tc.prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        errorMessage = `HTTP ${res.status}: ${body.slice(0, 300)}`;
      } else {
        const json = (await res.json().catch(() => null)) as {
          choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          model?: string;
        } | null;
        const msg = json?.choices?.[0]?.message;
        responseText = typeof msg?.content === 'string' ? msg.content : '';
        model = json?.model ?? null;
        promptTokens = json?.usage?.prompt_tokens ?? null;
        completionTokens = json?.usage?.completion_tokens ?? null;
        totalTokens = json?.usage?.total_tokens ?? null;
        // Defensive: also fold any tool_calls present on the final message.
        if (Array.isArray(msg?.tool_calls)) {
          for (const tcRaw of msg.tool_calls) {
            const name = (tcRaw as { function?: { name?: string } })?.function?.name;
            if (name && !seen.has(name)) seen.set(name, { name });
          }
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      unsub();
    }

    const latencyMs = Date.now() - t0;
    const toolCalls = [...seen.values()];
    runToolTotal += toolCalls.length;
    if (!errorMessage) okTurns += 1;

    await prisma.testTurn.create({
      data: {
        runId,
        caseId: tc.id,
        caseName: tc.name,
        order,
        prompt: tc.prompt,
        responseText,
        toolCalls: toolCalls.length ? (toolCalls as unknown as object) : undefined,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        errorMessage,
      },
    });
    log.info({ case: tc.id, latencyMs, tools: toolCalls.length, error: !!errorMessage }, 'bench_turn_done');

    if (order < suite.cases.length) {
      await new Promise((r) => setTimeout(r, GAP_BETWEEN_TURNS_MS));
    }
  }

  // Zero tools captured across an otherwise-successful run is the signature of
  // a broken capture path (the gateway→llm-proxy→progress-bus wiring) — most
  // suites include cases that should call a tool. Surface it loudly.
  if (runToolTotal === 0 && okTurns > 0) {
    log.warn({ okTurns }, 'bench_run_no_tools_captured');
  }

  await prisma.testRun.update({
    where: { id: runId },
    data: { status: 'done', finishedAt: new Date() },
  });
  log.info({ toolsCaptured: runToolTotal }, 'bench_run_done');
}

/**
 * Boot recovery: a TestRun in status="running" can only be genuinely executing
 * within the current process. At boot, any "running" row is orphaned from a
 * dead process, so mark them errored (otherwise their run page auto-refreshes
 * forever and the concurrency guard would block new runs on that instance).
 */
export async function recoverStrandedTestRuns(): Promise<number> {
  const res = await prisma.testRun.updateMany({
    where: { status: 'running' },
    data: { status: 'error', finishedAt: new Date() },
  });
  if (res.count > 0) logger.info({ count: res.count }, 'recovered_stranded_test_runs');
  return res.count;
}
