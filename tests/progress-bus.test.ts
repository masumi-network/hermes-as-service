import { describe, it, expect } from 'vitest';
import {
  publishProgress,
  subscribeProgress,
  hasProgressSubscribers,
  _subscriberCount,
  type ProgressEvent,
} from '../src/routes/progress-bus.js';

const ev = (over: Partial<ProgressEvent> = {}): ProgressEvent => ({
  phase: 'tool',
  ts: 1,
  ...over,
});

describe('progress-bus', () => {
  it('delivers events to a subscriber', () => {
    const got: ProgressEvent[] = [];
    const unsub = subscribeProgress('i1', (e) => got.push(e));
    publishProgress('i1', ev({ label: 'A' }));
    publishProgress('i1', ev({ label: 'B' }));
    unsub();
    expect(got.map((e) => e.label)).toEqual(['A', 'B']);
  });

  it('is a no-op when nobody is subscribed', () => {
    expect(hasProgressSubscribers('none')).toBe(false);
    expect(() => publishProgress('none', ev())).not.toThrow();
  });

  it('fans out to multiple subscribers', () => {
    const a: string[] = [];
    const b: string[] = [];
    const ua = subscribeProgress('i2', (e) => a.push(e.label ?? ''));
    const ub = subscribeProgress('i2', (e) => b.push(e.label ?? ''));
    expect(_subscriberCount('i2')).toBe(2);
    publishProgress('i2', ev({ label: 'x' }));
    ua();
    ub();
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('stops delivering after unsubscribe and cleans up the map', () => {
    const got: number[] = [];
    const unsub = subscribeProgress('i3', () => got.push(1));
    publishProgress('i3', ev());
    unsub();
    publishProgress('i3', ev());
    expect(got).toHaveLength(1);
    expect(hasProgressSubscribers('i3')).toBe(false);
    expect(_subscriberCount('i3')).toBe(0);
  });

  it('double unsubscribe is safe and does not drop a re-subscriber', () => {
    const unsub = subscribeProgress('i4', () => {});
    unsub();
    unsub(); // no-op
    const got: number[] = [];
    const unsub2 = subscribeProgress('i4', () => got.push(1));
    publishProgress('i4', ev());
    expect(got).toHaveLength(1);
    unsub2();
  });

  it('a throwing subscriber does not break publishing to others', () => {
    const got: string[] = [];
    const u1 = subscribeProgress('i5', () => {
      throw new Error('boom');
    });
    const u2 = subscribeProgress('i5', (e) => got.push(e.label ?? ''));
    expect(() => publishProgress('i5', ev({ label: 'ok' }))).not.toThrow();
    expect(got).toEqual(['ok']);
    u1();
    u2();
  });

  it('isolates events by instance', () => {
    const a: string[] = [];
    const ua = subscribeProgress('A', (e) => a.push(e.label ?? ''));
    publishProgress('B', ev({ label: 'forB' }));
    expect(a).toEqual([]);
    ua();
  });
});
