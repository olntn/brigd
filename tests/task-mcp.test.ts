import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, runFence } from '../server/store';
import { prepareAttachment } from '../server/attachments';
import { createTaskBroker, createTaskBridge, type TaskBroker } from '../server/task-mcp';
import { MAX_TASK_READ_BYTES, MAX_TASK_TOOL_CALLS, TASK_MCP_TOOLS, MAX_TASK_RESULT_TOTAL_BYTES, type TaskToolResult } from '../server/task-mcp-protocol';
import type { TaskInput } from '../src/lib/types';

let directory: string, store: Store, brokers: TaskBroker[];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'brigd-mcp-test-')); store = new Store(join(directory, 'app.sqlite')); brokers = []; });
afterEach(() => { for (const broker of brokers) broker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'Attachment task', instruction: 'Inspect task attachments.', provider: 'codex', cwd: directory, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch });
const stage = async (data: Uint8Array, mime = 'text/plain', name = 'input.txt') => store.stageAttachment(await prepareAttachment(data, mime, name));
const parse = (result: TaskToolResult): any => { expect(result.isError).not.toBe(true); const first = result.content[0]; if (!first || first.type !== 'text') throw new Error('No text result'); return JSON.parse(first.text); };
function setup(attachmentIds: string[] = []) { const task = store.createTask(taskInput({ attachmentIds })); const run = store.startManual(task.id, false); const broker = createTaskBroker(store, run, runFence(run)); brokers.push(broker); return { task, run, broker }; }
const call = (broker: TaskBroker, tool: string, args: unknown = {}, requestId = crypto.randomUUID()) => broker.dispatch({ capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId, tool, arguments: args });

describe('authoritative current-task MCP broker', () => {
  test('frozen IDs exclude other tasks and late uploads; bounded text chunks preserve bytes', async () => {
    const a = await stage(Buffer.from('hello world')), other = await stage(Buffer.from('OTHER TASK'));
    store.createTask(taskInput({ attachmentIds: [other.id] }));
    const { task, broker } = setup([a.id]);
    const late = await stage(Buffer.from('LATE'));
    store.comment(task.id, null, 'user', 'Later upload', Date.now(), null, [late.id]);
    expect(parse(await call(broker, 'list_attachments')).attachments.map((x: any) => x.id)).toEqual([a.id]);
    expect(parse(await call(broker, 'read_attachment', { attachment_id: a.id, offset: 1, max_bytes: 4 }))).toMatchObject({ data: 'ello', bytes: 4, next_offset: 5 });
    for (const id of [other.id, late.id, 'unknown']) expect((await call(broker, 'read_attachment', { attachment_id: id })).isError).toBe(true);
    expect((await call(broker, 'read_attachment', { attachment_id: a.id, max_bytes: MAX_TASK_READ_BYTES + 1 })).isError).toBe(true);
    expect((await call(broker, 'read_attachment', { attachment_id: a.id, task_id: task.id })).isError).toBe(true);
  });
  test('invalid or non-ASCII credentials never reveal data or throw', async () => {
    const { broker } = setup();
    for (const capability of [undefined, '', 'f'.repeat(64), 'é'.repeat(64), {}, broker.agentConfig.env.BRIGD_TASK_CAPABILITY + 'a']) {
      const result = await broker.dispatch({ capability, requestId: 'request', tool: 'list_attachments', arguments: {} });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(broker.agentConfig.context.taskId);
    }
    expect(parse(await call(broker, 'list_attachments')).attachments).toEqual([]);
  });
  test('native image content uses validated PNG preview and never exceeds provider line budget', async () => {
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#2299dd' } }).png().toBuffer();
    const a = await stage(bytes, 'image/png', 'diagram.png'); const { broker } = setup([a.id]);
    const result = await call(broker, 'view_attachment', { attachment_id: a.id });
    expect(result.isError).not.toBe(true);
    const image = result.content.find(item => item.type === 'image');
    expect(image?.type).toBe('image');
    if (image?.type !== 'image') throw new Error('No image');
    expect(image.mimeType).toBe('image/png'); expect(Buffer.from(image.data, 'base64').byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(384 * 1024);
    expect((await sharp(Buffer.from(image.data, 'base64')).metadata()).format).toBe('png');
  });
  test('publishes generated bytes and attribution atomically, exact logical retries do not duplicate', async () => {
    const { run, task, broker } = setup();
    writeFileSync(join(broker.agentConfig.context.outputDirectory, 'result.txt'), 'generated artifact');
    const args = { path: 'result.txt', mime: 'text/plain', caption: 'Finished report', idempotency_key: 'report-1' };
    const first = parse(await call(broker, 'add_attachment', args));
    const repeat = parse(await call(broker, 'add_attachment', args));
    expect(first.attachment.id).toBe(repeat.attachment.id);
    const attachment = store.getAttachment(task.id, first.attachment.id);
    expect(attachment).toMatchObject({ source: 'agent', taskId: task.id, runId: run.id, stepIndex: null, attemptId: null });
    expect(Buffer.from(store.readAttachment(task.id, attachment.id).data).toString()).toBe('generated artifact');
    expect(store.detail(task.id).comments.filter(c => c.body === 'Finished report')).toHaveLength(1);
    expect(parse(await call(broker, 'list_attachments')).attachments.map((x: any) => x.id)).toContain(attachment.id);
    const c = { body: 'A separate factual update', idempotency_key: 'comment-1' };
    expect(parse(await call(broker, 'add_comment', c)).comment_id).toBe(parse(await call(broker, 'add_comment', c)).comment_id);
    expect((await call(broker, 'add_comment', { ...c, body: 'Conflicting retry' })).isError).toBe(true);
    expect((await call(broker, 'add_comment', { ...c, idempotency_key: 'report-1' })).isError).toBe(true);
    expect((await call(broker, 'add_comment', { ...c, run_id: 'someone-else' })).isError).toBe(true);
  });
  test('original materialization creates separate app-named copies and removes unchanged copies on revocation', async () => {
    const a = await stage(Buffer.from('original'), 'text/plain', 'USER-TEXT.txt'); const { broker } = setup([a.id]);
    const result = parse(await call(broker, 'read_attachment', { attachment_id: a.id, materialize: true }));
    expect(result.local_path).toContain('/.brigd-inputs-'); expect(result.local_path).not.toContain('USER-TEXT');
    expect(result.local_path).not.toStartWith(broker.agentConfig.context.outputDirectory + '/');
    expect(readFileSync(result.local_path, 'utf8')).toBe('original');
    expect(statSync(result.local_path).mode & 0o777).toBe(0o400);
    broker.close(); expect(existsSync(result.local_path)).toBe(false);
  });
  test('modified original copies are preserved, arbitrary materialization destinations are rejected', async () => {
    const a = await stage(Buffer.from('original')); const { broker } = setup([a.id]);
    const result = parse(await call(broker, 'read_attachment', { attachment_id: a.id, materialize: true }));
    chmodSync(result.local_path, 0o600); writeFileSync(result.local_path, 'worker modification');
    expect((await call(broker, 'read_attachment', { attachment_id: a.id, materialize: true, path: '/tmp/elsewhere' })).isError).toBe(true);
    broker.close(); expect(readFileSync(result.local_path, 'utf8')).toBe('worker modification');
  });
  test('outbox refuses traversal, absolute paths, symlinks, hardlinks, directories and FIFOs', async () => {
    const { broker } = setup(); const root = broker.agentConfig.context.outputDirectory;
    const outside = join(directory, 'outside-secret'); writeFileSync(outside, 'not an attachment');
    symlinkSync(outside, join(root, 'symlink')); linkSync(outside, join(root, 'hardlink')); mkdirSync(join(root, 'subdir'));
    const fifo = Bun.spawnSync(['mkfifo', join(root, 'fifo')]); expect(fifo.exitCode).toBe(0);
    for (const path of ['../outside-secret', outside, 'subdir/../symlink', 'subdir/a', 'symlink', 'hardlink', 'subdir', 'fifo', '.', '..', 'x\\a']) {
      expect((await call(broker, 'add_attachment', { path, mime: 'text/plain', idempotency_key: crypto.randomUUID() })).isError).toBe(true);
    }
    expect(store.detail(broker.agentConfig.context.taskId).attachments).toEqual([]);
  });
  test('swapping the outbox parent to a symlink fails closed and preserves the external directory', async () => {
    const { broker } = setup(); const root = broker.agentConfig.context.outputDirectory;
    writeFileSync(join(root, 'result.txt'), 'original output');
    renameSync(root, root + '-moved'); symlinkSync(directory, root); writeFileSync(join(directory, 'result.txt'), 'external secret');
    expect((await call(broker, 'add_attachment', { path: 'result.txt', mime: 'text/plain', idempotency_key: 'swapped' })).isError).toBe(true);
    broker.close(); expect(readFileSync(join(directory, 'result.txt'), 'utf8')).toBe('external secret');
  });
  test('cancellation, completion, resume and explicit close revoke old capability reads and writes', async () => {
    for (const terminal of ['cancel', 'complete', 'resume', 'close']) {
      const { run, broker } = setup();
      if (terminal === 'cancel') store.cancel(run.id);
      if (terminal === 'complete') store.finish(run.id, 'completed', 'Done', null);
      if (terminal === 'resume') { store.setSession(run.id, 'session-1'); store.finish(run.id, 'waiting_input', 'Need detail', null); store.resume(run.id, 'Answer'); }
      if (terminal === 'close') broker.close();
      expect((await call(broker, 'list_attachments')).isError).toBe(true);
      expect((await call(broker, 'add_comment', { body: 'late', idempotency_key: 'late' })).isError).toBe(true);
      expect(store.detail(run.taskId).comments.some(c => c.body === 'late')).toBe(false);
    }
  });
  test('aggregate request count is bounded and bridge credentials differ per invocation', async () => {
    const { broker } = setup(); const { broker: other } = setup();
    expect(broker.agentConfig.name).not.toBe(other.agentConfig.name); expect(broker.agentConfig.env.BRIGD_TASK_CAPABILITY).not.toBe(other.agentConfig.env.BRIGD_TASK_CAPABILITY);
    for (let i = 0; i < MAX_TASK_TOOL_CALLS; i++) expect((await call(broker, 'list_attachments')).isError).not.toBe(true);
    expect((await call(broker, 'list_attachments')).isError).toBe(true);
    expect((await call(broker, 'add_comment', { body: 'over budget', idempotency_key: 'late' })).isError).toBe(true);
  });
  test('aggregate native image budget is enforced before the CLI output limit', async () => {
    const noise = Buffer.alloc(1024 * 1024 * 3); crypto.getRandomValues(noise.subarray(0, 65536));
    for (let i = 65536; i < noise.length; i += 65536) noise.copy(noise, i, 0, Math.min(65536, noise.length - i));
    const bytes = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
    const a = await stage(bytes, 'image/png', 'noise.png'); const { broker } = setup([a.id]);
    let total = 0, successes = 0, stopped = false;
    for (let i = 0; i <= MAX_TASK_TOOL_CALLS; i++) { const r = await call(broker, 'view_attachment', { attachment_id: a.id }); if (r.isError) { stopped = true; break; } total += Buffer.byteLength(JSON.stringify(r)); successes++; }
    expect(stopped).toBe(true); expect(successes).toBeGreaterThan(0); expect(total).toBeLessThanOrEqual(MAX_TASK_RESULT_TOTAL_BYTES);
  });
});

describe('real official SDK stdio transport', () => {
  test('initializes and exposes exactly the five task tools without database access', async () => {
    const client = new Client({ name: 'brigd-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('server/task-mcp-stdio.ts')], stderr: 'pipe',
      env: { BRIGD_TASK_SOCKET: join(directory, 'absent.sock'), BRIGD_TASK_CAPABILITY: '1'.repeat(64) } });
    let errors = ''; transport.stderr?.on('data', chunk => { errors += chunk.toString(); });
    try {
      await client.connect(transport);
      const tools = await client.listTools(); expect(tools.tools.map(x => x.name)).toEqual([...TASK_MCP_TOOLS]);
      expect(tools.tools.every(x => x.inputSchema.additionalProperties === false)).toBe(true);
      const result = await client.callTool({ name: 'list_attachments', arguments: {} }); expect(result.isError).toBe(true);
      expect(errors).not.toContain('1'.repeat(64)); expect(errors).not.toContain('app.sqlite');
    } finally { await client.close(); }
  });
  test.skipIf(process.env.BRIGD_TEST_NO_SOCKETS === '1' && !process.env.CI)('private UDS roundtrip reads image and publishes artifact (required in CI)', async () => {
    const a = await stage(await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer(), 'image/png', 'image.png');
    const task = store.createTask(taskInput({ attachmentIds: [a.id] })); const run = store.startManual(task.id, false);
    const bridge = createTaskBridge(store, run, runFence(run));
    brokers.push(bridge);
    expect(statSync(bridge.agentConfig.env.BRIGD_TASK_SOCKET).mode & 0o777).toBe(0o600);
    const client = new Client({ name: 'brigd-roundtrip', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: bridge.agentConfig.command, args: bridge.agentConfig.args, env: bridge.agentConfig.env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(5);
      const result = await client.callTool({ name: 'view_attachment', arguments: { attachment_id: a.id } });
      expect(result.isError).not.toBe(true); expect((result.content as any[]).some(x => x.type === 'image')).toBe(true);
      writeFileSync(join(bridge.agentConfig.context.outputDirectory, 'result.txt'), 'SDK publication');
      const publication = await client.callTool({ name: 'add_attachment', arguments: { path: 'result.txt', mime: 'text/plain', idempotency_key: 'sdk-1' } });
      expect(publication.isError).not.toBe(true); expect(store.detail(task.id).attachments?.some(x => x.name === 'result.txt')).toBe(true);
      bridge.close(); expect(existsSync(bridge.agentConfig.env.BRIGD_TASK_SOCKET)).toBe(false);
      expect((await client.callTool({ name: 'list_attachments', arguments: {} })).isError).toBe(true);
    } finally { await client.close(); }
  });
});
