import { describe, it, expect } from 'vitest';
import { buildPersonaDirective, isVerbosity, isTone } from '../src/provision/profile.js';

describe('buildPersonaDirective', () => {
  it('returns empty string when nothing is set (opt-in: no behavior change)', () => {
    expect(buildPersonaDirective({})).toBe('');
    expect(buildPersonaDirective({ personaName: null, verbosity: null, tone: null })).toBe('');
    expect(buildPersonaDirective({ personaName: '', verbosity: undefined, tone: undefined })).toBe('');
  });

  it('includes the name when set', () => {
    const out = buildPersonaDirective({ personaName: 'Athena' });
    expect(out).toContain('Your name is "Athena"');
    expect(out).toContain('user.persona');
  });

  it('trims whitespace-only name to nothing', () => {
    expect(buildPersonaDirective({ personaName: '   ' })).toBe('');
  });

  it('includes a verbosity clause for each valid value', () => {
    expect(buildPersonaDirective({ verbosity: 'brief' })).toContain('Brief');
    expect(buildPersonaDirective({ verbosity: 'balanced' })).toContain('Balanced');
    expect(buildPersonaDirective({ verbosity: 'detailed' })).toContain('Detailed');
  });

  it('includes a tone clause for each valid value', () => {
    expect(buildPersonaDirective({ tone: 'professional' })).toContain('Professional');
    expect(buildPersonaDirective({ tone: 'friendly' })).toContain('Friendly');
    expect(buildPersonaDirective({ tone: 'playful' })).toContain('Playful');
  });

  it('ignores unrecognized verbosity/tone values (no clause emitted)', () => {
    expect(buildPersonaDirective({ verbosity: 'verbose' })).toBe('');
    expect(buildPersonaDirective({ tone: 'sarcastic' })).toBe('');
  });

  it('combines all three when set', () => {
    const out = buildPersonaDirective({ personaName: 'Nova', verbosity: 'brief', tone: 'playful' });
    expect(out).toContain('Nova');
    expect(out).toContain('Brief');
    expect(out).toContain('Playful');
  });

  it('always states the voice-only / no-leak-to-artifacts invariants when any setting is present', () => {
    const out = buildPersonaDirective({ tone: 'playful' });
    expect(out).toContain('VOICE only');
    expect(out.toLowerCase()).toContain('cost-gating');
    // The hard boundary: tone never leaks into outbound artifacts.
    expect(out).toMatch(/drafted emails|leave the user|professional/i);
  });
});

describe('isVerbosity / isTone guards', () => {
  it('accepts valid values', () => {
    expect(isVerbosity('brief')).toBe(true);
    expect(isVerbosity('balanced')).toBe(true);
    expect(isVerbosity('detailed')).toBe(true);
    expect(isTone('professional')).toBe(true);
    expect(isTone('friendly')).toBe(true);
    expect(isTone('playful')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isVerbosity('verbose')).toBe(false);
    expect(isVerbosity(null)).toBe(false);
    expect(isVerbosity(undefined)).toBe(false);
    expect(isTone('rude')).toBe(false);
    expect(isTone(42)).toBe(false);
  });
});
