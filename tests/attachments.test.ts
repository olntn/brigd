import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createHandler } from '../server/http';
import { Engine } from '../server/engine';
import { AppError, Store, runFence } from '../server/store';
import { attachmentDisposition, attachmentIds, attachmentName, prepareAttachment, preparedAttachmentPayload } from '../server/attachments';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_PREVIEW_MAX_BYTES, ATTACHMENT_STAGING_TTL_MS } from '../src/lib/attachments';
import type { TaskInput } from '../src/lib/types';

const BASE = 1_700_000_000_000;
const input = (patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'Files', instruction: 'Inspect attached files', provider: 'codex', cwd: '/tmp', schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch });
let folder: string, store: Store;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'brigd-attachment-')); store = new Store(join(folder, 'app.sqlite')); });
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
const payload = (body = 'hello', name = 'note.txt') => prepareAttachment(Buffer.from(body), 'text/plain', name);
const stage = async (body = 'hello', now = BASE) => store.stageAttachment(await payload(body), now);
function status(action: () => unknown, expected: number) { try { action(); throw new Error('expected AppError'); } catch (e) { expect(e).toBeInstanceOf(AppError); expect((e as AppError).status).toBe(expected); } }

 describe('attachment payload boundary', () => {
  test.each(['../secret', '/tmp/a', 'C:\\secret', 'a\n.txt', 'a\r.txt', 'a\0.txt', '\u202eevil.txt', '..', '', 'a'.repeat(256)])('rejects unsafe filename %s', name => { expect(() => attachmentName(name)).toThrow(AppError); });
  test('normalizes safe Unicode name and uses safe disposition fields', () => {
    const name = attachmentName('  отчёт "новый".txt ');
    const header = attachmentDisposition(name);
    expect(header).toStartWith('attachment; filename="');
    expect(header).toContain("filename*=UTF-8''%D0");
    expect(header).not.toContain('"новый"');
  });
  test('rejects excess/duplicate/malformed IDs and invalid prepared data', () => {
    for (const ids of [[...Array(21)].map((_, i) => `file-${i}`), ['x', 'x'], ['../x'], null, 'x']) expect(() => attachmentIds(ids)).toThrow(AppError);
    expect(attachmentIds(undefined)).toEqual([]);
    expect(() => store.stageAttachment({ name: 'a', mime: 'text/plain', size: 1, sha256: 'fake', previewable: true })).toThrow(AppError);
  });
  test('enforces upload bytes and preserves immutable caller-isolated content', async () => {
    await expect(prepareAttachment(new Uint8Array(ATTACHMENT_MAX_BYTES + 1), 'text/plain', 'large')).rejects.toMatchObject({ status: 413 });
    const bytes = Buffer.from('original');
    const prepared = await prepareAttachment(bytes, 'text/plain', 'note.txt');
    bytes.fill(0);
    preparedAttachmentPayload(prepared).data.fill(1);
    const upload = store.stageAttachment(prepared, BASE);
    const task = store.createTask(input({ attachmentIds: [upload.id] }), BASE);
    expect(Buffer.from(store.readAttachment(task.id, upload.id).data).toString()).toBe('original');
    expect(upload.sha256).toBe(createHash('sha256').update('original').digest('hex'));
  });
  test.each(['image/svg+xml', 'text/html', 'image/png', 'image/jpeg', 'image/webp'])('active content with claimed %s is never previewable', async mime => {
    const prepared = await prepareAttachment(Buffer.from('<svg onload="alert(1)"><script>alert(1)</script></svg>'), mime, 'unsafe.svg');
    expect(prepared.previewable).toBe(false);
    const upload = store.stageAttachment(prepared, BASE);
    const task = store.createTask(input({ attachmentIds: [upload.id] }), BASE);
    status(() => store.readAttachmentPreview(task.id, upload.id), 415);
  });
  test.each(['png', 'jpeg', 'webp', 'gif'] as const)('decodes real %s into bounded PNG tool preview', async format => {
    const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#c0ffee' } }).toFormat(format).toBuffer();
    const prepared = await prepareAttachment(bytes, 'text/html', 'misleading.html');
    expect(prepared).toMatchObject({ mime: `image/${format}`, previewable: true, size: bytes.length });
    const preview = preparedAttachmentPayload(prepared).preview!;
    expect(preview.length).toBeLessThanOrEqual(ATTACHMENT_PREVIEW_MAX_BYTES);
    expect((await sharp(preview).metadata()).format).toBe('png');
  });
  test('malformed raster signatures and large-pixel images remain download-only', async () => {
    const bad = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]);
    expect((await prepareAttachment(bad, 'image/png', 'bad.png')).previewable).toBe(false);
    const huge = await sharp({ create: { width: 20_000, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    expect((await prepareAttachment(huge, 'image/png', 'wide.png')).previewable).toBe(false);
  });
  test('large raster preview is bounded without changing downloadable original', async () => {
    const bytes = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: 'white', noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).png().toBuffer();
    expect(bytes.length).toBeGreaterThan(ATTACHMENT_PREVIEW_MAX_BYTES);
    const p = await prepareAttachment(bytes, 'image/png', 'noise.png');
    expect(p.previewable).toBe(true);
    expect(preparedAttachmentPayload(p).preview!.length).toBeLessThanOrEqual(ATTACHMENT_PREVIEW_MAX_BYTES);
    expect(Buffer.from(preparedAttachmentPayload(p).data).equals(bytes)).toBe(true);
  });
});

describe('durable scoped attachment storage', () => {
  test('staged upload binds atomically to task; unbound files are not readable', async () => {
    const upload = await stage();
    expect(upload).toMatchObject({ taskId: null, source: 'user', commentId: null, runId: null });
    status(() => store.getAttachment('missing', upload.id), 404);
    const task = store.createTask(input({ attachmentIds: [upload.id] }), BASE);
    expect(task.attachments?.map(a => a.id)).toEqual([upload.id]);
    expect(store.detail(task.id).attachments?.[0]).toMatchObject({ taskId: task.id, size: 5 });
    const other = store.createTask(input(), BASE);
    status(() => store.readAttachment(other.id, upload.id), 404);
    status(() => store.deleteStagedAttachment(upload.id), 409);
    status(() => store.updateTask(other.id, input({ attachmentIds: [upload.id] }), BASE), 409);
  });
  test('invalid mixed binding rolls back all task/comment fields and staging', async () => {
    const upload = await stage();
    const task = store.createTask(input(), BASE);
    status(() => store.updateTask(task.id, input({ title: 'bad', attachmentIds: [upload.id, 'missing'] }), BASE), 404);
    expect(store.getTask(task.id).title).toBe('Files');
    expect((store.db.query('SELECT task_id FROM attachments WHERE id=?').get(upload.id) as any).task_id).toBeNull();
    status(() => store.comment(task.id, null, 'user', '', BASE, undefined, [upload.id, 'missing']), 404);
    expect(store.detail(task.id).comments).toEqual([]);
    const c = store.comment(task.id, null, 'user', '', BASE, undefined, [upload.id]);
    expect(c.attachments?.[0]).toMatchObject({ id: upload.id, commentId: c.id, taskId: task.id });
    status(() => store.comment(task.id, null, 'user', '', BASE, undefined, [upload.id]), 409);
  });
  test('staging expiry, bounded cleanup and count quota are enforced', async () => {
    const p = await payload();
    for (let i = 0; i < 100; i++) store.stageAttachment(p, BASE);
    status(() => store.stageAttachment(p, BASE), 413);
    const expiredId = (store.db.query('SELECT id FROM attachments LIMIT 1').get() as any).id;
    status(() => store.createTask(input({ attachmentIds: [expiredId] }), BASE + ATTACHMENT_STAGING_TTL_MS), 404);
    expect(store.listTasks()).toEqual([]);
    expect(store.cleanupAttachments(BASE + ATTACHMENT_STAGING_TTL_MS, 3)).toBe(3);
    expect((store.db.query('SELECT count(*) n FROM attachments').get() as any).n).toBe(97);
    expect(store.stageAttachment(p, BASE + ATTACHMENT_STAGING_TTL_MS)).toMatchObject({ taskId: null });
    expect((store.db.query('SELECT count(*) n FROM attachments').get() as any).n).toBe(1);
  });
  test('task direct removal retains original metadata and historical bytes', async () => {
    const file = await stage();
    const task = store.createTask(input({ attachmentIds: [file.id] }), BASE);
    const run = store.startManual(task.id, false, BASE);
    store.updateTask(task.id, input({ attachmentIds: [] }), BASE + 1);
    expect(store.getTask(task.id).attachments).toEqual([]);
    expect(store.getRun(run.id).inputAttachments?.map(a => a.id)).toEqual([file.id]);
    expect(Buffer.from(store.readAttachment(task.id, file.id).data).toString()).toBe('hello');
    expect(() => store.db.query('UPDATE attachments SET name=? WHERE id=?').run('changed', file.id)).toThrow('immutable');
    expect(() => store.db.query('UPDATE attachments SET data=? WHERE id=?').run(Buffer.from('other'), file.id)).toThrow('immutable');
  });
  test('snapshots exclude late unrelated user files; clarification and prior-step outputs advance once', async () => {
    const original = await stage('initial');
    const task = store.createTask(input({ attachmentIds: [original.id] }), BASE);
    const run = store.startManual(task.id, true, BASE);
    const fence = runFence(run);
    const late = await stage('late', BASE + 1);
    store.comment(task.id, null, 'user', 'Later', BASE + 1, undefined, [late.id]);
    const output = store.publishAgentAttachment(run.id, fence, 'out', await payload('output'), 'Here', BASE + 2);
    expect(store.getRun(run.id).inputAttachments?.map(a => a.id)).toEqual([original.id]);
    expect(new Set(store.listRunAttachments(run.id, fence).map(a => a.id))).toEqual(new Set([original.id, output.id]));
    store.setSession(run.id, 'session-1', fence);
    store.finish(run.id, 'waiting_input', 'Question', null, BASE + 3, fence);
    const answer = await stage('answer', BASE + 4);
    const resumed = store.resume(run.id, 'Files', false, BASE + 5, [answer.id]);
    expect(new Set(resumed.inputAttachments?.map(a => a.id))).toEqual(new Set([original.id, output.id, answer.id]));
    expect(store.detail(task.id).comments.at(-1)?.attachments?.[0]).toMatchObject({ id: answer.id, runId: run.id });
    status(() => store.listRunAttachments(run.id, fence), 409);
  });
  test('resume binding rollback restores status, turn, comments and staging', async () => {
    const task = store.createTask(input(), BASE), run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'session-1'); store.finish(run.id, 'waiting_input', '?', null, BASE);
    const file = await stage(); const before = store.detail(task.id);
    status(() => store.resume(run.id, 'Files', false, BASE, [file.id, 'missing']), 404);
    expect(store.detail(task.id)).toEqual(before);
    expect((store.db.query('SELECT task_id FROM attachments WHERE id=?').get(file.id) as any).task_id).toBeNull();
  });
  test('metadata APIs contain no file bytes or base64 copies', async () => {
    const f = await stage('very private file bytes');
    const task = store.createTask(input({ attachmentIds: [f.id] }), BASE);
    store.startManual(task.id, true, BASE);
    const serialized = JSON.stringify([store.listTasks(), store.detail(task.id)]);
    expect(serialized).not.toContain('very private file bytes'); expect(serialized).not.toContain('data'); expect(serialized).not.toContain('preview_size');
  });
  test('restart preserves attachments, associations, snapshots and IDs', async () => {
    const f = await stage(); const t = store.createTask(input({ attachmentIds: [f.id] }), BASE); const r = store.startManual(t.id, false, BASE);
    const before = store.detail(t.id); store.close(); store = new Store(join(folder, 'app.sqlite'));
    expect(store.detail(t.id)).toEqual(before);
    expect(store.getRun(r.id).inputAttachments?.[0]?.id).toBe(f.id);
    expect(Buffer.from(store.readAttachment(t.id, f.id).data).toString()).toBe('hello');
  });
});

describe('migration and workflow attachment isolation', () => {
  test('additive migration twice preserves every existing worker/task/instruction/run/comment/avatar/session field', async () => {
    const worker = store.createWorker({ name: 'Ada', provider: 'codex', effort: 'high', communicationStyle: 'Concise', avatarUrl: null }, BASE);
    store.createInstruction({ title: 'Keep exact', body: 'existing guidance', enabled: true }, BASE);
    store.saveAvatar(Buffer.from('old-avatar-bytes'), 'image/png');
    const task = store.createTask(input({ workerId: worker.id }), BASE);
    const run = store.startManual(task.id, false, BASE);
    store.setSession(run.id, 'keep-existing-cli-session');
    store.comment(task.id, run.id, 'user', 'Keep original context', BASE);
    store.finish(run.id, 'waiting_input', 'Which file?', null, BASE);
    const tables = ['workers', 'avatars', 'instructions', 'tasks', 'runs', 'comments', 'service_lease'];
    const before = Object.fromEntries(tables.map(table => [table, store.db.query(`SELECT * FROM ${table}`).all()]));
    // Exact pre-attachment schema: discard only these newly added, empty tables.
    store.db.exec('DROP TABLE attachment_publications; DROP TABLE run_attachment_inputs; DROP TABLE comment_attachment_links; DROP TABLE task_attachment_links; DROP TABLE attachments;');
    for (let pass = 0; pass < 2; pass++) {
      store.close(); store = new Store(join(folder, 'app.sqlite'));
      for (const table of tables) expect(store.db.query(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
      expect(store.getRun(run.id)).toMatchObject({ sessionId: 'keep-existing-cli-session', status: 'waiting_input', inputAttachments: [] });
      expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    const file = await stage();
    expect(store.resume(run.id, 'Here', false, BASE, [file.id])).toMatchObject({ id: run.id, sessionId: 'keep-existing-cli-session', turn: 2, inputAttachments: [expect.objectContaining({ id: file.id })] });
  });
  test('successor step and retry receive prior outputs with immutable attempt attribution', async () => {
    const first = store.createWorker({ name: 'First', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null }, BASE);
    const second = store.createWorker({ name: 'Second', provider: 'claude', effort: 'default', communicationStyle: '', avatarUrl: null }, BASE);
    const task = store.createTask(input({ steps: [first, second].map(worker => ({ workerId: worker.id, title: worker.name, instruction: 'Inspect' })) }), BASE);
    const run = store.startManual(task.id, false, BASE), fence = runFence(run);
    const artifact = store.publishAgentAttachment(run.id, fence, 'step-one', await payload(), 'Result', BASE);
    const later = await stage('late', BASE + 1); store.comment(task.id, null, 'user', 'late', BASE + 1, undefined, [later.id]);
    const next = store.finish(run.id, 'completed', 'Done', null, BASE + 2, fence);
    expect(next.inputAttachments?.map(a => a.id)).toEqual([artifact.id]);
    expect(artifact).toMatchObject({ stepIndex: 0, attemptId: fence.attemptId });
    status(() => store.publishAgentComment(run.id, fence, 'stale', { body: 'late' }), 409);
    const nextFence = runFence(next);
    const attemptOutput = store.publishAgentAttachment(run.id, nextFence, 'step-two', await payload(), 'Partial', BASE + 3);
    store.finish(run.id, 'failed', null, 'Error', BASE + 4, nextFence);
    const retried = store.retry(run.id, false, BASE + 5);
    expect(new Set(retried.inputAttachments?.map(a => a.id))).toEqual(new Set([artifact.id, attemptOutput.id]));
    expect(runFence(retried).attemptId).not.toBe(nextFence.attemptId);
    status(() => store.publishAgentComment(run.id, nextFence, 'retry-wrong', { body: 'Stale' }), 409);
  });
  test('task lifetime file quota includes removed direct attachments', async () => {
    const task = store.createTask(input(), BASE), p = await payload('x');
    for (let batch = 0; batch < 10; batch++) {
      const ids = Array.from({ length: ATTACHMENT_MAX_COUNT }, () => store.stageAttachment(p, BASE).id);
      store.updateTask(task.id, input({ attachmentIds: ids }), BASE);
      store.updateTask(task.id, input({ attachmentIds: [] }), BASE);
    }
    expect(store.getTask(task.id).attachments).toEqual([]);
    const extra = store.stageAttachment(p, BASE);
    status(() => store.updateTask(task.id, input({ attachmentIds: [extra.id] }), BASE), 413);
    expect((store.db.query('SELECT count(*) AS n FROM attachments WHERE task_id=?').get(task.id) as any).n).toBe(200);
    expect((store.db.query('SELECT task_id FROM attachments WHERE id=?').get(extra.id) as any).task_id).toBeNull();
  });
});

describe('atomic run-fenced publication', () => {
  test('agent identity comes only from run; caption and immutable artifact commit together', async () => {
    const task = store.createTask(input(), BASE), run = store.startManual(task.id, false, BASE), fence = runFence(run);
    const p = await payload('result');
    const f = store.publishAgentAttachment(run.id, fence, 'id-1', p, 'Result', BASE);
    expect(f).toMatchObject({ taskId: task.id, runId: run.id, source: 'agent', stepIndex: null, attemptId: null });
    expect(store.detail(task.id).comments.at(-1)).toMatchObject({ body: 'Result', attachments: [f] });
    expect(store.publishAgentAttachment(run.id, fence, 'id-1', p, 'Result', BASE + 1)).toEqual(f);
    expect(store.detail(task.id).comments.filter(c => c.body === 'Result')).toHaveLength(1);
    status(() => store.publishAgentAttachment(run.id, fence, 'id-1', p, 'Changed', BASE), 409);
    status(() => store.publishAgentComment(run.id, fence, 'id-1', { body: 'Result' }, BASE), 409);
    const c = store.publishAgentComment(run.id, fence, 'comment-1', { body: 'See file', attachmentIds: [f.id] }, BASE);
    expect(store.publishAgentComment(run.id, fence, 'comment-1', { body: 'See file', attachmentIds: [f.id] }, BASE + 1)).toEqual(c);
    expect(store.getAttachment(task.id, f.id).commentId).toBe(f.commentId);
    store.cancel(run.id, BASE);
    status(() => store.publishAgentAttachment(run.id, fence, 'id-1', p, 'Result', BASE), 409);
    status(() => store.publishAgentComment(run.id, fence, 'comment-1', { body: 'See file', attachmentIds: [f.id] }, BASE), 409);
  });
  test('stale turn/step/attempt and hidden same-task files are refused without writes', async () => {
    const task = store.createTask(input(), BASE), run = store.startManual(task.id, false, BASE), fence = runFence(run), p = await payload();
    for (const stale of [{ ...fence, turn: 2 }, { ...fence, currentStepIndex: 1 }, { ...fence, attemptId: 'wrong' }]) status(() => store.publishAgentAttachment(run.id, stale, 'x', p, 'No', BASE), 409);
    const late = await stage(); store.comment(task.id, null, 'user', 'late', BASE, undefined, [late.id]);
    const before = store.detail(task.id);
    status(() => store.publishAgentComment(run.id, fence, 'guess', { body: 'guess', attachmentIds: [late.id] }), 404);
    expect(store.detail(task.id)).toEqual(before);
  });
  test('failed caption publication rolls back comment, file and idempotency row', async () => {
    const task = store.createTask(input(), BASE), run = store.startManual(task.id, false, BASE), fence = runFence(run), p = await payload();
    store.db.exec("CREATE TRIGGER fail_file BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'disk write failure'); END");
    const before = store.detail(task.id);
    expect(() => store.publishAgentAttachment(run.id, fence, 'retry', p, 'Caption', BASE)).toThrow('disk write failure');
    expect(store.detail(task.id)).toEqual(before);
    expect((store.db.query('SELECT count(*) n FROM attachment_publications').get() as any).n).toBe(0);
    store.db.exec('DROP TRIGGER fail_file');
    expect(store.publishAgentAttachment(run.id, fence, 'retry', p, 'Caption', BASE).commentId).not.toBeNull();
  });
});


describe('binary upload and attachment JSON API', () => {
  const origin = 'http://127.0.0.1:4310';
  const handler = () => createHandler(new Engine(store, true, () => ({ result: new Promise(() => {}), cancel() {} })), { port: 4310, root: folder });
  const json = (path: string, method: string, value: unknown) => handler()(new Request(origin + path, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value) }));
  const upload = (name: string, data: Uint8Array, headers: Record<string, string> = {}) => handler()(new Request(origin + '/api/uploads?name=' + encodeURIComponent(name), { method: 'POST', headers: { origin, 'content-type': 'application/octet-stream', ...headers }, body: data as BodyInit }));
  test('raw upload then create/update/comment is atomic and omission preserves task attachments', async () => {
    const response = await upload('report.txt', Buffer.from('bytes'));
    expect(response.status).toBe(201); const file = await response.json();
    const create = await json('/api/tasks', 'POST', input({ attachmentIds: [file.id] }));
    expect(create.status).toBe(201); const task = await create.json();
    expect(task.attachments?.[0]?.id).toBe(file.id);
    expect((await json(`/api/tasks/${task.id}`, 'PATCH', { title: 'Renamed' })).status).toBe(200);
    expect(store.getTask(task.id).attachments?.map(a => a.id)).toEqual([file.id]);
    const second = await (await upload('comment.txt', Buffer.from('comment file'))).json();
    const comment = await json(`/api/tasks/${task.id}/comments`, 'POST', { attachmentIds: [second.id] });
    expect(comment.status).toBe(201); expect(await comment.json()).toMatchObject({ body: '', attachments: [expect.objectContaining({ id: second.id })] });
    expect((await json(`/api/tasks/${task.id}/comments`, 'POST', {})).status).toBe(400);
    expect((await json(`/api/tasks/${task.id}`, 'PATCH', { attachmentIds: [] })).status).toBe(200);
    expect(store.getTask(task.id).attachments).toEqual([]);
    expect((await json('/api/tasks', 'POST', input({ attachmentIds: 'bad' as any }))).status).toBe(400);
  });
  test('files-only clarification binds exact uploaded file and retains the CLI session', async () => {
    const task = store.createTask(input()), run = store.startManual(task.id, true);
    store.setSession(run.id, 'session-files'); store.finish(run.id, 'waiting_input', 'Send file', null);
    const file = await (await upload('answer.txt', Buffer.from('answer'))).json();
    const response = await json(`/api/runs/${run.id}/resume`, 'POST', { attachmentIds: [file.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: 'session-files', turn: 2, inputAttachments: [expect.objectContaining({ id: file.id })] });
    expect(store.detail(task.id).comments.at(-1)?.body).toBe('Ответ приложен во вложениях.');
  });
  test('upload cap, filename validation and origin/host/fetch guards reject without saving', async () => {
    expect((await upload('too-big.bin', new Uint8Array(ATTACHMENT_MAX_BYTES + 1))).status).toBe(413);
    expect((await upload('../bad', Buffer.from('x'))).status).toBe(400);
    const rejectedHeaders: Record<string, string>[] = [{ origin: 'https://evil.test' }, { origin: '' }, { host: 'evil.test' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of rejectedHeaders) expect((await upload('a.txt', Buffer.from('x'), headers)).status).toBe(403);
    expect((store.db.query('SELECT count(*) n FROM attachments').get() as any).n).toBe(0);
  });
  test('chunked upload byte bound is enforced without Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(ATTACHMENT_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    const response = await handler()(new Request(origin + '/api/uploads?name=chunked.bin', { method: 'POST', headers: { origin }, body: stream, duplex: 'half' } as RequestInit));
    expect(response.status).toBe(413); expect(cancelled).toBe(true);
    expect((store.db.query('SELECT count(*) n FROM attachments').get() as any).n).toBe(0);
  });
  test('deleting staging is scoped to unbound files and cannot remove committed files', async () => {
    const staged = await (await upload('a', Buffer.from('x'))).json();
    expect((await handler()(new Request(`${origin}/api/uploads/${staged.id}`, { method: 'DELETE', headers: { origin } }))).status).toBe(200);
    expect((await handler()(new Request(`${origin}/api/uploads/${staged.id}`, { method: 'DELETE', headers: { origin } }))).status).toBe(404);
    const second = await (await upload('b', Buffer.from('y'))).json();
    const task = store.createTask(input({ attachmentIds: [second.id] }));
    expect((await handler()(new Request(`${origin}/api/uploads/${second.id}`, { method: 'DELETE', headers: { origin } }))).status).toBe(409);
    expect(store.readAttachment(task.id, second.id).data.byteLength).toBe(1);
  });
});
