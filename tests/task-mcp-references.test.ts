import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { prepareAttachment } from '../server/attachments';
import { Store, runFence } from '../server/store';
import { createTaskBridge, createTaskBroker, type TaskBroker } from '../server/task-mcp';
import { TASK_MCP_TOOLS, type TaskToolResult } from '../server/task-mcp-protocol';
import type { Attachment, Run, TaskInput } from '../src/lib/types';

let directory: string, store: Store, brokers: TaskBroker[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brigd-mcp-references-test-'));
  store = new Store(join(directory, 'app.sqlite'));
  brokers = [];
});
afterEach(() => {
  for (const broker of brokers) broker.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Reference reader', instruction: 'Read the referenced tasks.', provider: 'codex', cwd: directory,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const stage = async (data: Uint8Array, mime = 'text/plain', name = 'reference.txt') =>
  store.stageAttachment(await prepareAttachment(data, mime, name));
const image = async (name = 'reference.png') => stage(
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2255cc' } }).png().toBuffer(), 'image/png', name,
);
const brokerFor = (run: Run) => {
  const broker = createTaskBroker(store, run, runFence(run));
  brokers.push(broker);
  return broker;
};
const setup = (patch: Partial<TaskInput> = {}) => {
  const task = store.createTask(taskInput(patch));
  const run = store.startManual(task.id, false);
  return { task, run, broker: brokerFor(run) };
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
const context = (attachment: Attachment) => ({
  id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size, previewable: attachment.previewable,
});
const short = (id: string) => id.slice(0, 8).toUpperCase();

describe('MCP referenced task reads', () => {
  test('follows nested references by full and uppercase short IDs and reads task and comment files', async () => {
    const original = store.createTask(taskInput({ title: 'Original investigation', instruction: 'Original source details.' }));
    const prior = store.createTask(taskInput());
    const deepestId = 'd91b14ac-1111-4111-8111-111111111111';
    const referencedId = 'cbd78596-2222-4222-8222-222222222222';
    const fixture = new Database(join(directory, 'app.sqlite'));
    try {
      fixture.query('UPDATE tasks SET id=? WHERE id=?').run(deepestId, original.id);
      fixture.query('UPDATE tasks SET id=? WHERE id=?').run(referencedId, prior.id);
    } finally { fixture.close(); }
    const deepest = store.getTask(deepestId);
    const file = await stage(Buffer.from('Referenced report contents'), 'text/plain', 'report.txt');
    const picture = await image();
    const referenced = store.updateTask(referencedId, taskInput({
      title: 'Earlier investigation', instruction: `Continue from task ${short(deepest.id)}.`, attachmentIds: [file.id],
    }));
    const note = store.comment(referenced.id, null, 'user', 'Diagram from earlier discussion', Date.now(), null, [picture.id]);
    const { task, broker } = setup({ instruction: `Read task ${short(referenced.id)} first.` });

    const current = parse(await call(broker, 'get_task'));
    expect(current.task).toMatchObject({ id: task.id, instruction: `Read task ${short(referenced.id)} first.`, archived: false });
    const reference = parse(await call(broker, 'get_task', { task_id: short(referenced.id) }));
    expect(reference.task).toMatchObject({ id: referenced.id, title: referenced.title, instruction: referenced.instruction, archived: false });
    expect(reference.attachment_count).toBe(2);
    expect(reference.attachments.map((attachment: any) => attachment.id).sort()).toEqual([file.id, picture.id].sort());
    expect(reference.next_offset).toBeNull();
    const originalSource = parse(await call(broker, 'get_task', { task_id: deepest.id }));
    expect(originalSource.task).toMatchObject({ id: deepest.id, title: 'Original investigation', instruction: 'Original source details.' });
    expect(parse(await call(broker, 'get_task', { task_id: deepest.id.slice(0, 6).toUpperCase() })).task.id).toBe(deepest.id);
    const comments = parse(await call(broker, 'list_comments', { task_id: referenced.id }));
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0]).toMatchObject({ id: note.id, taskId: referenced.id, body: note.body, attachments: [{ ...context(picture), available: true }] });
    const read = parse(await call(broker, 'read_attachment', { task_id: short(referenced.id), attachment_id: file.id, offset: 11, max_bytes: 6 }));
    expect(read).toMatchObject({ data: 'report', offset: 11, bytes: 6, encoding: 'utf-8', next_offset: 17 });
    const materialized = parse(await call(broker, 'read_attachment', { task_id: referenced.id, attachment_id: file.id, materialize: true }));
    expect(readFileSync(materialized.local_path, 'utf8')).toBe('Referenced report contents');
    const viewed = await call(broker, 'view_attachment', { task_id: referenced.id, attachment_id: picture.id });
    expect(viewed.isError).not.toBe(true);
    const preview = viewed.content.find(content => content.type === 'image');
    if (preview?.type !== 'image') throw new Error('No native reference image');
    expect(preview.mimeType).toBe('image/png');
    expect((await sharp(Buffer.from(preview.data, 'base64')).metadata()).format).toBe('png');
  });

  test('explicit current-task selectors preserve frozen invocation inputs and comment boundary', async () => {
    const file = await stage(Buffer.from('Current input'));
    const picture = await image('current.png');
    const task = store.createTask(taskInput({ attachmentIds: [file.id, picture.id] }));
    const run = store.startManual(task.id, false);
    const late = await image('late-current.png');
    const note = store.comment(task.id, null, 'user', 'Late current upload', Date.now(), null, [late.id]);
    const broker = brokerFor(run);
    store.comment(task.id, null, 'user', 'After current history boundary');
    const defaultTask = parse(await call(broker, 'get_task'));
    const defaultComments = parse(await call(broker, 'list_comments'));
    const defaultAttachments = parse(await call(broker, 'list_attachments'));
    expect(defaultTask.attachment_count).toBe(2);
    expect(defaultTask.attachments.map((attachment: any) => attachment.id).sort()).toEqual([file.id, picture.id].sort());
    expect(defaultComments.comments.find((comment: any) => comment.id === note.id).attachments).toEqual([{ ...context(late), available: false }]);

    for (const task_id of [task.id, short(task.id)]) {
      expect(parse(await call(broker, 'get_task', { task_id }))).toEqual(defaultTask);
      expect(parse(await call(broker, 'list_comments', { task_id }))).toEqual(defaultComments);
      expect(parse(await call(broker, 'list_attachments', { task_id }))).toEqual(defaultAttachments);
      expect(parse(await call(broker, 'read_attachment', { task_id, attachment_id: file.id })).data).toBe('Current input');
      expect((await call(broker, 'view_attachment', { task_id, attachment_id: picture.id })).isError).not.toBe(true);
      expect((await call(broker, 'read_attachment', { task_id, attachment_id: late.id })).isError).toBe(true);
      expect((await call(broker, 'view_attachment', { task_id, attachment_id: late.id })).isError).toBe(true);
    }
    expect(defaultComments.comments.some((comment: any) => comment.body === 'After current history boundary')).toBe(false);
  });

  test('captures external history lazily and shares its stable snapshot across aliases and tools', async () => {
    const first = await stage(Buffer.from('Existing reference'));
    const reference = store.createTask(taskInput({ attachmentIds: [first.id] }));
    store.comment(reference.id, null, 'user', 'Initial external note');
    const { broker } = setup();
    const beforeRead = await stage(Buffer.from('Arrived before external discovery'));
    const visible = store.comment(reference.id, null, 'user', 'Before first external read', Date.now(), null, [beforeRead.id]);
    const initial = parse(await call(broker, 'list_comments', { task_id: short(reference.id) }));
    expect(initial.comments.map((comment: any) => comment.body)).toEqual(['Initial external note', 'Before first external read']);
    expect(initial.comments.find((comment: any) => comment.id === visible.id).attachments[0].available).toBe(true);

    const late = await stage(Buffer.from('Arrived after external discovery'));
    store.comment(reference.id, null, 'user', 'After external snapshot', 1, null, [late.id]);
    const descriptor = parse(await call(broker, 'get_task', { task_id: reference.id }));
    expect(descriptor.attachment_count).toBe(2);
    expect(descriptor.attachments.map((attachment: any) => attachment.id).sort()).toEqual([first.id, beforeRead.id].sort());
    expect(parse(await call(broker, 'list_comments', { task_id: reference.id }))).toEqual(initial);
    expect(parse(await call(broker, 'list_attachments', { task_id: short(reference.id) })).attachments.map((attachment: any) => attachment.id).sort()).toEqual([first.id, beforeRead.id].sort());
    expect(parse(await call(broker, 'read_attachment', { task_id: reference.id, attachment_id: beforeRead.id })).data).toBe('Arrived before external discovery');
    expect((await call(broker, 'read_attachment', { task_id: short(reference.id), attachment_id: late.id })).isError).toBe(true);
    expect((await call(broker, 'view_attachment', { task_id: reference.id, attachment_id: late.id })).isError).toBe(true);
  });

  test('get_task bounds attachment metadata and pagination exposes remaining reference files', async () => {
    const reference = store.createTask(taskInput());
    for (let index = 0; index < 22; index++) {
      const file = await stage(Buffer.from(`Reference ${index}`), 'text/plain', `reference-${index}.txt`);
      store.comment(reference.id, null, 'user', `File ${index}`, Date.now(), null, [file.id]);
    }
    const expected = store.listTaskAttachments(reference.id).map(context);
    const { broker } = setup();
    const descriptor = parse(await call(broker, 'get_task', { task_id: reference.id }));
    expect(descriptor).toMatchObject({ attachments: expected.slice(0, 20), attachment_count: 22, next_offset: 20 });
    const second = parse(await call(broker, 'list_attachments', { task_id: short(reference.id), offset: descriptor.next_offset, limit: 1 }));
    expect(second).toEqual({ attachments: expected.slice(20, 21), next_offset: 21 });
    const last = parse(await call(broker, 'list_attachments', { task_id: reference.id, offset: second.next_offset }));
    expect(last).toEqual({ attachments: expected.slice(21), next_offset: null });
    const comments = parse(await call(broker, 'list_comments', { task_id: reference.id, offset: 20 }));
    expect(comments.comments.map((comment: any) => comment.body)).toEqual(['File 20', 'File 21']);
    expect(comments.next_offset).toBeNull();
  });

  test('can inspect archived references and rejects malformed, missing, or ambiguous IDs', async () => {
    const archived = store.createTask(taskInput({ title: 'Archived source' }));
    store.comment(archived.id, null, 'user', 'Archived source note');
    store.archiveTask(archived.id);
    const first = store.createTask(taskInput({ title: 'Ambiguous one' }));
    const second = store.createTask(taskInput({ title: 'Ambiguous two' }));
    const firstId = 'abc12345-1111-4111-8111-111111111111';
    const secondId = 'abc12345-2222-4222-8222-222222222222';
    const fixture = new Database(join(directory, 'app.sqlite'));
    try {
      fixture.query('UPDATE tasks SET id=? WHERE id=?').run(firstId, first.id);
      fixture.query('UPDATE tasks SET id=? WHERE id=?').run(secondId, second.id);
    } finally { fixture.close(); }
    const { broker } = setup();
    expect(parse(await call(broker, 'get_task', { task_id: short(archived.id) })).task).toMatchObject({ id: archived.id, title: archived.title, archived: true });
    expect(parse(await call(broker, 'list_comments', { task_id: archived.id })).comments[0].body).toBe('Archived source note');
    for (const task_id of ['', 'abcd', 'abc123456', '../abc12345', 'not-a-task', null, 12, crypto.randomUUID(), 'ABC12345']) {
      const result = await call(broker, 'get_task', { task_id });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('Ambiguous one');
      expect(JSON.stringify(result)).not.toContain('Ambiguous two');
    }
    expect(parse(await call(broker, 'get_task', { task_id: firstId })).task.id).toBe(firstId);
    expect(parse(await call(broker, 'get_task', { task_id: secondId })).task.id).toBe(secondId);
    expect((await call(broker, 'get_task', { run_id: archived.id })).isError).toBe(true);
  });

  test('external reads never grant current-task publication rights or arbitrary attachment access', async () => {
    const file = await stage(Buffer.from('Read-only referenced input'));
    const orphan = await stage(Buffer.from('Unlinked task-owned file'));
    const referenced = store.createTask(taskInput({ attachmentIds: [file.id, orphan.id] }));
    store.updateTask(referenced.id, taskInput({ attachmentIds: [file.id] }));
    const otherFile = await stage(Buffer.from('Different task input'));
    store.createTask(taskInput({ attachmentIds: [otherFile.id] }));
    const staged = await stage(Buffer.from('Unbound upload'));
    const { task, broker } = setup();
    parse(await call(broker, 'get_task', { task_id: referenced.id }));
    expect(parse(await call(broker, 'read_attachment', { task_id: referenced.id, attachment_id: file.id })).data).toBe('Read-only referenced input');
    for (const attachment_id of [otherFile.id, staged.id, orphan.id, 'unknown']) {
      expect((await call(broker, 'read_attachment', { task_id: referenced.id, attachment_id })).isError).toBe(true);
      expect((await call(broker, 'view_attachment', { task_id: referenced.id, attachment_id })).isError).toBe(true);
    }
    expect((await call(broker, 'read_attachment', { attachment_id: file.id })).isError).toBe(true);
    expect((await call(broker, 'read_attachment', { task_id: task.id, attachment_id: file.id })).isError).toBe(true);
    expect((await call(broker, 'add_comment', { body: 'Copy external file', attachment_ids: [file.id], idempotency_key: 'foreign-file' })).isError).toBe(true);
    expect((await call(broker, 'add_comment', { task_id: referenced.id, body: 'Foreign write', idempotency_key: 'foreign-comment' })).isError).toBe(true);
    writeFileSync(join(broker.agentConfig.context.outputDirectory, 'result.txt'), 'New output');
    expect((await call(broker, 'add_attachment', { task_id: referenced.id, path: 'result.txt', mime: 'text/plain', idempotency_key: 'foreign-upload' })).isError).toBe(true);
    expect(store.detail(referenced.id).comments).toEqual([]);
    expect(store.listTaskAttachments(referenced.id).map(attachment => attachment.id)).toEqual([file.id]);
    expect(store.detail(task.id).comments.some(comment => ['Copy external file', 'Foreign write'].includes(comment.body))).toBe(false);
    const publication = parse(await call(broker, 'add_comment', { body: 'Current task answer', idempotency_key: 'current-answer' }));
    expect(store.detail(task.id).comments.find(comment => comment.id === publication.comment_id)?.body).toBe('Current task answer');
    const ownFile = parse(await call(broker, 'add_attachment', { path: 'result.txt', mime: 'text/plain', idempotency_key: 'current-upload' }));
    expect(parse(await call(broker, 'get_task', { task_id: short(task.id) })).attachments.map((attachment: any) => attachment.id)).toContain(ownFile.attachment.id);
    expect(parse(await call(broker, 'read_attachment', { task_id: task.id, attachment_id: ownFile.attachment.id })).data).toBe('New output');
  });

  test('revocation prevents all cross-task reads, including an already discovered reference', async () => {
    const file = await image();
    const referenced = store.createTask(taskInput({ title: 'Protected external title', attachmentIds: [file.id] }));
    store.comment(referenced.id, null, 'user', 'Protected external discussion');
    for (const terminal of ['cancel', 'complete', 'resume', 'close']) {
      const { run, broker } = setup();
      expect(parse(await call(broker, 'get_task', { task_id: referenced.id })).task.id).toBe(referenced.id);
      if (terminal === 'cancel') store.cancel(run.id);
      if (terminal === 'complete') store.finish(run.id, 'completed', 'Done', null);
      if (terminal === 'resume') {
        store.setSession(run.id, 'session-1');
        store.finish(run.id, 'waiting_input', 'Need detail', null);
        store.resume(run.id, 'Answer');
      }
      if (terminal === 'close') broker.close();
      for (const tool of ['get_task', 'list_comments', 'list_attachments', 'read_attachment', 'view_attachment']) {
        const args = { task_id: referenced.id, ...(['read_attachment', 'view_attachment'].includes(tool) ? { attachment_id: file.id } : {}) };
        const result = await call(broker, tool, args);
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain('Protected external');
      }
    }
  });
});

describe('official SDK referenced task reads', () => {
  test.skipIf(process.env.BRIGD_TEST_NO_SOCKETS === '1' && !process.env.CI)('discovers the selector schemas and reads another task over source stdio', async () => {
    const file = await stage(Buffer.from('SDK referenced content'));
    const picture = await image();
    const referenced = store.createTask(taskInput({ title: 'SDK referenced task', attachmentIds: [file.id] }));
    store.comment(referenced.id, null, 'user', 'SDK referenced comment', Date.now(), null, [picture.id]);
    const task = store.createTask(taskInput({ instruction: `Read ${short(referenced.id)}.` }));
    const run = store.startManual(task.id, false);
    const bridge = createTaskBridge(store, run, runFence(run));
    brokers.push(bridge);
    const client = new Client({ name: 'brigd-reference-reading-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: bridge.agentConfig.command, args: [resolve('server/task-mcp-stdio.ts')], env: bridge.agentConfig.env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual([...TASK_MCP_TOOLS]);
      for (const name of ['get_task', 'list_comments', 'list_attachments', 'read_attachment', 'view_attachment']) {
        const tool = tools.find(tool => tool.name === name);
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.inputSchema.properties?.task_id).toBeDefined();
        expect(tool?.inputSchema.additionalProperties).toBe(false);
      }
      for (const name of ['add_comment', 'add_attachment']) expect(tools.find(tool => tool.name === name)?.inputSchema.properties?.task_id).toBeUndefined();
      const descriptor = parse(await client.callTool({ name: 'get_task', arguments: { task_id: short(referenced.id) } }) as TaskToolResult);
      expect(descriptor.task).toMatchObject({ id: referenced.id, title: referenced.title });
      const comments = parse(await client.callTool({ name: 'list_comments', arguments: { task_id: referenced.id } }) as TaskToolResult);
      expect(comments.comments[0]).toMatchObject({ body: 'SDK referenced comment', attachments: [{ ...context(picture), available: true }] });
      const attachments = parse(await client.callTool({ name: 'list_attachments', arguments: { task_id: short(referenced.id) } }) as TaskToolResult);
      expect(attachments.attachments.map((attachment: any) => attachment.id).sort()).toEqual([file.id, picture.id].sort());
      const read = parse(await client.callTool({ name: 'read_attachment', arguments: { task_id: referenced.id, attachment_id: file.id } }) as TaskToolResult);
      expect(read.data).toBe('SDK referenced content');
      const viewed = await client.callTool({ name: 'view_attachment', arguments: { task_id: short(referenced.id), attachment_id: picture.id } });
      expect(viewed.isError).not.toBe(true);
      expect((viewed.content as any[]).some(content => content.type === 'image')).toBe(true);
      bridge.close();
      expect((await client.callTool({ name: 'get_task', arguments: { task_id: referenced.id } })).isError).toBe(true);
    } finally { await client.close(); }
  });
});
