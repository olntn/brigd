import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store';
import { Engine, type AgentFactory } from '../server/engine';
import type { AgentInput, AgentCallbacks, AgentOutcome } from '../server/adapter';
import { prepareAttachment } from '../server/attachments';
import { createTaskBroker, type TaskBroker } from '../server/task-mcp';
import type { TaskInput } from '../src/lib/types';

let folder: string, store: Store, engine: Engine;
let calls: { input: AgentInput; callbacks: AgentCallbacks; resolve: (value: AgentOutcome) => void; reject: (error: Error) => void }[];
let brokers: TaskBroker[];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const factory: AgentFactory = (input, callbacks) => {
  let resolve!: (value: AgentOutcome) => void, reject!: (error: Error) => void;
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  calls.push({ input, callbacks, resolve, reject });
  return { result, cancel: () => reject(new Error('Synthetic cancellation')) };
};
const invoke = (broker: TaskBroker, tool: string, args: Record<string, unknown> = {}) => broker.dispatch({
  capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool, arguments: args,
});
const text = (result: Awaited<ReturnType<typeof invoke>>) => {
  expect(result.isError).not.toBe(true);
  const content = result.content.find(value => value.type === 'text');
  if (content?.type !== 'text') throw new Error('Expected MCP text result');
  return JSON.parse(content.text);
};
const outcome = (sessionId: string, waiting = false): AgentOutcome => ({ sessionId,
  envelope: { status: waiting ? 'needs_input' : 'completed', summary: waiting ? 'Need the screenshot.' : 'Verified this step.', questions: waiting ? ['Which element?'] : [] } });
const taskInput = (extra: Partial<TaskInput> = {}): TaskInput => ({ title: 'Attachment handoff', instruction: 'Use inputs and attach verified output.', provider: 'codex', cwd: folder,
  schedule: 'manual', paused: false, intervalMinutes: null, firstRunAt: null, ...extra });
const stagedText = async (name: string) => store.stageAttachment(await prepareAttachment(Buffer.from(name), 'text/plain', name));
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-attachment-engine-'));
  store = new Store(join(folder, 'test.sqlite'));
  calls = []; brokers = [];
  engine = new Engine(store, false, factory, (db, run, fence) => { const broker = createTaskBroker(db, run, fence); broker.agentConfig.env.BRIGD_TASK_SOCKET = "/tmp/brigd-inprocess-test.sock"; brokers.push(broker); return broker; });
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  store.close(); rmSync(folder, { recursive: true, force: true });
});

test('engine freezes attachment inputs, hands off outputs across providers, and resumes only explicit clarification files', async () => {
  const original = await stagedText('original.txt');
  const first = store.createWorker({ name: 'Planner', provider: 'codex', effort: 'high', communicationStyle: '', avatarUrl: null });
  const second = store.createWorker({ name: 'Builder', provider: 'claude', effort: 'high', communicationStyle: '', avatarUrl: null });
  const task = store.createTask(taskInput({ attachmentIds: [original.id], steps: [
    { workerId: first.id, title: 'Plan', instruction: 'Publish a plan.' }, { workerId: second.id, title: 'Build', instruction: 'Use the plan.' },
  ] }));
  const run = engine.start(task.id);
  expect(calls[0]?.input.attachments?.map(file => file.id)).toEqual([original.id]);
  const oldBroker = brokers[0]!;
  writeFileSync(join(oldBroker.agentConfig.context.outputDirectory, 'plan.txt'), 'Approved implementation plan');
  const output = text(await invoke(oldBroker, 'add_attachment', { path: 'plan.txt', mime: 'text/plain', caption: 'Plan evidence', idempotency_key: 'first_plan' })).attachment;
  calls[0]!.resolve(outcome('planner-session')); await flush();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.input.provider).toBe('claude');
  expect(calls[1]?.input.attachments?.map(file => file.id).sort()).toEqual([original.id, output.id].sort());
  expect((await invoke(oldBroker, 'add_comment', { body: 'Late comment', idempotency_key: 'late' })).isError).toBe(true);
  const lateEdit = await stagedText('later-task-edit.txt');
  store.updateTask(task.id, { ...task, attachmentIds: [original.id, lateEdit.id] });
  expect(text(await invoke(brokers[1]!, 'list_attachments')).attachments.map((file: any) => file.id).sort()).toEqual([original.id, output.id].sort());
  calls[1]!.resolve(outcome('builder-session', true)); await flush();
  const clarification = await stagedText('clarification.txt');
  engine.resume(run.id, 'Use the attached exact target.', false, [clarification.id]);
  expect(calls[2]?.input.sessionId).toBe('builder-session');
  expect(calls[2]?.input.attachments?.map(file => file.id).sort()).toEqual([original.id, output.id, clarification.id].sort());
  expect(calls[2]?.input.attachments?.some(file => file.id === lateEdit.id)).toBe(false);
  const frozenTurnOne = store.db.query('SELECT attachment_id FROM run_attachment_inputs WHERE run_id=? AND turn=1').all(run.id) as { attachment_id: string }[];
  expect(frozenTurnOne.map(row => row.attachment_id)).toEqual([original.id]);
  expect(store.detail(task.id).comments.find(comment => comment.body === 'Use the attached exact target.')?.attachments?.[0]?.id).toBe(clarification.id);
  calls[2]!.resolve(outcome('builder-session')); await flush();
  expect(store.getRun(run.id).status).toBe('completed');
  for (const broker of brokers) expect((await invoke(broker, 'list_attachments')).isError).toBe(true);
});

test('cancellation revokes a bridge during image preparation before its atomic publication', async () => {
  const task = store.createTask(taskInput());
  const run = engine.start(task.id), broker = brokers[0]!;
  const png = await sharp({ create: { width: 1000, height: 800, channels: 4, background: '#6f54dc' } }).png().toBuffer();
  writeFileSync(join(broker.agentConfig.context.outputDirectory, 'result.png'), png);
  const pending = invoke(broker, 'add_attachment', { path: 'result.png', mime: 'image/png', caption: 'Must not publish after cancel', idempotency_key: 'cancelled' });
  engine.cancel(run.id);
  expect((await pending).isError).toBe(true); await flush();
  expect(store.getRun(run.id).status).toBe('cancelled');
  expect(store.listTaskAttachments(task.id)).toHaveLength(0);
  expect(store.detail(task.id).comments.some(comment => comment.body === 'Must not publish after cancel')).toBe(false);
});

test('factory failure and shutdown revoke capabilities without losing task history', async () => {
  await engine.shutdown();
  engine = new Engine(store, false, () => { throw new Error('Provider missing'); }, (db, run, fence) => { const broker = createTaskBroker(db, run, fence); broker.agentConfig.env.BRIGD_TASK_SOCKET = "/tmp/brigd-inprocess-test.sock"; brokers.push(broker); return broker; });
  const task = store.createTask(taskInput());
  const failed = engine.start(task.id);
  expect(failed.status).toBe('failed');
  expect((await invoke(brokers[0]!, 'list_attachments')).isError).toBe(true);
  engine = new Engine(store, false, factory, (db, run, fence) => { const broker = createTaskBroker(db, run, fence); broker.agentConfig.env.BRIGD_TASK_SOCKET = "/tmp/brigd-inprocess-test.sock"; brokers.push(broker); return broker; });
  const current = engine.start(task.id);
  await engine.shutdown();
  expect(store.getRun(current.id).status).toBe('interrupted');
  expect((await invoke(brokers[1]!, 'add_comment', { body: 'After shutdown', idempotency_key: 'shutdown' })).isError).toBe(true);
  expect(store.detail(task.id).runs).toHaveLength(2);
});

test('MCP comments accept the shared 20-file limit and reject a larger association atomically', async () => {
  const files = [];
  for (let index = 0; index < 20; index++) files.push(await stagedText(`context-${index}.txt`));
  const ids = files.map(file => file.id);
  const task = store.createTask(taskInput({ attachmentIds: ids }));
  engine.start(task.id);
  const published = text(await invoke(brokers[0]!, 'add_comment', { body: 'All twenty sources', attachment_ids: ids, idempotency_key: 'all_sources' }));
  expect(store.detail(task.id).comments.find(comment => comment.id === published.comment_id)?.attachments).toHaveLength(20);
  const before = store.detail(task.id).comments.length;
  const result = await invoke(brokers[0]!, 'add_comment', { body: 'Too many', attachment_ids: [...ids, 'another-id'], idempotency_key: 'too_many' });
  expect(result.isError).toBe(true);
  expect(store.detail(task.id).comments).toHaveLength(before);
});
