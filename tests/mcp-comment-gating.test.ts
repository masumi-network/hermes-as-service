import { describe, expect, it } from 'vitest';
import { confirmsAtMedium, toolsForAutonomy } from '../src/routes/sokosumi-mcp.js';

const findAt = (level: 'low' | 'medium' | 'high', name: string) =>
  toolsForAutonomy(level).find((t) => t.name === name);

describe('MCP comment gating (write-light)', () => {
  it('add_task_comment is blocked at low', () => {
    expect(findAt('low', 'sokosumi_add_task_comment')).toBeUndefined();
  });

  it('add_task_comment is available at medium + high as write-light', () => {
    expect(findAt('medium', 'sokosumi_add_task_comment')?.access).toBe('write-light');
    expect(findAt('high', 'sokosumi_add_task_comment')?.access).toBe('write-light');
  });

  it('write-light executes at medium (no confirmation); write + spend still confirm', () => {
    expect(confirmsAtMedium('write-light')).toBe(false);
    expect(confirmsAtMedium('read')).toBe(false);
    expect(confirmsAtMedium('write')).toBe(true);
    expect(confirmsAtMedium('spend')).toBe(true);
  });

  it('creating tasks and jobs stays gated at medium', () => {
    const createTask = findAt('medium', 'sokosumi_create_task');
    const createJob = findAt('medium', 'sokosumi_create_job');
    expect(createTask?.access).toBe('write');
    expect(createJob?.access).toBe('spend');
    expect(confirmsAtMedium(createTask!.access)).toBe(true);
    expect(confirmsAtMedium(createJob!.access)).toBe(true);
  });

  it('low autonomy is read-only (no write-light, write, or spend tools)', () => {
    for (const t of toolsForAutonomy('low')) expect(t.access).toBe('read');
  });
});
