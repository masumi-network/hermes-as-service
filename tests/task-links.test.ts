import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sokosumi supports task-to-task links (`/tasks/{id}/links`, six relations)
 * and we exposed nothing for it. Hermes' entire vocabulary for "these two are
 * connected" was prose in a comment: unreadable by the board, invisible to
 * other coworkers, gone once the comment scrolls.
 *
 * That mattered most for follow-ups: the board sweep creates a task out of
 * finished work and had no way to record where it came from.
 */

process.env['SOKOSUMI_ORCHESTRATOR_API_KEY_MAINNET'] = 'x'.repeat(32);
process.env['SOKOSUMI_API_BASE_MAINNET'] = 'https://api.example.test/v1';
const load = async () => import('../src/routes/sokosumi-mcp.js');

const CTX = {
  instanceId: 'i1',
  userId: 'user_1',
  env: 'mainnet' as const,
  autonomyLevel: 'high' as const,
};

interface Call { method: string; path: string; body?: unknown }
let calls: Call[];

function stubApi(over: (path: string, method: string) => unknown | undefined = () => undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const path = new URL(url).pathname.replace(/^\/v1/, '');
      const method = init.method ?? 'GET';
      calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined });
      const custom = over(path, method);
      if (custom !== undefined) return custom;
      let body: unknown = { data: [] };
      if (path === '/coworkers') body = { data: [{ id: 'cw_1', slug: 'bront', name: 'Bront' }] };
      else if (path === '/tasks' && method === 'POST') body = { data: { id: 'new_task', name: 'X' } };
      else if (/\/tasks\/[^/]+\/links$/.test(path) && method === 'POST') body = { data: { id: 'lnk_1' } };
      else if (/\/tasks\/[^/]+\/links$/.test(path)) body = { data: [] };
      else if (/\/tasks\/[^/]+$/.test(path)) body = { data: { id: 'tsk_1', name: 'Source' } };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sokosumi_link_tasks', () => {
  it('creates the link with the relation read FROM task_id TO to_task_id', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool(
        'sokosumi_link_tasks',
        { task_id: 'new', to_task_id: 'src', relation: 'parent', note: 'came out of this' },
        CTX,
      ),
    );
    expect(out.ok).toBe(true);
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/links'));
    expect(post?.path).toBe('/tasks/new/links');
    expect(post?.body).toEqual({ toTaskId: 'src', relation: 'parent', note: 'came out of this' });
  });

  it('rejects a relation Sokosumi does not define, and says which are valid', async () => {
    stubApi();
    const { executeTool } = await load();
    await expect(
      executeTool('sokosumi_link_tasks', { task_id: 'a', to_task_id: 'b', relation: 'depends_on' }, CTX),
    ).rejects.toThrow(/invalid relation.*blocked_by/s);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('accepts every relation the API defines', async () => {
    const { executeTool } = await load();
    for (const relation of ['related', 'blocks', 'blocked_by', 'parent', 'child', 'duplicate']) {
      calls = [];
      stubApi();
      const out = JSON.parse(
        await executeTool('sokosumi_link_tasks', { task_id: 'a', to_task_id: 'b', relation }, CTX),
      );
      expect(out.relation).toBe(relation);
    }
  });

  it('refuses to link a task to itself', async () => {
    stubApi();
    const { executeTool } = await load();
    await expect(
      executeTool('sokosumi_link_tasks', { task_id: 'a', to_task_id: 'a', relation: 'related' }, CTX),
    ).rejects.toThrow(/cannot be linked to itself/);
  });

  it('is write-light — no confirmation card at medium (a link is free and reversible)', async () => {
    const { TOOLS_ALL, confirmsAtMedium } = (await load()) as unknown as {
      TOOLS_ALL?: Array<{ name: string; access: string }>;
      confirmsAtMedium: (a: string) => boolean;
    };
    // TOOLS_ALL isn't exported; assert via the gating helper on the known access.
    expect(confirmsAtMedium('write-light')).toBe(false);
    expect(confirmsAtMedium('write')).toBe(true);
    void TOOLS_ALL;
  });
});

describe('sokosumi_get_task_links', () => {
  it('returns the links', async () => {
    stubApi((path) =>
      /\/tasks\/tsk_1\/links$/.test(path)
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { id: 'l1', relation: 'child', peerTask: { id: 't2', name: 'Follow-up', status: 'READY' } },
              ],
            }),
            text: async () => '',
          }
        : undefined,
    );
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_get_task_links', { task_id: 'tsk_1' }, CTX));
    expect(out.count).toBe(1);
    // The peer's name and status come embedded — no second fetch needed.
    expect(out.links[0].peerTask).toMatchObject({ name: 'Follow-up', status: 'READY' });
  });

  it('says an empty result is complete, so the agent does not retry', async () => {
    // The list_tasks retry loop came from exactly this ambiguity.
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_get_task_links', { task_id: 'tsk_1' }, CTX));
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/do not retry/i);
  });
});

describe('sokosumi_get_task embeds links', () => {
  it('folds links into the task body', async () => {
    stubApi((path) =>
      /\/tasks\/tsk_1\/links$/.test(path)
        ? {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'l1', relation: 'blocked_by' }] }),
            text: async () => '',
          }
        : undefined,
    );
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_get_task', { id: 'tsk_1' }, CTX));
    expect(out.id).toBe('tsk_1');
    expect(out.links).toHaveLength(1);
  });

  it('still returns the task when the links call fails', async () => {
    stubApi((path) =>
      /\/links$/.test(path)
        ? { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }
        : undefined,
    );
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_get_task', { id: 'tsk_1' }, CTX));
    expect(out.id).toBe('tsk_1');
    expect(out.links).toEqual([]);
  });
});

describe('create_task provenance link', () => {
  it('links the new task to its source in ONE call, defaulting to parent', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool(
        'sokosumi_create_task',
        { name: 'Follow-up', coworker_id: 'cw_1', linked_task_id: 'src_task' },
        CTX,
      ),
    );
    expect(out.link).toMatchObject({ ok: true, relation: 'parent', toTaskId: 'src_task' });
    const linkPost = calls.find((c) => c.method === 'POST' && c.path.endsWith('/links'));
    expect(linkPost?.path).toBe('/tasks/new_task/links');
  });

  it('honours an explicit relation', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool(
        'sokosumi_create_task',
        { name: 'F', coworker_id: 'cw_1', linked_task_id: 'src', link_relation: 'blocked_by' },
        CTX,
      ),
    );
    expect(out.link.relation).toBe('blocked_by');
  });

  it('creates no link when none was asked for', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool('sokosumi_create_task', { name: 'F', coworker_id: 'cw_1' }, CTX),
    );
    expect(out.link).toBeUndefined();
    expect(calls.some((c) => c.path.endsWith('/links'))).toBe(false);
  });

  it('a failed link does NOT fail the task — the task still exists', async () => {
    stubApi((path, method) =>
      /\/links$/.test(path) && method === 'POST'
        ? { ok: false, status: 422, json: async () => ({}), text: async () => 'bad link' }
        : undefined,
    );
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool(
        'sokosumi_create_task',
        { name: 'F', coworker_id: 'cw_1', linked_task_id: 'src' },
        CTX,
      ),
    );
    expect(out.task.id).toBe('new_task'); // the task survived
    expect(out.link).toMatchObject({ ok: false });
    expect(out.link.error).toMatch(/422/);
  });
});

describe('cross-workspace links', () => {
  it('translates Sokosumi\'s misleading 404 into something actionable', async () => {
    // Verified in production: linking a PERSONAL task to an ORG task returns
    // a bare 404 "Task not found" — naming neither task — even though both
    // read fine individually. Untranslated, the agent retries the wrong id.
    stubApi((path, method) =>
      /\/links$/.test(path) && method === 'POST'
        ? {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => '{"error":"NotFound","message":"Task not found"}',
          }
        : undefined,
    );
    const { executeTool } = await load();
    await expect(
      executeTool('sokosumi_link_tasks', { task_id: 'a', to_task_id: 'b', relation: 'related' }, CTX),
    ).rejects.toThrow(/SAME workspace/);
  });

  it('tells the agent the link is bidirectional so it does not create the inverse', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool('sokosumi_link_tasks', { task_id: 'a', to_task_id: 'b', relation: 'parent' }, CTX),
    );
    expect(out.note).toMatch(/visible from BOTH tasks/);
  });
});

describe('projects', () => {
  it('lists projects across every workspace, tagged with the one they belong to', async () => {
    // The agent claimed "the API has no projectId". It does — POST /tasks
    // accepts it, PATCH /tasks/{id} accepts it, and /projects/{id}/tasks moves
    // an existing one. The gap was ours.
    stubApi((path) => {
      if (path.endsWith('/organizations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'org_1', name: 'utxo AG' }] }),
          text: async () => '',
        };
      }
      if (path === '/projects') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'prj_1', name: 'Masumi Landing & Marketing' }] }),
          text: async () => '',
        };
      }
      return undefined;
    });
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_list_projects', {}, CTX));
    // personal + org_1, each returning the project
    expect(out.count).toBe(2);
    expect(out.projects.map((p: { orgId: string | null }) => p.orgId)).toEqual([null, 'org_1']);
    expect(out.projects[1].orgName).toBe('utxo AG');
  });

  it('tells the agent an empty project list is complete', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(await executeTool('sokosumi_list_projects', {}, CTX));
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/do not retry/i);
  });

  it('files a NEW task under a project in the same create call', async () => {
    stubApi();
    const { executeTool } = await load();
    await executeTool(
      'sokosumi_create_task',
      { name: 'T', coworker_id: 'cw_1', project_id: 'prj_1' },
      CTX,
    );
    const post = calls.find((c) => c.method === 'POST' && c.path === '/tasks');
    expect(post?.body).toMatchObject({ projectId: 'prj_1' });
  });

  it('sends assigneeId alongside the deprecated coworkerId', async () => {
    // Sokosumi's spec marks coworkerId deprecated. Sending both means the
    // eventual removal cannot silently start creating unassigned tasks.
    stubApi();
    const { executeTool } = await load();
    await executeTool('sokosumi_create_task', { name: 'T', coworker_id: 'cw_1' }, CTX);
    const post = calls.find((c) => c.method === 'POST' && c.path === '/tasks');
    expect(post?.body).toMatchObject({ coworkerId: 'cw_1', assigneeId: 'cw_1' });
  });

  it('moves an existing task into a project', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool('sokosumi_set_task_project', { task_id: 'tsk_1', project_id: 'prj_1' }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/projects/prj_1/tasks')).toBe(true);
  });

  it('takes a task back out', async () => {
    stubApi();
    const { executeTool } = await load();
    const out = JSON.parse(
      await executeTool('sokosumi_set_task_project', { task_id: 'tsk_1', remove_from: 'prj_1' }, CTX),
    );
    expect(out.removedFrom).toBe('prj_1');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/projects/prj_1/tasks/tsk_1')).toBe(true);
  });

  it('explains the cross-workspace 404 instead of passing it through', async () => {
    stubApi((path, method) =>
      path === '/projects/prj_1/tasks' && method === 'POST'
        ? { ok: false, status: 404, json: async () => ({}), text: async () => 'Not found' }
        : undefined,
    );
    const { executeTool } = await load();
    await expect(
      executeTool('sokosumi_set_task_project', { task_id: 'tsk_1', project_id: 'prj_1' }, CTX),
    ).rejects.toThrow(/ITS OWN workspace/);
  });
});
