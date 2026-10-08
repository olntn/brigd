import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCallbacks, AgentInput, AgentOutcome } from '../server/adapter';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { Store } from '../server/store';
import type { Run, Task, TaskDetail, TaskInput } from '../src/lib/types';

const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
interface Call {
  input: AgentInput;
  callbacks: AgentCallbacks;
  resolve: (outcome: AgentOutcome) => void;
  reject: (error: unknown) => void;
}
let calls: Call[];
const factory: AgentFactory = (input, callbacks) => {
  let resolve!: Call['resolve'];
  let reject!: Call['reject'];
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  calls.push({ input, callbacks, resolve, reject });
  return { result, cancel: () => reject(new Error('Synthetic cancellation')) };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const valid = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Inspect repository', instruction: 'Review local code.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
function request(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
  return handler(new Request(ORIGIN + path, {
    method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
  }));
}
async function createTask(patch: Partial<TaskInput> = {}): Promise<Task> {
  const response = await request('/api/tasks', 'POST', valid(patch));
  expect(response.status).toBe(201);
  return response.json();
}
async function detail(id: string): Promise<TaskDetail> {
  const response = await request(`/api/tasks/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trackt-http-test-'));
  store = new Store(join(folder, 'trackt.sqlite'));
  calls = [];
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: PORT, root: folder, startedAt: 12345 });
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('loopback request boundary', () => {
  test('schedule pause remains available after its working directory disappears', async () => {
    const project = join(folder, 'removed-project');
    mkdirSync(project);
    const task = await createTask({ cwd: project, schedule: 'interval', intervalMinutes: 1, firstRunAt: Date.now() - 1000 });
    rmSync(project, { recursive: true });
    const response = await request(`/api/tasks/${task.id}`, 'PATCH', { paused: true });
    expect(response.status).toBe(200);
    expect((await response.json()).paused).toBe(true);
    engine.tick();
    expect(calls).toHaveLength(0);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { paused: 'true' })).status).toBe(400);
  });
  test.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`])('allows the exact local Host %s', async host => {
    const response = await handler(new Request(`http://${host}/api/tasks`, { headers: { host } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test.each(['evil.test:4310', '127.0.0.1.evil.test:4310', 'localhost.evil.test:4310', '127.0.0.1:99', 'localhost', '[::1]:4310', '0.0.0.0:4310'])('rejects untrusted Host %s before reading or mutating state', async host => {
    const response = await request('/api/tasks', 'POST', valid(), { host });
    expect(response.status).toBe(403);
    expect(store.listTasks()).toEqual([]);
  });

  test('rejects DNS-rebinding requests even when Origin matches the attacker-controlled host', async () => {
    const response = await handler(new Request('http://rebind.example:4310/api/tasks', {
      method: 'POST', headers: { host: 'rebind.example:4310', origin: 'http://rebind.example:4310', 'content-type': 'application/json' },
      body: JSON.stringify(valid()),
    }));
    expect(response.status).toBe(403);
    expect(store.listTasks()).toEqual([]);
  });

  test.each(['https://evil.test', 'null', 'http://127.0.0.1:4310.evil.test', 'http://localhost:5173', 'https://localhost:4310'])('rejects foreign Origin %s on both reads and writes', async origin => {
    expect((await request('/api/tasks', 'GET', undefined, { origin })).status).toBe(403);
    expect((await request('/api/tasks', 'POST', valid(), { origin })).status).toBe(403);
    expect(store.listTasks()).toEqual([]);
  });

  test('permits same-origin browser writes and rejects writes with missing Origin', async () => {
    const response = await handler(new Request(ORIGIN + '/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid()),
    }));
    expect(response.status).toBe(403);
    expect(store.listTasks()).toEqual([]);
    expect((await request('/api/tasks', 'POST', valid())).status).toBe(201);
  });

  test('rejects cross-site fetch metadata even with an otherwise allowed origin', async () => {
    expect((await request('/api/tasks', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await request('/api/tasks', 'POST', valid(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(store.listTasks()).toEqual([]);
  });

  test('development mode adds only the explicitly supported local Vite origins', async () => {
    handler = createHandler(engine, { port: PORT, root: folder, dev: true });
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect((await request('/api/tasks', 'POST', valid(), { origin })).status).toBe(201);
    }
    expect((await request('/api/tasks', 'POST', valid(), { origin: 'http://localhost:5174' })).status).toBe(403);
    expect((await request('/api/tasks', 'POST', valid(), { origin: 'http://evil.test:5173' })).status).toBe(403);
  });

  test('explicit container hosts and origins allow only configured boundaries and advertise configured cwd', async () => {
    const host = 'trackt-preview.example.test';
    const origin = `https://${host}`;
    const cwd = join(folder, 'container-project');
    mkdirSync(cwd);
    handler = createHandler(engine, { port: PORT, root: folder, allowedHosts: [host], allowedOrigins: [origin], defaultCwd: cwd });
    const info = await handler(new Request(origin + '/api/info', { headers: { host, origin } }));
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ cwd, mode: 'mock' });
    const created = await handler(new Request(origin + '/api/tasks', {
      method: 'POST', headers: { host, origin, 'content-type': 'application/json' }, body: JSON.stringify(valid({ cwd })),
    }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ cwd });
    expect((await request('/api/info')).status).toBe(403);
    const blockedHeaders: Record<string, string>[] = [
      { host: 'attacker.example.test', origin },
      { host, origin: 'https://attacker.example.test' },
      { host, origin: `http://${host}` },
      { host, origin, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of blockedHeaders) {
      expect((await handler(new Request(origin + '/api/tasks', { method: 'POST', headers, body: JSON.stringify(valid({ cwd })) }))).status).toBe(403);
    }
    expect(store.listTasks()).toHaveLength(1);
  });

  test('API success and error responses carry defensive headers without permissive CORS', async () => {
    for (const response of [await request('/api/info'), await request('/api/no-such-route')]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});

describe('bounded JSON and task validation', () => {
  test.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', 'application/json-extra'])('rejects unsupported content type %s', async contentType => {
    expect((await request('/api/tasks', 'POST', valid(), { 'content-type': contentType })).status).toBe(415);
    expect(store.listTasks()).toEqual([]);
  });

  test('rejects a missing Content-Type before creating a task', async () => {
    const response = await handler(new Request(ORIGIN + '/api/tasks', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify(valid()) }));
    expect(response.status).toBe(415);
  });

  test.each(['{', '', 'null', '[]', '"text"', '7', 'true'])('rejects malformed or non-object JSON %j', async body => {
    const response = await handler(new Request(ORIGIN + '/api/tasks', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body }));
    expect(response.status).toBe(400);
    expect(store.listTasks()).toEqual([]);
  });

  test('accepts a JSON content type with a charset parameter', async () => {
    expect((await request('/api/tasks', 'POST', valid(), { 'content-type': 'application/json; charset=utf-8' })).status).toBe(201);
  });

  test('rejects an oversized declared length before validation', async () => {
    expect((await request('/api/tasks', 'POST', valid(), { 'content-length': '32769' })).status).toBe(413);
    expect(store.listTasks()).toEqual([]);
  });

  test.each([undefined, '1'])('counts actual bytes with absent or dishonest content-length %s', async contentLength => {
    const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
    if (contentLength !== undefined) headers['content-length'] = contentLength;
    const body = JSON.stringify({ ...valid(), instruction: 'é'.repeat(17_000) });
    const response = await handler(new Request(ORIGIN + '/api/tasks', { method: 'POST', headers, body }));
    expect(response.status).toBe(413);
    expect(store.listTasks()).toEqual([]);
  });

  test('streamed bodies are bounded across chunks and cancelled once the limit is crossed', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16_384)); controller.enqueue(new Uint8Array(16_384)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    const response = await handler(new Request(ORIGIN + '/api/tasks', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: stream,
    }));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test('exactly the 32768-byte body boundary is accepted with harmless JSON whitespace', async () => {
    const value = JSON.stringify(valid());
    const body = value + ' '.repeat(32_768 - Buffer.byteLength(value));
    expect(Buffer.byteLength(body)).toBe(32_768);
    const response = await handler(new Request(ORIGIN + '/api/tasks', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body }));
    expect(response.status).toBe(201);
  });

  test.each([
    ['title', ''], ['title', ' '.repeat(5)], ['title', 'x'.repeat(141)], ['title', 'a\0b'],
    ['instruction', ''], ['instruction', 'x'.repeat(16_001)], ['provider', 'unknown'],
    ['schedule', 'cron'], ['paused', 'false'], ['cwd', '.'], ['cwd', '/definitely-not-a-trackt-folder'],
  ])('rejects invalid %s values without storing partial tasks', async (field, value) => {
    expect((await request('/api/tasks', 'POST', { ...valid(), [field]: value })).status).toBe(400);
    expect(store.listTasks()).toEqual([]);
  });

  test('cwd must be a directory; symlink directories resolve to their real path', async () => {
    const file = join(folder, 'file.txt');
    writeFileSync(file, 'Not a directory');
    expect((await request('/api/tasks', 'POST', valid({ cwd: file }))).status).toBe(400);
    const actual = join(folder, 'project');
    const alias = join(folder, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const task = await createTask({ cwd: alias, title: '  Trim title  ', instruction: '  Trim instruction  ' });
    expect(task).toMatchObject({ cwd: realpathSync(actual), title: 'Trim title', instruction: 'Trim instruction' });
  });

  test.each([0, -1, 1.5, 525_601, null, '5'])('rejects invalid interval minutes %j', async intervalMinutes => {
    expect((await request('/api/tasks', 'POST', { ...valid(), schedule: 'interval', intervalMinutes })).status).toBe(400);
  });

  test.each([-1, 1.5, 'tomorrow', 8_640_000_000_000_001])('rejects invalid first-run timestamp %j', async firstRunAt => {
    expect((await request('/api/tasks', 'POST', { ...valid(), schedule: 'interval', intervalMinutes: 5, firstRunAt })).status).toBe(400);
  });

  test('invalid task patch preserves all existing data', async () => {
    const task = await createTask();
    const before = await detail(task.id);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { provider: 'not-a-provider', title: 'Should not be saved' })).status).toBe(400);
    expect(await detail(task.id)).toEqual(before);
  });
});

describe('persisted API lifecycle', () => {
  test('info clearly identifies mock mode and available providers', async () => {
    const response = await request('/api/info');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'mock', scheduler: 'running', startedAt: 12345, providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] });
  });

  test('create, update, comment, run, persist waiting, resume, and complete using one session', async () => {
    const task = await createTask({ provider: 'claude' });
    expect(task).toMatchObject({ status: 'ready', runCount: 0, latestRun: null });
    expect((await (await request('/api/tasks')).json()).map((item: Task) => item.id)).toEqual([task.id]);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Updated title', paused: true })).status).toBe(200);
    expect((await request(`/api/tasks/${task.id}/comments`, 'POST', { body: '  Project context  ' })).status).toBe(201);
    const started = await request(`/api/tasks/${task.id}/run`, 'POST');
    expect(started.status).toBe(201);
    const run: Run = await started.json();
    expect(calls).toHaveLength(1);
    calls[0]!.callbacks.onSession('claude-persistent-session');
    calls[0]!.resolve({ sessionId: 'claude-persistent-session', envelope: { status: 'needs_input', summary: 'Need a branch', questions: ['Which branch?'] } });
    await flush();
    expect((await detail(task.id)).task.status).toBe('waiting_input');
    expect((await request(`/api/tasks/${task.id}/run`, 'POST')).status).toBe(409);
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    engine = new Engine(store, true, factory);
    handler = createHandler(engine, { port: PORT, root: folder });
    engine.startScheduler();
    expect(calls).toHaveLength(1);
    const persisted = await detail(task.id);
    expect(persisted.task).toMatchObject({ title: 'Updated title', paused: true, status: 'waiting_input', runCount: 1 });
    expect(persisted.runs[0]).toMatchObject({ id: run.id, sessionId: 'claude-persistent-session' });
    expect(persisted.comments.map(comment => comment.body)).toContain('Project context');
    expect(persisted.comments.map(comment => comment.body)).toContain('Which branch?');
    const resumed = await request(`/api/runs/${run.id}/resume`, 'POST', { answer: 'main' });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ id: run.id, status: 'running', turn: 2 });
    expect(calls[1]!.input).toMatchObject({ provider: 'claude', sessionId: 'claude-persistent-session', answer: 'main' });
    calls[1]!.resolve({ sessionId: 'claude-persistent-session', envelope: { status: 'completed', summary: 'Review finished', questions: [] } });
    await flush();
    const finished = await detail(task.id);
    expect(finished.task).toMatchObject({ status: 'completed', runCount: 1 });
    expect(finished.runs[0]).toMatchObject({ summary: 'Review finished', sessionId: 'claude-persistent-session', turn: 2 });
    expect(finished.comments.at(-1)).toMatchObject({ kind: 'result', body: 'Review finished' });
  });

  test('ordinary comments do not resume a waiting run or act as native approval', async () => {
    const task = await createTask();
    const run = engine.start(task.id);
    calls[0]!.resolve({ sessionId: 'waiting-session', envelope: { status: 'needs_input', summary: 'Question', questions: ['Which file?'] } });
    await flush();
    expect((await request(`/api/tasks/${task.id}/comments`, 'POST', { body: 'Approved; continue' })).status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting_input', turn: 1 });
  });

  test('interrupted resume requires boolean acknowledgement and never substitutes a new session', async () => {
    const task = await createTask();
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'original-session');
    store.reconcile();
    for (const acknowledgement of [undefined, false, 'true', 1]) {
      expect((await request(`/api/runs/${run.id}/resume`, 'POST', { answer: 'Continue', acknowledgeInterruption: acknowledgement })).status).toBe(409);
    }
    expect(calls).toHaveLength(0);
    expect((await request(`/api/runs/${run.id}/resume`, 'POST', { answer: 'Continue', acknowledgeInterruption: true })).status).toBe(200);
    expect(calls[0]!.input.sessionId).toBe('original-session');
    expect(store.getTask(task.id).runCount).toBe(1);
  });

  test('missing-session resume fails safely through API and leaves run unchanged', async () => {
    const task = await createTask();
    const run = store.startManual(task.id, true);
    store.finish(run.id, 'waiting_input', 'Question', null);
    expect((await request(`/api/runs/${run.id}/resume`, 'POST', { answer: 'Answer' })).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({ status: 'waiting_input', sessionId: null, turn: 1 });
  });

  test('cancel remains durable when the fake agent rejects from termination', async () => {
    const task = await createTask();
    const run = engine.start(task.id);
    const response = await request(`/api/runs/${run.id}/cancel`, 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelling' });
    await flush();
    expect((await detail(task.id)).task.status).toBe('cancelled');
    expect((await request(`/api/runs/${run.id}/cancel`, 'POST')).status).toBe(409);
  });

  test.each(['', '  ', 'x'.repeat(8_001), 'a\0b'])('rejects invalid comments and resume answers', async value => {
    const task = await createTask();
    const run = store.startManual(task.id, true);
    store.setSession(run.id, 'waiting-session');
    store.finish(run.id, 'waiting_input', 'Question', null);
    const before = store.detail(task.id);
    expect((await request(`/api/tasks/${task.id}/comments`, 'POST', { body: value })).status).toBe(400);
    expect((await request(`/api/runs/${run.id}/resume`, 'POST', { answer: value })).status).toBe(400);
    expect(store.detail(task.id)).toEqual(before);
  });

  test('all run mutations require valid JSON before any side effect', async () => {
    const task = await createTask();
    const response = await handler(new Request(ORIGIN + `/api/tasks/${task.id}/run`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '[]' }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(store.getTask(task.id).runCount).toBe(0);
  });

  test('unknown tasks, runs, and API routes return JSON 404 errors', async () => {
    for (const [path, method] of [['/api/tasks/missing', 'GET'], ['/api/tasks/missing/run', 'POST'], ['/api/runs/missing/cancel', 'POST'], ['/api/no-such-route', 'GET']]) {
      const response = await request(path!, method!);
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBeTypeOf('string');
    }
  });
});

describe('local UI static serving', () => {
  test('missing build reports a clear 503 rather than pretending the UI is available', async () => {
    const response = await request('/');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('bun run build');
  });

  test('serves assets, client routes, and HEAD requests with no body', async () => {
    mkdirSync(join(folder, 'dist'));
    writeFileSync(join(folder, 'dist', 'index.html'), '<!doctype html><title>Trackt test</title>');
    writeFileSync(join(folder, 'dist', 'app.js'), 'console.log("Trackt test");');
    const asset = await request('/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log');
    const route = await request('/tasks/local-route');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>Trackt test</title>');
    const head = await request('/app.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('rejects encoded path traversal outside dist', async () => {
    writeFileSync(join(folder, 'private.txt'), 'Never expose this');
    const response = await request('/%2e%2e%2fprivate.txt');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Never expose this');
  });

  test('malformed URL escapes are a validation error', async () => {
    expect((await request('/%zz')).status).toBe(400);
  });
});
