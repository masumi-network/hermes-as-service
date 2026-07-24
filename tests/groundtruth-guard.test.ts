import { describe, it, expect } from 'vitest';
import { detectUnverifiedWriteClaim } from '../src/notifications/groundtruth-guard.js';

describe('detectUnverifiedWriteClaim', () => {
  // These MUST be flagged — the agent asserts a completed Sokosumi write.
  const positives: [string, string][] = [
    [
      'the real Elena incident',
      "Let me answer her. Here's what I told Elena: 1. Full marketing site. That was the last of the 6 — all unblocked now.",
    ],
    ['told a named coworker', 'I told Hannah the greeting is for the platform UI.'],
    ['answered a named coworker', 'I answered Maya with the scope details.'],
    ['replied to a named coworker', 'I replied to Hepha with the go-ahead.'],
    ['left a comment', "I've left Elena a comment explaining the scope."],
    ['added a comment', 'I added a comment to the task with the deadline.'],
    ['posted a comment', 'I posted a comment for the coworker.'],
    ['bare commented', 'I commented on the task with the missing context.'],
    ['commented on the', 'Done — commented on the task so she can proceed.'],
    ['moved to status', 'I moved it to READY so Maya can start.'],
    ['set the status', 'I set the status to COMPLETED for you.'],
    ['created the task', 'I created the task and assigned it to Hannah.'],
    ['kicked off the job', "I've kicked off the job for the redesign."],
    ['provided input', 'I provided the required input she was blocked on.'],
  ];

  // These MUST NOT be flagged — intent, negation, questions, or talking to the
  // user (not a task write).
  const negatives: [string, string][] = [
    ['future intent', "I'll comment on the task once you confirm the scope."],
    ['let me', 'Let me comment on it and unblock her.'],
    ['can (modal)', 'I can comment on the task if you want.'],
    ['question', 'Should I comment on the task to unblock Elena?'],
    ['want me to', 'Want me to leave a comment for her?'],
    ['negation couldnt', "I couldn't comment because the task was parked."],
    ['negation didnt', "I didn't comment yet — waiting on your call."],
    ['negation havent', "I haven't commented on it; need your decision first."],
    ['told YOU (user, not coworker)', "I told you the job costs 5 credits."],
    ['answered your question', 'I answered your question above about pricing.'],
    ['plain status update', 'The task is still waiting on your decision.'],
    ['going to tell', "I'm going to tell Elena once you decide."],
    ['need to', 'I need to comment but the tool errored out.'],
    ['no claim at all', "Here's a summary of what Elena is asking about scope."],
  ];

  for (const [label, text] of positives) {
    it(`flags: ${label}`, () => {
      expect(detectUnverifiedWriteClaim(text)).not.toBeNull();
    });
  }

  for (const [label, text] of negatives) {
    it(`ignores: ${label}`, () => {
      expect(detectUnverifiedWriteClaim(text)).toBeNull();
    });
  }

  it('returns null on empty input', () => {
    expect(detectUnverifiedWriteClaim('')).toBeNull();
  });
});
