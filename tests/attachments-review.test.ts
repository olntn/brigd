import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { MAX_TASK_RESULT_TOTAL_BYTES } from '../server/task-mcp-protocol';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store, runFence } from '../server/store';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { prepareAttachment } from '../server/attachments';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';
import { TaskOutputDirectory, createTaskBroker, type TaskBroker } from '../server/task-mcp';
import type { Attachment, TaskInput } from '../src/lib/types';

const ORIGIN = 'http://127.0.0.1:4310';
let folder: string, store: Store, handler: ReturnType<typeof createHandler>;
let brokers: TaskBroker[];
const input = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'Attachment boundary review', instruction: 'Inspect attached task files.', provider: 'codex', cwd: folder, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch });
const request = (path: string, method = 'GET', value?: unknown) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
}));
async function upload(data: Uint8Array | string, name: string, mime = 'application/octet-stream'): Promise<Attachment> {
  const response = await handler(new Request(`${ORIGIN}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': mime }, body: data as BodyInit }));
  expect(response.status).toBe(201);
  return response.json();
}
async function staged(name = 'input.txt', content = 'input') { return store.stageAttachment(await prepareAttachment(Buffer.from(content), 'text/plain', name)); }
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-attachment-review-'));
  store = new Store(join(folder, 'data.sqlite'));
  handler = createHandler(new Engine(store, true), { port: 4310, root: folder });
  brokers = [];
});
afterEach(() => { for (const broker of brokers) broker.close(); store.close(); rmSync(folder, { recursive: true, force: true }); });

describe('independent in-process binary HTTP boundary review', () => {
  test('binary originals round-trip exactly while metadata JSON contains no BLOBs', async () => {
    const bytes = Buffer.from([0, 255, 0, 254, 19, 128, 12]);
    const file = await upload(bytes, 'исходник.bin');
    const created = await request('/api/tasks', 'POST', input({ attachmentIds: [file.id] }));
    expect(created.status).toBe(201);
    const task = await created.json();
    const response = await request(`/api/tasks/${task.id}/attachments/${file.id}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toStartWith('attachment;');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const serialized = JSON.stringify(await (await request(`/api/tasks/${task.id}`)).json());
    expect(serialized).not.toContain('"data":');
    expect(serialized).not.toContain('"preview":');
    const head = await request(`/api/tasks/${task.id}/attachments/${file.id}`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test.each([['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], ['text/html', '<script>alert(1)</script>']])('active %s remains download-only with nosniff and sandbox', async (mime, content) => {
    const file = await upload(content, 'active.txt', mime);
    const task = store.createTask(input({ attachmentIds: [file.id] }));
    expect(file.previewable).toBe(false);
    const response = await request(`/api/tasks/${task.id}/attachments/${file.id}`);
    expect(await response.text()).toBe(content);
    expect(response.headers.get('content-disposition')).toStartWith('attachment;');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect((await request(`/api/tasks/${task.id}/attachments/${file.id}?preview=1`)).status).toBe(415);
  });

  test('only re-encoded PNG previews are inline; originals always download including HEAD', async () => {
    const original = await sharp({ create: { width: 4, height: 5, channels: 3, background: '#c04791' } }).jpeg().toBuffer();
    const file = await upload(original, 'photo.jpg', 'image/jpeg');
    expect(file.previewable).toBe(true);
    const task = store.createTask(input({ attachmentIds: [file.id] }));
    const route = `/api/tasks/${task.id}/attachments/${file.id}`;
    for (const method of ['GET', 'HEAD']) {
      const raw = await request(route, method);
      expect(raw.headers.get('content-disposition')).toStartWith('attachment;');
      expect(raw.headers.get('content-type')).toBe('image/jpeg');
      const preview = await request(`${route}?preview=1`, method);
      expect(preview.headers.get('content-disposition')).toStartWith('inline;');
      expect(preview.headers.get('content-type')).toBe('image/png');
      if (method === 'GET') expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      else expect((await preview.arrayBuffer()).byteLength).toBe(0);
    }
    const download = await request(`${route}?preview=1&download=1`);
    expect(download.headers.get('content-disposition')).toStartWith('attachment;');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
  });

  test('staged IDs are unreadable until binding and never readable through another task', async () => {
    const file = await upload('secret task input', 'secret.txt', 'text/plain');
    const first = store.createTask(input()), second = store.createTask(input());
    expect((await request(`/api/tasks/${first.id}/attachments/${file.id}`)).status).toBe(404);
    store.updateTask(first.id, input({ attachmentIds: [file.id] }));
    expect((await request(`/api/tasks/${second.id}/attachments/${file.id}`)).status).toBe(404);
    expect((await request(`/api/tasks/${second.id}/attachments/${file.id}?preview=1`, 'HEAD')).status).toBe(404);
    expect((await request(`/api/uploads/${file.id}`, 'DELETE')).status).toBe(409);
    expect((await request(`/api/tasks/${first.id}/attachments/${file.id}`)).status).toBe(200);
  });

  test('actual streamed upload bytes enforce limit despite dishonest Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(ATTACHMENT_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    const response = await handler(new Request(`${ORIGIN}/api/uploads?name=large.bin`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': '1' }, body: stream }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect((store.db.query('SELECT count(*) AS n FROM attachments').get() as { n: number }).n).toBe(0);
  });

  test('four pending uploads cap retained request bodies and release slots after failure', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const pending = Array.from({ length: 4 }, (_, index) => handler(new Request(`${ORIGIN}/api/uploads?name=${index}.txt`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); } }) })));
    const refused = await handler(new Request(`${ORIGIN}/api/uploads?name=fifth.txt`, { method: 'POST', headers: { origin: ORIGIN }, body: 'fifth' }));
    expect(refused.status).toBe(429);
    for (const controller of controllers) { controller.enqueue(new Uint8Array(ATTACHMENT_MAX_BYTES + 1)); controller.close(); }
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([413, 413, 413, 413]);
    expect((await upload('slot released', 'sixth.txt')).size).toBe(13);
  });
});

describe('independent snapshot and descriptor review', () => {
  test('successor receives prior outputs plus clarification; edits and mid-run ordinary comments stay excluded', async () => {
    const worker = store.createWorker({ name: 'Reviewer', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
    const first = await staged('first.txt'), edited = await staged('edited.txt'), ordinary = await staged('ordinary.txt'), answer = await staged('answer.txt');
    const task = store.createTask(input({ attachmentIds: [first.id], steps: [{ workerId: worker.id, title: 'One', instruction: 'First' }, { workerId: worker.id, title: 'Two', instruction: 'Second' }] }));
    const run = store.startManual(task.id, false);
    const fence = runFence(run);
    const output = store.publishAgentAttachment(run.id, fence, 'output-one', await prepareAttachment(Buffer.from('result'), 'text/plain', 'result.txt'), 'First result');
    store.updateTask(task.id, input({ attachmentIds: [edited.id] }));
    store.comment(task.id, null, 'user', 'Later context', Date.now(), undefined, [ordinary.id]);
    store.setSession(run.id, 'first-session', fence);
    store.finish(run.id, 'waiting_input', 'Need answer', null, Date.now(), fence);
    const resumed = store.resume(run.id, 'Answer', false, Date.now(), [answer.id]);
    const expected = [first.id, output.id, answer.id].sort();
    expect(resumed.inputAttachments!.map(a => a.id).sort()).toEqual(expected);
    expect(() => store.publishAgentComment(run.id, fence, 'late', { body: 'Old invocation' })).toThrow();
    const next = store.finish(run.id, 'completed', 'First complete', null, Date.now(), runFence(resumed));
    expect(next.currentStepIndex).toBe(1);
    expect(next.inputAttachments!.map(a => a.id).sort()).toEqual(expected);
    const originalSnapshot = store.db.query('SELECT attachment_id FROM run_attachment_inputs WHERE run_id=? AND turn=1').all(run.id) as { attachment_id: string }[];
    expect(originalSnapshot.map(row => row.attachment_id)).toEqual([first.id]);
    expect(() => store.publishAgentAttachment(run.id, runFence(resumed), 'late-output', {} as never)).toThrow();
  });

  test('output descriptor rejects traversal, symlinks, hard links and a replaced root', () => {
    const output = new TaskOutputDirectory(folder);
    try {
      const secret = join(folder, 'secret'); writeFileSync(secret, 'outside');
      writeFileSync(join(output.path, 'result.txt'), 'result');
      expect(output.read('result.txt').toString()).toBe('result');
      for (const path of ['../secret', '/secret', '..', 'nested/file', 'nested\\file']) expect(() => output.read(path)).toThrow();
      symlinkSync(secret, join(output.path, 'symlink'));
      linkSync(secret, join(output.path, 'hardlink'));
      mkdirSync(join(output.path, 'directory'));
      for (const path of ['symlink', 'hardlink', 'directory']) expect(() => output.read(path)).toThrow();
      const renamed = output.path + '-old'; renameSync(output.path, renamed); symlinkSync(folder, output.path);
      expect(() => output.read('secret')).toThrow();
      rmSync(output.path); renameSync(renamed, output.path);
      expect(output.read('result.txt').toString()).toBe('result');
    } finally { output.close(); }
    expect(() => output.read('result.txt')).toThrow();
  });

  test('broker native image content is safe PNG and capability revokes immediately', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    const file = store.stageAttachment(await prepareAttachment(png, 'image/png', 'screenshot.png'));
    const task = store.createTask(input({ attachmentIds: [file.id] }));
    const run = store.startManual(task.id, false);
    const broker = createTaskBroker(store, run, runFence(run)); brokers.push(broker);
    const request = { capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: 'test', tool: 'view_attachment', arguments: { attachment_id: file.id } };
    const result = await broker.dispatch(request);
    expect(result.isError).not.toBe(true);
    const image = result.content.find(c => c.type === 'image');
    expect(image?.type).toBe('image');
    if (image?.type === 'image') { expect(image.mimeType).toBe('image/png'); expect((await sharp(Buffer.from(image.data, 'base64')).metadata()).width).toBe(8); }
    expect((await broker.dispatch({ ...request, capability: 'é'.repeat(64) })).isError).toBe(true);
    store.cancel(run.id);
    expect((await broker.dispatch(request)).isError).toBe(true);
  });
});


describe('independent bounded publication receipt review', () => {
  test.each(['single', 'parallel'] as const)('budget exhaustion must not report failure after committing a publication (%s)', async mode => {
    const png = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const image = store.stageAttachment(await prepareAttachment(png, 'image/png', 'noise.png'));
    const text = await staged('text.txt', 'x'.repeat(32768));
    const task = store.createTask(input({ attachmentIds: [image.id, text.id] }));
    const run = store.startManual(task.id, false), broker = createTaskBroker(store, run, runFence(run)); brokers.push(broker);
    let bytes = 0, calls = 0;
    const call = async (tool: string, args: unknown) => {
      const result = await broker.dispatch({ capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: String(++calls), tool, arguments: args });
      bytes += Buffer.byteLength(JSON.stringify(result)) + 1;
      return result;
    };
    for (let index = 0; index < 5; index++) expect((await call('view_attachment', { attachment_id: image.id })).isError).not.toBe(true);
    const first = await call('read_attachment', { attachment_id: text.id, max_bytes: 1 });
    const block = first.content[0];
    if (block?.type !== 'text') throw new Error('Expected text read');
    const template = JSON.parse(block.text);
    const size = (count: number) => Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ...template, bytes: count, next_offset: count, data: 'x'.repeat(count) }) }] })) + 1;
    const spare = mode === 'parallel' ? 4096 : 0;
    while (MAX_TASK_RESULT_TOTAL_BYTES - bytes - spare > size(16384)) expect((await call('read_attachment', { attachment_id: text.id, max_bytes: 16384 })).isError).not.toBe(true);
    const remaining = MAX_TASK_RESULT_TOTAL_BYTES - bytes - spare;
    let count = 1, low = 1, high = 16384;
    while (low <= high) { const n = Math.floor((low + high) / 2); if (size(n) < remaining) { count = n; low = n + 1; } else high = n - 1; }
    expect((await call('read_attachment', { attachment_id: text.id, max_bytes: count })).isError).not.toBe(true);
    let result;
    if (mode === 'parallel') {
      writeFileSync(join(broker.agentConfig.context.outputDirectory, 'receipt.png'), png);
      const pending = call('add_attachment', { path: 'receipt.png', mime: 'image/png', caption: 'Receipt boundary', idempotency_key: 'receipt-boundary' });
      expect((await call('list_attachments', {})).isError).toBe(true);
      result = await pending;
    } else result = await call('add_comment', { body: 'Receipt boundary', idempotency_key: 'receipt-boundary' });
    const saved = store.detail(task.id).comments.some(comment => comment.body === 'Receipt boundary');
    // Either reject before the write or return a successful bounded receipt.
    expect(saved).toBe(result.isError !== true);
  });

  test('materialized originals are bounded and unchanged app copies are removed on close', () => {
    const directory = new TaskOutputDirectory(folder, '.brigd-inputs-');
    const copied: string[] = [];
    try {
      expect(() => directory.materialize(Buffer.from('input'), '/../escape')).toThrow();
      for (let index = 0; index < 20; index++) copied.push(directory.materialize(Buffer.from(`input ${index}`), '.txt'));
      expect(readFileSync(copied[0]!, 'utf8')).toBe('input 0');
      expect(() => directory.materialize(Buffer.from('one too many'), '.txt')).toThrow();
    } finally { directory.close(); }
    expect(copied.some(path => existsSync(path))).toBe(false);
    expect(existsSync(directory.path)).toBe(false);
  });
});


describe('independent in-flight revoke review', () => {
  test.each(['cancel', 'successor'] as const)('preparation in flight cannot publish after %s', async transition => {
    const worker = store.createWorker({ name: 'Worker', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
    const task = store.createTask(input({ steps: [1, 2].map(n => ({ workerId: worker.id, title: `Step ${n}`, instruction: 'Inspect' })) }));
    const run = store.startManual(task.id, false), fence = runFence(run), broker = createTaskBroker(store, run, fence); brokers.push(broker);
    const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: 'orange' } }).png().toBuffer();
    writeFileSync(join(broker.agentConfig.context.outputDirectory, 'pending.png'), png);
    const pending = broker.dispatch({ capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: 'pending', tool: 'add_attachment', arguments: { path: 'pending.png', mime: 'image/png', caption: 'Must not appear', idempotency_key: 'pending' } });
    if (transition === 'cancel') store.cancel(run.id);
    else store.finish(run.id, 'completed', 'Advance now', null, Date.now(), fence);
    expect((await pending).isError).toBe(true);
    expect(store.detail(task.id).attachments).toHaveLength(0);
    expect(store.detail(task.id).comments.some(comment => comment.body === 'Must not appear')).toBe(false);
    expect((store.db.query('SELECT count(*) AS n FROM attachment_publications').get() as { n: number }).n).toBe(0);
  });
});

test('byte-offset text reads preserve split Unicode without replacement-character corruption', async () => {
  const original = Buffer.from('\uFEFFЖ🙂中A');
  const file = store.stageAttachment(await prepareAttachment(original, 'text/plain', 'unicode.txt'));
  const task = store.createTask(input({ attachmentIds: [file.id] })), run = store.startManual(task.id, false);
  const broker = createTaskBroker(store, run, runFence(run)); brokers.push(broker);
  const full = await broker.dispatch({ capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: 'unicode-full', tool: 'read_attachment', arguments: { attachment_id: file.id } });
  const fullContent = full.content[0];
  if (fullContent?.type !== 'text') throw new Error('Expected UTF-8 tool response');
  const fullChunk = JSON.parse(fullContent.text);
  expect(Buffer.from(fullChunk.data, fullChunk.encoding === 'base64' ? 'base64' : 'utf8')).toEqual(original);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < original.length; offset++) {
    const result = await broker.dispatch({ capability: broker.agentConfig.env.BRIGD_TASK_CAPABILITY, requestId: `unicode-${offset}`, tool: 'read_attachment', arguments: { attachment_id: file.id, offset, max_bytes: 1 } });
    expect(result.isError).not.toBe(true);
    const content = result.content[0];
    if (content?.type !== 'text') throw new Error('Expected text tool response');
    const chunk = JSON.parse(content.text);
    expect(chunk.bytes).toBe(1);
    expect(['utf-8', 'base64']).toContain(chunk.encoding);
    parts.push(Buffer.from(chunk.data, chunk.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  expect(Buffer.concat(parts)).toEqual(original);
});
