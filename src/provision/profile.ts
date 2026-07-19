// Persona settings for every user's Hermes. The agent's SOUL.md,
// config.yaml, and skills are NOT here — they live in docker/hermes-user/
// and are baked into the user image (the launcher syncs them onto
// /opt/data on every boot). This module only builds the persona directive
// injected through onboarding/notify prompts.

export type Verbosity = 'brief' | 'balanced' | 'detailed';
export type Tone = 'professional' | 'friendly' | 'playful';

/** 3-axis personality, each an integer 0–100, sent on the onboard payload.
 *  Absent = treat every axis as 50 (balanced) = today's behavior. */
export interface Personality {
  tone: number; // 0 = direct / to-the-point … 100 = warm / personable
  detail: number; // 0 = concise / short … 100 = thorough / detailed
  style: number; // 0 = formal / professional … 100 = casual / playful
}

export interface PersonaSettings {
  personaName?: string | null;
  verbosity?: string | null;
  tone?: string | null;
  personality?: Personality | null;
}

export function isVerbosity(v: unknown): v is Verbosity {
  return v === 'brief' || v === 'balanced' || v === 'detailed';
}
export function isTone(t: unknown): t is Tone {
  return t === 'professional' || t === 'friendly' || t === 'playful';
}

function verbosityClause(v: string | null | undefined): string | null {
  switch (v) {
    case 'brief':
      return 'Brief — lead with the answer in as few words as it takes. Skip supporting detail unless the user asks for it. Never drop information that affects a decision (costs, deadlines, risks).';
    case 'balanced':
      return 'Balanced — answer first, then a sentence or two of the most useful context.';
    case 'detailed':
      return 'Detailed — give the answer, then the reasoning, relevant context, and the obvious next step. Still no padding or filler.';
    default:
      return null;
  }
}

function toneClause(t: string | null | undefined): string | null {
  switch (t) {
    case 'professional':
      return 'Professional — formal, no slang, no emoji.';
    case 'friendly':
      return 'Friendly — warm and conversational, still tight.';
    case 'playful':
      return 'Playful — casual, light humour, the occasional emoji is fine.';
    default:
      return null;
  }
}

// Bucketed clauses for the 0–100 personality axes (≤33 / 34–66 / ≥67).
const PERSONALITY_CLAUSES = {
  tone: {
    low: 'Be direct; skip pleasantries.',
    mid: 'Balance warmth and efficiency.',
    high: 'Be warm, friendly, personable.',
  },
  detail: {
    low: 'Keep it short; lead with the answer.',
    mid: 'Give a normal amount of detail.',
    high: 'Be thorough; explain your reasoning, add context.',
  },
  style: {
    low: 'Keep a formal, professional register.',
    mid: 'Use a relaxed-professional register.',
    high: 'Be casual and playful; light humour is fine.',
  },
} as const;

function clampAxis(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 50;
  return Math.max(0, Math.min(100, v));
}
function axisBucket(n: number): 'low' | 'mid' | 'high' {
  return n <= 33 ? 'low' : n <= 66 ? 'mid' : 'high';
}

/** Persona lines for the 3-axis personality. Empty when unset (= balanced =
 *  today's behavior); when present, every axis maps to its bucketed clause. */
function personalityLines(p: Personality | null | undefined): string[] {
  if (!p || typeof p !== 'object') return [];
  const tone = clampAxis((p as Partial<Personality>).tone);
  const detail = clampAxis((p as Partial<Personality>).detail);
  const style = clampAxis((p as Partial<Personality>).style);
  return [
    `- Warmth: ${PERSONALITY_CLAUSES.tone[axisBucket(tone)]}`,
    `- Detail: ${PERSONALITY_CLAUSES.detail[axisBucket(detail)]}`,
    `- Register: ${PERSONALITY_CLAUSES.style[axisBucket(style)]}`,
  ];
}

/**
 * Build the persona directive the agent stores under memory key
 * `user.persona` and applies to its voice. Returns '' when nothing is
 * set, so callers can inject it unconditionally without changing default
 * behavior — the whole feature is opt-in.
 *
 * Hard invariants (stated in the directive itself so the agent can't
 * over-apply the knobs): persona shapes VOICE only. It never changes
 * accuracy, the lead-with-the-answer structure, cost-gating before
 * spending credits, or correctness — and it never applies to anything
 * that leaves the user (drafted emails, task comments colleagues read,
 * documents), which stay professional regardless of tone.
 */
export function buildPersonaDirective(p: PersonaSettings): string {
  const lines: string[] = [];
  const name = typeof p.personaName === 'string' ? p.personaName.trim() : '';
  if (name) lines.push(`- Your name is "${name}". Refer to yourself by it; sign proactive messages with it.`);
  const v = verbosityClause(p.verbosity);
  if (v) lines.push(`- Response length: ${v}`);
  const t = toneClause(p.tone);
  if (t) lines.push(`- Tone: ${t}`);
  lines.push(...personalityLines(p.personality));
  if (lines.length === 0) return '';
  return `Persona settings the user chose for you — save them under memory key \
user.persona and ALWAYS apply them going forward:
${lines.join('\n')}

These shape your VOICE only. They never change your accuracy, your \
lead-with-the-answer structure, your cost-gating before spending credits, \
or the correctness of numbers and actions. And they never apply to \
anything that leaves the user — drafted emails, comments on tasks your \
colleagues will read, shared documents — those stay professional \
regardless of the tone setting. When a task prompt specifies an explicit \
output structure or format contract (required sections, quoted prompts, \
schemas), follow that contract exactly — persona trims prose, never \
required structure.`;
}
