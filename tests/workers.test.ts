import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { AgentCallbacks, AgentInput, AgentOutcome } from '../server/adapter';
import { MAX_AVATAR_BYTES } from '../server/avatars';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import type { Effort, Provider, Run, Task, TaskInput, Worker, WorkerInput, WorkerSnapshot } from '../src/lib/types';

const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = 1_700_000_000_000;
const MINUTE = 60_000;

// Real one-pixel raster fixtures. The PNG builder writes complete chunks with CRCs
// so size/dimension boundaries don't accidentally depend on accepting invalid files.
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Uint8Array): Buffer<ArrayBuffer> {
  const contents = Buffer.concat([Buffer.from(kind), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  contents.copy(result, 4);
  result.writeUInt32BE(crc32(contents), result.length - 4);
  return result;
}
function png(width = 1, height = 1, padding = 0): Buffer<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height)))];
  if (padding) parts.push(chunk('tEXt', Buffer.concat([Buffer.from('padding\0'), Buffer.alloc(padding, 32)])));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const PNG = png();
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCaiiivoj54/9k=', 'base64');
const WEBP = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoBAAEAAUAmJaACdLoB+AAF9AAA/ccf+Smv8bctX/yC9W+bY0AAAA==', 'base64');
const RASTERS = [
  { mime: 'image/png', bytes: PNG },
  { mime: 'image/jpeg', bytes: JPEG },
  { mime: 'image/webp', bytes: WEBP },
];

interface Call {
  input: AgentInput;
  callbacks: AgentCallbacks;
  resolve: (outcome: AgentOutcome) => void;
  reject: (error: unknown) => void;
}
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
let calls: Call[];
const factory: AgentFactory = (input, callbacks) => {
  let resolve!: Call['resolve'];
  let reject!: Call['reject'];
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  calls.push({ input, callbacks, resolve, reject });
  return { result, cancel: () => reject(new Error('Synthetic cancellation')) };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Review project', instruction: 'Inspect local code.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const workerInput = (patch: Partial<WorkerInput> = {}): WorkerInput => ({
  name: 'Ada', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null, ...patch,
});
const snapshot = (worker: Worker): WorkerSnapshot => ({
  id: worker.id, name: worker.name, description: worker.description, provider: worker.provider, model: worker.model, effort: worker.effort,
  communicationStyle: worker.communicationStyle, avatarUrl: worker.avatarUrl,
});
function request(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
  return handler(new Request(ORIGIN + path, { method,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
  }));
}
function upload(bytes: Uint8Array, mime = 'image/png', headers: Record<string, string> = {}) {
  return handler(new Request(ORIGIN + '/api/avatars', {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': mime, ...headers }, body: new Uint8Array(bytes),
  }));
}
async function createWorker(patch: Record<string, unknown> = {}): Promise<Worker> {
  const response = await request('/api/workers', 'POST', { ...workerInput(), ...patch });
  expect(response.status).toBe(201);
  return response.json();
}
async function createTask(patch: Partial<TaskInput> = {}): Promise<Task> {
  const response = await request('/api/tasks', 'POST', taskInput(patch));
  expect(response.status).toBe(201);
  return response.json();
}
async function reopen() {
  await engine.shutdown();
  await flush();
  store.close();
  store = new Store(join(folder, 'workers.sqlite'));
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
}
function expectAppError(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
function avatarCount() {
  return (store.db.query('SELECT count(*) AS n FROM avatars').get() as { n: number }).n;
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-workers-test-'));
  store = new Store(join(folder, 'workers.sqlite'));
  calls = [];
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  await flush();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('additive worker migration and legacy compatibility', () => {
  test('migrates a real pre-worker database twice without rewriting task/run/comment/session data', () => {
    const path = join(folder, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL, provider TEXT NOT NULL,
        cwd TEXT NOT NULL, schedule TEXT NOT NULL, interval_minutes INTEGER, first_run_at INTEGER,
        next_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
        cwd TEXT NOT NULL, instruction TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for INTEGER, status TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, summary TEXT,
        error TEXT, turn INTEGER NOT NULL DEFAULT 1, mock INTEGER NOT NULL);
      CREATE TABLE comments (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT REFERENCES runs(id), kind TEXT NOT NULL,
        body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE service_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL);
      INSERT INTO tasks VALUES ('legacy-task', 'Старая задача', 'Keep exact instruction', 'claude', '/tmp', 'interval', 5,
        ${BASE}, ${BASE + 5 * MINUTE}, 1, ${BASE}, ${BASE + 10});
      INSERT INTO runs VALUES ('legacy-complete', 'legacy-task', 'codex', '/tmp/previous', 'Old instruction', 'manual', NULL,
        'completed', 'old-session', ${BASE - 10}, ${BASE - 5}, ${BASE - 5}, 'Old result', NULL, 2, 1);
      INSERT INTO runs VALUES ('legacy-waiting', 'legacy-task', 'claude', '/tmp', 'Keep exact instruction', 'schedule', ${BASE},
        'waiting_input', 'keep-this-session', ${BASE}, ${BASE + 10}, NULL, 'Which branch?', NULL, 3, 0);
      INSERT INTO comments VALUES (7, 'legacy-comment', 'legacy-task', NULL, 'user', 'Keep context', ${BASE - 5});
      INSERT INTO comments VALUES (11, 'legacy-question', 'legacy-task', 'legacy-waiting', 'question', 'Which branch?', ${BASE + 10});
      INSERT INTO service_lease VALUES (1, ${process.pid}, 'keep-this-owner');
    `);
    const originalTasks = legacy.query('SELECT * FROM tasks').all() as Record<string, unknown>[];
    const originalRuns = legacy.query('SELECT * FROM runs ORDER BY id').all() as Record<string, unknown>[];
    const originalComments = legacy.query('SELECT * FROM comments ORDER BY seq').all() as Record<string, unknown>[];
    legacy.close();
    let migrated: Store | undefined;
    try {
      for (let pass = 0; pass < 2; pass++) {
        migrated = new Store(path);
        const tasks = (migrated.db.query('SELECT * FROM tasks').all() as Record<string, unknown>[])
          .map(row => { expect(row.worker_id).toBeNull(); return Object.fromEntries(Object.keys(originalTasks[0]!).map(key => [key, row[key]])); });
        const runs = (migrated.db.query('SELECT * FROM runs ORDER BY id').all() as Record<string, unknown>[])
          .map(row => {
            expect(row.worker_id).toBeNull(); expect(row.worker_snapshot).toBeNull(); expect(row.instructions_snapshot).toBe('[]');
            return Object.fromEntries(Object.keys(originalRuns[0]!).map(key => [key, row[key]]));
          });
        expect(tasks).toEqual(originalTasks);
        expect(runs).toEqual(originalRuns);
        expect((migrated.db.query('SELECT * FROM comments ORDER BY seq').all() as Record<string, unknown>[]).map(row =>
          Object.fromEntries(Object.keys(originalComments[0] as Record<string, unknown>).map(key => [key, row[key]])))).toEqual(originalComments);
        expect(migrated.db.query('SELECT * FROM service_lease').get()).toEqual({ singleton: 1, pid: process.pid, owner: 'keep-this-owner', identity: null });
        expect(migrated.listWorkers()).toEqual([]);
        expect(migrated.detail('legacy-task').task).toMatchObject({
          id: 'legacy-task', provider: 'claude', workerId: null, worker: null, paused: true,
          status: 'waiting_input', runCount: 2, nextRunAt: BASE + 5 * MINUTE,
        });
        expect(migrated.getRun('legacy-waiting')).toMatchObject({ workerId: null, worker: null, sessionId: 'keep-this-session', turn: 3 });
        expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        expectAppError(() => migrated!.startManual('legacy-task', true), 409);
        if (pass === 0) { migrated.close(); migrated = undefined; }
      }
      const resumed = migrated!.resume('legacy-waiting', 'main', false, BASE + 20);
      expect(resumed).toMatchObject({ workerId: null, worker: null, sessionId: 'keep-this-session', provider: 'claude', turn: 4, status: 'running' });
      const comment = migrated!.detail('legacy-task').comments.at(-1)!;
      expect(comment).toMatchObject({ runId: 'legacy-waiting', kind: 'user', body: 'main' });
      expect((migrated!.db.query('SELECT seq FROM comments WHERE id=?').get(comment.id) as { seq: number }).seq).toBe(12);
    } finally { migrated?.close(); }
  });

  test.each(['codex', 'claude'] as const)('unassigned %s tasks and manual/scheduled runs retain null worker defaults', async provider => {
    const manual = await createTask({ provider });
    expect(manual).toMatchObject({ workerId: null, worker: null, provider });
    const run = store.startManual(manual.id, true, BASE);
    expect(run).toMatchObject({ workerId: null, worker: null, provider });
    store.finish(run.id, 'completed', 'Done', null, BASE + 1);
    const task = store.createTask(taskInput({ provider, schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    expect(store.claimDue(true, BASE)[0]).toMatchObject({ taskId: task.id, workerId: null, worker: null, provider });
    expect((store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id) as { worker_snapshot: string | null }).worker_snapshot).toBeNull();
  });
});

describe('worker profile CRUD and validation', () => {
  test('creates minimal profiles with defaults, trims text, patches fields, archives and restores the same identity', async () => {
    expect(await (await request('/api/workers')).json()).toEqual([]);
    const response = await request('/api/workers', 'POST', { name: '  Ада  ', provider: 'codex' });
    expect(response.status).toBe(201);
    const created: Worker = await response.json();
    expect(created).toMatchObject({ name: 'Ада', description: '', provider: 'codex', model: null, effort: 'default', communicationStyle: '', avatarUrl: null, archived: false });
    expect(created.id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(await (await request(`/api/workers/${created.id}`)).json()).toEqual(created);
    const patched = await request(`/api/workers/${created.id}`, 'PATCH', {
      name: '  Ada Lovelace  ', effort: 'high', communicationStyle: '  Коротко и по делу.  ', id: 'injected-id', createdAt: 1,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: created.id, createdAt: created.createdAt, name: 'Ada Lovelace', provider: 'codex', effort: 'high', communicationStyle: 'Коротко и по делу.' });
    expect((await request(`/api/workers/${created.id}`, 'DELETE')).status).toBe(200);
    expect(store.getWorker(created.id).archived).toBe(true);
    expect((await request(`/api/workers/${created.id}`, 'DELETE')).status).toBe(200);
    const active = await createWorker({ name: 'Grace' });
    expect((await (await request('/api/workers')).json()).map((worker: Worker) => worker.id)).toEqual([active.id, created.id]);
    const restored = await request(`/api/workers/${created.id}`, 'PATCH', { archived: false });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ id: created.id, archived: false, effort: 'high', createdAt: created.createdAt });
    await reopen();
    expect(store.getWorker(created.id)).toMatchObject({ id: created.id, archived: false, name: 'Ada Lovelace' });
  });

  test.each(['codex', 'claude'] as const)('round-trips nullable, trimmed and custom %s model IDs without an allowlist', async provider => {
    const worker = await createWorker({ provider, model: '  vendor/model-v2.1:latest+fast@region[1m]  ' });
    expect(worker.model).toBe('vendor/model-v2.1:latest+fast@region[1m]');
    expect((await (await request('/api/workers')).json())[0].model).toBe(worker.model);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { name: 'Renamed' })).status).toBe(200);
    expect(store.getWorker(worker.id).model).toBe(worker.model);
    await reopen();
    expect(store.getWorker(worker.id).model).toBe(worker.model);
    for (const model of [null, '', '   ']) {
      expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model })).status).toBe(200);
      expect(store.getWorker(worker.id).model).toBeNull();
    }
    const exact = 'm'.repeat(128);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model: exact })).status).toBe(200);
    expect(store.getWorker(worker.id).model).toBe(exact);
  });

  test('HTTP provider changes reset an omitted model but accept an explicit new model', async () => {
    const worker = await createWorker({ model: 'gpt-5.3-codex' });
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'codex', effort: 'high' })).status).toBe(200);
    expect(store.getWorker(worker.id).model).toBe('gpt-5.3-codex');
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'claude' })).status).toBe(200);
    expect(store.getWorker(worker.id).model).toBeNull();
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model: 'sonnet' })).status).toBe(200);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'codex', model: 'future-codex' })).status).toBe(200);
    expect(store.getWorker(worker.id)).toMatchObject({ provider: 'codex', model: 'future-codex' });
  });

  test('direct callers preserve omitted models on same-provider edits and reset on provider changes', () => {
    const worker = store.createWorker(workerInput({ model: '  custom-model  ' }));
    expect(worker.model).toBe('custom-model');
    expect(store.updateWorker(worker.id, workerInput({ name: 'Changed' })).model).toBe('custom-model');
    expect(store.updateWorker(worker.id, workerInput({ provider: 'claude' })).model).toBeNull();
    expect(store.updateWorker(worker.id, workerInput({ provider: 'codex', model: 'new-model' })).model).toBe('new-model');
    expect(store.updateWorker(worker.id, workerInput({ model: null })).model).toBeNull();
    expect(store.createWorker(workerInput()).model).toBeNull();
  });

  test.each([0, false, {}, [], '-m', '--help', 'm'.repeat(129), 'two models', 'model\tname', 'model\nname',
    '\tmodel', 'model\r', '\u0000model', 'model\u007f', 'model\u0085', 'model;echo', '$(id)', '`id`',
    '"model"', "model'", 'model\\path', 'model=other', 'model💥'].map(model => ({ model })))('rejects invalid model $model atomically over HTTP and direct Store calls', async ({ model }) => {
    const worker = await createWorker({ model: 'kept-model' });
    expect((await request('/api/workers', 'POST', { ...workerInput(), model })).status).toBe(400);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model, name: 'Do not save' })).status).toBe(400);
    const invalid = { ...workerInput(), model } as WorkerInput;
    expectAppError(() => store.createWorker(invalid), 400);
    expectAppError(() => store.updateWorker(worker.id, invalid), 400);
    expect(store.listWorkers()).toEqual([worker]);
  });

  const supported: [Provider, Effort][] = [
    ...(['default', 'low', 'medium', 'high', 'xhigh'] as Effort[]).map(effort => ['codex', effort] as [Provider, Effort]),
    ...(['default', 'low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map(effort => ['claude', effort] as [Provider, Effort]),
  ];
  test.each(supported)('accepts supported %s effort %s', async (provider, effort) => {
    expect(await createWorker({ provider, effort })).toMatchObject({ provider, effort });
  });

  test('switching provider requires a compatible effort and invalid updates are atomic', async () => {
    const worker = await createWorker({ provider: 'claude', effort: 'max' });
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'codex', name: 'Must not save' })).status).toBe(400);
    expect(store.getWorker(worker.id)).toEqual(worker);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'codex', effort: 'xhigh' })).status).toBe(200);
    expect(store.getWorker(worker.id)).toMatchObject({ provider: 'codex', effort: 'xhigh', name: worker.name });
  });

  test.each([
    ['name', ''], ['name', '   '], ['name', null], ['name', 12], ['name', 'x'.repeat(81)], ['name', 'a\0b'],
    ['provider', 'openai'], ['provider', null], ['provider', 1],
    ['effort', 'max'], ['effort', 'minimal'], ['effort', 'HIGH'], ['effort', ''], ['effort', 1], ['effort', null],
    ['communicationStyle', 'x'.repeat(4_001)], ['communicationStyle', 'a\0b'], ['communicationStyle', {}], ['communicationStyle', false], ['communicationStyle', null],
    ['avatarUrl', ''], ['avatarUrl', false], ['avatarUrl', 'https://example.com/avatar.png'],
    ['avatarUrl', ORIGIN + '/api/avatars/' + 'a'.repeat(64)], ['avatarUrl', '//evil.example/avatar.png'],
    ['avatarUrl', 'data:image/png;base64,AAAA'], ['avatarUrl', 'javascript:alert(1)'], ['avatarUrl', '/api/avatars/../../index.html'],
    ['avatarUrl', '/api/avatars/' + 'A'.repeat(64)], ['avatarUrl', '/api/avatars/' + 'a'.repeat(63)],
    ['avatarUrl', '/api/avatars/' + 'a'.repeat(64) + '?x=1'], ['avatarUrl', '/api/avatars/' + 'a'.repeat(64) + '#x'],
    ['archived', 'true'], ['archived', null],
  ])('rejects invalid %s input without a partial profile', async (field, value) => {
    expect((await request('/api/workers', 'POST', { ...workerInput(), [field]: value })).status).toBe(400);
    expect(store.listWorkers()).toEqual([]);
  });

  test('accepts boundary-length text and resets style/effort only with valid explicit values', async () => {
    const worker = await createWorker({ name: 'n'.repeat(80), communicationStyle: 's'.repeat(4_000), effort: 'high' });
    expect(worker.name).toHaveLength(80);
    expect(worker.communicationStyle).toHaveLength(4_000);
    for (const field of ['effort', 'communicationStyle']) {
      expect((await request(`/api/workers/${worker.id}`, 'PATCH', { [field]: null })).status).toBe(400);
      expect(store.getWorker(worker.id)).toEqual(worker);
    }
    const response = await request(`/api/workers/${worker.id}`, 'PATCH', { effort: 'default', communicationStyle: '', avatarUrl: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ effort: 'default', communicationStyle: '', avatarUrl: null });
    expect((await createWorker({ communicationStyle: '  \n\t  ' })).communicationStyle).toBe('');
  });

  test('requires avatar IDs to exist and keeps the prior profile on invalid avatar patch', async () => {
    const absent = '/api/avatars/' + '0'.repeat(64);
    expect((await request('/api/workers', 'POST', { ...workerInput(), avatarUrl: absent })).status).toBe(400);
    const response = await upload(PNG);
    const { avatarUrl } = await response.json();
    const worker = await createWorker({ avatarUrl });
    expect(worker.avatarUrl).toBe(avatarUrl);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { avatarUrl: absent, name: 'Do not save' })).status).toBe(400);
    expect(store.getWorker(worker.id)).toEqual(worker);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { avatarUrl: null })).status).toBe(200);
    expect(store.getWorker(worker.id).avatarUrl).toBeNull();
    expect((await request(avatarUrl)).status).toBe(200);
  });

  test.each(['GET', 'PATCH', 'DELETE'])('missing worker %s returns 404', async method => {
    expect((await request('/api/workers/missing', method, workerInput())).status).toBe(404);
  });
});

describe('worker assignment and immutable run snapshots', () => {
  test('task providers follow current profiles; old sessions keep their original identity across edits, reassignment, archive, and restart', async () => {
    const originalAvatar = store.saveAvatar(PNG, 'image/png', BASE);
    const replacementAvatar = store.saveAvatar(JPEG, 'image/jpeg', BASE);
    const original = store.createWorker(workerInput({ name: 'Original', description: 'Original role', model: 'gpt-5.3-codex', effort: 'xhigh', communicationStyle: 'Use short summaries', avatarUrl: originalAvatar }), BASE);
    const task = store.createTask(taskInput({ workerId: original.id, provider: 'claude' }), BASE);
    expect(task).toMatchObject({ workerId: original.id, provider: 'codex', worker: original });
    const run = store.startManual(task.id, true, BASE + 1);
    const frozen = snapshot(original);
    expect(run).toMatchObject({ workerId: original.id, worker: frozen, provider: 'codex' });
    expect(frozen.model).toBe('gpt-5.3-codex');
    expect(Object.keys(run.worker!).sort()).toEqual(['avatarUrl', 'communicationStyle', 'description', 'effort', 'id', 'model', 'name', 'provider']);
    store.setSession(run.id, 'original-persistent-session');
    store.finish(run.id, 'waiting_input', 'Choose branch', null, BASE + 2);
    const edited = store.updateWorker(original.id, workerInput({ name: 'Edited', description: 'Updated role', provider: 'claude', model: 'claude-opus-4-6', effort: 'max', communicationStyle: 'Long explanations', avatarUrl: replacementAvatar }), BASE + 3);
    expect(store.getTask(task.id)).toMatchObject({ worker: edited, provider: 'claude' });
    expect(store.getRun(run.id).worker).toEqual(frozen);
    const other = store.createWorker(workerInput({ name: 'Other', description: 'Replacement role', provider: 'claude', model: 'sonnet', effort: 'high' }), BASE + 4);
    store.updateTask(task.id, taskInput({ workerId: other.id, instruction: 'Replacement task instruction' }), BASE + 5);
    store.archiveWorker(original.id, BASE + 6);
    store.archiveWorker(other.id, BASE + 7);
    await reopen();
    expect(store.getTask(task.id)).toMatchObject({ workerId: other.id, provider: 'claude', worker: { id: other.id, archived: true } });
    expect(store.getRun(run.id)).toMatchObject({ workerId: original.id, worker: frozen, provider: 'codex', sessionId: 'original-persistent-session', instruction: task.instruction });
    const resumed = store.resume(run.id, 'main', false, BASE + 8);
    expect(resumed).toMatchObject({ id: run.id, workerId: original.id, worker: frozen, provider: 'codex', sessionId: 'original-persistent-session', turn: 2 });
    store.finish(run.id, 'completed', 'Finished original work', null, BASE + 9);
    const next = store.startManual(task.id, true, BASE + 10);
    expect(next).toMatchObject({ workerId: other.id, worker: snapshot(other), provider: 'claude', instruction: 'Replacement task instruction' });
    store.finish(next.id, 'completed', 'Finished new work', null, BASE + 11);
    await reopen();
    expect(store.getRun(run.id).worker).toEqual(frozen);
    expect(Buffer.from(store.getAvatar(originalAvatar.split('/').at(-1)!).data)).toEqual(PNG);
    expect(store.detail(task.id).runs.map(item => item.workerId)).toEqual([other.id, original.id]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('a CLI-default snapshot stays null when the active worker receives a model later', () => {
    const worker = store.createWorker(workerInput());
    const task = store.createTask(taskInput({ workerId: worker.id }));
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'default-model-session');
    store.updateWorker(worker.id, workerInput({ model: 'new-explicit-model' }));
    expect(store.getRun(run.id).worker?.model).toBeNull();
    store.finish(run.id, 'waiting_input', 'Continue?', null);
    expect(store.resume(run.id, 'Yes').worker?.model).toBeNull();
    store.finish(run.id, 'completed', 'Done', null);
    expect(store.startManual(task.id, true).worker?.model).toBe('new-explicit-model');
  });

  test('malicious model data in a persisted simple snapshot cannot launch a resumed process', async () => {
    const worker = store.createWorker(workerInput({ model: 'valid-model' }));
    const task = store.createTask(taskInput({ workerId: worker.id }));
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'snapshot-model-session');
    store.finish(run.id, 'waiting_input', 'Continue?', null);
    const original = (store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id) as { worker_snapshot: string }).worker_snapshot;
    try {
      for (const model of ['--dangerous-option', 'model\n--dangerous-option', { value: 'model' }]) {
        const corrupted = JSON.stringify({ ...JSON.parse(original), model });
        store.db.query('UPDATE runs SET worker_snapshot=? WHERE id=?').run(corrupted, run.id);
        expectAppError(() => engine.resume(run.id, 'Do not launch.', false), 409);
        expect(calls).toHaveLength(0);
        expect(store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id)).toEqual({ worker_snapshot: corrupted });
      }
    } finally { store.db.query('UPDATE runs SET worker_snapshot=? WHERE id=?').run(original, run.id); }
  });

  test('archives retain assigned tasks but reject new assignment; explicit detach and restore behave predictably', async () => {
    const worker = await createWorker();
    const task = await createTask({ workerId: worker.id, provider: 'claude' });
    expect(task.provider).toBe('codex');
    expect((await request(`/api/workers/${worker.id}`, 'DELETE')).status).toBe(200);
    expect((await request('/api/tasks', 'POST', taskInput({ workerId: worker.id }))).status).toBe(409);
    const otherTask = await createTask();
    expect((await request(`/api/tasks/${otherTask.id}`, 'PATCH', { workerId: worker.id })).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Still assigned' })).status).toBe(200);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { paused: true })).status).toBe(200);
    expect(store.getTask(task.id)).toMatchObject({ workerId: worker.id, worker: { archived: true }, title: 'Still assigned', paused: true });
    const detached = await request(`/api/tasks/${task.id}`, 'PATCH', { workerId: null, provider: 'claude' });
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({ workerId: null, worker: null, provider: 'claude' });
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { workerId: worker.id })).status).toBe(409);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { archived: false })).status).toBe(200);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { workerId: worker.id })).status).toBe(200);
    expect(store.getTask(task.id)).toMatchObject({ workerId: worker.id, provider: 'codex' });
  });

  test('legacy direct update callers omit workerId without losing assignment; explicit null detaches', () => {
    const worker = store.createWorker(workerInput());
    const task = store.createTask(taskInput({ workerId: worker.id }));
    store.archiveWorker(worker.id);
    expect(store.updateTask(task.id, taskInput({ title: 'Legacy caller' }))).toMatchObject({ workerId: worker.id, worker: { archived: true } });
    expect(store.updateTask(task.id, taskInput({ workerId: null }))).toMatchObject({ workerId: null, worker: null });
  });

  test.each(['missing', '../worker', 'https://example.com/id', 'a_b', '', 'a'.repeat(101), 1, {}, []].map(workerId => ({ workerId })))('rejects missing/malformed assignment $workerId without changing a task', async ({ workerId }) => {
    const task = await createTask();
    const expected = workerId === 'missing' ? 404 : 400;
    expect((await request('/api/tasks', 'POST', { ...taskInput(), workerId })).status).toBe(expected);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { workerId, title: 'Do not save' })).status).toBe(expected);
    expect(store.getTask(task.id)).toEqual(task);
  });

  test('scheduled snapshots capture current settings at each occurrence and still run for archived assigned workers', async () => {
    const worker = store.createWorker(workerInput({ description: 'Initial role', model: 'gpt-5.3-codex', effort: 'low', communicationStyle: 'Initial style' }), BASE);
    const task = store.createTask(taskInput({ workerId: worker.id, schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const first = store.claimDue(true, BASE)[0]!;
    expect(first).toMatchObject({ taskId: task.id, workerId: worker.id, worker: snapshot(worker), trigger: 'schedule', scheduledFor: BASE });
    store.finish(first.id, 'completed', 'First complete', null, BASE + 1);
    const edited = store.updateWorker(worker.id, workerInput({ description: 'Updated role', provider: 'claude', model: 'opus', effort: 'max', communicationStyle: 'Updated style' }), BASE + 2);
    store.archiveWorker(worker.id, BASE + 3);
    await reopen();
    const second = store.claimDue(true, BASE + 5 * MINUTE)[0]!;
    expect(second).toMatchObject({ workerId: worker.id, worker: snapshot(edited), provider: 'claude', scheduledFor: BASE + 5 * MINUTE });
    expect(store.getRun(first.id).worker).toEqual(snapshot(worker));
    expect(store.claimDue(true, BASE + 5 * MINUTE)).toEqual([]);
    expect(store.getTask(task.id)).toMatchObject({ worker: { archived: true }, nextRunAt: BASE + 10 * MINUTE, runCount: 2 });
  });

  test('HTTP run and detail round-trip frozen worker data while task detail shows the current profile', async () => {
    const worker = await createWorker({ description: 'Initial role', model: 'gpt-5.3-codex', communicationStyle: 'Keep it brief', effort: 'high' });
    const task = await createTask({ workerId: worker.id });
    const response = await request(`/api/tasks/${task.id}/run`, 'POST', {});
    expect(response.status).toBe(201);
    const run: Run = await response.json();
    expect(run.worker).toEqual(snapshot(worker));
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ sessionId: 'synthetic-worker-session', envelope: { status: 'completed', summary: 'Done', questions: [] } });
    await flush();
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { name: 'New display name', description: 'Updated role', model: 'gpt-5.4', effort: 'low' })).status).toBe(200);
    const detail = await (await request(`/api/tasks/${task.id}`)).json();
    expect(detail.task.worker).toMatchObject({ name: 'New display name', description: 'Updated role', model: 'gpt-5.4', effort: 'low' });
    expect(detail.runs[0]).toMatchObject({ id: run.id, status: 'completed', worker: snapshot(worker) });
    expect(detail.task.latestRun.worker).toEqual(snapshot(worker));
  });
});

describe('display-only worker descriptions', () => {
  test('HTTP creates, reads and independently edits descriptions and personal instructions; omitted values preserve and null clears', async () => {
    const worker = await createWorker({ description: '  Reviews migrations.\nChecks compatibility.  ', communicationStyle: 'Use concise Russian.' });
    expect(worker.description).toBe('Reviews migrations.\nChecks compatibility.');
    expect(await (await request(`/api/workers/${worker.id}`)).json()).toEqual(worker);
    expect((await (await request('/api/workers')).json())[0]).toEqual(worker);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { communicationStyle: 'Explain your checks.' })).status).toBe(200);
    expect(store.getWorker(worker.id)).toMatchObject({ description: worker.description, communicationStyle: 'Explain your checks.' });
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { description: '  New role  ' })).status).toBe(200);
    expect(store.getWorker(worker.id)).toMatchObject({ description: 'New role', communicationStyle: 'Explain your checks.' });
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { provider: 'claude' })).status).toBe(200);
    await reopen();
    expect(store.getWorker(worker.id)).toMatchObject({ description: 'New role', communicationStyle: 'Explain your checks.' });
    for (const description of [null, '', ' \n\t ']) {
      expect((await request(`/api/workers/${worker.id}`, 'PATCH', { description: 'Before clear' })).status).toBe(200);
      expect((await request(`/api/workers/${worker.id}`, 'PATCH', { description })).status).toBe(200);
      expect(store.getWorker(worker.id)).toMatchObject({ description: '', communicationStyle: 'Explain your checks.' });
    }
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { description: 'я'.repeat(1_000) })).status).toBe(200);
    expect(store.getWorker(worker.id).description).toBe('я'.repeat(1_000));
    expect((await createWorker({ description: null, communicationStyle: 'Never copy this into description.' })).description).toBe('');
  });

  test('direct Store calls trim descriptions, preserve omitted edits even across providers and clear null', () => {
    const worker = store.createWorker(workerInput({ description: '  Database reviewer  ', communicationStyle: 'Keep this instruction.' }));
    expect(worker.description).toBe('Database reviewer');
    for (const provider of ['codex', 'claude'] as const) {
      expect(store.updateWorker(worker.id, workerInput({ provider, communicationStyle: worker.communicationStyle })).description).toBe(worker.description);
    }
    expect(store.updateWorker(worker.id, workerInput({ description: null })).description).toBe('');
    expect(store.updateWorker(worker.id, workerInput({ description: '  Updated role  ' })).description).toBe('Updated role');
    expect(store.updateWorker(worker.id, workerInput({ description: ' ' })).description).toBe('');
    expect(store.createWorker(workerInput({ communicationStyle: 'No implied role.' })).description).toBe('');
  });

  test.each([0, false, {}, [], 'x'.repeat(1_001), ' '.repeat(1_001), 'a\0b'].map(description => ({ description })))('rejects invalid descriptions $description atomically in HTTP and Store calls', async ({ description }) => {
    const worker = await createWorker({ description: 'Kept role', communicationStyle: 'Kept instruction' });
    expect((await request('/api/workers', 'POST', { ...workerInput(), description })).status).toBe(400);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { description, communicationStyle: 'Do not save' })).status).toBe(400);
    const invalid = { ...workerInput(), description } as WorkerInput;
    expectAppError(() => store.createWorker(invalid), 400);
    expectAppError(() => store.updateWorker(worker.id, invalid), 400);
    expect(store.listWorkers()).toEqual([worker]);
  });

  test.each(['missing', 'null'])('pre-description database and %s snapshots upgrade in memory without changing raw data', async legacyDescription => {
    const worker = store.createWorker(workerInput({ model: 'kept-model', communicationStyle: '  Keep exact personal instructions.\nDo not make this a role.  ' }), BASE);
    const task = store.createTask(taskInput({ workerId: worker.id }), BASE);
    const run = store.startManual(task.id, true, BASE + 1);
    store.setSession(run.id, 'legacy-description-session');
    store.finish(run.id, 'waiting_input', 'Which target?', null, BASE + 2);
    const { description: _description, ...legacyWorker } = snapshot(worker);
    const workerJSON = JSON.stringify({ ...legacyWorker, ...(legacyDescription === 'null' ? { description: null } : {}) }, null, 2);
    store.db.query('UPDATE runs SET worker_snapshot=? WHERE id=?').run(workerJSON, run.id);
    store.db.exec('ALTER TABLE workers DROP COLUMN description');
    const tables = ['workers', 'tasks', 'runs', 'comments', 'instructions'];
    const originals = new Map(tables.map(table => [table, store.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]]));
    for (let pass = 0; pass < 2; pass++) {
      await reopen();
      for (const table of tables) {
        const rows = originals.get(table)!;
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]!).map(name => `"${name}"`).join(',');
        expect(store.db.query(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
      }
      expect(store.getWorker(worker.id)).toMatchObject({ description: '', communicationStyle: worker.communicationStyle, model: 'kept-model' });
      expect(store.db.query('SELECT description FROM workers WHERE id=?').get(worker.id)).toEqual({ description: '' });
      expect(store.getRun(run.id).worker).toEqual(snapshot(worker));
      expect(store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id)).toEqual({ worker_snapshot: workerJSON });
    }
    store.updateWorker(worker.id, { ...worker, description: 'Current role', communicationStyle: 'Current personal instructions' });
    const resumed = store.resume(run.id, 'main');
    expect(resumed.worker).toMatchObject({ description: '', communicationStyle: worker.communicationStyle });
    expect(store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id)).toEqual({ worker_snapshot: workerJSON });
    store.finish(run.id, 'completed', 'Done', null);
    expect(store.startManual(task.id, true).worker).toMatchObject({ description: 'Current role', communicationStyle: 'Current personal instructions' });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('malformed descriptions in simple snapshots fail closed before a resumed agent launches', () => {
    const worker = store.createWorker(workerInput({ description: 'Valid role' }));
    const task = store.createTask(taskInput({ workerId: worker.id }));
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'description-session');
    store.finish(run.id, 'waiting_input', 'Continue?', null);
    const original = (store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id) as { worker_snapshot: string }).worker_snapshot;
    try {
      for (const description of [false, 1, {}, [], 'x'.repeat(1_001), 'a\0b', ' noncanonical ']) {
        const corrupted = JSON.stringify({ ...JSON.parse(original), description });
        store.db.query('UPDATE runs SET worker_snapshot=? WHERE id=?').run(corrupted, run.id);
        expectAppError(() => engine.resume(run.id, 'Do not launch.', false), 409);
        expect(calls).toHaveLength(0);
        expect(store.db.query('SELECT worker_snapshot FROM runs WHERE id=?').get(run.id)).toEqual({ worker_snapshot: corrupted });
      }
    } finally { store.db.query('UPDATE runs SET worker_snapshot=? WHERE id=?').run(original, run.id); }
  });
});

describe('bounded, same-origin, immutable raster avatars', () => {
  test.each(RASTERS)('stores valid $mime bytes in SQLite and serves exact GET/HEAD metadata', async ({ mime, bytes }) => {
    const response = await upload(bytes, mime);
    expect(response.status).toBe(201);
    const { avatarUrl } = await response.json();
    expect(avatarUrl).toBe('/api/avatars/' + createHash('sha256').update(bytes).digest('hex'));
    expect(avatarCount()).toBe(1);
    expect(store.db.query('SELECT typeof(data) AS kind FROM avatars').get()).toEqual({ kind: 'blob' });
    for (const method of ['GET', 'HEAD']) {
      const image = await request(avatarUrl, method);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe(mime);
      expect(image.headers.get('content-length')).toBe(String(bytes.length));
      expect(image.headers.get('content-disposition')).toBe('inline');
      expect(image.headers.get('x-content-type-options')).toBe('nosniff');
      expect(image.headers.get('content-security-policy')).toContain("img-src 'self' data:");
      expect(image.headers.get('access-control-allow-origin')).toBeNull();
      expect(Buffer.from(await image.arrayBuffer())).toEqual(method === 'GET' ? bytes : Buffer.alloc(0));
    }
    expect(readdirSync(folder).filter(name => !name.startsWith('workers.sqlite'))).toEqual([]);
    await reopen();
    expect(Buffer.from(await (await request(avatarUrl)).arrayBuffer())).toEqual(bytes);
  });

  test('deduplicates identical uploads without mutating original data or metadata', async () => {
    const first = store.saveAvatar(PNG, 'image/png', BASE);
    const duplicate = store.saveAvatar(PNG, 'image/jpeg', BASE + 1);
    expect(duplicate).toBe(first);
    const response = await upload(PNG, 'IMAGE/PNG; charset=binary');
    expect(response.status).toBe(201);
    expect((await response.json()).avatarUrl).toBe(first);
    expect(avatarCount()).toBe(1);
    expect(store.db.query('SELECT mime,created_at FROM avatars').get()).toEqual({ mime: 'image/png', created_at: BASE });
    expect(Buffer.from(store.getAvatar(first.split('/').at(-1)!).data)).toEqual(PNG);
  });

  test.each(['image/svg+xml', 'image/gif', 'text/html', 'text/plain', 'application/octet-stream', 'multipart/form-data'])('rejects unsupported MIME %s before saving', async mime => {
    expect((await upload(PNG, mime)).status).toBe(415);
    expect(avatarCount()).toBe(0);
  });

  test.each([
    ['image/png', JPEG], ['image/jpeg', PNG], ['image/webp', PNG],
    ['image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['image/jpeg', Buffer.from('<html><script>alert(1)</script></html>')],
    ['image/webp', Buffer.from('GIF89a\x01\x00\x01\x00')],
  ] as [string, Buffer][])('rejects MIME spoofing as %s', async (mime, bytes) => {
    expect((await upload(bytes, mime)).status).toBe(400);
    expect(avatarCount()).toBe(0);
  });

  test('requires content type and rejects missing avatar IDs and noncanonical paths', async () => {
    const response = await handler(new Request(ORIGIN + '/api/avatars', { method: 'POST', headers: { origin: ORIGIN }, body: new Uint8Array(PNG) }));
    expect(response.status).toBe(415);
    for (const path of ['0'.repeat(64), 'A'.repeat(64), 'x', 'a'.repeat(63), 'a'.repeat(65), '%2e%2e%2fworkers']) {
      expect((await request('/api/avatars/' + path)).status).toBe(404);
    }
    expect(avatarCount()).toBe(0);
  });

  test('allows the exact 256 KiB image limit and rejects larger declared or actual bodies', async () => {
    const exact = png(1, 1, MAX_AVATAR_BYTES - PNG.length - 20);
    expect(exact.length).toBe(MAX_AVATAR_BYTES);
    expect((await upload(exact)).status).toBe(201);
    expect((await upload(PNG, 'image/png', { 'content-length': String(MAX_AVATAR_BYTES + 1) })).status).toBe(413);
    for (const headers of [{}, { 'content-length': '1' }] as Record<string, string>[]) {
      expect((await upload(png(1, 1, MAX_AVATAR_BYTES), 'image/png', headers)).status).toBe(413);
    }
    expect((await upload(Buffer.alloc(0))).status).toBe(413);
    expect(avatarCount()).toBe(1);
  });

  test('cancels an oversized streamed avatar after counting actual bytes across chunks', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AVATAR_BYTES / 2));
        controller.enqueue(new Uint8Array(MAX_AVATAR_BYTES / 2));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; },
    });
    const response = await handler(new Request(ORIGIN + '/api/avatars', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'image/png', 'content-length': '1' }, body: stream,
    }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(avatarCount()).toBe(0);
  });

  test.each([[0, 1], [1, 0], [1025, 1], [1, 1025]])('rejects PNG dimensions %d × %d', async (width, height) => {
    expect((await upload(png(width, height))).status).toBe(400);
    expect(avatarCount()).toBe(0);
  });
  test('accepts the exact maximum 1024 × 1024 raster dimensions', async () => {
    expect((await upload(png(1024, 1024))).status).toBe(201);
  });

  test.each(['image/jpeg', 'image/webp'])('rejects oversized dimensions in %s headers', async mime => {
    const bytes = Buffer.from(mime === 'image/jpeg' ? JPEG : WEBP);
    if (mime === 'image/jpeg') {
      const startOfFrame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      expect(startOfFrame).toBeGreaterThan(0);
      bytes.writeUInt16BE(1025, startOfFrame + 7);
    } else bytes.writeUInt16LE(1025, 26);
    expect((await upload(bytes, mime)).status).toBe(400);
    expect(avatarCount()).toBe(0);
  });

  test('rejects malformed RIFF size and animated extended WebP', async () => {
    const malformed = Buffer.from(WEBP);
    malformed.writeUInt32LE(WEBP.length, 4);
    expect((await upload(malformed, 'image/webp')).status).toBe(400);
    const animated = Buffer.alloc(30);
    animated.write('RIFF', 0); animated.writeUInt32LE(22, 4); animated.write('WEBPVP8X', 8);
    animated.writeUInt32LE(10, 16); animated[20] = 2;
    expect((await upload(animated, 'image/webp')).status).toBe(400);
    expect(avatarCount()).toBe(0);
  });

  test.each(RASTERS)('rejects truncated $mime headers without a complete image payload', async ({ mime, bytes }) => {
    const length = mime === 'image/png' ? 33 : mime === 'image/jpeg' ? bytes.indexOf(Buffer.from([0xff, 0xc0])) + 19 : 30;
    const truncated = Buffer.from(bytes.subarray(0, length));
    if (mime === 'image/webp') truncated.writeUInt32LE(truncated.length - 8, 4);
    expect((await upload(truncated, mime)).status).toBe(400);
    expect(avatarCount()).toBe(0);
  });
});

describe('worker and avatar HTTP security boundaries', () => {
  const forbiddenHeaders: Record<string, string>[] = [
    { host: 'evil.example:4310' },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  test.each(forbiddenHeaders)('worker and avatar mutations inherit Host/Origin/fetch guards: %j', async headers => {
    const worker = await createWorker();
    const task = await createTask();
    expect((await request('/api/workers', 'POST', workerInput(), headers)).status).toBe(403);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { name: 'Do not save' }, headers)).status).toBe(403);
    expect((await request(`/api/workers/${worker.id}`, 'DELETE', {}, headers)).status).toBe(403);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { workerId: worker.id }, headers)).status).toBe(403);
    expect((await upload(PNG, 'image/png', headers)).status).toBe(403);
    expect(store.listWorkers()).toEqual([worker]);
    expect(store.getTask(task.id)).toEqual(task);
    expect(avatarCount()).toBe(0);
  });

  test('all new mutations require Origin even when Host is local', async () => {
    const worker = await createWorker();
    for (const [path, method, body, type] of [
      ['/api/workers', 'POST', JSON.stringify(workerInput()), 'application/json'],
      [`/api/workers/${worker.id}`, 'PATCH', JSON.stringify({ name: 'Do not save' }), 'application/json'],
      [`/api/workers/${worker.id}`, 'DELETE', '{}', 'application/json'],
      ['/api/avatars', 'POST', new Uint8Array(PNG), 'image/png'],
    ] as [string, string, string | Uint8Array<ArrayBuffer>, string][]) {
      expect((await handler(new Request(ORIGIN + path, { method, headers: { 'content-type': type }, body }))).status).toBe(403);
    }
    expect(store.listWorkers()).toEqual([worker]);
    expect(avatarCount()).toBe(0);
  });

  test.each(forbiddenHeaders)('avatar GET/HEAD and worker reads reject cross-origin or untrusted requests: %j', async headers => {
    const worker = await createWorker();
    const avatarUrl = store.saveAvatar(PNG, 'image/png');
    for (const method of ['GET', 'HEAD']) expect((await request(avatarUrl, method, undefined, headers)).status).toBe(403);
    expect((await request('/api/workers', 'GET', undefined, headers)).status).toBe(403);
    expect((await request(`/api/workers/${worker.id}`, 'GET', undefined, headers)).status).toBe(403);
  });

  test('worker JSON cap remains 32 KiB after enabling the larger binary upload limit', async () => {
    const value = JSON.stringify(workerInput());
    const exact = value + ' '.repeat(32_768 - Buffer.byteLength(value));
    const send = (body: string, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + '/api/workers', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body,
    }));
    expect((await send(exact)).status).toBe(201);
    expect((await send(exact + ' ')).status).toBe(413);
    expect((await send(exact + ' ', { 'content-length': '1' })).status).toBe(413);
    expect((await send(value, { 'content-length': '32769' })).status).toBe(413);
    expect((await send(JSON.stringify({ ...workerInput(), extra: 'é'.repeat(17_000) }))).status).toBe(413);
    expect(store.listWorkers()).toHaveLength(1);
    expect((await upload(png(1, 1, 40_000))).status).toBe(201);
  });

  test.each(['[]', 'null', 'true', '42', '"worker"', '{'])('rejects malformed or nonobject worker JSON %s', async body => {
    const response = await handler(new Request(ORIGIN + '/api/workers', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body,
    }));
    expect(response.status).toBe(400);
    expect(store.listWorkers()).toEqual([]);
  });

  test('worker JSON and binary upload paths keep separate content type checks', async () => {
    expect((await request('/api/workers', 'POST', workerInput(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await upload(PNG, 'application/json')).status).toBe(415);
    expect(store.listWorkers()).toEqual([]);
    expect(avatarCount()).toBe(0);
  });
});
