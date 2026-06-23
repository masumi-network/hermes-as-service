import { describe, it, expect } from 'vitest';
import { parseEnumOutput } from '../src/skills/preinstalled.js';

// Mirrors what the exec emits: \n===SKILL:<slug>===\n<frontmatter lines>
const STDOUT = [
  '',
  '===SKILL:daily-brief===',
  'name: Daily Brief',
  'description: Compiles a morning summary of inbox, calendar, and tasks.',
  '',
  '===SKILL:web-research===',
  'name: web-research',
  'description: "Searches the web and summarizes findings with sources."',
  '',
  '===SKILL:outbox-send===',
  'name: Outbox Send',
  'description: internal plumbing',
  '',
  '===SKILL:ads-google===',
  '',
  '===SKILL:no-desc===',
  'name: No Desc',
  'description: >',
  '',
  '===SKILL:daily-brief===',
  'name: duplicate should be ignored',
].join('\n');

describe('parseEnumOutput', () => {
  const skills = parseEnumOutput(STDOUT);
  const bySlug = Object.fromEntries(skills.map((s) => [s.slug, s]));

  it('parses name + description from frontmatter', () => {
    expect(bySlug['daily-brief']).toEqual({
      slug: 'daily-brief',
      name: 'Daily Brief',
      description: 'Compiles a morning summary of inbox, calendar, and tasks.',
    });
  });

  it('humanizes a kebab-case frontmatter name and strips quotes from description', () => {
    expect(bySlug['web-research'].name).toBe('Web Research');
    expect(bySlug['web-research'].description).toBe('Searches the web and summarizes findings with sources.');
  });

  it('humanizes the slug when there is no frontmatter at all', () => {
    expect(bySlug['ads-google']).toEqual({ slug: 'ads-google', name: 'Ads Google', description: null });
  });

  it('treats a block-scalar / empty description as null', () => {
    expect(bySlug['no-desc'].description).toBeNull();
    expect(bySlug['no-desc'].name).toBe('No Desc');
  });

  it('excludes internal plumbing skills (outbox-send)', () => {
    expect(bySlug['outbox-send']).toBeUndefined();
  });

  it('dedupes repeated slugs (first wins)', () => {
    expect(skills.filter((s) => s.slug === 'daily-brief')).toHaveLength(1);
  });

  it('returns the list sorted by display name', () => {
    const names = skills.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('handles empty output', () => {
    expect(parseEnumOutput('')).toEqual([]);
  });
});
