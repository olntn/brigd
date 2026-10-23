import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { AgentRunError, buildPrompt, type AgentCallbacks, type AgentInput, type AgentOutcome } from '../server/adapter';
import { Engine, type AgentFactory } from '../server/engine';
import { ProtocolError, UsageLimitError } from '../server/protocol';
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
  test('a failed webhook retries without affecting a question or failed run; payload contains metadata only', async () => {
    const received: { body: string; signature: string | null }[] = [];
    const receiver = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      received.push({ body: await request.text(), signature: request.headers.get('X-Brigd-Signature') });
      return new Response(null, { status: 503 });
    } });
    try {
      store.updateGeneralSettings({ webhookUrl: `http://127.0.0.1:${receiver.port}/events`, webhookSecret: 'test-secret' });
      const task = store.createTask(input(folder, { title: 'Needs attention', instruction: 'PRIVATE instructions' }));
      const run = engine.start(task.id);
      expect(() => store.db.transaction(() => { store.finish(run.id, 'waiting_input', null, null); throw new Error('rollback'); }).immediate()).toThrow('rollback');
      await store.notifications.idle();
      expect(received).toHaveLength(0);
      expect(store.getRun(run.id).status).toBe('running');
      agent.calls[0]!.resolve(outcome('needs_input'));
      await flush();
      await store.notifications.idle();
      expect(store.getRun(run.id).status).toBe('waiting_input');
      expect(received).toHaveLength(2);
      expect(JSON.parse(received[0]!.body)).toEqual({ event: 'run.waiting_input', taskId: task.id, title: task.title, worker: 'codex', status: 'waiting_input', at: store.getRun(run.id).updatedAt });
      expect(received[0]!.signature).toBe(createHmac('sha256', 'test-secret').update(received[0]!.body).digest('hex'));
      expect(received[0]!.body).not.toContain('PRIVATE');
      store.finish(run.id, 'waiting_input', null, null); // stale finish cannot emit again
      await store.notifications.idle();
      expect(received).toHaveLength(2);
      engine.resume(run.id, 'PRIVATE answer', false);
      agent.calls[1]!.reject(new Error('PRIVATE failure details'));
      await flush();
      await store.notifications.idle();
      expect(store.getRun(run.id).status).toBe('failed');
      expect(received).toHaveLength(4);
      expect(JSON.parse(received[2]!.body)).toMatchObject({ event: 'run.failed', status: 'failed' });
      expect(received[2]!.body).not.toContain('PRIVATE');
    } finally { receiver.stop(true); }
  });
  test('manual launch passes a persisted snapshot and records streamed progress and result', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    expect(run.status).toBe('running');
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.input).toEqual({ provider: 'codex', cwd: folder, instruction: task.instruction, instructions: [], sessionId: undefined, answer: undefined, mock: true, model: null, effort: 'default', communicationStyle: '' });
    agent.calls[0]!.callbacks.onSession('session-exact');
    agent.calls[0]!.callbacks.onComment('Reading files');
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', sessionId: 'session-exact', summary: 'Checked repository', error: null });
    expect(store.getRun(run.id).finishedAt).not.toBeNull();
    expect(store.detail(task.id).comments.map(c => c.kind)).toEqual(['system', 'agent', 'result']);
    expect(store.detail(task.id).comments[1]?.body).toBe('Reading files');
  });

  test.each(['completed', 'needs_input', 'blocked'] as const)('%s reuses a published answer while preserving distinct comments and questions', async status => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    const final = outcome(status);
    agent.calls[0]!.callbacks.onComment(`\n${final.envelope.summary}\n`);
    const published = store.detail(task.id).comments.at(-1)!;
    agent.calls[0]!.callbacks.onComment('A separate answer with additional details.');
    const separate = store.detail(task.id).comments.at(-1)!;
    const user = store.comment(task.id, run.id, 'user', final.envelope.summary);
    agent.calls[0]!.resolve(final);
    await flush();
    const comments = store.detail(task.id).comments.filter(comment => comment.kind !== 'system');
    expect(comments.map(comment => comment.id).slice(0, 3)).toEqual([published.id, separate.id, user.id]);
    expect(comments[0]).toEqual({ ...published, kind: status === 'completed' ? 'result' : 'agent' });
    expect(comments[1]?.body).toBe('A separate answer with additional details.');
    expect(comments.filter(comment => comment.kind !== 'user' && comment.body.trim() === final.envelope.summary)).toHaveLength(1);
    expect(comments.filter(comment => comment.kind === 'question').map(comment => comment.body)).toEqual(final.envelope.questions);
  });

  test('captures synchronously published comments before a factory returns', async () => {
    engine = new Engine(store, true, (input, callbacks) => {
      callbacks.onComment('Checked repository');
      return agent.factory(input, callbacks);
    });
    const task = store.createTask(input(folder));
    engine.start(task.id);
    const published = store.detail(task.id).comments.at(-1)!;
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.detail(task.id).comments.filter(comment => comment.kind !== 'system')).toEqual([{ ...published, kind: 'result' }]);
  });

  test('identical summaries from previous turns and runs remain separate', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    const waiting = outcome('needs_input');
    agent.calls[0]!.callbacks.onComment(waiting.envelope.summary);
    agent.calls[0]!.resolve(waiting);
    await flush();
    const prior = store.detail(task.id).comments.find(comment => comment.kind === 'agent')!;
    const sameResult: AgentOutcome = { sessionId: 'session-exact', envelope: { status: 'completed', summary: waiting.envelope.summary, questions: [] } };
    engine.resume(run.id, waiting.envelope.summary, false);
    agent.calls[1]!.resolve(sameResult);
    await flush();
    const due = Date.now();
    store.updateTask(task.id, { ...task, schedule: 'interval', intervalMinutes: 1, firstRunAt: due });
    engine.tick(due);
    const next = store.activeRun(task.id)!;
    agent.calls[2]!.resolve(sameResult);
    await flush();
    const identical = store.detail(task.id).comments.filter(comment => comment.body === waiting.envelope.summary);
    expect(identical.map(comment => comment.kind)).toEqual(['agent', 'user', 'result', 'result']);
    expect(identical[0]).toEqual(prior);
    expect(identical.map(comment => comment.runId)).toEqual([run.id, run.id, run.id, next.id]);
  });

  test('identical summaries from previous attempts and workflow steps remain separate', async () => {
    const worker = store.createWorker({ name: 'Reviewer', provider: 'codex', avatarUrl: null, effort: 'default', communicationStyle: '' });
    const task = store.createTask(input(folder, { steps: [
      { workerId: worker.id, title: 'First', instruction: 'Review first.' },
      { workerId: worker.id, title: 'Second', instruction: 'Review second.' },
    ] }));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onComment('Checked repository');
    const prior = store.detail(task.id).comments.at(-1)!;
    agent.calls[0]!.reject(new Error('Attempt failed after publishing'));
    await flush();
    engine.retry(run.id);
    agent.calls[1]!.resolve(outcome());
    await flush();
    agent.calls[2]!.resolve(outcome('completed', 'second-step-session'));
    await flush();
    const identical = store.detail(task.id).comments.filter(comment => comment.body === 'Checked repository');
    expect(identical[0]).toEqual(prior);
    expect(identical.map(comment => ({ kind: comment.kind, stepIndex: comment.stepIndex }))).toEqual([
      { kind: 'agent', stepIndex: 0 }, { kind: 'result', stepIndex: 0 }, { kind: 'result', stepIndex: 1 },
    ]);
  });

  test('each workflow stage reports its own progress status; a late report cannot cross the run fence', async () => {
    const worker = store.createWorker({ name: 'Reviewer', provider: 'codex', avatarUrl: null, effort: 'default', communicationStyle: '' });
    const task = store.createTask(input(folder, { steps: [
      { workerId: worker.id, title: 'First', instruction: 'Review first.' },
      { workerId: worker.id, title: 'Second', instruction: 'Review second.' },
    ] }));
    const run = engine.start(task.id);
    expect(store.getTask(task.id).latestRun!.progress).toBeNull();
    agent.calls[0]!.callbacks.onProgress!('Сбор информации о проекте');
    expect(store.getTask(task.id).latestRun!.progress).toMatchObject({ text: 'Сбор информации о проекте' });
    agent.calls[0]!.callbacks.onProgress!('Bad\u0000'.repeat(40));
    expect(store.getRun(run.id).progress!.text).toBe('Сбор информации о проекте');
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', currentStepIndex: 1, progress: null });
    agent.calls[0]!.callbacks.onProgress!('Поздний статус первого этапа');
    expect(store.getRun(run.id).progress).toBeNull();
    agent.calls[1]!.callbacks.onProgress!('Написание кода');
    expect(store.getRun(run.id).progress!.text).toBe('Написание кода');
    agent.calls[1]!.resolve(outcome('completed', 'second-step-session'));
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', progress: null });
    expect(store.detail(task.id).logs!.filter(log => log.kind === 'progress').map(log => ({ summary: log.summary, stepIndex: log.stepIndex }))).toEqual([
      { summary: 'Статус выполнения: Сбор информации о проекте', stepIndex: 0 },
      { summary: 'Статус выполнения: Написание кода', stepIndex: 1 },
    ]);
  });

  test('action logs persist separately from agent answers and late logs cannot cross a run fence', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    const first = agent.calls[0]!;
    first.callbacks.onLog?.({ kind: 'command', summary: 'Выполняет команду: bun test', details: ['Файл или папка: tests/engine.test.ts'] });
    first.resolve(outcome('needs_input'));
    await flush();
    expect(store.detail(task.id).logs?.[0]).toMatchObject({ taskId: task.id, runId: run.id, stepIndex: null, kind: 'command', details: ['Файл или папка: tests/engine.test.ts'] });
    expect(store.detail(task.id).comments.some(comment => comment.body.includes('bun test'))).toBe(false);
    engine.resume(run.id, 'Use server/engine.ts', false);
    const before = store.detail(task.id).logs;
    first.callbacks.onLog?.({ kind: 'command', summary: 'Stale action', details: [] });
    expect(store.detail(task.id).logs).toEqual(before);
    engine.cancel(run.id);
    agent.calls[1]!.callbacks.onLog?.({ kind: 'command', summary: 'Cancelled action', details: [] });
    expect(store.detail(task.id).logs).toEqual(before);
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

  test.each(['codex', 'claude'] as const)('%s launches and resumes frozen worker model/ultracode/effort/style after profile edits and archiving', async provider => {
    const worker = store.createWorker({ name: 'Reviewer', description: 'DISPLAY_ONLY_ROLE: database migrations.', avatarUrl: null, provider, model: 'original-model', ultracode: true, effort: 'high', communicationStyle: 'Be concise; "quotes" stay literal.' });
    const task = store.createTask(input(folder, { provider, workerId: worker.id }));
    const run = engine.start(task.id);
    expect(run.worker).toMatchObject({ id: worker.id, description: worker.description, provider, model: 'original-model', ultracode: true, effort: 'high', communicationStyle: worker.communicationStyle });
    expect(agent.calls[0]!.input).toEqual({ provider, cwd: folder, instruction: task.instruction, instructions: [], sessionId: undefined, answer: undefined, mock: true, model: 'original-model', ultracode: true, effort: 'high', communicationStyle: worker.communicationStyle });
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    const nextProvider = provider === 'codex' ? 'claude' : 'codex';
    store.updateWorker(worker.id, { name: 'Changed reviewer', description: 'DISPLAY_ONLY_UPDATED_ROLE: implementation.', avatarUrl: null, provider: nextProvider, model: 'updated-model', ultracode: false, effort: 'low', communicationStyle: 'A different style' });
    store.archiveWorker(worker.id);
    engine.resume(run.id, 'Continue with the original task.', false);
    expect(agent.calls[1]!.input).toEqual({ ...agent.calls[0]!.input, sessionId: 'session-exact', answer: 'Continue with the original task.' });
    expect(store.getRun(run.id).worker).toEqual(run.worker);
    agent.calls[1]!.resolve(outcome());
    await flush();
    const due = Date.now();
    store.updateTask(task.id, { ...store.getTask(task.id), schedule: 'interval', intervalMinutes: 1, firstRunAt: due });
    engine.tick(due);
    const next = store.activeRun(task.id)!;
    expect(next.worker?.description).toBe('DISPLAY_ONLY_UPDATED_ROLE: implementation.');
    expect(agent.calls[2]!.input).toMatchObject({ provider: nextProvider, model: 'updated-model', ultracode: false, effort: 'low', communicationStyle: 'A different style', sessionId: undefined });
    for (const call of agent.calls) {
      expect(call.input).not.toHaveProperty('description');
      const prompt = buildPrompt(call.input);
      expect(prompt).not.toContain('DISPLAY_ONLY_');
      expect(prompt).toContain(JSON.stringify(call.input.communicationStyle));
    }
  });

  test('scheduled launch uses the same persisted worker settings as manual launch', () => {
    const now = Date.now();
    const worker = store.createWorker({ name: 'Scheduled reviewer', avatarUrl: null, provider: 'claude', model: 'opus', ultracode: true, effort: 'max', communicationStyle: 'Use bullet points.' });
    const task = store.createTask(input(folder, { provider: 'claude', workerId: worker.id, schedule: 'interval', intervalMinutes: 5, firstRunAt: now }));
    engine.tick(now);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.input).toMatchObject({ provider: 'claude', model: 'opus', ultracode: true, effort: 'max', communicationStyle: worker.communicationStyle });
    expect(store.detail(task.id).runs[0]!.worker).toMatchObject({ id: worker.id, model: 'opus', ultracode: true, effort: 'max' });
  });

  test('a waiting worker session resumes frozen settings after closing and reopening the database', async () => {
    const worker = store.createWorker({ name: 'Persistent reviewer', avatarUrl: null, provider: 'codex', model: 'original-model', ultracode: true, effort: 'xhigh', communicationStyle: 'Report only verified facts.' });
    const task = store.createTask(input(folder, { workerId: worker.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    store.updateWorker(worker.id, { ...worker, provider: 'claude', model: 'changed-model', ultracode: false, effort: 'max', communicationStyle: 'Changed after restart.' });
    engine = new Engine(store, true, agent.factory);
    engine.startScheduler();
    expect(agent.calls).toHaveLength(1);
    engine.resume(run.id, 'Use src/main.ts.', false);
    expect(agent.calls[1]!.input).toMatchObject({ provider: 'codex', model: 'original-model', ultracode: true, effort: 'xhigh', communicationStyle: worker.communicationStyle, sessionId: 'session-exact', answer: 'Use src/main.ts.' });
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

  test('tick starts a due daily occurrence once and plans the next local time', () => {
    const now = Date.UTC(2026, 9, 26, 8, 5);
    // Every day at 11:00 in Moscow: the 08:00 UTC occurrence fell due five minutes ago.
    const task = store.createTask(input(folder, { schedule: 'daily', timeOfDay: '11:00', timeZone: 'Europe/Moscow' }), now - 10 * 60_000);
    expect(task.nextRunAt).toBe(Date.UTC(2026, 9, 26, 8));
    engine.tick(now);
    engine.tick(now + 60_000);
    expect(agent.calls).toHaveLength(1);
    expect(store.detail(task.id).runs.map(run => run.scheduledFor)).toEqual([Date.UTC(2026, 9, 26, 8)]);
    expect(store.getTask(task.id).nextRunAt).toBe(Date.UTC(2026, 9, 27, 8));
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

describe('autopilot', () => {
  test('mock dependency chain skips a waiting head and starts it only after prerequisite success', async () => {
    const a = store.createTask(input(folder, { title: 'A', schedule: 'auto' }));
    const b = store.createTask(input(folder, { title: 'B', schedule: 'auto', priority: 'critical', dependsOnTaskIds: [a.id] }));
    const otherFolder = join(folder, 'independent'); mkdirSync(otherFolder);
    const independent = store.createTask(input(otherFolder, { schedule: 'auto' }));
    engine.setAutopilot({ enabled: true, until: null });
    expect(store.detail(a.id).runs).toHaveLength(1);
    expect(store.detail(independent.id).runs).toHaveLength(1);
    expect(store.detail(b.id).runs).toEqual([]);
    expect(store.autopilotOverview().pool.find(task => task.id === b.id)?.dependencies[0]).toMatchObject({ title: 'A', satisfied: false });
    agent.calls.find(call => call.input.cwd === folder)!.resolve(outcome());
    await flush();
    engine.tick();
    await flush();
    expect(store.detail(b.id).runs[0]).toMatchObject({ trigger: 'autopilot', status: 'running' });
    expect(store.getTask(b.id).dependencies[0]!.satisfied).toBe(true);
  });

  test('mock failed prerequisite leaves a dependent in the queue without attempts or extra failures', async () => {
    const a = store.createTask(input(folder, { title: 'A', schedule: 'auto' }));
    const b = store.createTask(input(folder, { title: 'B', schedule: 'auto', dependsOnTaskIds: [a.id] }));
    engine.setAutopilot({ enabled: true, until: null });
    agent.calls[0]!.reject(new Error('Prerequisite failed'));
    await flush();
    engine.tick(); engine.tick();
    expect(store.detail(b.id).runs).toEqual([]);
    expect(store.getTask(b.id).status).toBe('ready');
    expect(store.autopilotOverview()).toMatchObject({ enabled: true, failures: 1, pool: [{ id: b.id, dependencies: [{ taskId: a.id, title: 'A', satisfied: false }] }] });
    store.archiveTask(a.id);
    expect(store.getTask(b.id).dependencies[0]).toMatchObject({ archived: true, satisfied: false });
  });

  test('webhook reports the settled empty queue and an automatic stop once each', async () => {
    const events: { event: string }[] = [];
    const receiver = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      events.push(await request.json() as { event: string });
      return new Response(null, { status: 204 });
    } });
    try {
      store.updateGeneralSettings({ webhookUrl: `http://127.0.0.1:${receiver.port}/events` });
      store.createTask(input(folder, { schedule: 'auto' }));
      engine.setAutopilot({ enabled: true, until: null });
      engine.tick();
      await store.notifications.idle();
      expect(events).toHaveLength(0);
      agent.calls[0]!.resolve(outcome());
      await flush();
      engine.tick();
      await store.notifications.idle();
      expect(events.map(event => event.event)).toEqual(['autopilot.empty']);
      engine.tick();
      await store.notifications.idle();
      expect(events).toHaveLength(1);
      store.stopAutopilot('until');
      await store.notifications.idle();
      expect(events.map(event => event.event)).toEqual(['autopilot.empty', 'autopilot.until']);
      store.stopAutopilot('until');
      await store.notifications.idle();
      expect(events).toHaveLength(2);
    } finally { receiver.stop(true); }
  });
  test('claims pool tasks oldest first and one per repository, keeps the rest editable, and continues as slots free up', async () => {
    const now = Date.now();
    const other = join(folder, 'other');
    const first = store.createTask(input(folder, { schedule: 'auto' }), now - 3);
    const second = store.createTask(input(folder, { schedule: 'auto' }), now - 2);
    const third = store.createTask(input(other, { schedule: 'auto' }), now - 1);
    engine.tick(now);
    expect(agent.calls).toHaveLength(0);
    const overview = engine.setAutopilot({ enabled: true, until: null }, now);
    await flush();
    expect(overview).toMatchObject({ enabled: true, startedAt: now, pool: [{ id: second.id }] });
    expect(overview.attempts.map(run => run.taskId)).toEqual([first.id, third.id]);
    expect(agent.calls.map(call => call.input.cwd)).toEqual([folder, other]);
    expect(store.detail(second.id).runs).toHaveLength(0);
    engine.tick(now + 1_000);
    expect(agent.calls).toHaveLength(2);
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.detail(first.id).runs[0]?.status).toBe('completed');
    engine.tick(now + 2_000);
    expect(agent.calls).toHaveLength(3);
    expect(store.detail(second.id).runs[0]).toMatchObject({ trigger: 'autopilot', status: 'running' });
    // One attempt per task and session: a failure waits for a person instead of being retried.
    agent.calls[2]!.reject(new Error('CLI crashed'));
    await flush();
    expect(store.detail(second.id).runs[0]?.status).toBe('failed');
    engine.tick(now + 3_000);
    expect(agent.calls).toHaveLength(3);
    expect(store.autopilotOverview()).toMatchObject({ enabled: true, failures: 1, pool: [] });
  });

  test('claims the repository\'s next task from the head of the queue as the person arranged it', async () => {
    const now = Date.now();
    const first = store.createTask(input(folder, { schedule: 'auto' }), now - 3);
    const second = store.createTask(input(folder, { schedule: 'auto' }), now - 2);
    const third = store.createTask(input(folder, { schedule: 'auto' }), now - 1);
    store.moveAutopilotTask(third.id, first.id);
    store.moveAutopilotTask(second.id, third.id);
    engine.setAutopilot({ enabled: true, until: null }, now);
    await flush();
    expect(store.autopilotOverview().attempts.map(run => run.taskId)).toEqual([second.id]);
    agent.calls[0]!.resolve(outcome());
    await flush();
    engine.tick(now + 1_000);
    await flush();
    expect(store.autopilotOverview().attempts.map(run => run.taskId)).toEqual([second.id, third.id]);
    expect(store.autopilotPool(now).map(task => task.id)).toEqual([first.id]);
  });

  test('claims a higher-priority task of the repository first, whatever its place in the queue', async () => {
    const now = Date.now();
    const low = store.createTask(input(folder, { schedule: 'auto', priority: 'low' }), now - 4);
    const normal = store.createTask(input(folder, { schedule: 'auto' }), now - 3);
    const critical = store.createTask(input(folder, { schedule: 'auto', priority: 'critical' }), now - 1);
    engine.setAutopilot({ enabled: true, until: null }, now);
    await flush();
    expect(store.autopilotOverview().attempts.map(run => run.taskId)).toEqual([critical.id]);
    agent.calls[0]!.resolve(outcome());
    await flush();
    engine.tick(now + 1_000);
    await flush();
    expect(store.autopilotOverview().attempts.map(run => run.taskId)).toEqual([critical.id, normal.id]);
    expect(store.autopilotPool(now).map(task => task.id)).toEqual([low.id]);
  });

  test('stops claiming at the stop time while started work finishes; a restart switches it off', async () => {
    const now = Date.now();
    const first = store.createTask(input(folder, { schedule: 'auto' }), now - 2);
    const second = store.createTask(input(folder, { schedule: 'auto' }), now - 1);
    engine.setAutopilot({ enabled: true, until: now + 60_000 }, now);
    await flush();
    expect(agent.calls).toHaveLength(1);
    engine.tick(now + 60_000);
    expect(store.getAutopilot()).toMatchObject({ enabled: false, stopReason: 'until', stoppedAt: now + 60_000 });
    expect(store.detail(first.id).runs[0]?.status).toBe('running');
    agent.calls[0]!.resolve(outcome());
    await flush();
    engine.tick(now + 61_000);
    expect(agent.calls).toHaveLength(1);
    expect(store.detail(second.id).runs).toHaveLength(0);
    expect(store.detail(first.id).runs[0]?.status).toBe('completed');
    engine.setAutopilot({ enabled: true, until: null }, now + 62_000);
    await flush();
    expect(agent.calls).toHaveLength(2);
    // The restart path interrupts running work and never resumes unattended claiming on its own.
    store.reconcile(now + 63_000);
    expect(store.getAutopilot()).toMatchObject({ enabled: false, stopReason: 'restart' });
    expect(store.detail(second.id).runs[0]?.status).toBe('interrupted');
  });
});

describe('replacement after exhausted usage limits', () => {
  const limit = (provider: 'codex' | 'claude' = 'codex') => new UsageLimitError(provider, provider === 'codex' ? "You've hit your usage limit. Try again at 6:00 PM." : 'Claude AI usage limit reached|1751212800');
  const profiles = () => {
    const claude = store.createWorker({ name: 'Opus', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', communicationStyle: 'Be brief.', avatarUrl: null });
    const codex = store.createWorker({ name: 'Sol', provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', communicationStyle: 'Verify twice.', avatarUrl: null, fallbackWorkerId: claude.id });
    return { claude, codex };
  };

  test('a fresh turn stopped by the limit continues with the profile replacement in a new session', async () => {
    const { claude, codex } = profiles();
    const task = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('codex-session');
    agent.calls[0]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]!.input).toEqual({ provider: 'claude', cwd: folder, instruction: task.instruction, instructions: [], sessionId: undefined, answer: undefined, mock: true, model: 'claude-opus-5-5', ultracode: false, effort: 'high', communicationStyle: 'Be brief.' });
    const replaced = store.getRun(run.id);
    expect(replaced).toMatchObject({ status: 'running', provider: 'claude', workerId: claude.id, sessionId: null, turn: 2, fallbackTurn: 2, error: null, summary: null });
    expect(replaced.worker).toMatchObject({ id: claude.id, name: 'Opus', provider: 'claude', model: 'claude-opus-5-5' });
    expect(store.getTask(task.id)).toMatchObject({ workerId: codex.id, provider: 'codex' });
    // The replaced process settled: its late callbacks cannot touch the new turn.
    agent.calls[0]!.callbacks.onComment('late codex comment');
    agent.calls[0]!.callbacks.onSession('codex-session-again');
    expect(store.getRun(run.id).sessionId).toBeNull();
    agent.calls[1]!.callbacks.onSession('claude-session');
    agent.calls[1]!.resolve(outcome('completed', 'claude-session'));
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', sessionId: 'claude-session', provider: 'claude', turn: 2, fallbackTurn: 2, summary: 'Checked repository' });
    const comments = store.detail(task.id).comments;
    const handover = comments.find(comment => comment.kind === 'system' && comment.body.includes('подхватывает'))!;
    expect(handover.body).toContain('Codex сообщил об исчерпании лимитов');
    expect(handover.body).toContain("You've hit your usage limit");
    expect(handover.body).toContain('Opus (Claude Code)');
    expect(comments.some(comment => comment.body === 'late codex comment')).toBe(false);
    expect(comments.filter(comment => comment.kind === 'result')).toHaveLength(1);
    const log = store.detail(task.id).logs!.find(entry => entry.summary.includes('подхватывает'))!;
    expect(log).toMatchObject({ runId: run.id, kind: 'lifecycle', error: "You've hit your usage limit. Try again at 6:00 PM." });
    expect(log.details.join('\n')).toContain('Opus (Claude Code, модель claude-opus-5-5)');
  });

  test('the general setting replaces a run without a worker, and the profile choice wins over it', async () => {
    const { claude, codex } = profiles();
    const sonnet = store.createWorker({ name: 'Sonnet', provider: 'claude', model: 'claude-sonnet-5-5', avatarUrl: null, effort: 'default', communicationStyle: '' });
    expect(store.setFallbackWorkers({ codex: sonnet.id })).toEqual({ codex: sonnet.id, claude: null });
    const plain = store.createTask(input(folder));
    const plainRun = engine.start(plain.id);
    agent.calls[0]!.reject(limit());
    await flush();
    expect(agent.calls[1]!.input).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', sessionId: undefined });
    expect(store.getRun(plainRun.id)).toMatchObject({ status: 'running', workerId: sonnet.id, provider: 'claude', fallbackTurn: 2 });
    agent.calls[1]!.resolve(outcome());
    await flush();
    expect(store.getRun(plainRun.id).status).toBe('completed');
    const assigned = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(assigned.id);
    agent.calls[2]!.reject(limit());
    await flush();
    expect(agent.calls[3]!.input).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    expect(store.getRun(run.id).workerId).toBe(claude.id);
  });

  test('without a configured replacement the run fails and explains where to configure one', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('codex-session');
    agent.calls[0]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(1);
    const failed = store.getRun(run.id);
    expect(failed).toMatchObject({ status: 'failed', sessionId: 'codex-session', turn: 1, fallbackTurn: null, provider: 'codex' });
    expect(failed.error).toContain("Codex сообщил об исчерпании лимитов: You've hit your usage limit");
    expect(failed.error).toContain('Настройки → Общие');
    expect(store.detail(task.id).comments.at(-1)).toMatchObject({ kind: 'system', body: failed.error });
    expect(store.activeRun(task.id)).toBeNull();
  });

  test('an archived replacement or one equal to the current worker is skipped with a reason', async () => {
    const { claude, codex } = profiles();
    store.archiveWorker(claude.id);
    const task = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(1);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', provider: 'codex', fallbackTurn: null });
    expect(store.getRun(run.id).error).toContain('Opus (в профиле работника) в архиве');
    const self = store.createWorker({ name: 'Sol again', provider: 'codex', avatarUrl: null, effort: 'default', communicationStyle: '' });
    store.setFallbackWorkers({ codex: self.id });
    const own = store.createTask(input(folder, { workerId: self.id }));
    const ownRun = engine.start(own.id);
    agent.calls[1]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(store.getRun(ownRun.id).error).toContain('совпадает с текущим работником');
  });

  test('a replacement that also runs out of limits fails without a third attempt', async () => {
    const { claude, codex } = profiles();
    store.updateWorker(claude.id, { ...claude, fallbackWorkerId: codex.id });
    const task = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.reject(limit());
    await flush();
    agent.calls[1]!.callbacks.onSession('claude-session');
    agent.calls[1]!.reject(limit('claude'));
    await flush();
    expect(agent.calls).toHaveLength(2);
    const failed = store.getRun(run.id);
    expect(failed).toMatchObject({ status: 'failed', provider: 'claude', workerId: claude.id, sessionId: 'claude-session', turn: 2, fallbackTurn: 2 });
    expect(failed.error).toContain('Claude Code сообщил об исчерпании лимитов: Claude AI usage limit reached|1751212800');
    expect(failed.error).toContain('Работник замены тоже исчерпал лимиты');
    expect(store.activeRun(task.id)).toBeNull();
  });

  test('a saved session is never handed over: answers and follow-ups fail with an explanation', async () => {
    const { codex } = profiles();
    const task = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome('needs_input'));
    await flush();
    engine.resume(run.id, 'Use main.', false);
    agent.calls[1]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(2);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', provider: 'codex', workerId: codex.id, turn: 2, fallbackTurn: null, sessionId: 'session-exact' });
    expect(store.getRun(run.id).error).toContain('сохранённой сессии');
    const done = store.createTask(input(folder, { workerId: codex.id }));
    const source = engine.start(done.id);
    agent.calls[2]!.resolve(outcome());
    await flush();
    const followup = engine.followup(done.id, { sourceRunId: source.id, sourceStepIndex: null, body: 'Explain more.', attachmentIds: [], requestId: 'limit-followup' });
    agent.calls[3]!.reject(limit());
    await flush();
    expect(agent.calls).toHaveLength(4);
    expect(store.getRun(followup.id)).toMatchObject({ status: 'failed', provider: 'codex', fallbackTurn: null });
    expect(store.getRun(followup.id).error).toContain('сохранённой сессии');
  });

  test('a workflow stage hands over to the replacement while later stages keep their own workers', async () => {
    const { claude, codex } = profiles();
    const task = store.createTask(input(folder, { steps: [
      { workerId: codex.id, title: 'First', instruction: 'Review first.' },
      { workerId: codex.id, title: 'Second', instruction: 'Review second.' },
    ] }));
    const run = engine.start(task.id);
    agent.calls[0]!.callbacks.onSession('codex-one');
    agent.calls[0]!.reject(limit());
    await flush();
    expect(agent.calls[1]!.input).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', sessionId: undefined, workflow: { stepIndex: 0, instruction: 'Review first.' } });
    let current = store.getRun(run.id);
    expect(current).toMatchObject({ status: 'running', currentStepIndex: 0, provider: 'claude', workerId: claude.id, sessionId: null, turn: 2, fallbackTurn: 2 });
    expect(current.steps[0]).toMatchObject({ workerId: claude.id, worker: { id: claude.id, provider: 'claude' }, status: 'running', sessionId: null });
    expect(current.steps[0]!.attempts.map(attempt => [attempt.status, attempt.turn, attempt.sessionId])).toEqual([['failed', 1, 'codex-one'], ['running', 2, null]]);
    expect(current.steps[0]!.attempts[0]!.error).toContain('Codex сообщил об исчерпании лимитов');
    expect(current.steps[1]).toMatchObject({ workerId: codex.id, worker: { id: codex.id }, status: 'pending' });
    agent.calls[1]!.callbacks.onSession('claude-one');
    agent.calls[1]!.resolve(outcome('completed', 'claude-one'));
    await flush();
    current = store.getRun(run.id);
    expect(current).toMatchObject({ status: 'running', currentStepIndex: 1, provider: 'codex', workerId: codex.id, turn: 3, fallbackTurn: 2 });
    expect(current.steps[0]).toMatchObject({ status: 'completed', sessionId: 'claude-one', workerId: claude.id });
    expect(agent.calls[2]!.input).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', workflow: { stepIndex: 1, predecessors: [{ summary: 'Checked repository' }] } });
    // The second stage is a different stage, so it is handed over again.
    agent.calls[2]!.reject(limit());
    await flush();
    current = store.getRun(run.id);
    expect(current).toMatchObject({ status: 'running', currentStepIndex: 1, provider: 'claude', workerId: claude.id, turn: 4, fallbackTurn: 4 });
    expect(agent.calls[3]!.input).toMatchObject({ provider: 'claude', workflow: { stepIndex: 1 } });
    agent.calls[3]!.resolve(outcome('completed', 'claude-two'));
    await flush();
    const finished = store.getRun(run.id);
    expect(finished).toMatchObject({ status: 'completed', turn: 4 });
    expect(finished.steps.map(step => [step.worker.id, step.status, step.sessionId])).toEqual([[claude.id, 'completed', 'claude-one'], [claude.id, 'completed', 'claude-two']]);
    expect(store.getTask(task.id).steps.map(step => step.workerId)).toEqual([codex.id, codex.id]);
    // A follow-up into the replaced stage continues the replacement's own session.
    const followup = engine.followup(task.id, { sourceRunId: run.id, sourceStepIndex: 0, body: 'Explain the first stage.', attachmentIds: [], requestId: 'replaced-stage' });
    expect(followup).toMatchObject({ provider: 'claude', workerId: claude.id, sessionId: 'claude-one' });
    expect(agent.calls[4]!.input).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', sessionId: 'claude-one' });
  });

  test('the handover survives a restart as an interrupted turn of the replacement', async () => {
    const { claude, codex } = profiles();
    const task = store.createTask(input(folder, { workerId: codex.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.reject(limit());
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ provider: 'claude', turn: 2 });
    // Simulate a process exit while the replacement runs: the new connection and engine reconstruct state solely from SQLite.
    const previous = { engine, store };
    store = new Store(join(folder, 'trackt.sqlite'));
    engine = new Engine(store, true, agent.factory);
    engine.startScheduler();
    const interrupted = store.getRun(run.id);
    expect(interrupted).toMatchObject({ status: 'interrupted', provider: 'claude', workerId: claude.id, turn: 2, fallbackTurn: 2 });
    expect(interrupted.worker).toMatchObject({ id: claude.id, provider: 'claude' });
    expect(agent.calls).toHaveLength(2);
    expectStatusError(() => engine.resume(run.id, 'Continue', false), 409);
    // The old process settles afterwards without touching the interrupted turn.
    await previous.engine.shutdown();
    previous.store.close();
    expect(store.getRun(run.id)).toMatchObject({ status: 'interrupted', provider: 'claude', turn: 2 });
  });

  test('an autopilot handover does not count toward the failure breaker', async () => {
    const { claude, codex } = profiles();
    const now = Date.now();
    const task = store.createTask(input(folder, { schedule: 'auto', workerId: codex.id }), now - 1);
    engine.setAutopilot({ enabled: true, until: null }, now);
    await flush();
    expect(agent.calls).toHaveLength(1);
    agent.calls[0]!.reject(limit());
    await flush();
    expect(store.getRun(store.detail(task.id).runs[0]!.id)).toMatchObject({ status: 'running', trigger: 'autopilot', workerId: claude.id });
    expect(store.autopilotOverview()).toMatchObject({ enabled: true, failures: 0 });
    agent.calls[1]!.resolve(outcome());
    await flush();
    expect(store.autopilotOverview()).toMatchObject({ enabled: true, failures: 0 });
    expect(store.detail(task.id).runs[0]?.status).toBe('completed');
  });
});

describe('timed turns', () => {
  test('a one-minute mock timeout releases the repository and lets the next autopilot task start', async () => {
    await engine.shutdown();
    engine = new Engine(store, true);
    store.updateGeneralSettings({ agentTimeLimitMinutes: 1 });
    const first = store.createTask(input(folder, { instruction: '[delay:61000]', schedule: 'auto' }));
    const second = store.createTask(input(folder, { instruction: '[delay:10]', schedule: 'auto' }));
    engine.startScheduler();
    engine.setAutopilot({ enabled: true, until: null });
    const running = store.getTask(first.id).latestRun!;
    expect(running).toMatchObject({ status: 'running', timeLimitMinutes: 1 });
    // Editing the defaults during the turn must not remove its saved deadline.
    store.updateGeneralSettings({ agentTimeLimitMinutes: null });
    expect(store.getRun(running.id).timeLimitMinutes).toBe(1);
    const deadline = performance.now() + 66_000;
    while (store.getTask(second.id).latestRun?.status !== 'completed') {
      if (performance.now() > deadline) throw new Error('Timed mock did not release its repository slot');
      await Bun.sleep(50);
    }
    const failed = store.getRun(running.id);
    expect(failed).toMatchObject({ status: 'failed', timeLimitMinutes: 1, timeLimitExceeded: true, error: 'Превышен лимит времени 1 мин; CLI остановлен' });
    expect(failed.sessionId).toStartWith('mock-codex-');
    expect(store.getTask(second.id).latestRun).toMatchObject({ status: 'completed', timeLimitMinutes: null });
    const detail = store.detail(first.id);
    expect(detail.comments.some(c => c.kind === 'system' && c.body === failed.error)).toBe(true);
    expect(detail.logs?.some(log => log.error === failed.error)).toBe(true);
    // Continue deliberately in the saved native session after a timeout.
    const continued = engine.followup(first.id, { sourceRunId: failed.id, sourceStepIndex: null, body: '[delay:10] Continue.', attachmentIds: [], requestId: 'timeout-followup' });
    expect(continued).toMatchObject({ sessionId: failed.sessionId, timeLimitMinutes: null });
    await Bun.sleep(50);
    expect(store.getRun(continued.id).status).toBe('completed');
  }, 70_000);

  test('three consecutive timeout failures trip the autopilot breaker', async () => {
    store.updateGeneralSettings({ agentTimeLimitMinutes: 1 });
    const tasks = [1, 2, 3, 4].map(() => store.createTask(input(folder, { schedule: 'auto' })));
    engine.setAutopilot({ enabled: true, until: null });
    for (let i = 0; i < 3; i++) {
      expect(agent.calls[i]!.input.timeLimitMinutes).toBe(1);
      agent.calls[i]!.reject(new AgentRunError('TIMEOUT', 'Превышен лимит времени 1 мин; CLI остановлен'));
      await flush();
      engine.tick();
    }
    expect(store.getAutopilot()).toMatchObject({ enabled: false, failures: 3, stopReason: 'failures' });
    expect(store.getTask(tasks[3]!.id).latestRun).toBeNull();
  });
});

describe('turn usage', () => {
  const usage = { inputTokens: 194_496, outputTokens: 5_321, cachedTokens: 184_220, costUsd: 0.4213 };

  test('a completed turn records the reported tokens and cost, the measured duration, provider, worker and trigger', async () => {
    const worker = store.createWorker({ name: 'Reviewer', provider: 'claude', avatarUrl: null, effort: 'default', communicationStyle: '' });
    const task = store.createTask(input(folder, { provider: 'claude', workerId: worker.id }));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve({ ...outcome(), usage });
    await flush();
    expect(store.getRun(run.id).status).toBe('completed');
    const [recorded] = store.turnUsage(run.id);
    expect(recorded).toMatchObject({ runId: run.id, turn: 1, stepIndex: null, attemptId: null, provider: 'claude', workerId: worker.id, trigger: 'manual', ...usage });
    expect(recorded!.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorded!.finishedAt).toBeGreaterThanOrEqual(recorded!.startedAt);
    expect(store.detail(task.id).runs[0]).toMatchObject({ usage: { turns: 1, pricedTurns: 1, ...usage }, turnUsage: [recorded] });
  });

  test('a turn without usage, as from an older CLI, still completes and records only its duration', async () => {
    const task = store.createTask(input(folder));
    const run = engine.start(task.id);
    agent.calls[0]!.resolve(outcome());
    await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', error: null });
    expect(store.turnUsage(run.id)).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null })]);
  });

  test('failed and cancelled turns keep the usage they reported before ending', async () => {
    const failing = store.createTask(input(folder, { title: 'Failing' }));
    const failed = engine.start(failing.id);
    agent.calls[0]!.callbacks.onUsage!({ ...usage, costUsd: null });
    agent.calls[0]!.reject(new ProtocolError('The CLI reported a failed turn. No successful result was accepted.'));
    await flush();
    expect(store.getRun(failed.id).status).toBe('failed');
    expect(store.turnUsage(failed.id)).toEqual([expect.objectContaining({ inputTokens: usage.inputTokens, costUsd: null })]);

    const cancelling = store.createTask(input(folder, { title: 'Cancelled' }));
    const cancelled = engine.start(cancelling.id);
    agent.calls[1]!.callbacks.onUsage!(usage);
    engine.cancel(cancelled.id);
    await flush();
    expect(store.getRun(cancelled.id).status).toBe('cancelled');
    expect(store.turnUsage(cancelled.id)).toEqual([expect.objectContaining(usage)]);
  });

  test('the final outcome wins over an earlier report, once per turn, across workflow steps and their attempts', async () => {
    const worker = store.createWorker({ name: 'Reviewer', provider: 'codex', avatarUrl: null, effort: 'default', communicationStyle: '' });
    const task = store.createTask(input(folder, { steps: [
      { workerId: worker.id, title: 'First', instruction: 'Review first.' },
      { workerId: worker.id, title: 'Second', instruction: 'Review second.' },
    ] }));
    const run = engine.start(task.id);
    agent.calls[0]!.reject(new Error('Attempt failed'));
    await flush();
    engine.retry(run.id);
    agent.calls[1]!.callbacks.onUsage!({ inputTokens: 1, outputTokens: 1, cachedTokens: null, costUsd: null });
    agent.calls[1]!.resolve({ ...outcome(), usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 40, costUsd: null } });
    await flush();
    agent.calls[2]!.resolve({ ...outcome('completed', 'second-step-session'), usage: { inputTokens: 200, outputTokens: 20, cachedTokens: 0, costUsd: null } });
    await flush();
    const steps = store.getRun(run.id).steps;
    expect(store.turnUsage(run.id).map(entry => [entry.turn, entry.stepIndex, entry.attemptId, entry.inputTokens])).toEqual([
      [1, 0, steps[0]!.attempts[0]!.id, null], [2, 0, steps[0]!.attempts[1]!.id, 100], [3, 1, steps[1]!.attempts[0]!.id, 200],
    ]);
    expect(store.getRun(run.id).usage).toMatchObject({ turns: 3, inputTokens: 300, outputTokens: 30, costUsd: null });
  });

  test('demo mode records plausible usage for the interface', async () => {
    await engine.shutdown();
    engine = new Engine(store, true);
    const task = store.createTask(input(folder, { provider: 'claude', instruction: 'Demo usage [delay:1]' }));
    const run = engine.start(task.id);
    const deadline = performance.now() + 5_000;
    while (store.getRun(run.id).status !== 'completed' && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.getRun(run.id).usage).toMatchObject({ turns: 1, pricedTurns: 1 });
    expect(store.getRun(run.id).usage!.inputTokens).toBeGreaterThan(0);
    expect(store.getRun(run.id).usage!.costUsd).toBeGreaterThan(0);
  });
});
