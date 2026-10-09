import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentInput, AgentOutcome } from '../server/adapter';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { MODEL_CATALOG_PROVIDER_LIMIT, MODEL_ID_LIMIT, MODEL_LABEL_LIMIT, modelPresets } from '../src/lib/workers';
import type { ModelCatalogEntry, ModelCatalogInput, Provider, TaskInput, WorkerInput } from '../src/lib/types';

const ORIGIN = 'http://127.0.0.1:4310';
const BASE = 1_700_000_000_000;
interface Call { input: AgentInput; resolve: (outcome: AgentOutcome) => void; reject: (error: unknown) => void; }
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
let calls: Call[];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const factory: AgentFactory = input => {
  let resolve!: Call['resolve'];
  let reject!: Call['reject'];
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  calls.push({ input, resolve, reject });
  return { result, cancel: () => reject(new Error('Synthetic cancellation')) };
};
const input = (patch: Partial<ModelCatalogInput> = {}): ModelCatalogInput => ({ provider: 'codex', modelId: 'custom-model', label: 'Своя модель', ...patch });
const workerInput = (patch: Partial<WorkerInput> = {}): WorkerInput => ({ name: 'Ada', provider: 'codex', model: null,
  effort: 'default', communicationStyle: '', avatarUrl: null, ...patch });
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'Inspect project', instruction: 'Review this project.',
  provider: 'codex', cwd: folder, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch });
const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
  body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value === undefined ? {} : value),
}));
function expectError(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
function resetEngine() { engine = new Engine(store, true, factory); handler = createHandler(engine, { port: 4310, root: folder }); }
async function reopen() {
  await engine.shutdown();
  await flush();
  store.close();
  store = new Store(join(folder, 'models.sqlite'));
  resetEngine();
}
function clearModels() { for (const model of store.listModels()) store.deleteModel(model.id); }
function fillProvider(provider: Provider, count = MODEL_CATALOG_PROVIDER_LIMIT) {
  const remaining = count - store.listModels().filter(model => model.provider === provider).length;
  for (let i = 0; i < remaining; i++) store.createModel(input({ provider, modelId: `fill-${provider}-${i}` }));
}
const selectedFields = ({ provider, modelId, label }: ModelCatalogEntry): ModelCatalogInput => ({ provider, modelId, label });
const expectedSeeds = (['codex', 'claude'] as const).flatMap(provider => modelPresets[provider].map(model => ({ provider, modelId: model.id, label: model.label })));

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-models-'));
  store = new Store(join(folder, 'models.sqlite'));
  calls = [];
  resetEngine();
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  await flush();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('persistent independent model catalog migration', () => {
  test('seeds the six initial models exactly once with stable identities and no catalog foreign keys', async () => {
    const initial = store.listModels();
    expect(initial).toHaveLength(6);
    expect(initial.map(selectedFields)).toEqual(expectedSeeds);
    expect(initial.every(model => /^[a-zA-Z0-9-]+$/.test(model.id) && model.createdAt > 0 && model.createdAt === model.updatedAt)).toBe(true);
    expect(new Set(initial.map(model => model.id)).size).toBe(6);
    expect(store.db.query('SELECT name FROM app_migrations').all()).toEqual([{ name: 'model_catalog_v1' }]);
    expect(store.db.query('PRAGMA foreign_key_list(model_catalog)').all()).toEqual([]);
    for (const table of ['workers', 'tasks', 'runs']) {
      expect((store.db.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string }[]).some(row => row.table === 'model_catalog')).toBe(false);
    }
    await reopen();
    expect(store.listModels()).toEqual(initial);
    await reopen();
    expect(store.listModels()).toEqual(initial);
    expect(await (await request('/api/models')).json()).toEqual(initial);
  });

  test('deleted or renamed defaults never respawn, including an empty catalog after repeated reopen', async () => {
    const initial = store.listModels();
    store.deleteModel(initial[0]!.id);
    const edited = store.updateModel(initial[1]!.id, { provider: 'claude', modelId: 'renamed-default', label: 'Новое имя' });
    await reopen();
    expect(store.listModels()).toEqual([edited, ...initial.slice(2)]);
    clearModels();
    await reopen();
    expect(store.listModels()).toEqual([]);
    await reopen();
    expect(store.listModels()).toEqual([]);
    const custom = store.createModel(input());
    await reopen();
    expect(store.listModels()).toEqual([custom]);
    expect(store.db.query('SELECT count(*) AS n FROM app_migrations WHERE name=?').get('model_catalog_v1')).toEqual({ n: 1 });
  });

  test.each([false, true])('additive seed migration preserves workers, task/run/session/comment data and exact snapshot bytes; legacy model column=%s', async legacyModel => {
    const worker = store.createWorker(workerInput({ model: legacyModel ? null : 'preexisting-custom-id' }), BASE);
    const simple = store.createTask(taskInput({ workerId: worker.id }), BASE);
    const workflow = store.createTask(taskInput({ title: 'Two steps', steps: [
      { workerId: worker.id, title: 'Plan', instruction: 'Plan.' },
      { workerId: worker.id, title: 'Build', instruction: 'Build.' },
    ] }), BASE);
    const waiting = store.startManual(simple.id, true, BASE + 1);
    store.setSession(waiting.id, 'keep-old-session');
    store.finish(waiting.id, 'waiting_input', 'Which branch?', null, BASE + 2);
    store.comment(simple.id, waiting.id, 'question', 'Keep this context', BASE + 3);
    const workflowRun = store.startManual(workflow.id, true, BASE + 4);
    store.finish(workflowRun.id, 'failed', null, 'Preserve pending step', BASE + 5);
    await engine.shutdown();
    await flush();
    // Emulate a database written before this feature, including old JSON without model.
    store.db.exec('DROP TABLE model_catalog; DROP TABLE app_migrations;');
    if (legacyModel) {
      store.db.exec('ALTER TABLE workers DROP COLUMN model;');
      for (const row of store.db.query('SELECT id,worker_snapshot,steps_snapshot FROM runs').all() as { id: string; worker_snapshot: string; steps_snapshot: string }[]) {
        const snapshot = JSON.parse(row.worker_snapshot);
        delete snapshot.model;
        const steps = JSON.parse(row.steps_snapshot);
        for (const step of steps) delete step.worker.model;
        store.db.query('UPDATE runs SET worker_snapshot=?,steps_snapshot=? WHERE id=?').run(JSON.stringify(snapshot, null, 2), JSON.stringify(steps, null, 2), row.id);
      }
    }
    const before = Object.fromEntries(['workers', 'tasks', 'runs', 'comments'].map(table => [table, store.db.query(`SELECT * FROM ${table} ORDER BY id`).all()]));
    store.close();
    store = new Store(join(folder, 'models.sqlite'));
    resetEngine();
    for (let pass = 0; pass < 2; pass++) {
      expect(store.listModels().map(selectedFields)).toEqual(expectedSeeds);
      for (const table of ['workers', 'tasks', 'runs', 'comments']) {
        const expected = legacyModel && table === 'workers' ? before[table]!.map(row => ({ ...(row as object), model: null })) : before[table];
        expect(store.db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(expected);
      }
      expect(store.getWorker(worker.id)).toEqual(worker);
      expect(store.getRun(waiting.id)).toMatchObject({ sessionId: 'keep-old-session', worker: { model: worker.model } });
      expect(store.getRun(workflowRun.id).steps.map(step => step.worker.model)).toEqual([worker.model, worker.model]);
      // Reading normalizes old snapshots only in memory.
      expect(store.db.query('SELECT * FROM runs ORDER BY id').all()).toEqual(before.runs);
      expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      if (pass === 0) await reopen();
    }
  });

  test('seeding and its marker are one transaction and a failed seed leaves no partial catalog', () => {
    const path = join(folder, 'failed-seed.sqlite');
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE model_catalog (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL, model_id TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(provider,model_id));
      CREATE TRIGGER reject_second_seed BEFORE INSERT ON model_catalog WHEN NEW.model_id='gpt-6-astra'
      BEGIN SELECT RAISE(ABORT,'Synthetic seed failure'); END;`);
    expect(() => new Store(path)).toThrow('Synthetic seed failure');
    expect(legacy.query('SELECT * FROM model_catalog').all()).toEqual([]);
    expect(legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_migrations'").all()).toEqual([]);
    legacy.exec('DROP TRIGGER reject_second_seed');
    legacy.close();
    const retried = new Store(path);
    try { expect(retried.listModels().map(selectedFields)).toEqual(expectedSeeds); }
    finally { retried.close(); }
  });
});

describe('validated bounded catalog CRUD', () => {
  test('CRUD preserves IDs, creation time and insertion order across edits, timestamp ties, VACUUM and reopen', async () => {
    clearModels();
    const first = store.createModel(input({ modelId: '  first-model  ', label: '  Первая 🌟  ' }), BASE);
    const second = store.createModel(input({ modelId: 'second-model' }), BASE - 1);
    const third = store.createModel(input({ modelId: 'third-model' }), BASE);
    expect(first).toMatchObject({ modelId: 'first-model', label: 'Первая 🌟', createdAt: BASE, updatedAt: BASE });
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'id', 'label', 'modelId', 'provider', 'updatedAt']);
    const edited = store.updateModel(first.id, { provider: 'claude', modelId: 'new-first', label: 'First updated' }, BASE + 1);
    expect(edited).toEqual({ ...first, provider: 'claude', modelId: 'new-first', label: 'First updated', updatedAt: BASE + 1 });
    const labelOnly = store.updateModel(second.id, { label: 'Second updated' }, BASE + 2);
    expect(labelOnly).toEqual({ ...second, label: 'Second updated', updatedAt: BASE + 2 });
    expect(store.listModels()).toEqual([edited, labelOnly, third]);
    store.db.exec('VACUUM');
    await reopen();
    expect(store.listModels()).toEqual([edited, labelOnly, third]);
    store.deleteModel(second.id);
    await reopen();
    expect(store.listModels()).toEqual([edited, third]);
    expectError(() => store.getModel(second.id), 404);
    expectError(() => store.updateModel(second.id, { label: 'Missing' }), 404);
    expectError(() => store.deleteModel(second.id), 404);
  });

  test('HTTP CRUD handles complete and partial changes and returns only catalog entry fields', async () => {
    const response = await request('/api/models', 'POST', input());
    expect(response.status).toBe(201);
    const created: ModelCatalogEntry = await response.json();
    expect(await (await request(`/api/models/${created.id}`)).json()).toEqual(created);
    const labelResponse = await request(`/api/models/${created.id}`, 'PATCH', { label: '  Новое название  ' });
    expect(labelResponse.status).toBe(200);
    expect(await labelResponse.json()).toMatchObject({ ...created, label: 'Новое название', updatedAt: expect.any(Number) });
    const providerResponse = await request(`/api/models/${created.id}`, 'PATCH', { provider: 'claude' });
    expect(providerResponse.status).toBe(200);
    expect(await providerResponse.json()).toMatchObject({ id: created.id, provider: 'claude', modelId: created.modelId });
    const full = input({ provider: 'codex', modelId: 'full-replacement', label: 'Replacement' });
    expect(await (await request(`/api/models/${created.id}`, 'PATCH', full)).json()).toMatchObject({ ...full, id: created.id, createdAt: created.createdAt });
    const deleted = await request(`/api/models/${created.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    for (const method of ['GET', 'PATCH', 'DELETE']) expect((await request(`/api/models/${created.id}`, method, { label: 'Missing' })).status).toBe(404);
    for (const path of ['bad_id', '%2e%2e%2fworkers', 'missing', 'a'.repeat(101)]) expect((await request('/api/models/' + path)).status).toBe(404);
  });

  test('provider and normalized case-sensitive model ID are unique; labels need not be unique', async () => {
    const first = store.createModel(input({ modelId: 'Same-ID' }));
    const otherProvider = store.createModel(input({ modelId: 'Same-ID', provider: 'claude' }));
    const differentCase = store.createModel(input({ modelId: 'same-id' }));
    expect(store.listModels().slice(-3)).toEqual([first, otherProvider, differentCase]);
    expectError(() => store.createModel(input({ modelId: ' Same-ID ' })), 409);
    expect((await request('/api/models', 'POST', input({ modelId: ' Same-ID ' }))).status).toBe(409);
    expectError(() => store.updateModel(differentCase.id, { modelId: first.modelId, label: 'Do not change' }), 409);
    expect((await request(`/api/models/${differentCase.id}`, 'PATCH', { modelId: first.modelId, label: 'Do not change' })).status).toBe(409);
    expect((await request(`/api/models/${otherProvider.id}`, 'PATCH', { provider: 'codex', label: 'Do not change' })).status).toBe(409);
    expect(store.listModels().slice(-3)).toEqual([first, otherProvider, differentCase]);
    expect(store.updateModel(first.id, { modelId: first.modelId }).id).toBe(first.id);
    expect(() => store.db.query('INSERT INTO model_catalog (id,provider,model_id,label,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('duplicate', first.provider, first.modelId, 'Bypass SQL', BASE, BASE)).toThrow();
  });

  const invalidCreates: unknown[] = [
    null, [], true, 0, 'model', {}, { provider: 'codex' }, { provider: 'codex', modelId: 'abc' },
    { provider: 'codex', label: 'Name' }, { modelId: 'abc', label: 'Name' },
    ...['openai', 'CODEX', '', null, 1, {}, []].map(provider => ({ ...input(), provider })),
    ...[null, '', '   ', 42, false, {}, [], 'x'.repeat(MODEL_ID_LIMIT + 1), '--flag', 'a b', 'a\tb', 'a\nb', 'a\0b', 'a\x7fb',
      'a;rm', 'a$(command)', 'a`command`', "a'quote", 'a"quote', 'а-model', 'a\\b'].map(modelId => ({ ...input(), modelId })),
    ...[null, '', '   ', 42, false, {}, [], '界'.repeat(MODEL_LABEL_LIMIT + 1), 'x\0y', 'x\ty', 'x\ny', 'x\x7fy', 'x\u0085y'].map(label => ({ ...input(), label })),
    ...['id', 'createdAt', 'updatedAt', 'model', 'extra', '__proto__', 'constructor'].map(key => ({ ...input(), [key]: 'injected' })),
  ];
  test.each(invalidCreates.map((value, index) => ({ value, index })))('invalid create is rejected directly and over HTTP without mutation: $index', async ({ value }) => {
    const before = store.listModels();
    expectError(() => store.createModel(value as ModelCatalogInput), 400);
    expect((await request('/api/models', 'POST', value)).status).toBe(400);
    expect(store.listModels()).toEqual(before);
  });

  const invalidPatches: unknown[] = [null, [], '', false, {}, { provider: null }, { provider: 'CODEX' }, { modelId: null },
    { modelId: '' }, { modelId: ' ' }, { modelId: '--flag' }, { modelId: { id: 'abc' } }, { modelId: 'x'.repeat(MODEL_ID_LIMIT + 1) },
    { label: 1 }, { label: '' }, { label: 'x\ny' }, { label: 'x'.repeat(MODEL_LABEL_LIMIT + 1) },
    { id: 'replace-id' }, { updatedAt: 0 }, { createdAt: 0 }, { extra: true }, { provider: 'claude', label: 'Valid', modelId: 'bad;command' }];
  test.each(invalidPatches.map((value, index) => ({ value, index })))('invalid partial edit is atomic: $index', async ({ value }) => {
    const model = store.createModel(input(), BASE);
    const before = store.listModels();
    expectError(() => store.updateModel(model.id, value as Partial<ModelCatalogInput>, BASE + 1), 400);
    expect((await request(`/api/models/${model.id}`, 'PATCH', value)).status).toBe(400);
    expect(store.listModels()).toEqual(before);
  });

  test('direct undefined fields are invalid and exact normalized bounds, native model aliases and Unicode labels are accepted', async () => {
    expectError(() => store.createModel({ ...input(), modelId: undefined } as unknown as ModelCatalogInput), 400);
    const model = store.createModel(input({ modelId: 'x'.repeat(MODEL_ID_LIMIT), label: '界'.repeat(MODEL_LABEL_LIMIT) }));
    for (const key of ['provider', 'modelId', 'label']) expectError(() => store.updateModel(model.id, { [key]: undefined }), 400);
    expect(store.updateModel(model.id, { modelId: `  ${model.modelId}  `, label: `  ${model.label}  ` })).toMatchObject(selectedFields(model));
    for (const modelId of ['opus', 'sonnet[1m]', 'anthropic.claude:dated-v1', 'projects/my-project/models/custom@latest', 'v1+extended']) {
      expect((await request('/api/models', 'POST', input({ modelId, label: 'モデル · Модель 🌟' }))).status).toBe(201);
    }
    const injectionLabel = "x'); DROP TABLE workers; -- <script>alert(1)</script>";
    expect(store.createModel(input({ modelId: 'safe-id', label: injectionLabel })).label).toBe(injectionLabel);
    expect(store.listWorkers()).toEqual([]);
    expect(store.getModel(model.id).modelId).toBe(model.modelId);
  });

  test('caps each provider at 100 and total at 200; full catalogs allow edits and a deletion frees capacity', async () => {
    for (const provider of ['codex', 'claude'] as const) fillProvider(provider);
    const before = store.listModels();
    expect(before).toHaveLength(200);
    for (const provider of ['codex', 'claude'] as const) {
      expectError(() => store.createModel(input({ provider })), 409);
      expect((await request('/api/models', 'POST', input({ provider }))).status).toBe(409);
    }
    const first = before[0]!;
    expectError(() => store.updateModel(first.id, { provider: 'claude', modelId: 'move-to-full-provider', label: 'Do not save' }), 409);
    expect((await request(`/api/models/${first.id}`, 'PATCH', { provider: 'claude', modelId: 'move-to-full-provider' })).status).toBe(409);
    expect(store.listModels()).toEqual(before);
    const edited = store.updateModel(first.id, { modelId: 'allowed-at-capacity', label: 'Allowed edit' });
    expect(edited).toMatchObject({ id: first.id, modelId: 'allowed-at-capacity', label: 'Allowed edit' });
    const removable = before.find(model => model.provider === 'claude')!;
    store.deleteModel(removable.id);
    expect(store.updateModel(first.id, { provider: 'claude' }).provider).toBe('claude');
    expect(store.createModel(input()).provider).toBe('codex');
    expect(store.listModels()).toHaveLength(200);
  });

  test.each(['capacity', 'duplicate'])('concurrent writers cannot defeat the %s constraint', async kind => {
    if (kind === 'capacity') fillProvider('codex', MODEL_CATALOG_PROVIDER_LIMIT - 1);
    const before = store.listModels();
    const gate = join(folder, 'go');
    const children = Array.from({ length: 4 }, (_, index) => {
      const ready = join(folder, `ready-${index}`);
      const model = input({ modelId: kind === 'duplicate' ? 'same-concurrent-id' : `concurrent-${index}` });
      const code = `import { Store, AppError } from ${JSON.stringify(resolve(import.meta.dir, '../server/store.ts'))};
        import { existsSync, writeFileSync } from 'node:fs';
        const store = new Store(${JSON.stringify(join(folder, 'models.sqlite'))});
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(2);
        try { store.createModel(${JSON.stringify(model)}); console.log('saved'); }
        catch (error) { if (!(error instanceof AppError) || error.status !== 409) throw error; console.log('bounded'); }
        finally { store.close(); }`;
      return { ready, child: Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' }) };
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!children.every(({ ready }) => existsSync(ready))) {
        if (Date.now() > deadline) throw new Error('Synthetic writers did not start');
        await Bun.sleep(5);
      }
      writeFileSync(gate, 'go');
      const results = await Promise.all(children.map(async ({ child }) => ({ code: await child.exited,
        out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));
      for (const result of results) { expect(result.code).toBe(0); expect(result.err).toBe(''); }
      expect(results.filter(item => item.out.trim() === 'saved')).toHaveLength(1);
      expect(store.listModels()).toHaveLength(before.length + 1);
    } finally {
      children.forEach(({ child }) => child.kill());
      await Promise.all(children.map(({ child }) => child.exited));
    }
  });
});

describe('catalog edits do not alter execution settings', () => {
  test('provider/ID/label changes and deletion preserve workers, immutable simple runs and future workflow steps', async () => {
    const catalog = store.createModel(input({ modelId: 'original-model' }));
    const worker = store.createWorker(workerInput({ model: catalog.modelId }));
    const simple = store.createTask(taskInput({ workerId: worker.id }));
    const workflow = store.createTask(taskInput({ title: 'Workflow', steps: [
      { workerId: worker.id, title: 'First', instruction: 'Plan.' },
      { workerId: worker.id, title: 'Second', instruction: 'Build.' },
    ] }));
    const oldRun = store.startManual(simple.id, true);
    store.finish(oldRun.id, 'completed', 'Already finished', null);
    const active = engine.start(workflow.id);
    expect(calls[0]!.input).toMatchObject({ provider: 'codex', model: 'original-model' });
    const rawBefore = store.db.query('SELECT * FROM runs ORDER BY id').all();
    const workersBefore = store.db.query('SELECT * FROM workers').all();
    const tasksBefore = store.db.query('SELECT * FROM tasks ORDER BY id').all();
    for (const patch of [{ label: 'Renamed' }, { modelId: 'new-catalog-id' }, { provider: 'claude' }]) {
      expect((await request(`/api/models/${catalog.id}`, 'PATCH', patch)).status).toBe(200);
      expect(store.getWorker(worker.id)).toEqual(worker);
      expect(store.db.query('SELECT * FROM runs ORDER BY id').all()).toEqual(rawBefore);
      expect(store.db.query('SELECT * FROM workers').all()).toEqual(workersBefore);
      expect(store.db.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(tasksBefore);
    }
    expect((await request(`/api/models/${catalog.id}`, 'DELETE')).status).toBe(200);
    expect(store.db.query('SELECT * FROM runs ORDER BY id').all()).toEqual(rawBefore);
    expect(store.getRun(oldRun.id).worker?.model).toBe('original-model');
    expect(store.getRun(active.id).steps.map(step => step.worker.model)).toEqual(['original-model', 'original-model']);
    calls[0]!.resolve({ sessionId: 'step-one-session', envelope: { status: 'completed', summary: 'First done', questions: [] } });
    await flush();
    expect(calls[1]!.input).toMatchObject({ provider: 'codex', model: 'original-model' });
    calls[1]!.resolve({ sessionId: 'step-two-session', envelope: { status: 'completed', summary: 'Second done', questions: [] } });
    await flush();
    expect(store.getRun(active.id).status).toBe('completed');
    await reopen();
    expect(store.getWorker(worker.id)).toEqual(worker);
    expect(store.startManual(simple.id, true).worker?.model).toBe('original-model');
    expect(store.getRun(oldRun.id).worker?.model).toBe('original-model');
    expect(store.getRun(active.id).steps.map(step => step.worker.model)).toEqual(['original-model', 'original-model']);
  });

  test('new and edited workers choose the caller ID, custom IDs and CLI defaults without catalog membership', async () => {
    clearModels();
    const model = store.createModel(input({ provider: 'claude', modelId: 'catalog-model' }));
    const custom = await request('/api/workers', 'POST', workerInput({ model: 'uncataloged-id' }));
    expect(custom.status).toBe(201);
    const worker = await custom.json();
    expect(worker.model).toBe('uncataloged-id');
    const task = store.createTask(taskInput({ workerId: worker.id }));
    const first = store.startManual(task.id, true);
    expect(first.worker?.model).toBe('uncataloged-id');
    store.finish(first.id, 'completed', 'Done', null);
    // Matching another provider's catalog entry cannot override caller provider or model.
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model: model.modelId })).status).toBe(200);
    expect(store.getWorker(worker.id)).toMatchObject({ provider: 'codex', model: model.modelId });
    store.updateModel(model.id, { modelId: 'edited-catalog-id' });
    store.deleteModel(model.id);
    const second = store.startManual(task.id, true);
    expect(second.worker).toMatchObject({ provider: 'codex', model: 'catalog-model' });
    store.finish(second.id, 'completed', 'Done again', null);
    expect((await request(`/api/workers/${worker.id}`, 'PATCH', { model: null })).status).toBe(200);
    expect(store.startManual(task.id, true).worker?.model).toBeNull();
    expect(store.getRun(first.id).worker?.model).toBe('uncataloged-id');
    expect(store.getRun(second.id).worker?.model).toBe('catalog-model');
    expect(store.listModels()).toEqual([]);
  });
});

describe('model catalog HTTP boundaries', () => {
  const forbiddenHeaders: Record<string, string>[] = [{ host: 'evil.example:4310' }, { origin: 'https://evil.example' },
    { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
  test.each(forbiddenHeaders)('reads and writes inherit Host/Origin/fetch-site guards: %j', async headers => {
    const before = store.listModels(), model = before[0]!;
    for (const [path, method, body] of [
      ['/api/models', 'GET', undefined], [`/api/models/${model.id}`, 'GET', undefined],
      ['/api/models', 'POST', input()], [`/api/models/${model.id}`, 'PATCH', { label: 'Do not save' }],
      [`/api/models/${model.id}`, 'DELETE', {}],
    ] as [string, string, unknown][]) expect((await request(path, method, body, headers)).status).toBe(403);
    expect(store.listModels()).toEqual(before);
  });

  test('all mutations require Origin and read routes work locally without Origin', async () => {
    const before = store.listModels(), model = before[0]!;
    for (const [path, method] of [['/api/models', 'POST'], [`/api/models/${model.id}`, 'PATCH'], [`/api/models/${model.id}`, 'DELETE']]) {
      expect((await handler(new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) }))).status).toBe(403);
    }
    for (const path of ['/api/models', `/api/models/${model.id}`]) {
      const response = await handler(new Request(ORIGIN + path));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(store.listModels()).toEqual(before);
  });

  test.each(['[]', 'null', 'true', '42', '"model"', '{'])('create and patch reject malformed or nonobject JSON %s', async body => {
    const before = store.listModels();
    for (const [path, method] of [['/api/models', 'POST'], [`/api/models/${before[0]!.id}`, 'PATCH']]) {
      expect((await handler(new Request(ORIGIN + path, { method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body }))).status).toBe(400);
    }
    expect(store.listModels()).toEqual(before);
  });

  test('create and patch require JSON content type', async () => {
    const before = store.listModels();
    for (const type of ['text/plain', 'application/octet-stream', '']) {
      expect((await request('/api/models', 'POST', input(), { 'content-type': type })).status).toBe(415);
      expect((await request(`/api/models/${before[0]!.id}`, 'PATCH', { label: 'Do not save' }, { 'content-type': type })).status).toBe(415);
    }
    expect(store.listModels()).toEqual(before);
  });

  test('32 KiB JSON cap counts actual UTF-8 bytes for create and patch without partial mutation', async () => {
    const send = (path: string, method: string, body: string, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + path, {
      method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body,
    }));
    const json = JSON.stringify(input()), exact = json + ' '.repeat(32_768 - Buffer.byteLength(json));
    const created = await send('/api/models', 'POST', exact);
    expect(created.status).toBe(201);
    const model: ModelCatalogEntry = await created.json();
    const patch = JSON.stringify({ label: 'At exact cap' }), exactPatch = patch + ' '.repeat(32_768 - Buffer.byteLength(patch));
    expect((await send(`/api/models/${model.id}`, 'PATCH', exactPatch)).status).toBe(200);
    const before = store.listModels();
    for (const [path, method, raw] of [['/api/models', 'POST', exact], [`/api/models/${model.id}`, 'PATCH', exactPatch]]) {
      expect((await send(path!, method!, raw! + ' ')).status).toBe(413);
      expect((await send(path!, method!, raw! + ' ', { 'content-length': '1' })).status).toBe(413);
      expect((await send(path!, method!, '{}', { 'content-length': '32769' })).status).toBe(413);
      expect((await send(path!, method!, JSON.stringify({ label: 'é'.repeat(17_000) }))).status).toBe(413);
    }
    expect(store.listModels()).toEqual(before);
  });

  test('oversized streamed JSON is cancelled across chunks and leaves the catalog untouched', async () => {
    const before = store.listModels();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(16_384)); controller.enqueue(new Uint8Array(16_384)); controller.enqueue(new Uint8Array(1));
    }, cancel() { cancelled = true; } });
    const response = await handler(new Request(ORIGIN + '/api/models', { method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '1' }, body: stream }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(store.listModels()).toEqual(before);
  });
});
