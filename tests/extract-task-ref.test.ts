import { describe, it, expect } from 'vitest';
import { extractTaskRef } from '../src/confirmations/store.js';

describe('extractTaskRef', () => {
  const result = JSON.stringify({
    scope: 'personal',
    assignedTo: { id: 'cwk_1', slug: 'hannah', name: 'Hannah' },
    task: { id: 'task_abc123', status: 'READY', name: 'Research MoE' },
  });

  it('pulls taskId / taskStatus / taskTitle / coworker from a create_task result', () => {
    expect(extractTaskRef('sokosumi_create_task', result)).toEqual({
      taskId: 'task_abc123',
      taskStatus: 'READY',
      taskTitle: 'Research MoE',
      coworker: 'Hannah',
    });
  });

  it('returns {} for non-create_task tools', () => {
    expect(extractTaskRef('sokosumi_add_task_comment', result)).toEqual({});
  });

  it('returns {} for missing / unparseable result', () => {
    expect(extractTaskRef('sokosumi_create_task', undefined)).toEqual({});
    expect(extractTaskRef('sokosumi_create_task', 'not json')).toEqual({});
  });

  it('omits absent fields rather than emitting undefined', () => {
    const partial = JSON.stringify({ task: { id: 'task_x' } });
    expect(extractTaskRef('sokosumi_create_task', partial)).toEqual({ taskId: 'task_x' });
  });
});
