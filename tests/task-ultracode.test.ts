import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCallbacks, AgentInput, AgentOutcome } from '../server/adapter';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { TASK_APP_OPERATIONS } from '../server/task-mcp-app-protocol';
import { runUltracode } from '../src/lib/workers';
import type { Envelope, Task, TaskInput, WorkerInput } from '../src/lib/types';

const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const INVALID_MESSAGE = 'ultracode должен быть true, false или null';
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
  title: 'Inspect repository', instruction: 'Review local code.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const workerInput = (patch: Partial<WorkerInput> = {}): WorkerInput => ({
  name: 'Reviewer', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null, ...patch,
});
const outcome = (status: Envelope['status'] = 'completed', sessionId = 'session-exact'): AgentOutcome => ({
  sessionId, envelope: { status, summary: status === 'needs_input' ? 'Need a target' : 'Checked repository', questions: status === 'needs_input' ? ['?'] : [] },
});
const request = (path: string, method = 'GET', value?: unknown) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json' },
  body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
}));
async function createTask(patch: Partial<TaskInput> = {}): Promise<Task> {
  const response = await request('/api/tasks', 'POST', taskInput(patch));
  expect(response.status).toBe(201);
  return response.json();
}
async function patchTask(id: string, patch: Record<string, unknown>): Promise<Task> {
  const response = await request(`/api/tasks/${id}`, 'PATCH', patch);
  expect(response.status).toBe(200);
  return response.json();
}
/** Finishes an agent call and lets the engine settle; a resumed session must keep its saved id. */
async function settle(index: number, status: Envelope['status'] = 'completed', sessionId = 'session-exact') {
  calls[index]!.resolve(outcome(status, sessionId));
  await flush();
}
/** A manual card refuses a second start after success, so later runs come from the scheduler. */
let due = Date.now();
function scheduleNext(taskId: string) {
  due += 1;
  store.updateTask(taskId, { ...store.getTask(taskId), schedule: 'interval', intervalMinutes: 1, firstRunAt: due });
  engine.tick(due);
  const run = store.activeRun(taskId);
  expect(run).not.toBeNull();
  expect(run!.trigger).toBe('schedule');
  return run!;
}
function expectAppError(action: () => unknown, message: string, status = 400) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); expect((error as AppError).message).toBe(message); }
}
async function reopen() {
  await engine.shutdown();
  await flush();
  store.close();
  store = new Store(join(folder, 'ultracode.sqlite'));
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
}
const columns = (table: string) => (store.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
const INVALID = [{ ultracode: 'true' }, { ultracode: 1 }, { ultracode: {} }];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-task-ultracode-'));
  store = new Store(join(folder, 'ultracode.sqlite'));
  calls = [];
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('task ultracode over HTTP', () => {
  test('an omitted choice is stored as null and follows the profile', async () => {
    const task = await createTask();
    expect(task.ultracode).toBeNull();
    expect(store.getTask(task.id).ultracode).toBeNull();
    expect((await (await request('/api/tasks')).json())[0].ultracode).toBeNull();
    expect((await (await request(`/api/tasks/${task.id}`)).json()).task.ultracode).toBeNull();
  });

  test.each([true, false, null])('ultracode=%p persists through creation and unrelated edits', async ultracode => {
    const task = await createTask({ ultracode });
    expect(task.ultracode).toBe(ultracode);
    expect(store.getTask(task.id).ultracode).toBe(ultracode);
    const renamed = await patchTask(task.id, { title: 'Renamed' });
    expect(renamed).toMatchObject({ title: 'Renamed', ultracode });
    expect((await patchTask(task.id, { paused: true })).ultracode).toBe(ultracode);
    expect((await patchTask(task.id, { tagIds: [] })).ultracode).toBe(ultracode);
    expect(store.getTask(task.id).ultracode).toBe(ultracode);
  });

  test('PATCH switches the choice and an explicit null resets it to the profile', async () => {
    const task = await createTask({ ultracode: true });
    expect((await patchTask(task.id, { ultracode: false })).ultracode).toBe(false);
    expect(store.getTask(task.id).ultracode).toBe(false);
    expect((await patchTask(task.id, { ultracode: null })).ultracode).toBeNull();
    expect(store.getTask(task.id).ultracode).toBeNull();
    expect((await patchTask(task.id, { ultracode: true })).ultracode).toBe(true);
    expect(store.getTask(task.id).ultracode).toBe(true);
  });

  test.each(INVALID)('rejects malformed $ultracode atomically over HTTP and in the store', async ({ ultracode }) => {
    const task = await createTask({ ultracode: true });
    const before = JSON.stringify(store.getTask(task.id));
    const response = await request(`/api/tasks/${task.id}`, 'PATCH', { ultracode, title: 'Do not save' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INVALID_MESSAGE });
    expect(JSON.stringify(store.getTask(task.id))).toBe(before);
    const created = await request('/api/tasks', 'POST', { ...taskInput(), ultracode });
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ error: INVALID_MESSAGE });
    expect(store.listTasks()).toHaveLength(1);
    expectAppError(() => store.createTask({ ...taskInput(), ultracode } as TaskInput), INVALID_MESSAGE);
    expectAppError(() => store.updateTask(task.id, { ...taskInput(), ultracode } as TaskInput), INVALID_MESSAGE);
    expect(JSON.stringify(store.getTask(task.id))).toBe(before);
  });

  test('updateTask keeps the stored choice when the input omits it', () => {
    const task = store.createTask(taskInput({ ultracode: true }));
    const { ultracode: _ultracode, ...withoutChoice } = task;
    expect(store.updateTask(task.id, { ...withoutChoice, title: 'Renamed' } as TaskInput)).toMatchObject({ title: 'Renamed', ultracode: true });
    expect(store.updateTask(task.id, { ...withoutChoice, ultracode: undefined } as TaskInput).ultracode).toBe(true);
    expect(store.updateTask(task.id, { ...withoutChoice, ultracode: null } as TaskInput).ultracode).toBeNull();
    expect(store.getTask(task.id).ultracode).toBeNull();
  });
});

describe('agent input', () => {
  test.each([
    { profile: true, task: false },
    { profile: false, task: true },
    { profile: true, task: null },
    { profile: false, task: null },
  ])('worker profile $profile with task choice $task', ({ profile, task: choice }) => {
    const worker = store.createWorker(workerInput({ ultracode: profile }));
    const task = store.createTask(taskInput({ workerId: worker.id, ultracode: choice }));
    const run = engine.start(task.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.ultracode).toBe(choice ?? profile);
    expect(run.ultracode).toBe(choice);
    // The frozen snapshot keeps the profile's own setting; only the launch input is overridden.
    expect(run.worker).toMatchObject({ id: worker.id, ultracode: profile });
    expect(runUltracode(run)).toBe(choice ?? profile);
  });

  test.each([true, false])('a worker-less task with ultracode=%p forces that mode', choice => {
    const task = store.createTask(taskInput({ ultracode: choice }));
    const run = engine.start(task.id);
    expect(run.worker).toBeNull();
    expect(run.ultracode).toBe(choice);
    expect(calls[0]!.input.ultracode).toBe(choice);
  });

  test('a worker-less task with null keeps the CLI default by omitting the key', () => {
    const task = store.createTask(taskInput());
    const run = engine.start(task.id);
    expect(run.ultracode).toBeNull();
    expect(calls[0]!.input).not.toHaveProperty('ultracode');
    expect(runUltracode(run)).toBeUndefined();
  });

  test('the choice is frozen at start: later card edits change only new runs', async () => {
    const worker = store.createWorker(workerInput({ ultracode: false }));
    const task = await createTask({ workerId: worker.id, ultracode: true });
    const run = engine.start(task.id);
    expect(calls[0]!.input.ultracode).toBe(true);
    await settle(0, 'needs_input');
    expect(store.getRun(run.id).status).toBe('waiting_input');
    await patchTask(task.id, { ultracode: false });
    expect(store.getTask(task.id).ultracode).toBe(false);
    engine.resume(run.id, 'answer', false);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ sessionId: 'session-exact', answer: 'answer', ultracode: true });
    await settle(1);
    const frozen = store.getRun(run.id);
    expect(frozen.status).toBe('completed');
    expect(frozen.ultracode).toBe(true);
    expect(frozen.worker!.ultracode).toBe(store.getWorker(worker.id).ultracode);
    expect(frozen.worker!.ultracode).toBe(false);
    const next = scheduleNext(task.id);
    expect(next.id).not.toBe(run.id);
    expect(next.ultracode).toBe(false);
    expect(calls[2]!.input.ultracode).toBe(false);
    const detail = await (await request(`/api/tasks/${task.id}`)).json();
    expect(detail.runs.map((entry: { id: string; ultracode: boolean | null }) => [entry.id, entry.ultracode])).toEqual(expect.arrayContaining([[run.id, true], [next.id, false]]));
  });
});

describe('workflow stages', () => {
  test.each([
    { choice: null, expected: [true, false] },
    { choice: true, expected: [true, true] },
    { choice: false, expected: [false, false] },
  ])('task choice $choice applies to every stage as $expected', async ({ choice, expected }) => {
    const ultra = store.createWorker(workerInput({ name: 'Ultra', ultracode: true }));
    const plain = store.createWorker(workerInput({ name: 'Plain', provider: 'claude', ultracode: false }));
    const task = store.createTask(taskInput({ ultracode: choice, steps: [
      { workerId: ultra.id, title: 'Plan', instruction: 'Plan.' },
      { workerId: plain.id, title: 'Build', instruction: 'Build.' },
    ] }));
    expect(task.ultracode).toBe(choice);
    const run = engine.start(task.id);
    expect(run.ultracode).toBe(choice);
    expect(run.steps.map(step => step.worker.ultracode)).toEqual([true, false]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ provider: 'codex', ultracode: expected[0] });
    await settle(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ provider: 'claude', ultracode: expected[1] });
    expect(store.getRun(run.id).ultracode).toBe(choice);
    expect(store.getRun(run.id).steps.map(step => step.worker.ultracode)).toEqual([true, false]);
  });
});

describe('followups', () => {
  test.each([true, false])('a followup keeps the source run\'s frozen choice %p over the card\'s current one', async choice => {
    const worker = store.createWorker(workerInput({ ultracode: !choice }));
    const task = await createTask({ workerId: worker.id, ultracode: choice });
    const source = engine.start(task.id);
    expect(calls[0]!.input.ultracode).toBe(choice);
    await settle(0, 'completed', 'source-session');
    expect(store.getRun(source.id)).toMatchObject({ status: 'completed', ultracode: choice });
    await patchTask(task.id, { ultracode: null });
    expect(store.getTask(task.id).ultracode).toBeNull();
    const followup = engine.followup(task.id, { sourceRunId: source.id, sourceStepIndex: null, body: 'more', attachmentIds: [], requestId: 'r1' });
    expect(followup.id).not.toBe(source.id);
    expect(followup.ultracode).toBe(choice);
    expect(store.getRun(followup.id).ultracode).toBe(choice);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ sessionId: 'source-session', ultracode: choice, followup: { sourceRunId: source.id, sourceStepIndex: null, request: 'more' } });
    await settle(1, 'completed', 'source-session');
    // A fresh run follows the card again, which now defers to the profile.
    const next = scheduleNext(task.id);
    expect(next.ultracode).toBeNull();
    expect(calls[2]!.input).toMatchObject({ sessionId: undefined, ultracode: !choice });
    expect(calls[2]!.input).not.toHaveProperty('followup');
  });
});

describe('database migration', () => {
  test('pre-ultracode databases gain nullable columns and follow the worker profile', async () => {
    const worker = store.createWorker(workerInput({ ultracode: true }));
    const task = store.createTask(taskInput({ workerId: worker.id, ultracode: false }));
    const run = engine.start(task.id);
    expect(calls[0]!.input.ultracode).toBe(false);
    await settle(0, 'needs_input');
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting_input', ultracode: false });
    await engine.shutdown();
    store.db.exec('ALTER TABLE tasks DROP COLUMN ultracode');
    store.db.exec('ALTER TABLE runs DROP COLUMN ultracode');
    expect(columns('tasks')).not.toContain('ultracode');
    expect(columns('runs')).not.toContain('ultracode');
    for (let pass = 0; pass < 2; pass++) {
      await reopen();
      expect(columns('tasks')).toContain('ultracode');
      expect(columns('runs')).toContain('ultracode');
      expect(store.getTask(task.id).ultracode).toBeNull();
      expect(store.getRun(run.id)).toMatchObject({ status: 'waiting_input', ultracode: null });
      expect(store.getRun(run.id).worker).toMatchObject({ id: worker.id, ultracode: true });
      expect(store.db.query('SELECT ultracode FROM tasks WHERE id=?').get(task.id)).toEqual({ ultracode: null });
      expect(store.db.query('SELECT ultracode FROM runs WHERE id=?').get(run.id)).toEqual({ ultracode: null });
    }
    engine.resume(run.id, 'main', false);
    expect(calls[1]!.input).toMatchObject({ sessionId: 'session-exact', answer: 'main', ultracode: true });
    await settle(1);
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', ultracode: null });
    expect(scheduleNext(task.id).ultracode).toBeNull();
    expect(calls[2]!.input.ultracode).toBe(true);
    await settle(2);
    // The re-added column accepts a fresh choice and freezes it again.
    expect((await patchTask(task.id, { ultracode: false })).ultracode).toBe(false);
    expect(scheduleNext(task.id).ultracode).toBe(false);
    expect(calls[3]!.input.ultracode).toBe(false);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('MCP app protocol', () => {
  test.each(['create_task', 'update_task'])('%s accepts a nullable boolean ultracode', name => {
    const operation = TASK_APP_OPERATIONS.find(entry => entry.name === name);
    expect(operation).toBeDefined();
    const properties = operation!.inputSchema.properties as Record<string, { properties?: Record<string, { type?: unknown }> }>;
    expect(properties.data?.properties?.ultracode?.type).toEqual(['boolean', 'null']);
  });
});
