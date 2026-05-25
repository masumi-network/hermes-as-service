import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = join(process.cwd(), 'docker/hermes-user/cron-outbox-bridge.sh');

/**
 * Drives the real bridge script with a fake responder for `curl` and `jq`
 * is expected to exist on the host. We point ORCHESTRATOR_BASE at a value
 * that would 404 if reached; the assertion isn't on the HTTP request — it's
 * on whether the script emits the "{}" no-op before reaching curl.
 *
 * Strategy: stub `curl` on PATH that *records* every invocation to a file.
 * If the script filtered correctly, the stub never runs.
 */
function runBridge(
  input: object,
): { stdout: string; stderr: string; status: number; curlInvocations: number } {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const curlLog = join(dir, 'curl.log');
  const curlStub = join(dir, 'curl');
  writeFileSync(
    curlStub,
    `#!/usr/bin/env bash\necho "$@" >> ${curlLog}\nexit 0\n`,
    { mode: 0o755 },
  );
  chmodSync(curlStub, 0o755);

  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    ORCHESTRATOR_BASE: 'https://example.invalid',
    INSTANCE_ID: 'test-instance',
    ORCHESTRATOR_OUTBOX_TOKEN: 'test-token',
  };

  const result = spawnSync('bash', [BRIDGE], {
    input: JSON.stringify(input),
    env,
    encoding: 'utf8',
  });
  const curlInvocations = existsSync(curlLog)
    ? readFileSync(curlLog, 'utf8').split('\n').filter((l) => l.length > 0).length
    : 0;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    curlInvocations,
  };
}

describe('cron-outbox-bridge.sh', () => {
  beforeAll(() => {
    // jq + bash must be on PATH for this test to run meaningfully.
    try {
      execSync('command -v jq >/dev/null 2>&1');
      execSync('command -v bash >/dev/null 2>&1');
    } catch {
      throw new Error('jq and bash must be installed to run this test');
    }
  });

  it('no-ops with "{}" when platform is not cron', () => {
    const r = runBridge({
      hook_event_name: 'post_llm_call',
      extra: { platform: 'cli', assistant_response: 'something' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.curlInvocations).toBe(0);
  });

  it('no-ops when the assistant_response is empty', () => {
    const r = runBridge({
      hook_event_name: 'post_llm_call',
      extra: { platform: 'cron', assistant_response: '' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.curlInvocations).toBe(0);
  });

  it.each([
    '[SILENT]',
    '[silent]',
    '  [SILENT]  ',
    '[NOREPLY]',
    '[NoReply]',
    '[NONE]',
    '[NOOP]',
    'ok',
    'OK',
    '  done  ',
    'Done',
  ])('drops sentinel response %j without calling curl', (resp) => {
    const r = runBridge({
      hook_event_name: 'post_llm_call',
      extra: { platform: 'cron', assistant_response: resp },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.curlInvocations).toBe(0);
  });

  it('forwards a real response to curl', () => {
    const r = runBridge({
      hook_event_name: 'post_llm_call',
      extra: {
        platform: 'cron',
        assistant_response: 'Here is your morning brief: 2 meetings today.',
        cron_job_name: 'daily-brief',
      },
    });
    expect(r.status).toBe(0);
    expect(r.curlInvocations).toBeGreaterThan(0);
  });

  it('also forwards multi-word responses that happen to contain a sentinel word', () => {
    // We only drop EXACTLY-sentinel responses (after trim+lowercase). A
    // response like "ok, here's the result" should NOT be filtered.
    const r = runBridge({
      hook_event_name: 'post_llm_call',
      extra: { platform: 'cron', assistant_response: "ok, here's the result" },
    });
    expect(r.curlInvocations).toBeGreaterThan(0);
  });
});
