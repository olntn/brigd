import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCallbacks, AgentInput, AgentOutcome } from '../server/adapter';
import { Engine, type AgentFactory } from '../server/engine';
import { ProtocolError } from '../server/protocol';
import { AppError, Store } from '../server/store';
import type { Envelope, TaskInput } from '../src/lib/types';

interface Invocation {
  input: AgentInput;
  callbacks: AgentCallbacks;
  resolve: (outcome: AgentOutcome) => void;
  reject: (error: unknown) => void;
  cancelled: number;
  ignoreCancel: boolean;
}
function controlledFactory() {
  const calls: Invocation[] = [];
  const factory: AgentFactory = (input, callbacks) => {
    let resolve!: Invocation['resolve'];
    let reject!: Invocation['reject'];
    const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
    const call = { input, callbacks, resolve, reject, cancelled: 0, ignoreCancel: false };
    calls.push(call);
    return { result, cancel: () => { call.cancelled++; if (!call.ignoreCancel) reject(new Error('Synthetic cancellation')); } };
  };
  return { calls, factory };
}
const outcome = (status: Envelope['status'] = 'completed', sessionId = 'session-exact'): AgentOutcome => ({
  sessionId, envelope: { status, summary: status === 'needs_input' ? 'Need a target' : 'Checked repository', questions: status === 'needs_input' ? ['Which file?', 'Which branch?'] : [] },
});
const input = (cwd: string, patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Task', instruction: 'Review the local repository.', provider: 'codex', cwd,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const expectStatusError = (action: () => unknown, status: number) => {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
};
let store: Store;
let engine: Engine;
let folder: string;
let agent: ReturnType<typeof controlledFactory>;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trackt-engine-test-'));
  store = new Store(join(folder, 'trackt.sqlite'));
  agent = controlledFactory();
  engine = new Engine(store, true, agent.factory);
});
afterEach(async () => {
  // Every test uses a controlled fake; cleanup cannot invoke a provider or leave a process behind.
  for (const call of agent.calls) { call.ignoreCancel = false; call.reject(new Error('Test cleanup')); }
  await flush();
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('agent lifecycle orchestration', () => {
  test('manual launch passes a persisted snapshot and records streamed progress and result', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    expect(run.status).toBe('running');
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.input).toEqual({ provider: 'codex', cwd: folder, instruction: task.instruction, instructions: [], sessionId: undefined, answer: undefined, mock: true, effort: 'default', communicationStyle: '' });
    agent.calls[0]!.callbacks.onSession('session-exact');
    agent.calls[0]!.callbacks.onComment('Reading files');
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', sessionId: 'session-exact', summary: 'Checked repository', error: null });
    expect(store.getRun(run.id).finishedAt).not.toBeNull();
    expect(store.detail(task.id).comments.map(c => c.kind)).toEqual(['system', 'agent', 'result']);
    expect(store.detail(task.id).comments[1]?.body).toBe('Reading files');
  });

  test('needs_input creates visible questions and answer resumes the exact session/run', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting_input', sessionId: 'session-exact', finishedAt: null, turn: 1 });
    expect(store.detail(task.id).comments.filter(c => c.kind === 'question').map(c => c.body)).toEqual(['Which file?', 'Which branch?']);
    const resumed = engine.resume(run.id, 'src/main.ts on main', false);
    expect(resumed).toMatchObject({ id: run.id, status: 'running', turn: 2, sessionId: 'session-exact' });
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]!.input).toMatchObject({ sessionId: 'session-exact', answer: 'src/main.ts on main', instruction: task.instruction, cwd: folder });
    expect(store.detail(task.id).comments.at(-1)).toMatchObject({ kind: 'user', body: 'src/main.ts on main', runId: run.id });
    agent.calls[1]!.resolve(outcome());
    await flush();
    expect(store.getTask(task.id)).toMatchObject({ status: 'completed', runCount: 1 });
  });

  test('resumption uses original provider, folder, instruction, and mock flag after task edits', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    store.updateTask(task.id, input('/var/tmp', { provider: 'claude', instruction: 'New instruction' }));
    engine.resume(run.id, 'Answer', false);
    expect(agent.calls[1]!.input).toMatchObject({ provider: 'codex', cwd: folder, instruction: task.instruction, sessionId: 'session-exact', mock: true });
  });

  test.each(['codex', 'claude'] as const)('%s launches and resumes frozen worker effort/style after profile edits and archiving', async provider => {
    const worker = store.createWorker({ name: 'Reviewer', avatarUrl: null, provider, effort: 'high', communicationStyle: 'Be concise; "quotes" stay literal.' });
    const task = store.createTask(input(folder, { provider, workerId: worker.id }));
    const run = engine.start(task.id);
    expect(run.worker).toMatchObject({ id: worker.id, provider, effort: 'high', communicationStyle: worker.communicationStyle });
    expect(agent.calls[0]!.input).toEqual({ provider, cwd: folder, instruction: task.instruction, instructions: [], sessionId: undefined, answer: undefined, mock: true, effort: 'high', communicationStyle: worker.communicationStyle });
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    const nextProvider = provider === 'codex' ? 'claude' : 'codex';
    store.updateWorker(worker.id, { name: 'Changed reviewer', avatarUrl: null, provider: nextProvider, effort: 'low', communicationStyle: 'A different style' });
    store.archiveWorker(worker.id);
    engine.resume(run.id, 'Continue with the original task.', false);
    expect(agent.calls[1]!.input).toEqual({ ...agent.calls[0]!.input, sessionId: 'session-exact', answer: 'Continue with the original task.' });
    expect(store.getRun(run.id).worker).toEqual(run.worker);
    agent.calls[1]!.resolve(outcome());
    await flush();
    engine.start(task.id);
    expect(agent.calls[2]!.input).toMatchObject({ provider: nextProvider, effort: 'low', communicationStyle: 'A different style', sessionId: undefined });
  });

  test('scheduled launch uses the same persisted worker settings as manual launch', () => {
    const now = Date.now();
    const worker = store.createWorker({ name: 'Scheduled reviewer', avatarUrl: null, provider: 'claude', effort: 'max', communicationStyle: 'Use bullet points.' });
    const task = store.createTask(input(folder, { provider: 'claude', workerId: worker.id, schedule: 'interval', intervalMinutes: 5, firstRunAt: now }));
    engine.tick(now);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.input).toMatchObject({ provider: 'claude', effort: 'max', communicationStyle: worker.communicationStyle });
    expect(store.detail(task.id).runs[0]!.worker).toMatchObject({ id: worker.id, effort: 'max' });
  });

  test('a waiting worker session resumes frozen settings after closing and reopening the database', async () => {
    const worker = store.createWorker({ name: 'Persistent reviewer', avatarUrl: null, provider: 'codex', effort: 'xhigh', communicationStyle: 'Report only verified facts.' });
    const task = store.createTask(input(folder, { workerId: worker.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    store.updateWorker(worker.id, { ...worker, provider: 'claude', effort: 'max', communicationStyle: 'Changed after restart.' });
    engine = new Engine(store, true, agent.factory);
    engine.startScheduler();
    expect(agent.calls).toHaveLength(1);
    engine.resume(run.id, 'Use src/main.ts.', false);
    expect(agent.calls[1]!.input).toMatchObject({ provider: 'codex', effort: 'xhigh', communicationStyle: worker.communicationStyle, sessionId: 'session-exact', answer: 'Use src/main.ts.' });
    expect(store.getRun(run.id).worker).toEqual(run.worker);
  });

  test('callbacks from an older turn cannot mutate the resumed turn', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    const old = agent.calls[0]!;
    old.resolve(outcome('needs_input'));
    await flush();
    engine.resume(run.id, 'Answer', false);
    const before = store.detail(task.id);
    old.callbacks.onSession('wrong-stale-session');
    old.callbacks.onComment('Stale progress from previous turn');
    expect(store.detail(task.id)).toEqual(before);
    agent.calls[1]!.resolve(outcome());
    await flush();
    expect(store.getRun(run.id).status).toBe('completed');
  });

  test('an active or waiting run prevents a second factory invocation', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    expectStatusError(() => engine.start(task.id), 409);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    expectStatusError(() => engine.start(task.id), 409);
    expect(agent.calls).toHaveLength(1);
    expect(store.getRun(run.id).status).toBe('waiting_input');
  });

  test('a run without a session cannot invoke the resume factory', () => {
    const task = store.createTask(input(folder));
    const run = store.startManual(task.id, true);
    store.finish(run.id, 'waiting_input', 'Need answer', null);
    expectStatusError(() => engine.resume(run.id, 'Answer', false), 409);
    expect(agent.calls).toHaveLength(0);
    expect(store.getRun(run.id).turn).toBe(1);
  });

  test('protocol rejection yields failed, preserves session, and never creates success output', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('session-exact');
    agent.calls[0]!.reject(new ProtocolError('The final response was not a JSON result envelope.'));
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', sessionId: 'session-exact', summary: null, error: 'The final response was not a JSON result envelope.' });
    expect(store.detail(task.id).comments.some(c => c.kind === 'result')).toBe(false);
    expect(store.detail(task.id).comments.at(-1)?.kind).toBe('system');
  });

  test('a final session mismatch fails transactionally without writing result or questions', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('session-exact');
    agent.calls[0]!.resolve(outcome('needs_input', 'wrong-session'));
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', sessionId: 'session-exact' });
    expect(store.detail(task.id).comments.filter(c => ['result', 'question'].includes(c.kind))).toHaveLength(0);
    expect(store.getRun(run.id).error).toContain('другую сессию');
  });

  test('synchronous factory failures become durable failed runs', async () => {
    await engine.shutdown();
    engine = new Engine(store, false, () => { throw new Error('Executable unavailable'); });
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    expect(run).toMatchObject({ status: 'failed', mock: false, error: 'Executable unavailable' });
    expect(store.detail(task.id).comments.at(-1)?.body).toBe('Executable unavailable');
  });

  test('blocked remains distinct from failed and completed', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve({ sessionId: 'session-exact', envelope: { status: 'blocked', summary: 'Native tool approval is required', questions: [] } });
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'blocked', summary: 'Native tool approval is required', error: 'Native tool approval is required' });
    expect(store.activeRun(task.id)).toBeNull();
    expect(store.detail(task.id).comments.some(c => c.kind === 'result' || c.kind === 'question')).toBe(false);
  });

  test.each(['resolve', 'reject'] as const)('cancel wins against a late %s, session, and progress callbacks', async kind => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    const call = agent.calls[0]!;
    call.ignoreCancel = true;
    const cancelled = engine.cancel(run.id);
    expect(cancelled.status).toBe('cancelling');
    expect(call.cancelled).toBe(1);
    const before = store.detail(task.id);
    call.callbacks.onSession('late-session');
    call.callbacks.onComment('Late misleading progress');
    if (kind === 'resolve') call.resolve(outcome());
    else call.reject(new Error('Late failure'));
    await flush();
    const after = store.detail(task.id);
    expect(after.runs[0]).toMatchObject({ status: 'cancelled', sessionId: null, summary: null, error: null });
    expect(after.comments.filter(comment => comment.kind !== 'system')).toEqual(before.comments.filter(comment => comment.kind !== 'system'));
    expect(after.comments.some(comment => comment.body.includes('Late misleading'))).toBe(false);
  });

  test.each(['resolve', 'reject'] as const)('cancelling keeps exclusive occupancy until the process settles with %s', async settlement => {
    const now = Date.now();
    const task = store.createTask(input(folder, { schedule: 'interval', intervalMinutes: 5, firstRunAt: now }));
    const first = engine.start(task.id);
    const call = agent.calls[0]!;
    call.ignoreCancel = true;
    expect(engine.cancel(first.id).status).toBe('cancelling');
    expect(store.activeRun(task.id)?.id).toBe(first.id);
    expectStatusError(() => engine.cancel(first.id), 409);
    expectStatusError(() => engine.start(task.id), 409);
    engine.tick(now + 31 * 60_000);
    expect(agent.calls).toHaveLength(1);
    expect(store.getTask(task.id).nextRunAt).toBe(now + 35 * 60_000);
    expect(store.getRun(first.id).status).toBe('cancelling');
    if (settlement === 'resolve') call.resolve(outcome());
    else call.reject(new Error('Process terminated after delay'));
    await flush();
    expect(store.getRun(first.id).status).toBe('cancelled');
    expect(store.activeRun(task.id)).toBeNull();
    expect(engine.start(task.id).id).not.toBe(first.id);
    expect(agent.calls).toHaveLength(2);
  });

  test('cancel of a waiting run does not require an active process and allows a new run', async () => {
    const task = store.createTask(input(folder));
    const first = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    expect(engine.cancel(first.id).status).toBe('cancelled');
    expect(agent.calls[0]!.cancelled).toBe(0);
    expect(engine.start(task.id).id).not.toBe(first.id);
    expect(agent.calls).toHaveLength(2);
  });

  test('progress and failure messages are bounded before persistence', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onComment('a'.repeat(20_000));
    agent.calls[0]!.reject(new Error('e'.repeat(20_000)));
    await flush();
    expect(store.detail(task.id).comments.find(c => c.kind === 'agent')?.body).toHaveLength(16_000);
    expect(store.getRun(run.id).error).toHaveLength(16_000);
    expect(store.detail(task.id).comments.at(-1)?.body).toHaveLength(16_000);
  });
});

describe('scheduler and restart safety', () => {
  test('tick skips missed intervals, honors pause, and cannot duplicate active work', () => {
    const now = Date.now();
    const task = store.createTask(input(folder, { schedule: 'interval', intervalMinutes: 5, firstRunAt: now - 62 * 60_000 }));
    store.createTask(input(folder, { schedule: 'interval', intervalMinutes: 5, firstRunAt: now - 60_000, paused: true }));
    engine.tick(now);
    engine.tick(now);
    engine.tick(now + 20 * 60_000);
    expect(agent.calls).toHaveLength(1);
    expect(store.detail(task.id).runs).toHaveLength(1);
    expect(store.detail(task.id).runs[0]?.scheduledFor).toBe(now - 2 * 60_000);
    expect(store.getTask(task.id).nextRunAt).toBe(now + 23 * 60_000);
  });

  test('restart keeps waiting sessions, interrupts running work, and never replays either', async () => {
    const now = Date.now();
    const taskInput = input(folder, { schedule: 'interval', intervalMinutes: 5, firstRunAt: now - 60 * 60_000 });
    const waitingTask = store.createTask(taskInput);
    const interruptedTask = store.createTask(taskInput);
    const waiting = store.startManual(waitingTask.id, true);
    store.setSession(waiting.id, 'saved-waiting');
    store.finish(waiting.id, 'waiting_input', 'Pick one', null);
    const running = store.startManual(interruptedTask.id, true);
    store.setSession(running.id, 'saved-running');
    // Simulate a process exit: a fresh connection and engine must reconstruct state solely from SQLite.
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    engine = new Engine(store, true, agent.factory);
    engine.startScheduler();
    expect(agent.calls).toHaveLength(0);
    expect(store.getRun(waiting.id)).toMatchObject({ status: 'waiting_input', sessionId: 'saved-waiting' });
    expect(store.getRun(running.id)).toMatchObject({ status: 'interrupted', sessionId: 'saved-running' });
    expectStatusError(() => engine.resume(running.id, 'Continue', false), 409);
    expect(agent.calls).toHaveLength(0);
    engine.resume(running.id, 'Previous process is stopped', true);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.input).toMatchObject({ sessionId: 'saved-running', answer: 'Previous process is stopped' });
    agent.calls[0]!.resolve(outcome('completed', 'saved-running'));
    await flush();
    expect(store.getTask(interruptedTask.id).runCount).toBe(1);
    expect(store.getRun(running.id).status).toBe('completed');
  });

  test('restart treats an unsettled cancellation as interrupted and never auto-replays it', () => {
    const task = store.createTask(input(folder, { schedule: 'interval', intervalMinutes: 1, firstRunAt: Date.now() - 600_000 }));
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'cancel-in-flight-session');
    store.cancel(run.id, Date.now(), true);
    expect(store.getRun(run.id).status).toBe('cancelling');
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    engine = new Engine(store, true, agent.factory);
    engine.startScheduler();
    expect(store.getRun(run.id)).toMatchObject({ status: 'interrupted', sessionId: 'cancel-in-flight-session' });
    expect(agent.calls).toHaveLength(0);
    expectStatusError(() => engine.start(task.id), 409);
    expectStatusError(() => engine.resume(run.id, 'Continue', false), 409);
    expect(store.getTask(task.id).runCount).toBe(1);
  });

  test('shutdown persists interruption before killing work and prevents further launches', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('saved-running');
    await engine.shutdown();
    expect(agent.calls[0]!.cancelled).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: 'interrupted', sessionId: 'saved-running', turn: 1 });
    expectStatusError(() => engine.start(task.id), 503);
    expectStatusError(() => engine.resume(run.id, 'Continue', true), 503);
    engine.tick(Date.now() + 60_000);
    expect(agent.calls).toHaveLength(1);
  });
});
