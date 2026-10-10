import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { DEFAULT_TAG_COLOR, TAG_COUNT_LIMIT, TAG_NAME_LIMIT } from '../src/lib/tags';
import type { RunStatus, TagInput, TaskInput } from '../src/lib/types';

const BASE = 1_700_000_000_000;
const ORIGIN = 'http://127.0.0.1:4310';
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
const input = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Inspect project', instruction: 'Review this project.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
function connect() {
  store = new Store(join(folder, 'tags.sqlite'));
  engine = new Engine(store, true, () => { throw new Error('Tag writes must not launch an agent'); });
  handler = createHandler(engine, { port: 4310, root: folder });
}
async function reopen() { await engine.shutdown(); store.close(); connect(); }
const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
  body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
}));
function expectError(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'brigd-tags-')); connect(); });
afterEach(async () => { await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true }); });

describe('persistent tag library', () => {
  test('creates, renames, assigns and deletes tags across database reopens', async () => {
    expect(store.listTags()).toEqual([]);
    const first = store.createTag({ name: '  Работа  ' }, BASE);
    const second = store.createTag({ name: 'Личное' }, BASE);
    const task = store.createTask(input({ tagIds: [second.id, first.id, second.id] }), BASE);
    expect(first).toEqual({ id: first.id, name: 'Работа', color: DEFAULT_TAG_COLOR, createdAt: BASE, updatedAt: BASE });
    expect(task.tagIds).toEqual([second.id, first.id]);
    expect(task.tags).toEqual([second, first]);
    const renamed = store.updateTag(first.id, { name: '  Проект  ' }, BASE + 1);
    expect(store.getTask(task.id).tags).toEqual([second, renamed]);
    await reopen();
    expect(store.listTags()).toEqual([renamed, second]);
    expect(store.detail(task.id).task.tags).toEqual([second, renamed]);
    store.deleteTag(second.id);
    expect(store.getTask(task.id).tagIds).toEqual([first.id]);
    expect(store.db.query('SELECT * FROM task_tags WHERE tag_id=?').all(second.id)).toEqual([]);
    await reopen();
    expect(store.listTags()).toEqual([renamed]);
    expect(store.getTask(task.id).tags).toEqual([renamed]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expectError(() => store.getTag(second.id), 404);
    expectError(() => store.updateTag(second.id, { name: 'Missing' }), 404);
    expectError(() => store.deleteTag(second.id), 404);
  });

  test('rejects duplicate Unicode names without changing tags or assignments', async () => {
    const first = store.createTag({ name: '  РАБОТА ' }, BASE);
    const second = store.createTag({ name: 'Other' }, BASE);
    const task = store.createTask(input({ tagIds: [first.id] }));
    for (const name of ['работа', ' Работа ', 'РАБОТА']) {
      expectError(() => store.createTag({ name }), 409);
      expectError(() => store.updateTag(second.id, { name }), 409);
      expect((await request('/api/tags', 'POST', { name })).status).toBe(409);
      expect((await request(`/api/tags/${second.id}`, 'PATCH', { name })).status).toBe(409);
    }
    store.createTag({ name: 'Café' });
    expectError(() => store.createTag({ name: 'CAFE\u0301' }), 409);
    expect(store.getTask(task.id).tags).toEqual([first]);
    expect(store.getTag(second.id)).toEqual(second);
    expect(store.updateTag(first.id, { name: 'Работа' }).name).toBe('Работа');
  });

  test.each([
    null, [], false, 'name', {}, { name: '' }, { name: ' \n\t ' }, { name: 1 }, { name: null },
    { name: 'a\0b' }, { name: 'я'.repeat(TAG_NAME_LIMIT + 1) }, { name: 'Name', id: 'custom' },
    { name: 'Name', createdAt: BASE }, { name: 'Name', color: 'red' },
  ].map((value, index) => ({ value, index })))('rejects invalid names and unknown fields: case $index', async ({ value }) => {
    const tag = store.createTag({ name: 'Existing' }, BASE);
    expectError(() => store.createTag(value as TagInput), 400);
    expectError(() => store.updateTag(tag.id, value as TagInput), 400);
    expect((await request('/api/tags', 'POST', value)).status).toBe(400);
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', value)).status).toBe(400);
    expect(store.listTags()).toEqual([tag]);
  });

  test('accepts the exact name limit and enforces library capacity atomically', () => {
    const first = store.createTag({ name: 'я'.repeat(TAG_NAME_LIMIT) }, BASE);
    for (let index = 1; index < TAG_COUNT_LIMIT; index++) store.createTag({ name: `Tag ${index}` }, BASE);
    expectError(() => store.createTag({ name: 'One too many' }), 409);
    expect(store.listTags()).toHaveLength(TAG_COUNT_LIMIT);
    expect(store.updateTag(first.id, { name: 'Still editable' }).name).toBe('Still editable');
    store.deleteTag(first.id);
    expect(store.createTag({ name: 'Space freed' }).name).toBe('Space freed');
    expect(store.listTags()).toHaveLength(TAG_COUNT_LIMIT);
  });
});

describe('tag colors', () => {
  test('defaults old clients to the shared color and normalizes arbitrary full HEX colors', async () => {
    const fallback = store.createTag({ name: 'Default' }, BASE);
    expect(fallback.color).toBe(DEFAULT_TAG_COLOR);
    const defaultResponse = await request('/api/tags', 'POST', { name: 'HTTP default' });
    expect(defaultResponse.status).toBe(201);
    expect((await defaultResponse.json()).color).toBe(DEFAULT_TAG_COLOR);
    const custom = store.createTag({ name: 'Custom', color: '#09ABeF' }, BASE + 1);
    expect(custom.color).toBe('#09abef');
    const customResponse = await request('/api/tags', 'POST', { name: 'HTTP custom', color: '#ABCDEF' });
    expect(customResponse.status).toBe(201);
    expect((await customResponse.json()).color).toBe('#abcdef');
    expect(store.createTag({ name: 'Black', color: '#000000' }).color).toBe('#000000');
    expect(store.createTag({ name: 'White', color: '#FFFFFF' }).color).toBe('#ffffff');
    const task = store.createTask(input({ tagIds: [custom.id] }), BASE + 2);
    await reopen();
    expect(store.getTag(custom.id)).toEqual(custom);
    expect(store.detail(task.id).task.tags).toEqual([custom]);
  });

  test('patches color, name or both while preserving omitted fields and linked tasks', async () => {
    const original = store.createTag({ name: 'Original', color: '#123456' }, BASE);
    const task = store.createTask(input({ tagIds: [original.id] }), BASE);
    const renamed = store.updateTag(original.id, { name: '  Renamed  ' }, BASE + 1);
    expect(renamed).toEqual({ ...original, name: 'Renamed', updatedAt: BASE + 1 });
    const recolored = store.updateTag(original.id, { color: '#FA09BC' }, BASE + 2);
    expect(recolored).toEqual({ ...renamed, color: '#fa09bc', updatedAt: BASE + 2 });
    const changed = store.updateTag(original.id, { name: 'Both', color: '#FEDCBA' }, BASE + 3);
    expect(changed).toEqual({ ...recolored, name: 'Both', color: '#fedcba', updatedAt: BASE + 3 });
    expect((await request(`/api/tags/${original.id}`, 'PATCH', { color: '#02AB67' })).status).toBe(200);
    expect(store.getTag(original.id)).toMatchObject({ name: 'Both', color: '#02ab67' });
    expect((await request(`/api/tags/${original.id}`, 'PATCH', { name: 'HTTP name' })).status).toBe(200);
    expect(store.getTag(original.id)).toMatchObject({ name: 'HTTP name', color: '#02ab67' });
    expect((await request(`/api/tags/${original.id}`, 'PATCH', { name: 'HTTP both', color: '#BA9876' })).status).toBe(200);
    const final = store.getTag(original.id);
    expect(final).toMatchObject({ id: original.id, name: 'HTTP both', color: '#ba9876', createdAt: BASE });
    expect(store.getTask(task.id)).toMatchObject({ tagIds: [original.id], tags: [final], updatedAt: BASE });
    await reopen();
    expect(store.getTag(original.id)).toEqual(final);
    expect(store.getTask(task.id).tags).toEqual([final]);
  });

  test.each([null, '', 'red', '#abc', '#12345678', '123456', ' #123456', '#123456 ', '#GGGGGG', 'var(--color)', true, 123, ['#123456'], {}]
    .map((color, index) => ({ color, index })))('rejects invalid colors atomically: case $index', async ({ color }) => {
    const tag = store.createTag({ name: 'Existing', color: '#123456' }, BASE);
    const task = store.createTask(input({ tagIds: [tag.id] }), BASE);
    const value = { name: 'Must roll back', color } as unknown as TagInput;
    expectError(() => store.createTag(value), 400);
    expectError(() => store.updateTag(tag.id, value, BASE + 1), 400);
    expectError(() => store.updateTag(tag.id, { color } as Partial<TagInput>, BASE + 1), 400);
    expect((await request('/api/tags', 'POST', value)).status).toBe(400);
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', value)).status).toBe(400);
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', { color })).status).toBe(400);
    expect(store.listTags()).toEqual([tag]);
    expect(store.getTask(task.id)).toEqual(task);
  });

  test('rejects empty patches, unknown fields, explicit undefined and color-only creation', async () => {
    const tag = store.createTag({ name: 'Existing', color: '#123456' }, BASE);
    expectError(() => store.createTag({ name: 'Undefined', color: undefined }), 400);
    for (const patch of [{}, { color: undefined }, { color: '#abcdef', id: 'injected' }, { name: 'Changed', extra: true }]) {
      expectError(() => store.updateTag(tag.id, patch as Partial<TagInput>), 400);
    }
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', {})).status).toBe(400);
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', { color: '#abcdef', id: 'injected' })).status).toBe(400);
    expect((await request('/api/tags', 'POST', { color: '#abcdef' })).status).toBe(400);
    expect(store.listTags()).toEqual([tag]);
  });

  test('duplicate-name failures also roll back a simultaneous color change', async () => {
    store.createTag({ name: 'Работа' }, BASE);
    const tag = store.createTag({ name: 'Other', color: '#123456' }, BASE);
    const patch = { name: 'РАБОТА', color: '#abcdef' };
    expectError(() => store.updateTag(tag.id, patch), 409);
    expect((await request(`/api/tags/${tag.id}`, 'PATCH', patch)).status).toBe(409);
    expect(store.getTag(tag.id)).toEqual(tag);
  });

  test('additive color migration preserves previous tag rows, assignments and timestamps on repeated reopen', () => {
    const path = join(folder, 'tags-before-colors.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL, provider TEXT NOT NULL,
        cwd TEXT NOT NULL, schedule TEXT NOT NULL, interval_minutes INTEGER, first_run_at INTEGER, next_run_at INTEGER,
        paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE tags (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        name_key TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE task_tags (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY(task_id,tag_id));
      INSERT INTO tasks VALUES ('linked-task','Linked task','Original instruction','codex','/tmp','manual',NULL,NULL,NULL,0,${BASE},${BASE + 1});
      INSERT INTO tags VALUES (42,'old-tag','Старый тег','старый тег',${BASE},${BASE + 2});
      INSERT INTO task_tags VALUES ('linked-task','old-tag',0);
    `);
    const oldTag = legacy.query('SELECT * FROM tags').all();
    const oldLinks = legacy.query('SELECT * FROM task_tags').all();
    const oldTask = legacy.query('SELECT * FROM tasks').all();
    const taskColumns = (legacy.query('PRAGMA table_info(tasks)').all() as { name: string }[]).map(row => row.name).join(',');
    legacy.close();
    for (let pass = 0; pass < 2; pass++) {
      const migrated = new Store(path);
      try {
        expect(migrated.db.query('SELECT seq,id,name,name_key,created_at,updated_at FROM tags').all()).toEqual(oldTag);
        expect(migrated.db.query('SELECT * FROM task_tags').all()).toEqual(oldLinks);
        expect(migrated.db.query(`SELECT ${taskColumns} FROM tasks`).all()).toEqual(oldTask);
        const tag = { id: 'old-tag', name: 'Старый тег', color: DEFAULT_TAG_COLOR, createdAt: BASE, updatedAt: BASE + 2 };
        expect(migrated.getTag('old-tag')).toEqual(tag);
        expect(migrated.getTask('linked-task').tags).toEqual([tag]);
        expect((migrated.db.query('PRAGMA table_info(tags)').all() as { name: string }[]).filter(column => column.name === 'color')).toHaveLength(1);
        expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { migrated.close(); }
    }
  });
});

describe('task tag assignments', () => {
  test('omitted tag IDs preserve assignments on edit; empty IDs clear them', async () => {
    const tag = store.createTag({ name: 'Work' });
    const task = store.createTask(input({ tagIds: [tag.id] }), BASE);
    expect(store.updateTask(task.id, input({ title: 'Edited' }), BASE + 1).tagIds).toEqual([tag.id]);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Edited again' })).status).toBe(200);
    expect(store.getTask(task.id).tags).toEqual([tag]);
    expect(store.updateTask(task.id, input({ tagIds: [] })).tags).toEqual([]);
  });

  test('unknown IDs roll back create, full edit and metadata edit atomically', async () => {
    const tag = store.createTag({ name: 'Existing' });
    const task = store.createTask(input({ tagIds: [tag.id] }), BASE);
    const unknown = [tag.id, 'missing-tag'];
    expectError(() => store.createTask(input({ tagIds: unknown })), 400);
    expectError(() => store.updateTask(task.id, input({ title: 'Must roll back', tagIds: unknown }), BASE + 1), 400);
    expectError(() => store.setTaskTags(task.id, unknown, BASE + 2), 400);
    expect((await request('/api/tasks', 'POST', input({ tagIds: unknown }))).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Must roll back', tagIds: unknown })).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: unknown })).status).toBe(400);
    expect(store.listTasks()).toEqual([task]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test.each([null, false, 'tag', {}, [null], [1], [''], ['with space'], ['a\0b'], ['a'.repeat(101)], Array(TAG_COUNT_LIMIT + 1).fill('tag')]
    .map((tagIds, index) => ({ tagIds, index })))('rejects malformed tag ID arrays: case $index', async ({ tagIds }) => {
    const task = store.createTask(input(), BASE);
    expect((await request('/api/tasks', 'POST', input({ tagIds } as unknown as Partial<TaskInput>))).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds })).status).toBe(400);
    expectError(() => store.setTaskTags(task.id, tagIds as string[]), 400);
    expect(store.listTasks()).toEqual([task]);
  });

  test.each(['running', 'waiting_input', 'interrupted', 'completed'] as const)('metadata remains editable on %s tasks without changing run or execution settings', async status => {
    const tag = store.createTag({ name: 'Assigned' });
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE + 60_000 }), BASE);
    const run = store.startManual(task.id, true, BASE + 1);
    if (status !== 'running') store.finish(run.id, status, 'Saved result', null, BASE + 2);
    const beforeTask = store.db.query('SELECT * FROM tasks WHERE id=?').get(task.id) as Record<string, unknown> & { updated_at: number };
    const beforeRun = store.db.query('SELECT * FROM runs WHERE id=?').get(run.id);
    const response = await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: [tag.id, tag.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tagIds: [tag.id], tags: [tag], status, nextRunAt: task.nextRunAt });
    const afterTask = store.db.query('SELECT * FROM tasks WHERE id=?').get(task.id) as Record<string, unknown> & { updated_at: number };
    expect({ ...afterTask, updated_at: beforeTask.updated_at }).toEqual(beforeTask);
    expect(store.db.query('SELECT * FROM runs WHERE id=?').get(run.id)).toEqual(beforeRun);
  });

  test.each(['blocked', 'failed'] as const)('permits assignment while a workflow occupies its task after %s', status => {
    const worker = store.createWorker({ name: 'Worker', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
    const task = store.createTask(input({ steps: [
      { workerId: worker.id, title: 'First', instruction: 'First step' },
      { workerId: worker.id, title: 'Second', instruction: 'Second step' },
    ] }));
    const run = store.startManual(task.id, true, BASE);
    store.finish(run.id, status, 'Needs attention', null, BASE + 1);
    expect(store.activeRun(task.id)?.id).toBe(run.id);
    const before = store.getRun(run.id);
    const tag = store.createTag({ name: 'Attention' });
    expect(store.setTaskTags(task.id, [tag.id]).tagIds).toEqual([tag.id]);
    expect(store.getRun(run.id)).toEqual(before);
  });

  test('metadata-only edits work after cwd disappears and reject execution fields', async () => {
    const cwd = join(folder, 'removed-project');
    mkdirSync(cwd);
    const task = store.createTask(input({ cwd }), BASE);
    const tag = store.createTag({ name: 'Project' });
    rmSync(cwd, { recursive: true });
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: [tag.id], instruction: 'Injected' })).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', {})).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: [tag.id] })).status).toBe(200);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { tagIds: [] })).status).toBe(200);
    expect(store.getTask(task.id)).toMatchObject({ cwd, instruction: task.instruction, tags: [] });
  });

  test('archived tasks reject assignment until restored', async () => {
    const tag = store.createTag({ name: 'Archive' });
    const task = store.createTask(input(), BASE);
    const archived = store.archiveTask(task.id, BASE + 1);
    expectError(() => store.setTaskTags(task.id, [tag.id]), 409);
    expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: [tag.id] })).status).toBe(409);
    expect(store.getTask(task.id)).toEqual(archived);
    store.restoreTask(task.id);
    expect(store.setTaskTags(task.id, [tag.id]).tags).toEqual([tag]);
  });

  test('filters tasks by tag and updates results when tags are removed', async () => {
    const tag = store.createTag({ name: 'Work' });
    const first = store.createTask(input({ tagIds: [tag.id] }), BASE);
    store.createTask(input(), BASE + 1);
    const last = store.createTask(input({ tagIds: [tag.id] }), BASE + 2);
    expect(store.listTasks(tag.id).map(task => task.id)).toEqual([last.id, first.id]);
    expect((await (await request(`/api/tasks?tagId=${tag.id}`)).json()).map((task: { id: string }) => task.id)).toEqual([last.id, first.id]);
    expect(await (await request('/api/tasks?tagId=missing')).json()).toEqual([]);
    expect((await request('/api/tasks?tagId=with%20space')).status).toBe(400);
    store.deleteTag(tag.id);
    expect(store.listTasks(tag.id)).toEqual([]);
  });
});

describe('tag HTTP boundary and legacy migration', () => {
  test('supports CRUD and returns normal error/security responses', async () => {
    const created = await request('/api/tags', 'POST', { name: '  Test  ' });
    expect(created.status).toBe(201);
    const tag = await created.json();
    expect(await (await request(`/api/tags/${tag.id}`)).json()).toEqual(tag);
    expect(await (await request('/api/tags')).json()).toEqual([tag]);
    const edited = await request(`/api/tags/${tag.id}`, 'PATCH', { name: 'Renamed' });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ id: tag.id, name: 'Renamed' });
    expect((await request(`/api/tags/${tag.id}`, 'DELETE')).status).toBe(200);
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await request(`/api/tags/${tag.id}`, method, { name: 'Missing' });
      expect(response.status).toBe(404);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await request('/api/tasks/missing/tags', 'PATCH', { tagIds: [] })).status).toBe(404);
  });

  test('rejects foreign hosts/origins and invalid JSON before mutations', async () => {
    const tag = store.createTag({ name: 'Existing' });
    const task = store.createTask(input(), BASE);
    const invalidHeaders: Record<string, string>[] = [{ host: 'evil.test:4310' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of invalidHeaders) {
      expect((await request('/api/tags', 'POST', { name: 'Unsafe' }, headers)).status).toBe(403);
      expect((await request(`/api/tasks/${task.id}/tags`, 'PATCH', { tagIds: [tag.id] }, headers)).status).toBe(403);
    }
    expect((await handler(new Request(ORIGIN + '/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Unsafe"}' }))).status).toBe(403);
    expect((await request('/api/tags', 'POST', { name: 'Unsafe' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await request('/api/tags', 'POST', { name: 'Unsafe' }, { 'content-length': '32769' })).status).toBe(413);
    const malformed = await handler(new Request(ORIGIN + '/api/tags', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{' }));
    expect(malformed.status).toBe(400);
    expect(store.listTags()).toEqual([tag]);
    expect(store.getTask(task.id)).toEqual(task);
  });

  test('legacy tasks acquire empty tags while old rows and saved sessions remain exact', () => {
    const path = join(folder, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL, provider TEXT NOT NULL,
        cwd TEXT NOT NULL, schedule TEXT NOT NULL, interval_minutes INTEGER, first_run_at INTEGER, next_run_at INTEGER,
        paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
        cwd TEXT NOT NULL, instruction TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for INTEGER, status TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, summary TEXT,
        error TEXT, turn INTEGER NOT NULL DEFAULT 1, mock INTEGER NOT NULL);
      INSERT INTO tasks VALUES ('old-task','Old task','Exact original text','codex','/tmp','manual',NULL,NULL,NULL,0,${BASE},${BASE});
      INSERT INTO runs VALUES ('old-run','old-task','codex','/tmp/original','Exact run text','manual',NULL,
        'completed','saved-exact-session',${BASE},${BASE + 1},${BASE + 1},'Saved result',NULL,3,1);
    `);
    const taskColumns = (legacy.query('PRAGMA table_info(tasks)').all() as { name: string }[]).map(row => row.name).join(',');
    const runColumns = (legacy.query('PRAGMA table_info(runs)').all() as { name: string }[]).map(row => row.name).join(',');
    const oldTask = legacy.query('SELECT * FROM tasks').all();
    const oldRun = legacy.query('SELECT * FROM runs').all();
    legacy.close();
    for (let pass = 0; pass < 2; pass++) {
      const migrated = new Store(path);
      try {
        expect(migrated.db.query(`SELECT ${taskColumns} FROM tasks`).all()).toEqual(oldTask);
        expect(migrated.db.query(`SELECT ${runColumns} FROM runs`).all()).toEqual(oldRun);
        expect(migrated.getTask('old-task')).toMatchObject({ tagIds: [], tags: [], status: 'completed' as RunStatus });
        expect(migrated.getRun('old-run')).toMatchObject({ sessionId: 'saved-exact-session', turn: 3 });
        expect(migrated.listTags()).toEqual([]);
        expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { migrated.close(); }
    }
  });
});
