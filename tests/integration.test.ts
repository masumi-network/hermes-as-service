import { afterAll, describe, expect, it } from 'vitest';

/**
 * End-to-end integration test against real Sprites.dev + real Postgres.
 *
 * Skipped by default. To run:
 *   export RUN_INTEGRATION=1
 *   export SPRITES_API_TOKEN=...
 *   export DATABASE_URL=...
 *   export OPENROUTER_API_KEY=...
 *   export ORCHESTRATOR_API_TOKEN=...
 *   export MASTER_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 *   npm test
 *
 * Provisioning takes ~5–10 min. The test polls until status=running.
 */

const liveMode = process.env.RUN_INTEGRATION === '1';
const describeLive = liveMode ? describe : describe.skip;

describeLive('live: provision → call → suspend → resume → destroy', () => {
  const userId = `test-${Date.now().toString(36)}`;

  it('round-trips an instance through its full lifecycle', async () => {
    const { provision, getInstance, suspendInstance, resumeInstance, destroyInstance, getDecryptedApiServerKey } =
      await import('../src/provision/provision.js');

    // 1. Provision
    const initial = await provision({ userId });
    expect(initial.status).toBe('provisioning');
    expect(initial.instanceId).toBeTruthy();

    // 2. Poll until running
    const deadline = Date.now() + 20 * 60_000;
    let view = initial;
    while (Date.now() < deadline) {
      view = await getInstance(userId);
      if (view.status === 'running' || view.status === 'error') break;
      await wait(15_000);
    }
    expect(view.status).toBe('running');
    expect(view.endpointUrl).toMatch(/^https:\/\//);

    // 3. Hit the Hermes API on the user sprite
    const apiKey = await getDecryptedApiServerKey(userId);
    const chat = await fetch(`${view.endpointUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [{ role: 'user', content: 'reply with the single word: ok' }],
        stream: false,
      }),
    });
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content.toLowerCase()).toContain('ok');

    // 4. Suspend → 5. Resume
    await suspendInstance(userId);
    const suspended = await getInstance(userId);
    expect(suspended.status).toBe('suspended');

    const resumed = await resumeInstance(userId);
    expect(resumed.status).toBe('running');

    // 6. Destroy
    await destroyInstance(userId);
    await expect(getInstance(userId)).rejects.toThrow();
  });

  afterAll(async () => {
    try {
      const { destroyInstance } = await import('../src/provision/provision.js');
      await destroyInstance(userId).catch(() => undefined);
    } catch {
      // best-effort cleanup
    }
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
