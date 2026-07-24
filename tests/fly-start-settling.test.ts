import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlyClient } from '../src/fly/client.js';
// FlyClient's constructor reads config; tests/setup.ts provides the baseline
// env, so it constructs fine. We spy on getMachine/startMachine so no real
// HTTP is issued.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const machine = (state: string): any => ({ id: 'm', state });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Regression: the capability-roll sweep restarted machines via restartMachine,
 * whose start step is a single POST that Fly answers with 412 while the machine
 * is still settling right after a stop. The old code gave up on that 412, so
 * rolls failed (mcp_tools_roll_failed in prod). startMachineSettling retries
 * through it — the same resilience the provision path already had.
 */
describe('startMachineSettling', () => {
  it('returns without starting when the machine is already started', async () => {
    const fly = new FlyClient();
    vi.spyOn(fly, 'getMachine').mockResolvedValue(machine('started'));
    const start = vi.spyOn(fly, 'startMachine').mockResolvedValue();
    await fly.startMachineSettling('a', 'm');
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a cleanly-stopped machine', async () => {
    const fly = new FlyClient();
    vi.spyOn(fly, 'getMachine').mockResolvedValue(machine('stopped'));
    const start = vi.spyOn(fly, 'startMachine').mockResolvedValue();
    await fly.startMachineSettling('a', 'm');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('retries the start through a 412 until it takes', async () => {
    vi.useFakeTimers();
    const fly = new FlyClient();
    vi.spyOn(fly, 'getMachine').mockResolvedValue(machine('stopped'));
    const start = vi
      .spyOn(fly, 'startMachine')
      .mockRejectedValueOnce(new Error('startMachine failed: 412'))
      .mockResolvedValueOnce();
    const p = fly.startMachineSettling('a', 'm');
    await vi.advanceTimersByTimeAsync(2500); // clear the one 2s backoff sleep
    await expect(p).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives up after the deadline rather than looping forever', async () => {
    vi.useFakeTimers();
    const fly = new FlyClient();
    vi.spyOn(fly, 'getMachine').mockResolvedValue(machine('stopped'));
    vi.spyOn(fly, 'startMachine').mockRejectedValue(new Error('startMachine failed: 412'));
    const p = fly.startMachineSettling('a', 'm').catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(95_000); // past the 90s deadline
    expect(String(await p)).toMatch(/412/);
  });
});
