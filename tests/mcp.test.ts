import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { MAX_TASK_REQUEST_BYTES } from '../server/task-mcp-protocol';
import { readConfig } from '../server/config';

const root = resolve(import.meta.dir, '..');
const token = 'mcp-test-' + 'a'.repeat(56);
const apps: Array<{ stop: () => Promise<void>; folder: string }> = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const app of apps.splice(0)) {
    await app.stop();
    rmSync(app.folder, { recursive: true, force: true });
  }
});

async function start(enabled = true) {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-http-mcp-'));
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
  Object.assign(env, { PORT: String(port), BRIGD_MODE: 'mock', BRIGD_DB: join(folder, 'app.sqlite'),
    BRIGD_HOST: '127.0.0.1', BRIGD_ALLOWED_HOSTS: `127.0.0.1:${port}`, BRIGD_ALLOWED_ORIGINS: origin,
    BRIGD_DEFAULT_CWD: folder, BRIGD_CLI_HOME: join(folder, 'cli-home'), BRIGD_UPDATE_BACKUP_DIR: join(folder, 'updates'),
    BRIGD_MCP_TOKEN: enabled ? token : '', TRACKT_MCP_TOKEN: '',
  });
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, logs: Promise<string[]>;
  async function stop() {
    if (!child) return;
    if (child.exitCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
    try { await child.exited; await logs; }
    finally { clearTimeout(timeout); }
  }
  async function boot() {
    child = Bun.spawn([process.execPath, join(root, 'server/index.ts')], { cwd: folder, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`brigd exited: ${(await logs).join('\n')}`);
      return (await fetch(origin + '/api/info')).ok;
    });
  }
  async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body ?? {}) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  async function connect() {
    const client = new Client({ name: 'brigd-external-test', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  apps.push({ stop, folder });
  await boot();
  return { folder, origin, api, connect, restart: async () => { await stop(); await boot(); } };
}
async function waitFor(read: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await read()) return; } catch (error) { last = error; }
    await Bun.sleep(25);
  }
  throw new Error(`Server did not become ready: ${last}`);
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === 'text')!.text!);
}
const creation = (title: string, key: string = crypto.randomUUID()) => ({ data: { title, instruction: 'Created from the IDE without a task run.' }, idempotency_key: key });

test('external MCP is opt-in and rejects weak or malformed configured credentials', async () => {
  expect(readConfig(root, {}).mcpToken).toBeUndefined();
  expect(readConfig(root, { TRACKT_MCP_TOKEN: token }).mcpToken).toBe(token);
  expect(readConfig(root, { TRACKT_MCP_TOKEN: token, BRIGD_MCP_TOKEN: '' }).mcpToken).toBeUndefined();
  for (const value of ['short', 'a'.repeat(257), 'a'.repeat(32) + '\n', 'a'.repeat(32) + ' ']) {
    expect(() => readConfig(root, { BRIGD_MCP_TOKEN: value })).toThrow('BRIGD_MCP_TOKEN');
  }
  const app = await start(false);
  const response = await fetch(app.origin + '/mcp', { method: 'POST' });
  expect(response.status).toBe(404);
  expect(await response.text()).toContain('BRIGD_MCP_TOKEN');
});

test('HTTP MCP requires bearer authentication, preserves browser guards and bounds incoming messages', async () => {
  const app = await start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  for (const authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${'b'.repeat(64)}`]) {
    const response = await fetch(app.origin + '/mcp', { method: 'POST', headers: { ...headers, Authorization: authorization }, body });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(await response.text()).not.toContain(token);
  }
  expect((await fetch(app.origin + '/mcp?token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
  const invalidHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
  for (const extra of invalidHeaders) {
    expect((await fetch(app.origin + '/mcp', { method: 'POST', headers: { ...headers, ...extra }, body })).status).toBe(403);
  }
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    const response = await fetch(app.origin + '/mcp', { method, headers });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  }
  expect((await fetch(app.origin + '/api/tasks', { method: 'POST', headers, body: '{}' })).status).toBe(403);
  expect((await fetch(app.origin + '/mcp', { method: 'POST', headers, body: 'x'.repeat(MAX_TASK_REQUEST_BYTES + 1) })).status).toBe(413);
  expect((await fetch(app.origin + '/mcp', { method: 'POST', headers, body: '{broken' })).status).toBe(400);
  expect((await fetch(app.origin + '/mcp', { method: 'POST', headers, body: '[' + body + ']' })).status).toBe(400);
  const ping = await fetch(app.origin + '/mcp', { method: 'POST', headers, body });
  expect(ping.status).toBe(200);
  expect(ping.headers.get('cache-control')).toBe('no-store');
  expect(await ping.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
});

test('SDK connects, manages cards and docs, reads attachments and paged discussion without any run', async () => {
  const app = await start(), client = await app.connect();
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['get_task', 'list_tasks', 'create_task', 'list_comments', 'read_attachment', 'get_doc_page']));
  expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['commit_changes']));
  expect(tools.find(tool => tool.name === 'get_task')!.inputSchema.required).toContain('task_id');
  const args = creation('External card');
  const card = await call(client, 'create_task', args);
  expect(await call(client, 'create_task', args)).toEqual(card);
  const detail = await app.api('/api/tasks/' + card.id);
  expect(detail.task).toMatchObject({ cwd: app.folder, provider: 'codex', schedule: 'manual', runCount: 0 });
  expect(detail.runs).toEqual([]);
  const shortId = card.id.slice(0, 8).toUpperCase();
  expect((await call(client, 'get_task', { task_id: shortId })).task.instruction).toBe(args.data.instruction);
  for (const [name, arguments_] of [
    ['get_task', {}], ['create_task', { data: args.data }], ['get_task', { task_id: card.id, extra: true }],
    ['commit_changes', { message: 'No worktree exists' }],
  ] as const) expect((await client.callTool({ name, arguments: arguments_ })).isError).toBe(true);
  const changed = await client.callTool({ name: 'create_task', arguments: { ...args, data: { ...args.data, title: 'Conflict' } } });
  expect(changed.isError).toBe(true);
  expect((await call(client, 'list_tasks', { query: 'External', limit: 1 })).items.map((item: any) => item.id)).toEqual([card.id]);
  const doc = await call(client, 'create_doc_page', { data: { title: 'MCP instructions', markdown: '# From the IDE\n\nUseful reference.' }, idempotency_key: 'doc-create' });
  expect(JSON.stringify(await call(client, 'get_doc_page', { doc_page_id: doc.id }))).toContain('Useful reference.');
  expect((await call(client, 'search_doc_pages', { query: 'Useful' })).items.map((item: any) => item.id)).toContain(doc.id);

  for (let i = 0; i < 23; i++) await call(client, 'post_task_comment', { task_id: shortId, data: { body: `Message ${i}` }, idempotency_key: `comment-${i}` });
  const first = await call(client, 'list_comments', { task_id: shortId, limit: 20 });
  expect(first.comments).toHaveLength(20);
  expect(first.next_offset).toBe(20);
  expect((await call(client, 'list_comments', { task_id: shortId, offset: 20 })).comments).toHaveLength(3);
  const upload = async (data: Buffer, name: string, type: string) => {
    const response = await fetch(app.origin + '/api/uploads?name=' + name, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': type }, body: new Uint8Array(data) });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  };
  const file = await upload(Buffer.from('Привет from an attachment'), 'note.txt', 'text/plain');
  const png = await upload(await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer(), 'view.png', 'image/png');
  await call(client, 'post_task_comment', { task_id: card.id, data: { body: 'Files', attachmentIds: [file.id, png.id] }, idempotency_key: 'files' });
  expect((await call(client, 'list_attachments', { task_id: shortId })).attachments).toHaveLength(2);
  const chunk = await call(client, 'read_attachment', { task_id: shortId, attachment_id: file.id, max_bytes: 1 });
  expect(chunk).toMatchObject({ bytes: 1, encoding: 'base64', next_offset: 1 });
  expect((await call(client, 'read_attachment', { task_id: shortId, attachment_id: file.id })).data).toBe('Привет from an attachment');
  expect((await client.callTool({ name: 'view_attachment', arguments: { task_id: shortId, attachment_id: png.id } })).content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]));
  expect((await client.callTool({ name: 'read_attachment', arguments: { task_id: shortId, attachment_id: file.id, materialize: true } })).isError).toBe(true);
  const other = await call(client, 'create_task', creation('Other card'));
  expect((await client.callTool({ name: 'read_attachment', arguments: { task_id: other.id, attachment_id: file.id } })).isError).toBe(true);
  await call(client, 'archive_task', { task_id: shortId, idempotency_key: 'archive' });
  expect((await call(client, 'get_task', { task_id: shortId })).task.archived).toBe(true);
  expect((await app.api('/api/tasks/' + card.id)).runs).toEqual([]);
}, 20000);

test('concurrent clients and reconnects after restart reuse durable mutation receipts', async () => {
  const app = await start(), first = await app.connect(), second = await app.connect();
  const args = creation('Only once', 'across-clients');
  const results = await Promise.all([first, second].map(client => client.callTool({ name: 'create_task', arguments: args })));
  expect(results.some(result => !result.isError)).toBe(true);
  const card = await call(first, 'create_task', args);
  expect(await call(second, 'create_task', args)).toEqual(card);
  await first.close(); await second.close();
  await app.restart();
  const reconnected = await app.connect();
  expect(await call(reconnected, 'create_task', args)).toEqual(card);
  expect((await call(reconnected, 'list_tasks', { query: 'Only once' })).total).toBe(1);
  expect((await reconnected.callTool({ name: 'create_task', arguments: { ...args, data: { ...args.data, title: 'Changed after restart' } } })).isError).toBe(true);
}, 20000);

test('backup restore returns its receipt and the external client continues against the reopened database', async () => {
  const app = await start(), client = await app.connect();
  const saved = await call(client, 'create_task', creation('Before snapshot'));
  const backup = await call(client, 'create_backup', { idempotency_key: 'snapshot' });
  await call(client, 'create_task', creation('After snapshot'));
  expect(await call(client, 'restore_backup', { backup_id: backup.id, idempotency_key: 'restore' })).toEqual({ accepted: true, status: 'queued', action: 'restore_backup' });
  await waitFor(async () => (await app.api('/api/backups')).selectedId === backup.id);
  expect((await call(client, 'list_tasks')).items.map((item: any) => item.id)).toEqual([saved.id]);
  const next = await call(client, 'create_task', creation('After restore'));
  expect((await call(client, 'get_task', { task_id: next.id })).task.title).toBe('After restore');
  expect((await app.api('/api/tasks/' + next.id)).runs).toEqual([]);
}, 20000);
