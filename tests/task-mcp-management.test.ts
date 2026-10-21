import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareAttachment } from '../server/attachments';
import { BackupManager } from '../server/backups';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store, runFence } from '../server/store';
import { createTaskBridge, createTaskBroker, type TaskAppAccess, type TaskBroker } from '../server/task-mcp';
import { MAX_TASK_RESULT_BYTES, MAX_TASK_TOOL_CALLS, TASK_MCP_TOOLS, type TaskToolResult } from '../server/task-mcp-protocol';
import type { Run, TaskInput } from '../src/lib/types';

const ORIGIN = 'http://127.0.0.1:4310';
let directory: string, store: Store, engine: Engine, backups: BackupManager, appAccess: TaskAppAccess;
let brokers: TaskBroker[], cancelAgents: Array<() => void>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const factory: AgentFactory = () => {
  let reject!: (error: unknown) => void;
  const result = new Promise<never>((_, no) => { reject = no; });
  const cancel = () => reject(new Error('Synthetic cancellation'));
  cancelAgents.push(cancel);
  return { result, cancel };
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brigd-mcp-management-test-'));
  store = new Store(join(directory, 'app.sqlite'));
  brokers = [];
  cancelAgents = [];
  engine = new Engine(store, true, factory);
  backups = new BackupManager({ dbPath: join(directory, 'app.sqlite'), updateBackupDir: join(directory, 'updates') });
  appAccess = {
    async request(method, path, data, invocation) {
      const handler = createHandler(engine, {
        port: 4310, root: directory, defaultCwd: directory, cliHome: join(directory, 'cli-home'), backupManager: backups,
        authorizeMutation: () => {
          if (!invocation.isCurrent()) throw new AppError('Invocation expired before write.', 409);
          return true;
        },
      });
      return handler(new Request(ORIGIN + path, {
        method, headers: { Host: '127.0.0.1:4310', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(data ?? {}),
      }));
    },
  };
});
afterEach(async () => {
  for (const broker of brokers) broker.close();
  for (const cancel of cancelAgents) cancel();
  await flush();
  await engine.shutdown();
  await flush();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Managing app', instruction: 'Manage requested app data.', provider: 'codex', cwd: directory,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const brokerFor = (run: Run, access = appAccess) => {
  const broker = createTaskBroker(store, run, runFence(run), access);
  brokers.push(broker);
  return broker;
};
const setup = (access = appAccess) => {
  const task = store.createTask(taskInput());
  const run = store.startManual(task.id, true);
  return { task, run, broker: brokerFor(run, access) };
};
const call = (broker: TaskBroker, tool: string, args: unknown = {}) => broker.dispatch({
  capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool, arguments: args,
});
const parse = (result: TaskToolResult): any => {
  expect(result.isError).not.toBe(true);
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('No text result');
  return JSON.parse(first.text);
};
const mutate = async (broker: TaskBroker, tool: string, args: Record<string, unknown>, key: string = crypto.randomUUID()) =>
  parse(await call(broker, tool, { ...args, idempotency_key: key }));
const createCard = (broker: TaskBroker, title: string, key: string = crypto.randomUUID(), data: Record<string, unknown> = {}) =>
  mutate(broker, 'create_task', { data: { title, instruction: 'Complete this card.', ...data } }, key);

describe('MCP app management through the shared HTTP controller', () => {
  test('creates, discovers, edits, archives, and restores cards with bounded filtered lists', async () => {
    const { broker } = setup();
    const cards = [];
    for (const title of ['Managed one', 'Managed two', 'Managed three']) cards.push(await createCard(broker, title));
    expect(cards.every(card => typeof card.id === 'string')).toBe(true);
    expect(store.getTask(cards[0].id)).toMatchObject({ provider: 'codex', cwd: directory, schedule: 'manual', paused: false });
    const first = parse(await call(broker, 'list_tasks', { query: 'Managed', archived: 'all', limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first).toMatchObject({ total: 3, next_offset: 2 });
    const last = parse(await call(broker, 'list_tasks', { query: 'Managed', archived: 'all', offset: first.next_offset, limit: 2 }));
    expect(last.items).toHaveLength(1);
    expect(last).toMatchObject({ total: 3, next_offset: null });
    expect(new Set([...first.items, ...last.items].map((item: any) => item.id))).toEqual(new Set(cards.map(card => card.id)));
    await mutate(broker, 'update_task', { task_id: cards[0].id.slice(0, 8).toUpperCase(), data: { title: 'Managed renamed', instruction: 'Updated card instructions.' } });
    expect(store.getTask(cards[0].id)).toMatchObject({ title: 'Managed renamed', instruction: 'Updated card instructions.' });
    await mutate(broker, 'archive_task', { task_id: cards[1].id });
    const active = parse(await call(broker, 'list_tasks', { query: 'Managed', archived: 'active' }));
    expect(active.total).toBe(2);
    const archived = parse(await call(broker, 'list_tasks', { query: 'Managed', archived: 'archived' }));
    expect(archived.items.map((item: any) => item.id)).toEqual([cards[1].id]);
    expect((await call(broker, 'update_task', { task_id: cards[1].id, data: { title: 'Forbidden archived edit' }, idempotency_key: 'archived-edit' })).isError).toBe(true);
    await mutate(broker, 'restore_task', { task_id: cards[1].id });
    expect(store.getTask(cards[1].id).archivedAt).toBeNull();
    expect(parse(await call(broker, 'list_tasks', { query: 'Managed', archived: 'active' })).total).toBe(3);
  });

  test('retries use durable invocation receipts across brokers and reject conflicting key reuse', async () => {
    const { run, broker } = setup();
    const args = { data: { title: 'Exactly one copy', instruction: 'A creation retried by the agent.' }, idempotency_key: 'create-once' };
    const first = parse(await call(broker, 'create_task', args));
    expect(parse(await call(broker, 'create_task', args))).toEqual(first);
    broker.close();
    const replacement = brokerFor(run);
    expect(parse(await call(replacement, 'create_task', args))).toEqual(first);
    expect((await call(replacement, 'create_task', { ...args, data: { ...args.data, title: 'Conflicting duplicate' } })).isError).toBe(true);
    expect((await call(replacement, 'create_tag', { data: { name: 'Conflicting operation' }, idempotency_key: args.idempotency_key })).isError).toBe(true);
    expect(store.listTasks().filter(task => task.title === 'Exactly one copy')).toHaveLength(1);
    expect(store.listTasks().some(task => task.title === 'Conflicting duplicate')).toBe(false);
    expect(store.listTags()).toEqual([]);
  });

  test('successful card edits refresh task metadata while invocation files and history remain frozen', async () => {
    const { task, run, broker } = setup();
    expect(parse(await call(broker, 'get_task')).task).toMatchObject({ title: 'Managing app', instruction: task.instruction });
    const late = store.stageAttachment(await prepareAttachment(Buffer.from('Uploaded during management'), 'text/plain', 'late-managed.txt'));
    await mutate(broker, 'post_task_comment', { task_id: task.id, data: { body: 'Comment after the invocation boundary.' } });
    await mutate(broker, 'update_task', { task_id: task.id, data: { title: 'Edited current card', instruction: 'Instructions for a future run.', attachmentIds: [late.id] } });
    const current = parse(await call(broker, 'get_task'));
    expect(current.task).toMatchObject({ id: task.id, title: 'Edited current card', instruction: 'Instructions for a future run.' });
    expect(current.attachments).toEqual([]);
    expect(current.attachment_count).toBe(0);
    expect(store.getRun(run.id).instruction).toBe(task.instruction);
    expect((await call(broker, 'read_attachment', { attachment_id: late.id })).isError).toBe(true);
    expect(parse(await call(broker, 'list_comments')).comments.some((comment: any) => comment.body === 'Comment after the invocation boundary.')).toBe(false);
    const card = await createCard(broker, 'Existing reference metadata');
    expect(parse(await call(broker, 'get_task', { task_id: card.id })).task.title).toBe('Existing reference metadata');
    await mutate(broker, 'update_task', { task_id: card.id, data: { title: 'Updated reference metadata' } });
    expect(parse(await call(broker, 'get_task', { task_id: card.id })).task.title).toBe('Updated reference metadata');
    await mutate(broker, 'archive_task', { task_id: card.id });
    expect(parse(await call(broker, 'get_task', { task_id: card.id })).task.archived).toBe(true);
    await mutate(broker, 'restore_task', { task_id: card.id });
    expect(parse(await call(broker, 'get_task', { task_id: card.id })).task.archived).toBe(false);
  });

  test('concurrent brokers do not repeat a creation while its first receipt is pending', async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let creations = 0;
    const slowAccess: TaskAppAccess = {
      async request(method, path, data, invocation) {
        const response = await appAccess.request(method, path, data, invocation);
        if (method === 'POST' && path === '/api/tasks') {
          creations++;
          entered();
          await blocked;
        }
        return response;
      },
    };
    const { run, broker } = setup(slowAccess);
    const other = brokerFor(run, slowAccess);
    const args = { data: { title: 'Concurrent creation', instruction: 'Create once across brokers.' }, idempotency_key: 'concurrent-create' };
    const first = call(broker, 'create_task', args);
    await started;
    const concurrent = call(other, 'create_task', args);
    release();
    const created = parse(await first);
    const raced = await concurrent;
    if (!raced.isError) expect(parse(raced).id).toBe(created.id);
    expect(parse(await call(other, 'create_task', args))).toEqual(created);
    expect(creations).toBe(1);
    expect(store.listTasks().filter(task => task.title === 'Concurrent creation')).toHaveLength(1);
  });

  test('validation and missing idempotency keys leave cards unchanged; lifecycle guards still apply', async () => {
    const { task, broker } = setup();
    const before = store.listTasks().length;
    for (const args of [
      { data: { title: 'Missing receipt key', instruction: 'No mutation.' } },
      { data: { title: '', instruction: 'Invalid title.' }, idempotency_key: 'invalid-title' },
      { data: { title: 'Invalid cwd', instruction: 'No mutation.', cwd: join(directory, 'missing') }, idempotency_key: 'invalid-cwd' },
      { data: { title: 'Invalid fields', instruction: 'No mutation.', unknown: true }, idempotency_key: 'unknown-field' },
    ]) expect((await call(broker, 'create_task', args)).isError).toBe(true);
    expect(store.listTasks()).toHaveLength(before);
    expect((await call(broker, 'update_task', { task_id: task.id, data: { title: '' }, idempotency_key: 'invalid-edit' })).isError).toBe(true);
    expect(store.getTask(task.id).title).toBe('Managing app');
    expect((await call(broker, 'archive_task', { task_id: task.id, idempotency_key: 'archive-active' })).isError).toBe(true);
    expect(store.getTask(task.id).archivedAt).toBeNull();
    const card = await createCard(broker, 'Start exactly once');
    const started = await mutate(broker, 'start_task', { task_id: card.id }, 'start-once');
    expect((await mutate(broker, 'start_task', { task_id: card.id }, 'start-once')).id).toBe(started.id);
    expect(store.detail(card.id).runs).toHaveLength(1);
    expect((await call(broker, 'archive_task', { task_id: card.id, idempotency_key: 'archive-running' })).isError).toBe(true);
    const comment = await mutate(broker, 'post_task_comment', { task_id: card.id, data: { body: 'Additional user request.' } }, 'post-once');
    expect((await mutate(broker, 'post_task_comment', { task_id: card.id, data: { body: 'Additional user request.' } }, 'post-once')).id).toBe(comment.id);
    expect(store.detail(card.id).comments.filter(item => item.body === 'Additional user request.')).toHaveLength(1);
  });

  test('manages worker and tag catalogs and assigns their IDs to cards', async () => {
    const { broker } = setup();
    const worker = await mutate(broker, 'create_worker', { data: { name: 'Management Ada', provider: 'codex', communicationStyle: 'Explain verified results.' } });
    const tag = await mutate(broker, 'create_tag', { data: { name: 'Managed label', color: '#336699' } });
    const card = await createCard(broker, 'Catalog assignment', crypto.randomUUID(), { workerId: worker.id });
    await mutate(broker, 'set_task_tags', { task_id: card.id, data: { tagIds: [tag.id] } });
    expect(store.getTask(card.id)).toMatchObject({ workerId: worker.id, tagIds: [tag.id] });
    expect(parse(await call(broker, 'list_tasks', { tag_id: tag.id })).items.map((item: any) => item.id)).toEqual([card.id]);
    await mutate(broker, 'update_worker', { worker_id: worker.id, data: { name: 'Management Grace', effort: 'high' } });
    expect(parse(await call(broker, 'get_worker', { worker_id: worker.id }))).toMatchObject({ name: 'Management Grace', effort: 'high', communicationStyle: 'Explain verified results.' });
    await mutate(broker, 'update_tag', { tag_id: tag.id, data: { name: 'Edited label', color: '#663399' } });
    expect(parse(await call(broker, 'get_tag', { tag_id: tag.id }))).toMatchObject({ name: 'Edited label', color: '#663399' });
    expect(parse(await call(broker, 'list_workers')).items.some((item: any) => item.id === worker.id)).toBe(true);
    expect(parse(await call(broker, 'list_tags')).items.map((item: any) => item.id)).toEqual([tag.id]);
    await mutate(broker, 'archive_worker', { worker_id: worker.id });
    expect(store.getWorker(worker.id).archived).toBe(true);
    await mutate(broker, 'update_worker', { worker_id: worker.id, data: { archived: false } });
    expect(store.getWorker(worker.id).archived).toBe(false);
    await mutate(broker, 'delete_tag', { tag_id: tag.id });
    expect(store.listTags()).toEqual([]);
    expect(store.getTask(card.id).tagIds).toEqual([]);
  });

  test('creates, edits, reads, and deletes instruction and model catalog entries', async () => {
    const { broker } = setup();
    const instruction = await mutate(broker, 'create_instruction', { data: { title: 'Management guideline', body: 'Retain stable task IDs.', enabled: true } });
    expect(parse(await call(broker, 'get_instruction', { instruction_id: instruction.id }))).toMatchObject({ title: 'Management guideline', body: 'Retain stable task IDs.', enabled: true });
    await mutate(broker, 'update_instruction', { instruction_id: instruction.id, data: { body: 'Retain IDs and useful history.', enabled: false } });
    expect(store.getInstruction(instruction.id)).toMatchObject({ body: 'Retain IDs and useful history.', enabled: false });
    expect(parse(await call(broker, 'list_instructions')).items.map((item: any) => item.id)).toEqual([instruction.id]);
    const model = await mutate(broker, 'create_model', { data: { provider: 'codex', modelId: 'management-model', label: 'Management model' } });
    await mutate(broker, 'update_model', { model_id: model.id, data: { label: 'Edited management model' } });
    expect(parse(await call(broker, 'get_model', { model_id: model.id }))).toMatchObject({ provider: 'codex', modelId: 'management-model', label: 'Edited management model' });
    expect(parse(await call(broker, 'list_models')).items.some((item: any) => item.id === model.id)).toBe(true);
    await mutate(broker, 'delete_instruction', { instruction_id: instruction.id });
    await mutate(broker, 'delete_model', { model_id: model.id });
    expect(store.listInstructions()).toEqual([]);
    expect(store.listModels().some(item => item.id === model.id)).toBe(false);
  });

  test('settings use shared validation and new cards retain explicit manual creation defaults', async () => {
    const { broker } = setup();
    const newDefault = join(directory, 'new-default');
    mkdirSync(newDefault);
    expect(parse(await call(broker, 'get_app_info'))).toMatchObject({ mode: 'mock' });
    expect(parse(await call(broker, 'get_general_settings'))).toMatchObject({ defaultCwd: directory, defaultSchedule: 'manual' });
    await mutate(broker, 'update_general_settings', { data: { defaultCwd: newDefault, defaultSchedule: 'auto' } });
    expect(store.getDefaultCwd()).toBe(newDefault);
    expect(store.getDefaultSchedule()).toBe('auto');
    const card = await createCard(broker, 'Stable creation defaults');
    expect(store.getTask(card.id)).toMatchObject({ cwd: directory, schedule: 'manual', provider: 'codex' });
    expect((await call(broker, 'update_general_settings', { data: { defaultSchedule: 'unknown' }, idempotency_key: 'invalid-settings' })).isError).toBe(true);
    expect(store.getDefaultSchedule()).toBe('auto');
    await mutate(broker, 'update_permission_settings', { data: { mode: 'full' } });
    expect(parse(await call(broker, 'get_permission_settings'))).toEqual({ mode: 'full' });
    await mutate(broker, 'update_permission_settings', { data: { mode: 'standard' } });
    const checks = [['bun', 'test', '--test-name-pattern', 'literal $name; argument']];
    await mutate(broker, 'update_autopilot_settings', { data: { integrationChecks: checks } });
    expect(parse(await call(broker, 'get_autopilot_settings'))).toMatchObject({ integrationChecks: checks, source: 'settings' });
    await mutate(broker, 'update_integrator', { data: { mode: 'custom', provider: 'codex', communicationStyle: 'Resolve only the reported conflicts.' } });
    expect(parse(await call(broker, 'get_integrator'))).toMatchObject({ mode: 'custom', communicationStyle: 'Resolve only the reported conflicts.' });
    await mutate(broker, 'update_autopilot', { data: { enabled: true, until: null } });
    expect(store.getAutopilot().enabled).toBe(true);
    await mutate(broker, 'update_autopilot', { data: { enabled: false } });
    expect(store.getAutopilot().enabled).toBe(false);
  });

  test('autopilot overview pages compact pool summaries even when raw cards exceed the response budget', async () => {
    const worker = store.createWorker({
      name: 'Pool worker', provider: 'codex', model: null, effort: 'default', avatarUrl: null,
      communicationStyle: 'WORKER-SNAPSHOT-MUST-STAY-OUT',
    });
    const instruction = 'POOL-INSTRUCTION-MUST-STAY-OUT\n'.repeat(600).slice(0, 16000);
    const expected: string[] = [];
    for (let index = 0; index < 35; index++) expected.push(store.createTask(taskInput({
      title: `Pool card ${index}`, instruction, schedule: 'auto', workerId: worker.id,
    }), 1_700_000_000_000 + index).id);
    const { broker } = setup();
    const state = store.getAutopilot();
    expect(state.enabled).toBe(false);
    const handler = createHandler(engine, { port: 4310, root: directory, defaultCwd: directory });
    const raw = await handler(new Request(ORIGIN + '/api/autopilot', { headers: { Host: '127.0.0.1:4310', Origin: ORIGIN } }));
    expect(raw.ok).toBe(true);
    expect(Buffer.byteLength(await raw.text())).toBeGreaterThan(MAX_TASK_RESULT_BYTES);

    const firstResult = await call(broker, 'get_autopilot');
    expect(Buffer.byteLength(JSON.stringify(firstResult)) + 1).toBeLessThanOrEqual(MAX_TASK_RESULT_BYTES);
    const first = parse(firstResult);
    expect(first).toMatchObject({ ...state, pool_count: 35, attempt_count: 0, pool_next_offset: 20, attempts_next_offset: null });
    expect(first.pool.map((card: any) => card.id)).toEqual(expected.slice(0, 20));
    expect(first.attempts).toEqual([]);
    const last = parse(await call(broker, 'get_autopilot', { offset: first.pool_next_offset }));
    expect(last).toMatchObject({ ...state, pool_count: 35, attempt_count: 0, pool_next_offset: null, attempts_next_offset: null });
    expect(last.pool.map((card: any) => card.id)).toEqual(expected.slice(20));
    expect(last.attempts).toEqual([]);
    for (const page of [first, last]) {
      expect(JSON.stringify(page)).not.toContain('POOL-INSTRUCTION-MUST-STAY-OUT');
      expect(JSON.stringify(page)).not.toContain('WORKER-SNAPSHOT-MUST-STAY-OUT');
      expect(page.pool.every((card: any) => !('instruction' in card) && !('worker' in card) && !('steps' in card))).toBe(true);
    }
    const small = parse(await call(broker, 'get_autopilot', { offset: 0, limit: 7 }));
    expect(small.pool.map((card: any) => card.id)).toEqual(expected.slice(0, 7));
    expect(small.pool_next_offset).toBe(7);
    expect((await call(broker, 'get_autopilot', { limit: 21 })).isError).toBe(true);
    expect(store.getAutopilot()).toEqual(state);
    expect(store.detail(expected[0]!).runs).toEqual([]);
  });

  test('backup receipts retry exactly once and snapshots include created cards and settings', async () => {
    const { broker } = setup();
    const card = await createCard(broker, 'Included in MCP backup');
    await mutate(broker, 'post_task_comment', { task_id: card.id, data: { body: 'Back up this discussion too.' } });
    await mutate(broker, 'update_general_settings', { data: { defaultSchedule: 'interval' } });
    const backup = await mutate(broker, 'create_backup', {}, 'backup-once');
    expect(await mutate(broker, 'create_backup', {}, 'backup-once')).toEqual(backup);
    expect(backups.list().backups).toHaveLength(1);
    const snapshot = new Database(backups.download(backup.id).path, { readonly: true });
    try {
      expect(snapshot.query('SELECT title,instruction FROM tasks WHERE id=?').get(card.id)).toEqual({ title: 'Included in MCP backup', instruction: 'Complete this card.' });
      expect(snapshot.query('SELECT body FROM comments WHERE task_id=?').all(card.id)).toEqual([{ body: 'Back up this discussion too.' }]);
      expect(snapshot.query('SELECT default_schedule FROM general_settings WHERE singleton=1').get()).toEqual({ default_schedule: 'interval' });
    } finally { snapshot.close(); }
    const after = await createCard(broker, 'Created after MCP backup');
    const renamed = await mutate(broker, 'rename_backup', { backup_id: backup.id, data: { name: 'Managed snapshot.sqlite' } });
    expect(renamed).toMatchObject({ id: backup.id, name: 'Managed snapshot.sqlite' });
    const overview = parse(await call(broker, 'list_backups'));
    expect(overview.items.map((item: any) => item.id)).toEqual([backup.id]);
    expect(overview).toMatchObject({ total: 1, next_offset: null });
    expect(store.getTask(after.id).title).toBe('Created after MCP backup');
    await mutate(broker, 'delete_backup', { backup_id: backup.id });
    expect(backups.list().backups).toEqual([]);
  });

  test('request-count and aggregate-output budgets reject app mutations before any write', async () => {
    const { broker } = setup();
    for (let index = 0; index < MAX_TASK_TOOL_CALLS; index++) expect((await call(broker, 'list_tasks')).isError).not.toBe(true);
    const before = store.listTasks().length;
    expect((await call(broker, 'create_task', { data: { title: 'Over request budget', instruction: 'Must not be created.' }, idempotency_key: 'over-count' })).isError).toBe(true);
    expect(store.listTasks()).toHaveLength(before);
    let writes = 0;
    const largeReads: TaskAppAccess = {
      async request(method, path, data, invocation) {
        if (method === 'GET' && path === '/api/info') return Response.json({ padding: 'x'.repeat(MAX_TASK_RESULT_BYTES - 512) });
        if (method !== 'GET') writes++;
        return appAccess.request(method, path, data, invocation);
      },
    };
    const outputLimited = setup(largeReads);
    for (let index = 0; index < 4; index++) expect((await call(outputLimited.broker, 'get_app_info')).isError).not.toBe(true);
    expect((await call(outputLimited.broker, 'create_task', { data: { title: 'Over output budget', instruction: 'Must not be created.' }, idempotency_key: 'over-output' })).isError).toBe(true);
    expect(writes).toBe(0);
    expect(store.listTasks().some(task => task.title === 'Over output budget')).toBe(false);
  });

  test('large Unicode HTTP errors retain a bounded retryable mutation receipt', async () => {
    let requests = 0;
    const failingAccess: TaskAppAccess = {
      async request() {
        requests++;
        return Response.json({ error: '界'.repeat(1600) }, { status: 409 });
      },
    };
    const { broker } = setup(failingAccess);
    const args = { data: { title: 'Rejected by controller', instruction: 'No card is created.' }, idempotency_key: 'unicode-error' };
    const first = await call(broker, 'create_task', args);
    expect(first.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4096);
    expect(await call(broker, 'create_task', args)).toEqual(first);
    expect(requests).toBe(1);
    expect(store.listTasks().some(task => task.title === 'Rejected by controller')).toBe(false);
  });

  test('expired invocations cannot manage app data, including cancellation during HTTP validation', async () => {
    const { task, run, broker } = setup();
    store.cancel(run.id);
    expect((await call(broker, 'create_task', { data: { title: 'After cancellation', instruction: 'No mutation.' }, idempotency_key: 'late-create' })).isError).toBe(true);
    expect((await call(broker, 'update_general_settings', { data: { defaultSchedule: 'auto' }, idempotency_key: 'late-settings' })).isError).toBe(true);
    expect((await call(broker, 'archive_task', { task_id: task.id, idempotency_key: 'late-archive' })).isError).toBe(true);
    expect(store.getDefaultSchedule()).toBe('manual');
    expect(store.getTask(task.id).archivedAt).toBeNull();
    const nextTask = store.createTask(taskInput());
    const nextRun = store.startManual(nextTask.id, true);
    const raceAccess: TaskAppAccess = {
      async request(method, path, data, invocation) {
        const response = appAccess.request(method, path, data, invocation);
        if (method === 'POST' && path === '/api/tasks') store.cancel(nextRun.id);
        return response;
      },
    };
    const raced = brokerFor(nextRun, raceAccess);
    expect((await call(raced, 'create_task', { data: { title: 'Cancelled while validating', instruction: 'No mutation.', cwd: directory }, idempotency_key: 'racing-create' })).isError).toBe(true);
    expect(store.listTasks().some(item => ['After cancellation', 'Cancelled while validating'].includes(item.title))).toBe(false);
  });

  test.each(['cancel_run', 'restore_backup'])('%s delivers acceptance before a deferred action stops its invocation', async tool => {
    let actions = 0;
    const deferredAccess: TaskAppAccess = {
      async request(method, path, data, invocation) {
        const selfCancel = path === `/api/runs/${invocation.runId}/cancel`;
        const restore = path.startsWith('/api/backups/') && path.endsWith('/select');
        if (method === 'POST' && (selfCancel || restore)) return {
          response: Response.json({ accepted: true, action: selfCancel ? 'cancel' : 'restore' }),
          afterResponse: () => { actions++; store.cancel(invocation.runId); },
        };
        return appAccess.request(method, path, data, invocation);
      },
    };
    const { run, broker } = setup(deferredAccess);
    const backup = tool === 'restore_backup' ? await mutate(broker, 'create_backup', {}) : null;
    const args = {
      ...(backup ? { backup_id: backup.id } : { run_id: run.id, data: {} }),
      idempotency_key: 'deferred-once',
    };
    const result = await call(broker, tool, args);
    expect(parse(result)).toMatchObject({ accepted: true });
    expect(actions).toBe(0);
    expect(store.getRun(run.id).status).toBe('running');
    broker.flushPendingActions({ ...result, content: [...result.content] });
    expect(actions).toBe(0);
    expect(parse(await call(broker, tool, args))).toEqual(parse(result));
    broker.flushPendingActions(result);
    expect(actions).toBe(1);
    expect(store.getRun(run.id).status).toBe('cancelled');
    broker.flushPendingActions(result);
    expect(actions).toBe(1);
    expect((await call(broker, 'get_app_info')).isError).toBe(true);
  });

  test('cancellation between acceptance and delivery discards a deferred action', async () => {
    let actions = 0;
    const deferredAccess: TaskAppAccess = {
      async request() {
        return { response: Response.json({ accepted: true }), afterResponse: () => { actions++; } };
      },
    };
    const { run, broker } = setup(deferredAccess);
    const result = await call(broker, 'cancel_run', { run_id: run.id, data: {}, idempotency_key: 'cancel-before-delivery' });
    expect(parse(result)).toEqual({ accepted: true });
    store.cancel(run.id);
    broker.flushPendingActions(result);
    expect(actions).toBe(0);
    broker.flushPendingActions();
    expect(actions).toBe(0);
  });
});

describe('official SDK management over stdio', () => {
  test.skipIf(process.env.BRIGD_TEST_NO_SOCKETS === '1' && !process.env.CI)('advertises management tools and creates a card through the app controller', async () => {
    const task = store.createTask(taskInput());
    const run = store.startManual(task.id, true);
    const bridge = createTaskBridge(store, run, runFence(run), appAccess);
    brokers.push(bridge);
    const client = new Client({ name: 'brigd-management-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: bridge.agentConfig.command, args: [resolve('server/task-mcp-stdio.ts')], env: bridge.agentConfig.env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual([...TASK_MCP_TOOLS]);
      for (const name of ['create_task', 'update_task', 'archive_task', 'create_worker', 'create_tag', 'update_general_settings', 'create_backup']) {
        const tool = tools.find(tool => tool.name === name);
        expect(tool?.inputSchema.required).toContain('idempotency_key');
        expect(tool?.inputSchema.additionalProperties).toBe(false);
      }
      const args = { data: { title: 'SDK management card', instruction: 'Created through MCP.' }, idempotency_key: 'sdk-create' };
      const created = parse(await client.callTool({ name: 'create_task', arguments: args }) as TaskToolResult);
      expect(parse(await client.callTool({ name: 'create_task', arguments: args }) as TaskToolResult)).toEqual(created);
      expect(store.getTask(created.id)).toMatchObject({ title: 'SDK management card', instruction: 'Created through MCP.' });
      const listed = parse(await client.callTool({ name: 'list_tasks', arguments: { query: 'SDK management card' } }) as TaskToolResult);
      expect(listed.items.map((item: any) => item.id)).toEqual([created.id]);
    } finally { await client.close(); }
  });
});

describe('documentation tools', () => {
  test('agents list, search, read, create, update and trash documentation pages and link them to cards', async () => {
    const { broker } = setup();
    const root = await mutate(broker, 'create_doc_page', { data: { title: 'Guide', markdown: '# Setup\n\nRun **bun install**.' } });
    expect(root).toMatchObject({ title: 'Guide', parentId: null, position: 0 });
    const child = await mutate(broker, 'create_doc_page', { data: { title: 'Child', parentId: root.id, markdown: '- item' } });
    expect(child).toMatchObject({ title: 'Child', parentId: root.id, position: 0 });
    const list = parse(await call(broker, 'list_doc_pages', {}));
    expect(list).toMatchObject({ total: 2, next_offset: null });
    expect(list.items).toEqual([expect.objectContaining({ id: root.id, parentId: null, position: 0, title: 'Guide' }), expect.objectContaining({ id: child.id, parentId: root.id, position: 0, title: 'Child' })]);
    const page = parse(await call(broker, 'get_doc_page', { doc_page_id: root.id }));
    expect(page).toMatchObject({ id: root.id, parentId: null, title: 'Guide', childIds: [child.id], markdown: '# Setup\n\nRun **bun install**.\n' });
    const found = parse(await call(broker, 'search_doc_pages', { query: 'install' }));
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ id: root.id, title: 'Guide', parentId: null });
    expect(found.items[0].snippet).toContain('[install]');
    expect(parse(await call(broker, 'search_doc_pages', { query: 'nothing here' })).items).toEqual([]);
    await mutate(broker, 'update_doc_page', { doc_page_id: root.id, data: { markdown: '## Changed' } });
    expect(store.getDocPage(root.id)).toMatchObject({ version: 2, blocks: [expect.objectContaining({ type: 'heading2', text: 'Changed' })] });
    await mutate(broker, 'update_doc_page', { doc_page_id: root.id, data: { title: 'Guide v2' } });
    expect(store.getDocPage(root.id)).toMatchObject({ title: 'Guide v2', version: 3 });
    expect((await call(broker, 'update_doc_page', { doc_page_id: root.id, data: {}, idempotency_key: 'empty-update' })).isError).toBe(true);
    expect((await call(broker, 'get_doc_page', { doc_page_id: 'missing-page' })).isError).toBe(true);
    expect((await call(broker, 'create_doc_page', { data: { title: 'Deep', parentId: 'missing-page', markdown: 'x' }, idempotency_key: 'missing-parent' })).isError).toBe(true);
    expect(store.listDocPages()).toHaveLength(2);
    await mutate(broker, 'delete_doc_page', { doc_page_id: child.id });
    expect(store.getDocPage(child.id).deletedAt).not.toBeNull();
    expect(parse(await call(broker, 'list_doc_pages', {})).total).toBe(1);
    const card = await createCard(broker, 'Documented card', crypto.randomUUID(), { docPageIds: [root.id] });
    expect(store.getTask(card.id).docPages).toEqual([{ id: root.id, title: 'Guide v2' }]);
    expect((await call(broker, 'create_task', { data: { title: 'Bad link', instruction: 'x', docPageIds: [child.id] }, idempotency_key: 'trashed-doc-link' })).isError).toBe(true);
    const run = store.startManual(card.id, true);
    expect(run.docs).toEqual([{ id: root.id, title: 'Guide v2' }]);
  });
});
