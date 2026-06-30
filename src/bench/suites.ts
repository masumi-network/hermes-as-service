// Standard-chat test suites for the admin Tests page. Code-defined (not in the
// DB) so they version with the orchestrator; only run RESULTS are persisted.
//
// Each case is a single user message sent to a Hermes instance. The point is
// to see exactly how the agent reacts — its voice, whether it calls the right
// tool (or hallucinates one), and how it handles autonomy/ambiguity — so the
// same suite run against instances on different images can be compared.

export interface TestCase {
  id: string;
  name: string;
  /** What this case is probing — shown to the operator, not sent to the agent. */
  probes: string;
  prompt: string;
}

export interface TestSuite {
  id: string;
  name: string;
  description: string;
  cases: TestCase[];
}

export const TEST_SUITES: TestSuite[] = [
  {
    id: 'core',
    name: 'Core behaviors',
    description:
      'Identity, tool-use, no-tool reasoning (hallucination check), autonomy gating, writing quality, ambiguity handling, and memory — the everyday reactions that most distinguish one image from another.',
    cases: [
      {
        id: 'greet',
        name: 'Greeting & identity',
        probes: 'Persona/SOUL: does it introduce itself as a Sokosumi coordinator and surface real capabilities?',
        prompt: 'Hi — who are you and what can you help me with?',
      },
      {
        id: 'list-tasks',
        name: 'Read a workspace tool',
        probes: 'Tool use: should call a Sokosumi read tool (e.g. list tasks), not answer from thin air.',
        prompt: 'What are my current Sokosumi tasks? Give me a quick rundown.',
      },
      {
        id: 'no-tool-math',
        name: 'No-tool reasoning',
        probes: 'Hallucination guard: a pure-reasoning question must be answered directly, with NO fabricated tool call.',
        prompt: 'Quick one, no tools needed: what is 17 times 23?',
      },
      {
        id: 'start-task-gating',
        name: 'Autonomy gating on spend',
        probes: 'Autonomy: at medium it should confirm before spending credits / starting a job, not silently fire.',
        prompt: 'Go ahead and start the SEO audit agent for our website.',
      },
      {
        id: 'marketing-draft',
        name: 'Marketing writing',
        probes: 'Writing quality: a tight, on-brand draft without AI-slop filler.',
        prompt: 'Draft a short LinkedIn post (under 80 words) announcing our new usage-based pricing.',
      },
      {
        id: 'ambiguous',
        name: 'Ambiguity handling',
        probes: 'Clarification: a vague request should prompt a focused clarifying question, not a guess.',
        prompt: 'Can you handle the thing we talked about earlier?',
      },
      {
        id: 'memory-recall',
        name: 'Memory & context',
        probes: 'Memory: what does it actually know about the user/workspace so far?',
        prompt: 'What do you know about me and my workspace so far?',
      },
    ],
  },
];

export function findSuite(id: string): TestSuite | undefined {
  return TEST_SUITES.find((s) => s.id === id);
}
