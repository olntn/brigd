import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgv, buildPrompt, MAX_PROMPT_BYTES, type AgentCallbacks, type AgentInput, type AgentOutcome } from '../server/adapter';
import { prepareAttachment } from '../server/attachments';
import { Engine, type AgentFactory, type TaskBridgeFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store, runFence } from '../server/store';
import { createTaskBroker, type TaskBroker } from '../server/task-mcp';
import type { Envelope, FollowupInput, Run, RunStatus, Task, TaskInput, Worker } from '../src/lib/types';

const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = 1_700_000_000_000;
interface Invocation {
  input: AgentInput;
  callbacks: AgentCallbacks;
  resolve: (value: AgentOutcome) => void;
  reject: (error: Error) => void;
  cancelled: number;
  ignoreCancel: boolean;
}
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
let calls: Invocation[];
let brokers: TaskBroker[];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const factory: AgentFactory = (input, callbacks) => {
  let resolve!: Invocation['resolve'];
  let reject!: Invocation['reject'];
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  const call: Invocation = { input, callbacks, resolve, reject, cancelled: 0, ignoreCancel: false };
  calls.push(call);
  return { result, cancel: () => { call.cancelled++; if (!call.ignoreCancel) reject(new Error('Synthetic cancellation')); } };
};
const bridgeFactory: TaskBridgeFactory = (db, run, fence) => {
  const broker = createTaskBroker(db, run, fence);
  broker.agentConfig.env.BRIGD_TASK_SOCKET = '/tmp/brigd-followup-test.sock';
  brokers.push(broker);
  return broker;
};
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Review the completed work', instruction: 'Implement the original requested change.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const input = (source: Run, patch: Partial<FollowupInput> = {}): FollowupInput => ({
  sourceRunId: source.id, sourceStepIndex: null, body: 'Explain the tradeoff in your completed change.', attachmentIds: [], requestId: crypto.randomUUID(), ...patch,
});
const outcome = (sessionId: string, status: Envelope['status'] = 'completed', summary = 'Follow-up answered.'): AgentOutcome => ({
  sessionId, envelope: { status, summary, questions: status === 'needs_input' ? ['Which part should I inspect?'] : [] },
});
const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
  body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
}));
function expectError(action: () => unknown, status = 409) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
function completed(task: Task, mock = true): Run {
  let run = store.startManual(task.id, mock);
  for (let index = 0; index < Math.max(1, run.steps.length); index++) {
    store.setSession(run.id, `source-session-${index}`);
    run = store.finish(run.id, 'completed', `Original stage ${index + 1} result.`, null);
  }
  return run;
}
function crew(): Worker[] {
  return [
    store.createWorker({ name: 'Planner', provider: 'codex', model: 'custom-codex', effort: 'xhigh', communicationStyle: 'Precise evidence.', avatarUrl: null }),
    store.createWorker({ name: 'Builder', provider: 'claude', model: 'custom-claude', effort: 'max', communicationStyle: 'Short summaries.', avatarUrl: null }),
    store.createWorker({ name: 'Reviewer', provider: 'codex', model: null, effort: 'high', communicationStyle: 'List checks.', avatarUrl: null }),
  ];
}
function workflow(workers = crew(), patch: Partial<TaskInput> = {}): Task {
  return store.createTask(taskInput({ steps: workers.map((worker, index) => ({ workerId: worker.id, title: `Stage ${index + 1}`, instruction: `Only do original stage ${index + 1}.` })), ...patch }));
}
async function settle(index: number, sessionId = calls[index]!.input.sessionId!, status: Envelope['status'] = 'completed') {
  calls[index]!.resolve(outcome(sessionId, status));
  await flush();
}
const staged = async (name: string) => store.stageAttachment(await prepareAttachment(Buffer.from(`Contents of ${name}`), 'text/plain', name));
const ids = (files: Run['inputAttachments']) => (files ?? []).map(file => file.id).sort();
const invoke = (broker: TaskBroker, tool: string, args: Record<string, unknown> = {}) => broker.dispatch({
  capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool, arguments: args,
});
function resultText(value: Awaited<ReturnType<typeof invoke>>): Record<string, any> {
  expect(value.isError).not.toBe(true);
  const block = value.content.find(item => item.type === 'text');
  if (block?.type !== 'text') throw new Error('Expected tool text');
  return JSON.parse(block.text);
}
async function reopen(mock = true) {
  await engine.shutdown();
  await flush();
  store.close();
  store = new Store(join(folder, 'followups.sqlite'));
  engine = new Engine(store, mock, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-followups-'));
  store = new Store(join(folder, 'followups.sqlite'));
  calls = []; brokers = [];
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder });
});
afterEach(async () => {
  for (const call of calls) { call.ignoreCancel = false; call.reject(new Error('Test cleanup')); }
  await flush();
  await engine.shutdown();
  for (const broker of brokers) broker.close();
  await flush();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('explicit follow-up HTTP contract', () => {
  test('ordinary comments remain inert; an explicit follow-up creates a separate scalar run and one user request', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const beforeSource = store.getRun(source.id);
    const note = await request(`/api/tasks/${task.id}/comments`, 'POST', { body: 'An ordinary note, even if it sounds like a request.' });
    expect(note.status).toBe(201);
    expect(calls).toHaveLength(0);
    expect(store.detail(task.id).runs).toHaveLength(1);
    const payload = input(source);
    const response = await request(`/api/tasks/${task.id}/followups`, 'POST', payload);
    expect(response.status).toBe(201);
    const run: Run = await response.json();
    expect(run.id).not.toBe(source.id);
    expect(run).toMatchObject({ trigger: 'followup', status: 'running', sessionId: source.sessionId, steps: [], currentStepIndex: null,
      followup: { sourceRunId: source.id, sourceStepIndex: null, request: payload.body, workflow: null } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.followup).toEqual({ sourceRunId: source.id, sourceStepIndex: null, request: payload.body });
    expect(calls[0]!.input.sessionId).toBe(source.sessionId!);
    expect(calls[0]!.input.workflow).toBeUndefined();
    expect(store.detail(task.id).comments.filter(comment => comment.kind === 'user' && comment.runId === run.id)).toMatchObject([
      { body: payload.body, stepIndex: null },
    ]);
    await settle(0);
    expect(store.getRun(source.id)).toEqual(beforeSource);
    expect(store.getRun(run.id).status).toBe('completed');
    expect(calls).toHaveLength(1);
  });

  test('strict exact request shape rejects invalid fields without comments, runs, or launches', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const good = input(source);
    const missing = Object.keys(good).map(key => Object.fromEntries(Object.entries(good).filter(([field]) => field !== key)));
    const invalid: unknown[] = [null, [], 'request', ...missing,
      { ...good, extra: true }, { ...good, sourceRunId: 5 }, { ...good, sourceRunId: '' }, { ...good, sourceRunId: '../run' },
      { ...good, sourceStepIndex: '0' }, { ...good, sourceStepIndex: 1.2 }, { ...good, sourceStepIndex: -1 },
      { ...good, body: '' }, { ...good, body: ' \n ' }, { ...good, body: 5 }, { ...good, body: 'null\0byte' },
      { ...good, attachmentIds: null }, { ...good, attachmentIds: 'file' }, { ...good, attachmentIds: [1] },
      { ...good, requestId: '' }, { ...good, requestId: null }, { ...good, requestId: '../unsafe' },
    ];
    const before = store.detail(task.id);
    for (const payload of invalid) {
      expect((await request(`/api/tasks/${task.id}/followups`, 'POST', payload)).status).toBe(400);
      expect(store.detail(task.id)).toEqual(before);
    }
    expect(calls).toHaveLength(0);
  });

  test('follow-up POST retains origin, media-type, method, and JSON size guards', async () => {
    const task = store.createTask(taskInput());
    const payload = input(completed(task));
    const path = `/api/tasks/${task.id}/followups`;
    expect((await request(path, 'POST', payload, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await request(path, 'POST', payload, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await request(path, 'POST', { ...payload, body: 'x'.repeat(200_000) })).status).toBe(413);
    expect((await request(path, 'GET')).status).toBeGreaterThanOrEqual(400);
    expect(calls).toHaveLength(0);
    expect(store.detail(task.id).runs).toHaveLength(1);
  });

  test.each(['running', 'waiting_input', 'failed', 'blocked', 'interrupted', 'cancelled'] as RunStatus[])('a %s source cannot be followed up', async status => {
    const task = store.createTask(taskInput());
    let source = store.startManual(task.id, true);
    store.setSession(source.id, 'noncompleted-session');
    if (status !== 'running') source = store.finish(source.id, status as Exclude<RunStatus, 'running'>, 'Not completed.', null);
    const before = store.detail(task.id);
    expect((await request(`/api/tasks/${task.id}/followups`, 'POST', input(source))).status).toBe(409);
    expect(store.detail(task.id)).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  test('a scalar source requires null step, an owned completed source, and an exact saved session even in mock mode', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const other = store.createTask(taskInput({ title: 'Another task' }));
    expect((await request(`/api/tasks/${task.id}/followups`, 'POST', input(source, { sourceStepIndex: 0 }))).status).toBe(409);
    expect((await request(`/api/tasks/${other.id}/followups`, 'POST', input(source))).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}/followups`, 'POST', input(source, { sourceRunId: 'missing-source' }))).status).toBe(404);
    store.db.query('UPDATE runs SET session_id=NULL WHERE id=?').run(source.id);
    expect((await request(`/api/tasks/${task.id}/followups`, 'POST', input(source))).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(store.detail(task.id).runs).toHaveLength(1);
  });

  test('workflow follow-ups require an explicit valid completed stage and the entire source run to be completed', async () => {
    const task = workflow();
    let source = store.startManual(task.id, true);
    store.setSession(source.id, 'first-stage-session');
    source = store.finish(source.id, 'completed', 'First completed.', null);
    expect(source.status).toBe('running');
    expectError(() => engine.followup(task.id, input(source, { sourceStepIndex: 0 })));
    store.setSession(source.id, 'second-stage-session');
    store.finish(source.id, 'completed', 'Second completed.', null);
    store.setSession(source.id, 'third-stage-session');
    source = store.finish(source.id, 'completed', 'All completed.', null);
    for (const index of [null, 3, 999]) expectError(() => engine.followup(task.id, input(source, { sourceStepIndex: index })));
    expect(calls).toHaveLength(0);
    expect(store.detail(task.id).runs).toHaveLength(1);
  });
});

describe('immutable follow-up source selection', () => {
  test.each([0, 1, 2])('stage %s keeps its original worker, settings, session and historical context without replaying the chain', async index => {
    const workers = crew();
    const guidance = store.createInstruction({ title: 'Original guidance', body: 'Keep the original frozen rule.', enabled: true });
    const task = workflow(workers);
    const source = completed(task);
    const snapshot = source.steps[index]!;
    for (const worker of workers) {
      store.updateWorker(worker.id, { ...worker, name: 'Changed profile', model: 'changed-model', effort: 'low', communicationStyle: 'Changed style.' });
      store.archiveWorker(worker.id);
    }
    store.updateInstruction(guidance.id, { body: 'New guidance.', enabled: false });
    store.deleteInstruction(guidance.id);
    store.updateTask(task.id, taskInput({ instruction: 'A completely new original task.', cwd: '/tmp', steps: [] }));
    const run = engine.followup(task.id, input(source, { sourceStepIndex: index }));
    expect(run).toMatchObject({ instruction: source.instruction, cwd: source.cwd, mock: source.mock, instructions: source.instructions,
      workerId: snapshot.workerId, worker: snapshot.worker, provider: snapshot.worker.provider, sessionId: snapshot.sessionId,
      steps: [], currentStepIndex: null, followup: { sourceRunId: source.id, sourceStepIndex: index,
        workflow: { steps: source.steps, currentStepIndex: index } } });
    expect(calls[0]!.input).toMatchObject({ instruction: source.instruction, cwd: source.cwd, instructions: source.instructions,
      model: snapshot.worker.model, effort: snapshot.worker.effort, communicationStyle: snapshot.worker.communicationStyle,
      provider: snapshot.worker.provider, sessionId: snapshot.sessionId, workflow: { stepIndex: index, title: snapshot.title, instruction: snapshot.instruction } });
    await settle(0);
    expect(calls).toHaveLength(1);
    expect(store.getRun(source.id)).toEqual(source);
    expect(store.getRun(run.id).status).toBe('completed');
    expect(store.getRun(run.id).steps).toEqual([]);
  });

  test('a completed chain with failed and interrupted historical attempts can be followed up without reviving those attempts', async () => {
    const task = workflow();
    let source = store.startManual(task.id, true);
    store.setSession(source.id, 'abandoned-first-session');
    store.finish(source.id, 'failed', null, 'First attempt failed.');
    source = store.retry(source.id);
    store.setSession(source.id, 'recovered-first-session');
    source = store.finish(source.id, 'completed', 'Recovered first stage.', null);
    store.reconcile();
    source = store.retry(source.id, true);
    store.setSession(source.id, 'recovered-second-session');
    source = store.finish(source.id, 'completed', 'Recovered second stage.', null);
    store.setSession(source.id, 'final-stage-session');
    source = store.finish(source.id, 'completed', 'All stages complete.', null);
    expect(source.steps[0]!.attempts.map(attempt => attempt.status)).toEqual(['failed', 'completed']);
    expect(source.steps[1]!.attempts.map(attempt => attempt.status)).toEqual(['interrupted', 'completed']);
    for (const index of [0, 1]) {
      const run = engine.followup(task.id, input(source, { sourceStepIndex: index }));
      expect(run.sessionId).toBe(source.steps[index]!.sessionId);
      expect(run.followup!.workflow!.steps).toEqual(source.steps);
      await settle(index);
    }
    expect(calls).toHaveLength(2);
    expect(store.getRun(source.id)).toEqual(source);
  });

  test('a scalar source freezes worker and reusable instructions and preserves mock rather than current engine mode', async () => {
    const worker = crew()[0]!;
    const guidance = store.createInstruction({ title: 'Frozen', body: 'Original rule.', enabled: true });
    const task = store.createTask(taskInput({ workerId: worker.id }));
    const source = completed(task, false);
    store.updateWorker(worker.id, { ...worker, provider: 'claude', model: 'changed', effort: 'low' });
    store.updateInstruction(guidance.id, { body: 'Changed rule.' });
    store.updateTask(task.id, taskInput({ workerId: null, cwd: '/tmp', instruction: 'Changed task.' }));
    const run = engine.followup(task.id, input(source));
    expect(run).toMatchObject({ mock: false, provider: 'codex', worker: source.worker, instruction: source.instruction, cwd: source.cwd, instructions: source.instructions });
    expect(calls[0]!.input).toMatchObject({ mock: false, sessionId: source.sessionId, model: worker.model, effort: worker.effort });
    await settle(0);
  });

  test('a follow-up of a follow-up uses the immediate source session and inherits frozen historical workflow context', async () => {
    const task = workflow();
    const source = completed(task);
    const first = engine.followup(task.id, input(source, { sourceStepIndex: 1, body: 'Explain the builder result.' }));
    await settle(0);
    const finished = store.getRun(first.id);
    expectError(() => engine.followup(task.id, input(finished, { sourceStepIndex: 1 })));
    const second = engine.followup(task.id, input(finished, { body: 'Add the missing caveat.' }));
    expect(second.followup).toEqual({ sourceRunId: first.id, sourceStepIndex: null, request: 'Add the missing caveat.', workflow: first.followup!.workflow });
    expect(second).toMatchObject({ worker: first.worker, sessionId: first.sessionId, steps: [], currentStepIndex: null });
    expect(calls[1]!.input.followup).toEqual({ sourceRunId: first.id, sourceStepIndex: null, request: 'Add the missing caveat.' });
    expect(calls[1]!.input.workflow).toEqual(calls[0]!.input.workflow);
    await settle(1);
    expect(calls).toHaveLength(2);
    expect(store.getRun(source.id)).toEqual(source);
  });
});

describe('durable exactly-once creation and atomic attachment binding', () => {
  test('same request returns the persisted run before and after completion/restart, and mismatched payload is rejected', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const payload = input(source);
    const first = engine.followup(task.id, payload);
    for (let repeat = 0; repeat < 4; repeat++) expect(engine.followup(task.id, payload).id).toBe(first.id);
    expect(calls).toHaveLength(1);
    const before = store.detail(task.id);
    for (const patch of [{ body: 'Different request.' }, { body: ` ${payload.body} ` }, { attachmentIds: ['different-upload'] }, { sourceRunId: 'another-run' }]) {
      expectError(() => engine.followup(task.id, { ...payload, ...patch }));
      expect(store.detail(task.id)).toEqual(before);
    }
    await settle(0);
    expect(engine.followup(task.id, payload).id).toBe(first.id);
    expect(calls).toHaveLength(1);
    await reopen();
    const replay = store.startFollowup(task.id, payload);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.id);
    expect(engine.followup(task.id, payload).id).toBe(first.id);
    expect(calls).toHaveLength(1);
    expect(store.detail(task.id).comments.filter(comment => comment.runId === first.id && comment.kind === 'user')).toHaveLength(1);
  });

  test('concurrent HTTP repeats share one run and one CLI invocation', async () => {
    const task = store.createTask(taskInput());
    const payload = input(completed(task));
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(`/api/tasks/${task.id}/followups`, 'POST', payload)));
    expect(responses.every(response => response.status === 201)).toBe(true);
    const runs: Run[] = await Promise.all(responses.map(response => response.json()));
    expect(new Set(runs.map(run => run.id)).size).toBe(1);
    expect(calls).toHaveLength(1);
    expect(store.detail(task.id).runs).toHaveLength(2);
    expect(store.detail(task.id).comments.filter(comment => comment.kind === 'user')).toHaveLength(1);
  });

  test('an interrupted persisted request never automatically relaunches after restart', async () => {
    const task = store.createTask(taskInput());
    const payload = input(completed(task));
    const first = engine.followup(task.id, payload);
    await reopen();
    engine.startScheduler();
    const restored = engine.followup(task.id, payload);
    expect(restored).toMatchObject({ id: first.id, status: 'interrupted', sessionId: first.sessionId });
    expect(calls).toHaveLength(1);
    expectError(() => engine.resume(first.id, 'Continue.', false));
    engine.resume(first.id, 'The old process has stopped. Continue.', true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input.sessionId).toBe(first.sessionId!);
    await settle(1);
    expect(calls).toHaveLength(2);
  });

  test('frozen source inputs and published outputs plus submitted files exclude unrelated later task comments and uploads', async () => {
    const original = await staged('source-input.txt');
    const task = store.createTask(taskInput({ attachmentIds: [original.id] }));
    let source = store.startManual(task.id, true);
    const output = store.publishAgentAttachment(source.id, runFence(source), 'source-output', await prepareAttachment(Buffer.from('Verified output.'), 'text/plain', 'source-output.txt'), 'Original output.');
    store.setSession(source.id, 'attachment-source-session');
    source = store.finish(source.id, 'completed', 'Ready.', null);
    const later = await staged('later-task-file.txt');
    store.updateTask(task.id, { ...task, attachmentIds: [original.id, later.id] });
    const laterComment = await staged('later-comment-file.txt');
    store.comment(task.id, null, 'user', 'Unrelated later note.', Date.now(), null, [laterComment.id]);
    const uploaded = await staged('followup-file.txt');
    const payload = input(source, { attachmentIds: [uploaded.id] });
    const first = engine.followup(task.id, payload);
    expect(ids(first.inputAttachments)).toEqual([original.id, output.id, uploaded.id].sort());
    expect(ids(calls[0]!.input.attachments)).toEqual(ids(first.inputAttachments));
    const comment = store.detail(task.id).comments.find(item => item.runId === first.id && item.kind === 'user')!;
    expect(comment.attachments?.map(file => file.id)).toEqual([uploaded.id]);
    expect(store.getAttachment(task.id, uploaded.id)).toMatchObject({ runId: first.id, commentId: comment.id, stepIndex: null, source: 'user' });
    expect(engine.followup(task.id, payload).id).toBe(first.id);
    expect(store.detail(task.id).comments.filter(item => item.runId === first.id && item.kind === 'user')).toHaveLength(1);
    await settle(0);
    await reopen();
    expect(ids(engine.followup(task.id, payload).inputAttachments)).toEqual([original.id, output.id, uploaded.id].sort());
    expect(calls).toHaveLength(1);
  });

  test.each(['missing', 'expired', 'bound'] as const)('%s attachment rolls back the run, request, comment and all staged bindings', async variant => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const valid = await staged('still-staged.txt');
    let badId = 'missing-upload';
    if (variant === 'expired') badId = store.stageAttachment(await prepareAttachment(Buffer.from('expired'), 'text/plain', 'expired.txt'), BASE).id;
    if (variant === 'bound') {
      const foreign = await staged('other-task.txt');
      store.createTask(taskInput({ title: 'Other owner', attachmentIds: [foreign.id] }));
      badId = foreign.id;
    }
    const payload = input(source, { attachmentIds: [valid.id, badId] });
    const before = store.detail(task.id);
    expectError(() => store.startFollowup(task.id, payload), variant === 'bound' ? 409 : 404);
    expect(store.detail(task.id)).toEqual(before);
    expect(store.db.query('SELECT task_id,run_id,comment_id FROM attachments WHERE id=?').get(valid.id)).toEqual({ task_id: null, run_id: null, comment_id: null });
    expect(store.db.query('SELECT * FROM followup_requests WHERE task_id=? AND request_id=?').get(task.id, payload.requestId)).toBeNull();
    const retried = store.startFollowup(task.id, { ...payload, attachmentIds: [valid.id] });
    expect(retried.created).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('attachment-only requests create one durable user request and retry safely with the original empty body', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const upload = await staged('request.txt');
    const payload = input(source, { body: '', attachmentIds: [upload.id] });
    const response = await request(`/api/tasks/${task.id}/followups`, 'POST', payload);
    expect(response.status).toBe(201);
    const run: Run = await response.json();
    expect(run.followup!.request.trim()).not.toBe('');
    expect(ids(run.inputAttachments)).toEqual([upload.id]);
    expect(store.detail(task.id).comments.find(comment => comment.runId === run.id && comment.kind === 'user')?.body).toBe(run.followup!.request);
    expect(engine.followup(task.id, payload).id).toBe(run.id);
    expectError(() => engine.followup(task.id, { ...payload, body: run.followup!.request }));
    expectError(() => engine.followup(task.id, { ...payload, body: ' ' }));
    expect(calls).toHaveLength(1);
  });

  test('selected workflow stage inputs exclude outputs from later stages even after the chain completes', async () => {
    const original = await staged('original-stage-input.txt');
    const task = workflow(undefined, { attachmentIds: [original.id] });
    let source = store.startManual(task.id, true);
    const outputs: string[] = [];
    for (let index = 0; index < 3; index++) {
      outputs.push(store.publishAgentAttachment(source.id, runFence(source), `output-${index}`,
        await prepareAttachment(Buffer.from(`Stage ${index} output`), 'text/plain', `stage-${index}.txt`), `Stage ${index} evidence.`).id);
      store.setSession(source.id, `scoped-stage-${index}`);
      source = store.finish(source.id, 'completed', `Stage ${index} completed.`, null);
    }
    const later = await staged('unrelated-after-chain.txt');
    store.comment(task.id, null, 'user', 'A later unrelated comment.', Date.now(), null, [later.id]);
    for (let index = 0; index < 3; index++) {
      const run = engine.followup(task.id, input(source, { sourceStepIndex: index }));
      expect(ids(run.inputAttachments)).toEqual([original.id, ...outputs.slice(0, index + 1)].sort());
      expect(ids(calls[index]!.input.attachments)).toEqual(ids(run.inputAttachments));
      await settle(index);
    }
    expect(calls).toHaveLength(3);
  });

  test('a failure after run and comment creation rolls back attachment binding and idempotency reservation together', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const upload = await staged('atomic.txt');
    const payload = input(source, { attachmentIds: [upload.id] });
    const before = store.detail(task.id);
    store.db.exec(`CREATE TRIGGER fail_followup_inputs BEFORE INSERT ON run_attachment_inputs BEGIN SELECT RAISE(ABORT, 'Injected input failure'); END;`);
    expect(() => store.startFollowup(task.id, payload)).toThrow();
    expect(store.detail(task.id)).toEqual(before);
    expect(store.db.query('SELECT task_id,run_id,comment_id FROM attachments WHERE id=?').get(upload.id)).toEqual({ task_id: null, run_id: null, comment_id: null });
    store.db.exec('DROP TRIGGER fail_followup_inputs');
    const committed = store.startFollowup(task.id, payload);
    expect(committed.created).toBe(true);
    expect(store.detail(task.id).comments.filter(comment => comment.runId === committed.run.id && comment.kind === 'user')).toHaveLength(1);
    expect(store.startFollowup(task.id, payload).created).toBe(false);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('single-session lifecycle, occupancy and stale launch fences', () => {
  test.each(['failed', 'blocked'] as const)('%s follow-ups are terminal, release occupancy, and cannot retry or resume', async terminal => {
    const task = workflow();
    const source = completed(task);
    const payload = input(source, { sourceStepIndex: 1 });
    const run = engine.followup(task.id, payload);
    if (terminal === 'failed') { calls[0]!.reject(new Error('Synthetic follow-up failure')); await flush(); }
    else await settle(0, run.sessionId!, 'blocked');
    expect(store.getRun(run.id).status).toBe(terminal);
    expect(store.activeRun(task.id)).toBeNull();
    expectError(() => engine.retry(run.id, true));
    expectError(() => engine.resume(run.id, 'Retry.', true));
    expect(engine.followup(task.id, payload).id).toBe(run.id);
    expect(calls).toHaveLength(1);
    expectError(() => engine.start(task.id));
    expect(engine.followup(task.id, input(source, { sourceStepIndex: 1 })).id).not.toBe(run.id);
    expect(calls).toHaveLength(2);
  });

  test('waiting follow-up resumes the same saved session with a fresh bridge and no chain handoff', async () => {
    engine = new Engine(store, false, factory, bridgeFactory);
    const task = workflow();
    const source = completed(task, false);
    const run = engine.followup(task.id, input(source, { sourceStepIndex: 1 }));
    const initial = brokers[0]!;
    await settle(0, run.sessionId!, 'needs_input');
    expect(store.getRun(run.id).status).toBe('waiting_input');
    expectError(() => engine.start(task.id));
    expectError(() => engine.followup(task.id, input(source, { sourceStepIndex: 0 })));
    const upload = await staged('clarification.txt');
    const resumed = engine.resume(run.id, 'Inspect this attached example.', false, [upload.id]);
    expect(resumed.followup).toEqual(run.followup);
    expect(calls[1]!.input).toMatchObject({ sessionId: run.sessionId, answer: 'Inspect this attached example.', followup: calls[0]!.input.followup, workflow: calls[0]!.input.workflow });
    expect(brokers).toHaveLength(2);
    expect(brokers[1]!.agentConfig.name).not.toBe(initial.agentConfig.name);
    expect(brokers[1]!.agentConfig.env.BRIGD_TASK_CAPABILITY).not.toBe(initial.agentConfig.env.BRIGD_TASK_CAPABILITY);
    expect((await invoke(initial, 'add_comment', { body: 'Stale update.', idempotency_key: 'stale' })).isError).toBe(true);
    const before = store.detail(task.id);
    calls[0]!.callbacks.onSession('stale-session');
    calls[0]!.callbacks.onComment('Stale callback must not reach the current turn.');
    expect(store.detail(task.id)).toEqual(before);
    expect(ids(calls[1]!.input.attachments)).toContain(upload.id);
    await settle(1);
    expect(store.getRun(run.id)).toMatchObject({ status: 'completed', sessionId: run.sessionId, steps: [], turn: 2 });
    expect(calls).toHaveLength(2);
  });

  test('fresh follow-up bridge rejects prior source capabilities and only exposes frozen inputs and current outputs', async () => {
    engine = new Engine(store, false, factory, bridgeFactory);
    const task = store.createTask(taskInput());
    const source = engine.start(task.id);
    const sourceBridge = brokers[0]!;
    writeFileSync(join(sourceBridge.agentConfig.context.outputDirectory, 'evidence.txt'), 'Original evidence.');
    const output = resultText(await invoke(sourceBridge, 'add_attachment', { path: 'evidence.txt', mime: 'text/plain', caption: 'Evidence', idempotency_key: 'evidence' })).attachment;
    await settle(0, 'bridge-source-session');
    const run = engine.followup(task.id, input(store.getRun(source.id)));
    const current = brokers[1]!;
    expect(current.agentConfig.name).not.toBe(sourceBridge.agentConfig.name);
    expect(current.agentConfig.context).toMatchObject({ runId: run.id, turn: 1, stepIndex: null });
    expect(resultText(await invoke(current, 'list_attachments')).attachments.map((file: any) => file.id)).toEqual([output.id]);
    expect((await invoke(sourceBridge, 'add_comment', { body: 'Old capability.', idempotency_key: 'late' })).isError).toBe(true);
    expect((await current.dispatch({ capability: sourceBridge.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool: 'list_attachments', arguments: {} })).isError).toBe(true);
    await settle(1);
    expect((await invoke(current, 'list_attachments')).isError).toBe(true);
  });

  test('cancelling holds task occupancy until the old handle settles and fences late callbacks/results', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const run = engine.followup(task.id, input(source));
    calls[0]!.ignoreCancel = true;
    expect(engine.cancel(run.id).status).toBe('cancelling');
    expect(calls[0]!.cancelled).toBe(1);
    expectError(() => engine.start(task.id));
    expectError(() => engine.followup(task.id, input(source)));
    const before = store.detail(task.id);
    calls[0]!.callbacks.onSession('late-session');
    calls[0]!.callbacks.onComment('Late comment.');
    expect(store.detail(task.id)).toEqual(before);
    await settle(0);
    expect(store.getRun(run.id).status).toBe('cancelled');
    expect(store.activeRun(task.id)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(engine.followup(task.id, input(source)).id).not.toBe(run.id);
  });

  test('interrupted follow-up needs explicit acknowledgement before cancel releases the task', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const run = engine.followup(task.id, input(source));
    await reopen();
    expect(store.getRun(run.id).status).toBe('interrupted');
    expectError(() => engine.cancel(run.id));
    expectError(() => engine.start(task.id));
    expectError(() => engine.retry(run.id, true));
    expect(engine.cancel(run.id, true).status).toBe('cancelled');
    expect(store.activeRun(task.id)).toBeNull();
    expectError(() => engine.start(task.id));
    expect(engine.followup(task.id, input(source)).id).not.toBe(run.id);
  });

  test('a changed resumed session fails instead of replacing the original saved session or launching successors', async () => {
    const task = workflow();
    const source = completed(task);
    const run = engine.followup(task.id, input(source, { sourceStepIndex: 0 }));
    await settle(0, 'wrong-replacement-session');
    const failed = store.getRun(run.id);
    expect(failed).toMatchObject({ status: 'failed', sessionId: source.steps[0]!.sessionId, steps: [] });
    expect(failed.error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(store.getRun(source.id)).toEqual(source);
  });

  test('a reentrant factory cannot create duplicate requests or bypass occupied task protection', async () => {
    const task = store.createTask(taskInput());
    const source = completed(task);
    const payload = input(source);
    let duplicate: Run | undefined;
    engine = new Engine(store, true, (agentInput, callbacks) => {
      duplicate = engine.followup(task.id, payload);
      expectError(() => engine.start(task.id));
      expectError(() => engine.followup(task.id, { ...payload, requestId: crypto.randomUUID() }));
      return factory(agentInput, callbacks);
    });
    const first = engine.followup(task.id, payload);
    expect(duplicate?.id).toBe(first.id);
    expect(calls).toHaveLength(1);
    await settle(0);
  });

  test('manual start, scheduler and new follow-ups wait for a failed old task handle to finish settling', async () => {
    const task = store.createTask(taskInput({ schedule: 'interval', intervalMinutes: 1, firstRunAt: BASE }));
    const source = completed(task);
    const run = engine.followup(task.id, input(source));
    const finish = store.finish.bind(store);
    let during: { active: Run | null; startError: unknown; followupError: unknown; calls: number; runs: number } | undefined;
    store.finish = (...args: Parameters<Store['finish']>) => {
      const terminal = finish(...args);
      if (args[0] === run.id && args[1] === 'failed') {
        let startError: unknown, followupError: unknown;
        try { engine.start(task.id); } catch (error) { startError = error; }
        try { engine.followup(task.id, input(source)); } catch (error) { followupError = error; }
        engine.tick(BASE + 60_000);
        during = { active: store.activeRun(task.id), startError, followupError, calls: calls.length, runs: store.detail(task.id).runs.length };
      }
      return terminal;
    };
    calls[0]!.reject(new Error('Fail while old handle still settles.'));
    await flush();
    store.finish = finish;
    expect(during).toBeDefined();
    expect(during!.active).toBeNull();
    expect(during!.startError).toBeInstanceOf(AppError);
    expect((during!.startError as AppError).status).toBe(409);
    expect(during!.followupError).toBeInstanceOf(AppError);
    expect((during!.followupError as AppError).status).toBe(409);
    expect(during!.calls).toBe(1);
    expect(during!.runs).toBe(2);
    expect(store.getRun(run.id).status).toBe('failed');
    expectError(() => engine.start(task.id));
    engine.followup(task.id, input(source));
    expect(calls).toHaveLength(2);
  });
});

describe('follow-up prompt and native CLI safety', () => {
  test.each(['codex', 'claude'] as const)('%s follow-up preserves explicit resume/model/effort flags and marks old task and stage historical', async provider => {
    const task = workflow();
    const source = completed(task);
    const selected = provider === 'codex' ? 0 : 1;
    engine.followup(task.id, input(source, { sourceStepIndex: selected, body: 'Explain only the finished implementation, including "quotes" and $(untrusted).' }));
    const followup = calls[0]!.input;
    const prompt = buildPrompt(followup);
    expect(prompt).toContain('FOLLOW-UP REQUEST');
    expect(prompt).toMatch(/HISTORICAL[^\n]*TASK/);
    expect(prompt).toMatch(/HISTORICAL[^\n]*(STAGE|STEP)/);
    expect(prompt).toContain(source.instruction);
    expect(prompt).toContain(source.steps[selected]!.instruction);
    expect(prompt).toContain(followup.followup!.request);
    expect(prompt).not.toContain('USER TASK:');
    expect(prompt).not.toContain('CURRENT WORKFLOW STEP');
    expect(prompt).not.toContain('Your completed summary is the handoff to the next worker');
    expect(prompt).not.toContain('Complete only this step toward the shared user task');
    const capabilities = { schema: true, permissionPrompts: true, model: true, efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const };
    const argv = buildArgv(followup, provider, capabilities);
    const ordinary = buildArgv({ ...followup, followup: undefined }, provider, capabilities);
    expect(argv.slice(0, -1)).toEqual(ordinary.slice(0, -1));
    expect(argv.at(-1)).toBe(prompt);
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', followup.model!]);
    expect(argv).not.toContain('--last');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    if (provider === 'codex') {
      expect(argv).toContain('resume');
      expect(argv.slice(-3, -1)).toEqual(['--', source.steps[selected]!.sessionId!]);
      expect(argv).toContain('model_reasoning_effort="xhigh"');
      expect(argv).toContain('approval_policy="on-request"');
    } else {
      expect(argv.slice(-3, -1)).toEqual(['--resume', source.steps[selected]!.sessionId!]);
      expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'max']);
      expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default']);
    }
  });

  test('individually valid fields fail the combined UTF-8 prompt bound without truncation or a factory launch', () => {
    const worker = store.createWorker({ name: 'Precise worker', provider: 'codex', effort: 'default', communicationStyle: '界'.repeat(4_000), avatarUrl: null });
    const instruction = '\u0001'.repeat(16_000);
    const task = store.createTask(taskInput({ workerId: worker.id, instruction }));
    const source = completed(task);
    const body = '界'.repeat(8_000);
    const payload = input(source, { body });
    const agentInput: AgentInput = { provider: source.provider, cwd: source.cwd, instruction, sessionId: source.sessionId!,
      communicationStyle: worker.communicationStyle, followup: { sourceRunId: source.id, sourceStepIndex: null, request: body } };
    // Each field obeys its own character limit; JSON escaping the historical task
    // plus the complete Unicode request and style exceeds the argv byte budget.
    expect(Buffer.byteLength(JSON.stringify(instruction) + JSON.stringify(worker.communicationStyle) + body, 'utf8')).toBeGreaterThan(MAX_PROMPT_BYTES);
    expect(() => buildPrompt(agentInput)).toThrow('combined prompt');
    const run = engine.followup(task.id, payload);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('combined prompt');
    expect(run.followup!.request).toBe(body);
    expect(run.instruction).toBe(instruction);
    expect(calls).toHaveLength(0);
    expect(engine.followup(task.id, payload).id).toBe(run.id);
    expect(calls).toHaveLength(0);
  });
});

describe('historical completion and safe stored snapshots', () => {
  test.each(['failed', 'blocked', 'cancelled'] as const)('historical completion prevents a new manual run after the latest follow-up is %s', async terminal => {
    const task = store.createTask(taskInput());
    expect(task.hasCompletedRun).toBe(false);
    const source = completed(task);
    expect(store.getTask(task.id).hasCompletedRun).toBe(true);
    const run = engine.followup(task.id, input(source));
    if (terminal === 'failed') { calls[0]!.reject(new Error('Failure')); await flush(); }
    else if (terminal === 'blocked') await settle(0, run.sessionId!, 'blocked');
    else { engine.cancel(run.id); await flush(); }
    expect(store.getTask(task.id)).toMatchObject({ hasCompletedRun: true, status: terminal, latestRun: { id: run.id } });
    expectError(() => store.startManual(task.id, true));
    expect((await request(`/api/tasks/${task.id}/run`, 'POST', {})).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(engine.followup(task.id, input(source)).id).not.toBe(run.id);
  });

  test('a session-change callback fences its failed follow-up while its cancelled handle is still alive', async () => {
    const task = store.createTask(taskInput({ schedule: 'interval', intervalMinutes: 1, firstRunAt: BASE }));
    const source = completed(task);
    const run = engine.followup(task.id, input(source));
    calls[0]!.ignoreCancel = true;
    expectError(() => calls[0]!.callbacks.onSession('unexpected-session'));
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', sessionId: source.sessionId });
    expect(calls[0]!.cancelled).toBe(1);
    expectError(() => engine.followup(task.id, input(source)));
    engine.tick(BASE + 60_000);
    expect(calls).toHaveLength(1);
    const before = store.detail(task.id);
    calls[0]!.callbacks.onComment('This callback comes from the failed old process.');
    expect(store.detail(task.id)).toEqual(before);
    calls[0]!.reject(new Error('Old process exited.'));
    await flush();
    const next = engine.followup(task.id, input(source));
    expect(next.id).not.toBe(run.id);
    expect(calls).toHaveLength(2);
  });

  test('manual start also fences an old ordinary handle when no completed history could otherwise block it', async () => {
    const task = store.createTask(taskInput({ schedule: 'interval', intervalMinutes: 1, firstRunAt: BASE }));
    const run = engine.start(task.id);
    calls[0]!.ignoreCancel = true;
    calls[0]!.callbacks.onSession('ordinary-exact-session');
    expectError(() => calls[0]!.callbacks.onSession('ordinary-wrong-session'));
    expect(store.getRun(run.id).status).toBe('failed');
    expect(store.getTask(task.id).hasCompletedRun).toBe(false);
    expect(store.activeRun(task.id)).toBeNull();
    expectError(() => engine.start(task.id));
    engine.tick(BASE + 60_000);
    expect(calls).toHaveLength(1);
    calls[0]!.reject(new Error('Old ordinary handle exited.'));
    await flush();
    expect(engine.start(task.id).id).not.toBe(run.id);
    expect(calls).toHaveLength(2);
  });

  test('a completed workflow stage without its own saved session cannot borrow a later stage session', () => {
    const task = workflow();
    const source = completed(task);
    const steps = structuredClone(source.steps);
    steps[0]!.sessionId = null;
    steps[0]!.attempts.at(-1)!.sessionId = null;
    store.db.query('UPDATE runs SET steps_snapshot=? WHERE id=?').run(JSON.stringify(steps), source.id);
    expect(store.getRun(source.id).sessionId).toBe('source-session-2');
    expectError(() => engine.followup(task.id, input(source, { sourceStepIndex: 0 })));
    expect(calls).toHaveLength(0);
    expect(store.detail(task.id).runs).toHaveLength(1);
  });

  test('corrupt follow-up snapshots fail closed with 409 without fallback to a current worker or a new session', async () => {
    const task = workflow();
    const source = completed(task);
    const payload = input(source, { sourceStepIndex: 1 });
    const { run } = store.startFollowup(task.id, payload);
    const original = JSON.stringify(run.followup);
    const brokenStep = structuredClone(run.followup!);
    brokenStep.workflow!.steps[1]!.worker.model = 'model\0corruption';
    const pendingStep = structuredClone(run.followup!);
    pendingStep.workflow!.steps[0]!.status = 'pending';
    const wrongSession = structuredClone(run.followup!);
    wrongSession.workflow!.steps[1]!.sessionId = 'different-session';
    wrongSession.workflow!.steps[1]!.attempts.at(-1)!.sessionId = 'different-session';
    const invalid: (string | null)[] = [null, '{', 'null', '[]', '{}', JSON.stringify({ ...run.followup, request: '' }),
      JSON.stringify({ ...run.followup, sourceRunId: run.id }), JSON.stringify({ ...run.followup, sourceStepIndex: 0 }),
      JSON.stringify({ ...run.followup, workflow: null }), JSON.stringify({ ...run.followup, extra: true }),
      JSON.stringify({ ...run.followup, workflow: { ...run.followup!.workflow, currentStepIndex: 99 } }),
      JSON.stringify(brokenStep), JSON.stringify(pendingStep), JSON.stringify(wrongSession),
    ];
    try {
      for (const snapshot of invalid) {
        store.db.query('UPDATE runs SET followup_snapshot=? WHERE id=?').run(snapshot, run.id);
        expectError(() => store.getRun(run.id));
        expect((await request(`/api/tasks/${task.id}`)).status).toBe(409);
        expect((await request(`/api/tasks/${task.id}/followups`, 'POST', payload)).status).toBe(409);
        expect(calls).toHaveLength(0);
        expect((store.db.query('SELECT count(*) AS n FROM runs WHERE task_id=?').get(task.id) as { n: number }).n).toBe(2);
      }
    } finally { store.db.query('UPDATE runs SET followup_snapshot=? WHERE id=?').run(original, run.id); }
    expect(store.getRun(run.id).followup).toEqual(run.followup);
  });

  test('malformed JSON in source snapshots rejects creation atomically instead of returning HTTP 500', async () => {
    const task = workflow();
    const source = completed(task);
    for (const column of ['steps_snapshot', 'worker_snapshot', 'instructions_snapshot']) {
      const original = (store.db.query(`SELECT ${column} AS value FROM runs WHERE id=?`).get(source.id) as { value: string }).value;
      try {
        store.db.query(`UPDATE runs SET ${column}=? WHERE id=?`).run('{', source.id);
        expect((await request(`/api/tasks/${task.id}/followups`, 'POST', input(source, { sourceStepIndex: 1 }))).status).toBe(409);
        expect(calls).toHaveLength(0);
        expect((store.db.query('SELECT count(*) AS n FROM runs WHERE task_id=?').get(task.id) as { n: number }).n).toBe(1);
        expect(store.db.query('SELECT * FROM followup_requests WHERE task_id=?').all(task.id)).toEqual([]);
      } finally { store.db.query(`UPDATE runs SET ${column}=? WHERE id=?`).run(original, source.id); }
    }
  });

  test('two additive migrations preserve old raw rows and exact saved sessions, then persist a follow-up across another reopen', () => {
    const path = join(folder, 'legacy-followups.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL, provider TEXT NOT NULL,
        cwd TEXT NOT NULL, schedule TEXT NOT NULL, interval_minutes INTEGER, first_run_at INTEGER, next_run_at INTEGER,
        paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
        cwd TEXT NOT NULL, instruction TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for INTEGER, status TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER, summary TEXT,
        error TEXT, turn INTEGER NOT NULL DEFAULT 1, mock INTEGER NOT NULL);
      CREATE TABLE comments (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO tasks VALUES ('legacy-task','Legacy task','Current edited text','claude','/tmp','manual',NULL,NULL,NULL,0,${BASE},${BASE + 10});
      INSERT INTO runs VALUES ('legacy-run','legacy-task','codex','/tmp/original','  Original exact task\\ntext  ','manual',NULL,
        'completed','legacy-exact-session',${BASE},${BASE + 1},${BASE + 1},'Original result',NULL,3,1);
      INSERT INTO comments VALUES (42,'legacy-comment','legacy-task','legacy-run','result','Exact old comment',${BASE + 1});
    `);
    const tables = ['tasks', 'runs', 'comments'];
    const originals = new Map(tables.map(table => [table, legacy.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]]));
    legacy.close();
    let migrated: Store | undefined;
    let created: Run | undefined;
    const payload: FollowupInput = { sourceRunId: 'legacy-run', sourceStepIndex: null, body: 'Explain the old result.', attachmentIds: [], requestId: 'legacy-request' };
    try {
      for (let pass = 0; pass < 2; pass++) {
        migrated = new Store(path);
        for (const table of tables) {
          const raw = originals.get(table)!;
          const columns = Object.keys(raw[0]!).map(column => `"${column}"`).join(',');
          expect(migrated.db.query(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all()).toEqual(raw);
        }
        expect(migrated.getRun('legacy-run')).toMatchObject({ followup: null, steps: [], currentStepIndex: null, sessionId: 'legacy-exact-session', turn: 3 });
        expect(migrated.getTask('legacy-task').hasCompletedRun).toBe(true);
        expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        migrated.close(); migrated = undefined;
      }
      migrated = new Store(path);
      created = migrated.startFollowup('legacy-task', payload).run;
      expect(created).toMatchObject({ trigger: 'followup', provider: 'codex', cwd: '/tmp/original', sessionId: 'legacy-exact-session', mock: true, steps: [], currentStepIndex: null });
      expect(created.instruction).toBe(String(originals.get('runs')![0]!.instruction));
      migrated.finish(created.id, 'completed', 'Explained.', null);
      migrated.close(); migrated = new Store(path);
      const replay = migrated.startFollowup('legacy-task', payload);
      expect(replay.created).toBe(false);
      expect(replay.run).toMatchObject({ id: created.id, status: 'completed', sessionId: 'legacy-exact-session' });
      expect(migrated.detail('legacy-task').comments.filter(comment => comment.kind === 'user' && comment.runId === created!.id)).toHaveLength(1);
      expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { migrated?.close(); }
  });
});
