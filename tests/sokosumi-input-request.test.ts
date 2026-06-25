import { describe, it, expect } from 'vitest';
import { extractAwaitingInputEvent } from '../src/routes/sokosumi-mcp.js';

describe('extractAwaitingInputEvent', () => {
  it('returns null for non-arrays and empty arrays', () => {
    expect(extractAwaitingInputEvent(null)).toBeNull();
    expect(extractAwaitingInputEvent(undefined)).toBeNull();
    expect(extractAwaitingInputEvent('nope')).toBeNull();
    expect(extractAwaitingInputEvent([])).toBeNull();
  });

  it('returns null when no event mentions input', () => {
    expect(extractAwaitingInputEvent([{ type: 'JOB_STARTED' }, { status: 'RUNNING' }])).toBeNull();
  });

  it('matches an event whose type contains INPUT', () => {
    const ev = { id: 'evt_1', type: 'AWAITING_INPUT', prompt: 'Which region?' };
    expect(extractAwaitingInputEvent([{ type: 'STARTED' }, ev])).toEqual(ev);
  });

  it('matches an event whose status contains INPUT (case-insensitive)', () => {
    const ev = { id: 'evt_2', status: 'awaiting_input' };
    expect(extractAwaitingInputEvent([ev])).toEqual(ev);
  });

  it('returns the newest matching event by createdAt', () => {
    const older = { id: 'old', type: 'INPUT_REQUEST', createdAt: '2026-01-01T00:00:00Z' };
    const newer = { id: 'new', type: 'INPUT_REQUEST', createdAt: '2026-06-01T00:00:00Z' };
    expect(extractAwaitingInputEvent([older, newer])?.['id']).toBe('new');
    expect(extractAwaitingInputEvent([newer, older])?.['id']).toBe('new');
  });

  it('ignores non-object entries', () => {
    const ev = { id: 'e', type: 'INPUT' };
    expect(extractAwaitingInputEvent([null, 'x', 42, ev])).toEqual(ev);
  });

  it('returns the OPEN request, never a later resolved/answered event', () => {
    const request = { id: 'req', type: 'INPUT_REQUEST', createdAt: '2026-06-01T00:00:00Z' };
    const response = { id: 'resp', type: 'INPUT_PROVIDED', createdAt: '2026-06-01T00:05:00Z' };
    // The response is newer; must still pick the request (response is resolved).
    expect(extractAwaitingInputEvent([request, response])?.['id']).toBe('req');
    expect(extractAwaitingInputEvent([response, request])?.['id']).toBe('req');
  });

  it('returns null when the only input event is already resolved', () => {
    expect(extractAwaitingInputEvent([{ id: 'r', status: 'INPUT_RECEIVED' }])).toBeNull();
    expect(extractAwaitingInputEvent([{ id: 'r', type: 'INPUT_RESPONSE' }])).toBeNull();
  });
});
