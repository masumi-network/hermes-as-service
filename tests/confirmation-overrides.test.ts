import { describe, it, expect } from 'vitest';
import { _applyApprovalOverridesForTests as apply } from '../src/confirmations/store.js';

describe('applyApprovalOverrides — substitution rules', () => {
  describe('sokosumi_create_task (org-aware)', () => {
    it('substitutes organization_id when override is a string', () => {
      const out = apply(
        'sokosumi_create_task',
        { name: 'task', coworker_id: 'cw_1', organization_id: 'old_org' },
        { organizationId: 'new_org' },
      );
      expect(out['organization_id']).toBe('new_org');
      expect(out['name']).toBe('task');
      expect(out['coworker_id']).toBe('cw_1');
    });

    it('inserts organization_id when args had none', () => {
      const out = apply(
        'sokosumi_create_task',
        { name: 'task', coworker_id: 'cw_1' },
        { organizationId: 'new_org' },
      );
      expect(out['organization_id']).toBe('new_org');
    });

    it('deletes organization_id when override is null (personal scope)', () => {
      const out = apply(
        'sokosumi_create_task',
        { name: 'task', coworker_id: 'cw_1', organization_id: 'old_org' },
        { organizationId: null },
      );
      expect('organization_id' in out).toBe(false);
      expect(out['name']).toBe('task');
    });

    it('null override is a no-op when args already had no org', () => {
      const out = apply(
        'sokosumi_create_task',
        { name: 'task', coworker_id: 'cw_1' },
        { organizationId: null },
      );
      expect('organization_id' in out).toBe(false);
    });

    it('does NOT mutate the original args object', () => {
      const original = { name: 'task', coworker_id: 'cw_1', organization_id: 'old' };
      const out = apply('sokosumi_create_task', original, { organizationId: 'new' });
      expect(original['organization_id']).toBe('old');
      expect(out['organization_id']).toBe('new');
      expect(out).not.toBe(original);
    });
  });

  describe('sokosumi_create_job (org-aware)', () => {
    it('substitutes organization_id like create_task', () => {
      const out = apply(
        'sokosumi_create_job',
        { agent_id: 'a1', task_id: 't1', organization_id: 'old_org' },
        { organizationId: 'new_org' },
      );
      expect(out['organization_id']).toBe('new_org');
    });
  });

  describe('non-org-aware tools', () => {
    it('drops the override for sokosumi_add_task_comment', () => {
      const args = { task_id: 't1', comment: 'hello' };
      const out = apply('sokosumi_add_task_comment', args, { organizationId: 'new_org' });
      expect(out).toEqual(args);
    });

    it('drops the override for sokosumi_provide_job_input', () => {
      const args = { job_id: 'j1', inputs: {} };
      const out = apply('sokosumi_provide_job_input', args, { organizationId: 'new_org' });
      expect(out).toEqual(args);
    });

    it('drops the override for sokosumi_refund_job', () => {
      const args = { job_id: 'j1' };
      const out = apply('sokosumi_refund_job', args, { organizationId: 'new_org' });
      expect(out).toEqual(args);
    });

    it('drops the override for unknown tools (forward-compat)', () => {
      const args = { foo: 'bar' };
      const out = apply('totally_new_tool', args, { organizationId: 'new_org' });
      expect(out).toEqual(args);
    });
  });

  describe('no-override paths', () => {
    it('returns args unchanged when overrides is undefined', () => {
      const args = { name: 'task', organization_id: 'old' };
      const out = apply('sokosumi_create_task', args, undefined);
      expect(out).toBe(args);
    });

    it('returns args unchanged when overrides has no organizationId key', () => {
      const args = { name: 'task', organization_id: 'old' };
      const out = apply('sokosumi_create_task', args, {} as never);
      expect(out).toBe(args);
    });
  });
});
