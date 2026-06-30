import { describe, it, expect } from 'vitest';
import {
  tagFromRef,
  currentImageTag,
  findImageVersion,
  diffImageVersions,
  IMAGE_VERSIONS,
} from '../src/images/manifest.js';

describe('tagFromRef', () => {
  it('extracts the tag from a full registry ref', () => {
    expect(tagFromRef('registry.fly.io/hermes-user-image:v21')).toBe('v21');
  });
  it('passes a bare tag through', () => {
    expect(tagFromRef('v21')).toBe('v21');
  });
  it('ignores a registry port colon', () => {
    expect(tagFromRef('registry.fly.io:5000/img:v21')).toBe('v21');
  });
  it('returns null for a digest ref (no tag)', () => {
    expect(tagFromRef('registry.fly.io/img@sha256:abcdef0123456789')).toBeNull();
  });
  it('returns null for a repo with no tag', () => {
    expect(tagFromRef('registry.fly.io/hermes-user-image')).toBeNull();
  });
  it('returns null for empty/nullish', () => {
    expect(tagFromRef('')).toBeNull();
    expect(tagFromRef(null)).toBeNull();
    expect(tagFromRef(undefined)).toBeNull();
  });
});

describe('currentImageTag', () => {
  it('matches the live FLY_MACHINE_IMAGE by tag suffix', () => {
    expect(currentImageTag('registry.fly.io/hermes-user-image:v21')).toBe('v21');
  });
  it('returns null when no manifest entry matches', () => {
    expect(currentImageTag('registry.fly.io/hermes-user-image:v99')).toBeNull();
    expect(currentImageTag(null)).toBeNull();
  });
});

describe('diffImageVersions', () => {
  it('reports skills removed in the newer version (denylist grows)', () => {
    // v20 denies nothing; v21 denies 57. Comparing a=v20 → b=v21.
    const d = diffImageVersions('v20', 'v21');
    expect(d.skillsRemovedInB.length).toBe(findImageVersion('v21')!.deniedSkills.length);
    expect(d.skillsRemovedInB).toContain('claude-code');
    expect(d.skillsRestoredInB).toEqual([]);
  });
  it('reports skills restored when comparing the other direction', () => {
    const d = diffImageVersions('v21', 'v20');
    expect(d.skillsRestoredInB.length).toBe(findImageVersion('v21')!.deniedSkills.length);
    expect(d.skillsRemovedInB).toEqual([]);
  });
  it('flags scalar field changes (tool enforcement, base image)', () => {
    const d = diffImageVersions('v19', 'v20');
    expect(d.toolUseEnforcement).toEqual({ a: false, b: true, changed: true });
    expect(d.baseImage.changed).toBe(true);
  });
  it('marks unchanged scalars as not changed', () => {
    const d = diffImageVersions('v20', 'v21');
    expect(d.defaultModel.changed).toBe(false);
    expect(d.toolUseEnforcement.changed).toBe(false);
  });
  it('throws on an unknown tag', () => {
    expect(() => diffImageVersions('v20', 'nope')).toThrow();
  });
});

describe('IMAGE_VERSIONS', () => {
  it('has unique tags', () => {
    const tags = IMAGE_VERSIONS.map((v) => v.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
