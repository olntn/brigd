import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { prepareAttachment } from '../server/attachments';
import { Store, runFence } from '../server/store';
import { createTaskBridge, createTaskBroker, type TaskBroker } from '../server/task-mcp';
import { MAX_TASK_RESULT_BYTES, TASK_MCP_TOOLS, type TaskToolResult } from '../server/task-mcp-protocol';
import type { Attachment, Comment, Run, TaskInput } from '../src/lib/types';

let directory: string, store: Store, brokers: TaskBroker[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'brigd-mcp-reading-test-'));
  store = new Store(join(directory, 'app.sqlite'));
  brokers = [];
});
afterEach(() => {
  for (const broker of brokers) broker.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Read task discussion', instruction: 'Read comments and their files.', provider: 'codex', cwd: directory,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const stage = async (data: Uint8Array, mime = 'text/plain', name = 'note.txt') =>
  store.stageAttachment(await prepareAttachment(data, mime, name));
const brokerFor = (run: Run) => {
  const broker = createTaskBroker(store, run, runFence(run));
  brokers.push(broker);
  return broker;
};
const call = (broker: TaskBroker, tool = 'list_comments', args: unknown = {}) => broker.dispatch({
  capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: crypto.randomUUID(), tool, arguments: args,
});
const parse = (result: TaskToolResult): any => {
  expect(result.isError).not.toBe(true);
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('No text result');
  return JSON.parse(first.text);
};
const attachmentContext = (attachment: Attachment, available = true) => ({
  id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size,
  previewable: attachment.previewable, available,
});
const commentContext = (comment: Comment) => ({
  id: comment.id, taskId: comment.taskId, runId: comment.runId, stepIndex: comment.stepIndex,
  kind: comment.kind, body: comment.body, createdAt: comment.createdAt,
  attachments: (comment.attachments ?? []).map(attachment => attachmentContext(attachment)),
});

describe('current-task MCP comment reading', () => {
  test('reads every comment kind across previous and current runs in insertion order, scoped to its task', async () => {
    const task = store.createTask(taskInput());
    const initial = store.comment(task.id, null, 'user', 'Original request', 300);
    const oldRun = store.startManual(task.id, false, 200);
    const oldStart = store.detail(task.id).comments.at(-1)!;
    const answer = store.comment(task.id, oldRun.id, 'agent', 'Prior attempt', 100, 0);
    const question = store.comment(task.id, oldRun.id, 'question', 'Which version?', 100, 1);
    const result = store.comment(task.id, oldRun.id, 'result', 'Prior findings', 50, 1);
    store.finish(oldRun.id, 'failed', null, 'Retry requested', 400);
    const note = store.comment(task.id, null, 'system', 'Task-level history', 20);
    const other = store.createTask(taskInput({ title: 'Unrelated task' }));
    store.comment(other.id, null, 'user', 'Private other-task discussion', 10);
    const run = store.startManual(task.id, false, 500);
    const currentStart = store.detail(task.id).comments.at(-1)!;
    const followup = store.comment(task.id, run.id, 'user', 'Current clarification', 5);
    const broker = brokerFor(run);

    const page = parse(await call(broker));
    expect(page.comments).toEqual([initial, oldStart, answer, question, result, note, currentStart, followup].map(commentContext));
    expect(page.next_offset).toBeNull();
    expect(JSON.stringify(page)).not.toContain('Private other-task discussion');
    expect(page.comments.map((comment: any) => comment.kind)).toEqual(['user', 'system', 'agent', 'question', 'result', 'system', 'system', 'user']);
  });

  test('paginates a fixed history boundary and validates offsets, limits, and task selectors', async () => {
    const task = store.createTask(taskInput());
    for (let index = 0; index < 25; index++) store.comment(task.id, null, 'user', `Comment ${index}`, 100 - index);
    const run = store.startManual(task.id, false);
    const expected = store.detail(task.id).comments.map(commentContext);
    const broker = brokerFor(run);
    store.comment(task.id, null, 'user', 'Late comment with older timestamp', 1);

    const first = parse(await call(broker));
    expect(first.comments).toEqual(expected.slice(0, 20));
    expect(first.next_offset).toBe(20);
    const second = parse(await call(broker, 'list_comments', { offset: first.next_offset, limit: 4 }));
    expect(second.comments).toEqual(expected.slice(20, 24));
    expect(second.next_offset).toBe(24);
    const last = parse(await call(broker, 'list_comments', { offset: second.next_offset }));
    expect(last.comments).toEqual(expected.slice(24));
    expect(last.next_offset).toBeNull();
    expect(parse(await call(broker, 'list_comments', { offset: expected.length }))).toEqual({ comments: [], next_offset: null });
    expect(parse(await call(broker, 'list_comments', { offset: expected.length + 1 }))).toEqual({ comments: [], next_offset: null });

    for (const args of [
      { offset: -1 }, { offset: 0.5 }, { offset: '0' }, { offset: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '1' },
      { task_id: 'bad-task-id' }, { run_id: run.id }, { offset: null }, [], null,
    ]) expect((await call(broker, 'list_comments', args)).isError).toBe(true);
    expect(parse(await call(broker, 'list_comments', { offset: 1, limit: 1 })).comments).toEqual(expected.slice(1, 2));
  });

  test('historical comment attachments can be listed, read, materialized, and viewed through the existing tools', async () => {
    const text = await stage(Buffer.from('Historical file contents'), 'text/plain', 'prior-report.txt');
    const image = await stage(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#22aa44' } }).png().toBuffer(), 'image/png', 'prior-image.png');
    const task = store.createTask(taskInput());
    const user = store.comment(task.id, null, 'user', 'Reference report', Date.now(), null, [text.id]);
    const previous = store.startManual(task.id, false);
    const agent = store.comment(task.id, previous.id, 'agent', 'Reference diagram', Date.now(), null, [image.id]);
    store.finish(previous.id, 'failed', null, 'New attempt');
    const run = store.startManual(task.id, false);
    const broker = brokerFor(run);

    const comments = parse(await call(broker)).comments;
    expect(comments.find((comment: any) => comment.id === user.id).attachments).toEqual([attachmentContext(text)]);
    expect(comments.find((comment: any) => comment.id === agent.id).attachments).toEqual([attachmentContext(image)]);
    expect(parse(await call(broker, 'list_attachments')).attachments.map((attachment: any) => attachment.id).sort()).toEqual([text.id, image.id].sort());
    expect(parse(await call(broker, 'read_attachment', { attachment_id: text.id }))).toMatchObject({ data: 'Historical file contents', encoding: 'utf-8' });
    const materialized = parse(await call(broker, 'read_attachment', { attachment_id: text.id, materialize: true }));
    expect(readFileSync(materialized.local_path, 'utf8')).toBe('Historical file contents');
    const preview = await call(broker, 'view_attachment', { attachment_id: image.id });
    expect(preview.isError).not.toBe(true);
    const content = preview.content.find(item => item.type === 'image');
    expect(content?.type).toBe('image');
    if (content?.type !== 'image') throw new Error('No image preview');
    expect(content.mimeType).toBe('image/png');
    expect((await sharp(Buffer.from(content.data, 'base64')).metadata()).format).toBe('png');
  });

  test('late or unrelated files remain inaccessible even when their metadata appears before the comment boundary', async () => {
    const task = store.createTask(taskInput());
    const run = store.startManual(task.id, false);
    const late = await stage(Buffer.from('Uploaded after run started'), 'text/plain', 'late.txt');
    const visibleComment = store.comment(task.id, null, 'user', 'Arrived during preparation', Date.now(), null, [late.id]);
    const otherFile = await stage(Buffer.from('Unrelated secret'), 'text/plain', 'private.txt');
    const other = store.createTask(taskInput());
    store.comment(other.id, null, 'user', 'Other task file', Date.now(), null, [otherFile.id]);
    const broker = brokerFor(run);
    const later = await stage(Buffer.from('After broker snapshot'));
    store.comment(task.id, null, 'user', 'After broker snapshot', 1, null, [later.id]);

    const page = parse(await call(broker));
    expect(page.comments.find((comment: any) => comment.id === visibleComment.id).attachments).toEqual([attachmentContext(late, false)]);
    expect(page.comments.some((comment: any) => comment.body === 'After broker snapshot')).toBe(false);
    expect(parse(await call(broker, 'list_attachments')).attachments).toEqual([]);
    for (const attachment_id of [late.id, later.id, otherFile.id]) {
      expect((await call(broker, 'read_attachment', { attachment_id })).isError).toBe(true);
      expect((await call(broker, 'view_attachment', { attachment_id })).isError).toBe(true);
    }
    const published = parse(await call(broker, 'add_comment', { body: 'Invocation publication', idempotency_key: 'visible-later' }));
    expect(store.detail(task.id).comments.some(comment => comment.id === published.comment_id)).toBe(true);
    expect(parse(await call(broker)).comments.some((comment: any) => comment.id === published.comment_id)).toBe(false);
  });

  test('reduces a large requested page to fit the result limit without dropping comments', async () => {
    const file = await stage(Buffer.from('Readable after comment paging'));
    const task = store.createTask(taskInput({ attachmentIds: [file.id] }));
    const mixed = '# Отчёт\n\n- Проверка **результата**: \\\\сервер\\путь\n'.repeat(500);
    for (let index = 0; index < 20; index++) store.comment(task.id, null, 'user', `${index}:\n${mixed}`.slice(0, 16000));
    const run = store.startManual(task.id, false);
    const expected = store.detail(task.id).comments;
    const broker = brokerFor(run);
    const received: any[] = [];
    let offset = 0;
    let pages = 0;
    do {
      const result = await call(broker, 'list_comments', { offset, limit: 20 });
      expect(Buffer.byteLength(JSON.stringify(result)) + 1).toBeLessThanOrEqual(MAX_TASK_RESULT_BYTES);
      const page = parse(result);
      expect(page.comments.length).toBeGreaterThan(0);
      received.push(...page.comments);
      pages++;
      if (page.next_offset === null) break;
      expect(page.next_offset).toBe(offset + page.comments.length);
      offset = page.next_offset;
    } while (pages < 4);
    expect(pages).toBeGreaterThan(1);
    expect(received.map(comment => comment.id)).toEqual(expected.map(comment => comment.id));
    expect(received.map(comment => comment.body)).toEqual(expected.map(comment => comment.body));
    expect(parse(await call(broker, 'read_attachment', { attachment_id: file.id })).data).toBe('Readable after comment paging');
  });

  test('reserves enough bytes for a terminal null cursor at the exact response boundary', async () => {
    const file = await stage(Buffer.from('Broker remains available'));
    const task = store.createTask(taskInput({ attachmentIds: [file.id] }));
    for (let index = 0; index < 3; index++) store.comment(task.id, null, 'user', '\u0001'.repeat(16000), 1000);
    const run = store.startManual(task.id, false, 1000);
    const initial = store.detail(task.id).comments.map(commentContext);
    const placeholder = {
      id: '0'.repeat(36), taskId: task.id, runId: null, stepIndex: null, kind: 'user', body: '', createdAt: 1000, attachments: [],
    };
    const wireBytes = (comments: unknown[], next_offset: number | null) =>
      Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ comments, next_offset }) }] })) + 1;
    const remaining = MAX_TASK_RESULT_BYTES - wireBytes([...initial, placeholder], 5);
    // Each control character becomes seven wire bytes after both JSON encodings.
    const body = '\u0001'.repeat(Math.floor(remaining / 7)) + 'a'.repeat(remaining % 7);
    expect(body.length).toBeLessThanOrEqual(16000);
    store.comment(task.id, null, 'user', body, 1000);
    const expected = store.detail(task.id).comments.map(commentContext);
    expect(wireBytes(expected, 5)).toBe(MAX_TASK_RESULT_BYTES);
    expect(wireBytes(expected, null)).toBe(MAX_TASK_RESULT_BYTES + 3);
    const broker = brokerFor(run);

    const first = await call(broker);
    const page = parse(first);
    expect(page.comments).toEqual(expected.slice(0, 4));
    expect(page.next_offset).toBe(4);
    expect(Buffer.byteLength(JSON.stringify(first)) + 1).toBeLessThanOrEqual(MAX_TASK_RESULT_BYTES);
    const last = parse(await call(broker, 'list_comments', { offset: page.next_offset }));
    expect(last).toEqual({ comments: expected.slice(4), next_offset: null });
    expect(parse(await call(broker, 'read_attachment', { attachment_id: file.id })).data).toBe('Broker remains available');
  });

  test('forged, cancelled, completed, resumed, and closed capabilities cannot read discussion history', async () => {
    for (const terminal of ['cancel', 'complete', 'resume', 'close']) {
      const task = store.createTask(taskInput());
      store.comment(task.id, null, 'user', 'Protected discussion');
      const run = store.startManual(task.id, false);
      const broker = brokerFor(run);
      const forged = await broker.dispatch({ capability: 'f'.repeat(64), requestId: 'forged', tool: 'list_comments', arguments: {} });
      expect(forged.isError).toBe(true);
      expect(JSON.stringify(forged)).not.toContain('Protected discussion');
      expect(parse(await call(broker)).comments.some((comment: any) => comment.body === 'Protected discussion')).toBe(true);
      if (terminal === 'cancel') store.cancel(run.id);
      if (terminal === 'complete') store.finish(run.id, 'completed', 'Done', null);
      if (terminal === 'resume') {
        store.setSession(run.id, 'session-1');
        store.finish(run.id, 'waiting_input', 'Need detail', null);
        store.resume(run.id, 'Answer');
      }
      if (terminal === 'close') broker.close();
      const result = await call(broker);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('Protected discussion');
    }
  });
});

describe('official SDK comment reading over stdio', () => {
  test.skipIf(process.env.BRIGD_TEST_NO_SOCKETS === '1' && !process.env.CI)('advertises the read-only tool and reads historical comments and their files', async () => {
    const file = await stage(Buffer.from('SDK historical content'), 'text/plain', 'sdk-history.txt');
    const image = await stage(await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer(), 'image/png', 'sdk-history.png');
    const task = store.createTask(taskInput());
    const historical = store.comment(task.id, null, 'user', 'SDK historical comment', Date.now(), null, [file.id, image.id]);
    const run = store.startManual(task.id, false);
    const bridge = createTaskBridge(store, run, runFence(run));
    brokers.push(bridge);
    const client = new Client({ name: 'brigd-comment-reading-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: bridge.agentConfig.command, args: [resolve('server/task-mcp-stdio.ts')], env: bridge.agentConfig.env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual([...TASK_MCP_TOOLS]);
      const tool = tools.find(tool => tool.name === 'list_comments');
      expect(tool).toMatchObject({
        inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
        annotations: { readOnlyHint: true },
      });
      const comments = parse(await client.callTool({ name: 'list_comments', arguments: {} }) as TaskToolResult).comments;
      expect(comments[0]).toEqual(commentContext(historical));
      const read = parse(await client.callTool({ name: 'read_attachment', arguments: { attachment_id: file.id } }) as TaskToolResult);
      expect(read.data).toBe('SDK historical content');
      const viewed = await client.callTool({ name: 'view_attachment', arguments: { attachment_id: image.id } });
      expect(viewed.isError).not.toBe(true);
      expect((viewed.content as any[]).some(content => content.type === 'image')).toBe(true);
      bridge.close();
      expect((await client.callTool({ name: 'list_comments', arguments: {} })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
