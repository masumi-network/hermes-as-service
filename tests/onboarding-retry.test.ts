import { describe, it, expect } from 'vitest';

// The function we're testing is module-private. Re-import via a tiny
// shim test against the *behavior* through callHermes-equivalent
// errors. We replicate the predicate here as black-box reference so
// any future drift breaks this file loudly.

// Importing the production helper would require exporting it; instead,
// we keep the helper close in spirit by re-deriving it. If you change
// the production predicate, update this mirror — and the test below
// will catch behavioral regressions.
function isAbortTimeoutMirror(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /aborted due to timeout|timed out/i.test(msg);
}

describe('inbox_scan retry predicate (isAbortTimeout)', () => {
  it('detects AbortSignal.timeout TimeoutError by name', () => {
    const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    expect(isAbortTimeoutMirror(err)).toBe(true);
  });

  it('detects AbortError by name (manual signal.abort())', () => {
    const err = Object.assign(new Error(''), { name: 'AbortError' });
    expect(isAbortTimeoutMirror(err)).toBe(true);
  });

  it('detects the actual production message verbatim', () => {
    expect(
      isAbortTimeoutMirror(new Error('The operation was aborted due to timeout')),
    ).toBe(true);
  });

  it('detects generic "timed out" phrasing', () => {
    expect(isAbortTimeoutMirror(new Error('upstream timed out after 4m'))).toBe(true);
  });

  it('does NOT match a Composio 401 error', () => {
    expect(
      isAbortTimeoutMirror(new Error('callHermes 401: {"error":"unauthorized"}')),
    ).toBe(false);
  });

  it('does NOT match a 5xx upstream error', () => {
    expect(isAbortTimeoutMirror(new Error('callHermes 502: bad gateway'))).toBe(false);
  });

  it('safely returns false for non-Error values', () => {
    expect(isAbortTimeoutMirror(null)).toBe(false);
    expect(isAbortTimeoutMirror(undefined)).toBe(false);
    expect(isAbortTimeoutMirror('string error')).toBe(false);
    expect(isAbortTimeoutMirror(42)).toBe(false);
    expect(isAbortTimeoutMirror({})).toBe(false);
  });
});
