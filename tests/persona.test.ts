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

describe('buildPersonaDirective — personality axes', () => {
  it('emits nothing when personality is absent (balanced = today\'s behavior)', () => {
    expect(buildPersonaDirective({})).toBe('');
    expect(buildPersonaDirective({ personality: null })).toBe('');
  });

  it('maps each axis to its bucketed clause (low / mid / high)', () => {
    const lo = buildPersonaDirective({ personality: { tone: 0, detail: 10, style: 20 } });
    expect(lo).toContain('Be direct; skip pleasantries.');
    expect(lo).toContain('Keep it short; lead with the answer.');
    expect(lo).toContain('Keep a formal, professional register.');

    const mid = buildPersonaDirective({ personality: { tone: 50, detail: 50, style: 50 } });
    expect(mid).toContain('Balance warmth and efficiency.');
    expect(mid).toContain('Give a normal amount of detail.');
    expect(mid).toContain('Use a relaxed-professional register.');

    const hi = buildPersonaDirective({ personality: { tone: 100, detail: 80, style: 90 } });
    expect(hi).toContain('Be warm, friendly, personable.');
    expect(hi).toContain('Be thorough; explain your reasoning, add context.');
    expect(hi).toContain('Be casual and playful; light humour is fine.');
  });

  it('respects bucket boundaries (33=low, 34=mid, 66=mid, 67=high)', () => {
    const c = (tone) => buildPersonaDirective({ personality: { tone, detail: 50, style: 50 } });
    expect(c(33)).toContain('Be direct; skip pleasantries.');
    expect(c(34)).toContain('Balance warmth and efficiency.');
    expect(c(66)).toContain('Balance warmth and efficiency.');
    expect(c(67)).toContain('Be warm, friendly, personable.');
  });

  it('clamps out-of-range values and defaults missing axes to balanced', () => {
    const out = buildPersonaDirective({ personality: { tone: 999, detail: -5 } });
    expect(out).toContain('Be warm, friendly, personable.'); // 999 → clamp 100 → high
    expect(out).toContain('Keep it short; lead with the answer.'); // -5 → clamp 0 → low
    expect(out).toContain('Use a relaxed-professional register.'); // missing style → 50 → mid
  });

  it('keeps the voice-only guardrail when only personality is set', () => {
    const out = buildPersonaDirective({ personality: { tone: 80, detail: 80, style: 80 } });
    expect(out).toContain('VOICE only');
    expect(out.toLowerCase()).toContain('cost-gating');
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
