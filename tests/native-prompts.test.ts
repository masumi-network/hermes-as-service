import { describe, expect, it } from 'vitest';
import { localCronToUtc, NATIVE_PROMPTS, NATIVE_PROMPTS_VERSION } from '../src/schedules/native-prompts.js';

describe('localCronToUtc', () => {
  it('passes through non-shiftable expressions untouched', () => {
    expect(localCronToUtc('0 */4 * * *', 'Europe/Berlin')).toBe('0 */4 * * *');
    expect(localCronToUtc('*/5 * * * *', 'America/New_York')).toBe('*/5 * * * *');
    expect(localCronToUtc('not a cron', 'UTC')).toBe('not a cron');
  });

  it('UTC timezone is identity', () => {
    expect(localCronToUtc('0 9 * * *', 'UTC')).toBe('0 9 * * *');
    expect(localCronToUtc('0 16 * * 5', 'UTC')).toBe('0 16 * * 5');
  });

  it('shifts positive-offset zones back and is deterministic for half-hour zones', () => {
    // Kolkata is UTC+5:30 year-round → rounds to +6 (Math.round(5.5)=6), always.
    const a = localCronToUtc('0 9 * * *', 'Asia/Kolkata');
    const b = localCronToUtc('0 9 * * *', 'Asia/Kolkata');
    expect(a).toBe(b);
    expect(a).toBe('0 3 * * *');
  });

  it('shifts day-of-week when crossing midnight westward (negative offset)', () => {
    // Los Angeles is UTC-7/-8. Sunday 23:00 local = Monday 06:00/07:00 UTC.
    const out = localCronToUtc('0 23 * * 0', 'America/Los_Angeles');
    const [, hour, , , dow] = out.split(' ');
    expect(Number(hour)).toBeGreaterThanOrEqual(6);
    expect(Number(hour)).toBeLessThanOrEqual(7);
    expect(dow).toBe('1');
  });

  it('shifts day-of-week when crossing midnight eastward (large positive offset)', () => {
    // Auckland is UTC+12/+13. Monday 10:00 local = Sunday 21:00/22:00 UTC.
    const out = localCronToUtc('0 10 * * 1', 'Pacific/Auckland');
    const [, hour, , , dow] = out.split(' ');
    expect(Number(hour)).toBeGreaterThanOrEqual(21);
    expect(Number(hour)).toBeLessThanOrEqual(22);
    expect(dow).toBe('0');
  });

  it('falls back to the input on an invalid timezone', () => {
    expect(localCronToUtc('0 9 * * *', 'Not/AZone')).toBe('0 9 * * *');
  });
});

describe('NATIVE_PROMPTS spec sanity', () => {
  it('names are unique and kebab-case', () => {
    const names = NATIVE_PROMPTS.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9-]+$/);
  });

  it('every localTime spec uses a shiftable single-hour expression', () => {
    for (const spec of NATIVE_PROMPTS.filter((n) => n.localTime)) {
      const parts = spec.cronExpr.split(/\s+/);
      expect(parts).toHaveLength(5);
      expect(parts[1]).toMatch(/^\d+$/);
      // DOW must be '*' or a single digit — the UTC shifter can't rewrite
      // ranges/lists when the shift crosses midnight.
      expect(parts[4]).toMatch(/^(\*|\d)$/);
    }
  });

  it('version is a positive integer (bump it when specs change)', () => {
    expect(Number.isInteger(NATIVE_PROMPTS_VERSION)).toBe(true);
    expect(NATIVE_PROMPTS_VERSION).toBeGreaterThan(0);
  });
});
