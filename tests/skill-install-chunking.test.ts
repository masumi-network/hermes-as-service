import { describe, expect, it } from 'vitest';
import {
  buildInstallSteps,
  packInstallExecs,
  prepareSkill,
} from '../src/skills/install-on-machine.js';

const MAX_EXEC_BYTES = 24 * 1024;

function makePrepared(files: { path: string; contents: string }[]) {
  // prepareSkill sanitizes + requires a top-level SKILL.md; add one if missing.
  const hasSkillMd = files.some((f) => f.path.toLowerCase() === 'skill.md');
  const all = hasSkillMd ? files : [{ path: 'SKILL.md', contents: '# skill' }, ...files];
  return prepareSkill('seo-geo', all);
}

/** Reconstruct what the shell would produce, to prove correctness. */
function simulate(execs: string[]): Map<string, string> {
  const tmp = new Map<string, string>(); // path -> base64 text accumulator
  const files = new Map<string, string>(); // decoded final files (staging paths)
  for (const script of execs) {
    for (const line of script.split('\n')) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^: > "(.+)"$/))) tmp.set(m[1]!, '');
      else if ((m = line.match(/^printf %s '(.*)' >> "(.+)"$/))) tmp.set(m[2]!, (tmp.get(m[2]!) ?? '') + m[1]);
      else if ((m = line.match(/^base64 -d < "(.+)" > "(.+)"$/))) {
        files.set(m[2]!, Buffer.from(tmp.get(m[1]!) ?? '', 'base64').toString('utf8'));
      }
    }
  }
  return files;
}

describe('skill install chunking', () => {
  it('every exec command stays under the payload budget', () => {
    // A skill big enough to force many chunks (the seo-geo bug was ~114KB b64).
    const big = 'x'.repeat(90 * 1024);
    const prepared = makePrepared([
      { path: 'SKILL.md', contents: '# seo-geo\n' + big },
      { path: 'references/a.md', contents: 'y'.repeat(30 * 1024) },
    ]);
    const execs = packInstallExecs(buildInstallSteps(prepared));
    expect(execs.length).toBeGreaterThan(1);
    for (const e of execs) {
      expect(e.length).toBeLessThanOrEqual(MAX_EXEC_BYTES + 64); // + sentinel/header slack
    }
  });

  it('reconstructs every file byte-for-byte across chunk boundaries', () => {
    const prepared = makePrepared([
      { path: 'SKILL.md', contents: 'A'.repeat(50 * 1024) + '\nunicode: café ☕ 日本語' },
      { path: 'references/schema.md', contents: 'B'.repeat(20 * 1024) },
      { path: 'examples/case.md', contents: 'short file' },
    ]);
    const execs = packInstallExecs(buildInstallSteps(prepared));
    const decoded = simulate(execs);
    for (const f of prepared.files) {
      const staged = [...decoded.keys()].find((k) => k.endsWith(`/${f.path}`));
      expect(staged, `file ${f.path} materialized`).toBeTruthy();
      expect(decoded.get(staged!)).toBe(f.contents);
    }
  });

  it('rm+mv swap is a single last step, in the final exec, not split', () => {
    const prepared = makePrepared([{ path: 'SKILL.md', contents: 'z'.repeat(60 * 1024) }]);
    const steps = buildInstallSteps(prepared);
    // The destroy + swap are ONE step so they can never split across execs.
    expect(steps[steps.length - 1]).toMatch(/^rm -rf ".+" && mv ".+" ".+"$/);
    const execs = packInstallExecs(steps);
    expect(execs[execs.length - 1]).toContain('&& mv ');
    for (let i = 0; i < execs.length - 1; i++) expect(execs[i]).not.toContain('mv ');
  });

  it('the b64 temp lives outside the staging tree (no sibling-file collision)', () => {
    // A skill file whose name ends in .b64 must NOT be clobbered by the temp.
    const prepared = makePrepared([
      { path: 'SKILL.md', contents: '# s' },
      { path: 'data.b64', contents: 'AAAA' },
    ]);
    const decoded = simulate(packInstallExecs(buildInstallSteps(prepared)));
    const dataFile = [...decoded.keys()].find((k) => k.endsWith('/data.b64'));
    expect(dataFile, 'data.b64 survived').toBeTruthy();
    expect(decoded.get(dataFile!)).toBe('AAAA');
  });

  it('a tiny skill fits in a single exec', () => {
    const prepared = makePrepared([{ path: 'SKILL.md', contents: '# hi' }]);
    expect(packInstallExecs(buildInstallSteps(prepared)).length).toBe(1);
  });

  it('base64 chunks only ever contain base64 characters (no shell metachars)', () => {
    const prepared = makePrepared([{ path: 'SKILL.md', contents: "danger'; rm -rf / #".repeat(5000) }]);
    for (const step of buildInstallSteps(prepared)) {
      const m = step.match(/^printf %s '(.*)' >> /);
      if (m) expect(m[1]).toMatch(/^[A-Za-z0-9+/=]*$/);
    }
  });
});
