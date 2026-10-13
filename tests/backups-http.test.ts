import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BackupEntry, BackupOverview, GeneralSettings, Task } from '../src/lib/types';
import { BACKUP_MAX_BYTES, BackupManager } from '../server/backups';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { Store } from '../server/store';

const servers: { child: ReturnType<typeof Bun.spawn>; folder: string }[] = [];
afterEach(async () => {
  const current = servers.splice(0);
  for (const { child } of current) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(current.map(({ child }) => child.exited));
  for (const folder of new Set(current.map(server => server.folder))) rmSync(folder, { recursive: true, force: true });
});

async function start(folder = mkdtempSync(join(tmpdir(), 'brigd-backup-http-'))) {
  const updateBackupDir = join(folder, 'update-backups');
  mkdirSync(updateBackupDir, { recursive: true });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
  Object.assign(env, { PORT: String(port), BRIGD_MODE: 'mock', BRIGD_DB: join(folder, 'app.sqlite'),
    BRIGD_UPDATE_BACKUP_DIR: updateBackupDir, BRIGD_HOST: '127.0.0.1', BRIGD_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    BRIGD_ALLOWED_ORIGINS: origin, BRIGD_CLI_HOME: join(folder, 'cli-home') });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../server/index.ts')], { env, stdout: 'pipe', stderr: 'pipe' });
  servers.push({ child, folder });
  const deadline = Date.now() + 8_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Backup test server failed: ${await new Response(child.stderr).text()}`);
    try { if ((await fetch(origin + '/api/info')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Backup test server startup timed out');
    await Bun.sleep(20);
  }
  const request = (path: string, method = 'GET', value: unknown = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value),
  });
  async function json<T>(path: string, method = 'GET', value: unknown = {}): Promise<T> {
    const response = await request(path, method, value);
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const task = (title: string, attachmentIds: string[] = []) => json<Task>('/api/tasks', 'POST', {
    title, instruction: 'Only mock execution.', provider: 'codex', cwd: folder,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, attachmentIds,
  });
  const upload = (bytes: Uint8Array, name: string, headers: Record<string, string> = {}) => fetch(origin + '/api/backups/upload', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-Backup-Name': encodeURIComponent(name), ...headers },
    body: new Uint8Array(bytes),
  });
  return { folder, origin, updateBackupDir, request, json, task, upload, child };
}

describe('backup HTTP lifecycle', () => {
  test('native server restores data and files, protects selection, and can recover the automatic safety copy', async () => {
    const app = await start();
    expect(await app.json<BackupOverview>('/api/backups')).toEqual({ backups: [], selectedId: null });
    const attachmentBytes = Buffer.from('Content included in the SQLite snapshot.');
    const attachmentResponse = await fetch(app.origin + '/api/uploads?name=backup-note.txt', {
      method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'text/plain' }, body: attachmentBytes,
    });
    expect(attachmentResponse.status).toBe(201);
    const attachment = await attachmentResponse.json();
    const original = await app.task('Original snapshot task', [attachment.id]);
    await app.json('/api/settings/general', 'PATCH', { defaultSchedule: 'interval' });
    const backup = await app.json<BackupEntry>('/api/backups', 'POST');
    const extra = await app.task('Created after snapshot');
    await app.json('/api/settings/general', 'PATCH', { defaultSchedule: 'auto' });
    const restored = await app.json<BackupEntry>(`/api/backups/${backup.id}/select`, 'POST');
    expect(restored.selected).toBe(true);
    expect((await app.json<Task[]>('/api/tasks')).map(task => task.id)).toEqual([original.id]);
    expect((await app.json<GeneralSettings>('/api/settings/general')).defaultSchedule).toBe('interval');
    const restoredFile = await app.request(`/api/tasks/${original.id}/attachments/${attachment.id}?download=1`);
    expect(Buffer.from(await restoredFile.arrayBuffer())).toEqual(attachmentBytes);
    expect((await app.request(`/api/backups/${backup.id}`, 'DELETE')).status).toBe(409);
    let overview = await app.json<BackupOverview>('/api/backups');
    expect(overview.selectedId).toBe(backup.id);
    const safety = overview.backups.find(entry => entry.id !== backup.id)!;
    expect(safety.name).toContain('Перед восстановлением');
    await app.json(`/api/backups/${safety.id}/select`, 'POST');
    expect(new Set((await app.json<Task[]>('/api/tasks')).map(task => task.id))).toEqual(new Set([original.id, extra.id]));
    expect((await app.json<GeneralSettings>('/api/settings/general')).defaultSchedule).toBe('auto');
    expect((await app.request(`/api/backups/${backup.id}`, 'DELETE')).status).toBe(200);
    overview = await app.json<BackupOverview>('/api/backups');
    expect(overview.selectedId).toBe(safety.id);
    expect(overview.backups.some(entry => entry.id === backup.id)).toBe(false);
    // Closing/reopening SQLite in this same PID must remove the copied lease,
    // and writes must use the new handler rather than the closed old Store.
    expect((await app.task('Writable after restore')).title).toBe('Writable after restore');
  }, 20_000);

  test('download/upload roundtrip and updater snapshots remain usable through restore', async () => {
    const app = await start();
    const original = await app.task('Update snapshot task');
    const backup = await app.json<BackupEntry>('/api/backups', 'POST');
    const download = await app.request(`/api/backups/${encodeURIComponent(backup.id)}/download`);
    expect(download.headers.get('content-type')).toBe('application/vnd.sqlite3');
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(download.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe('SQLite format 3\0');
    const head = await app.request(`/api/backups/${backup.id}/download`, 'HEAD');
    expect(Number(head.headers.get('content-length'))).toBe(bytes.length);
    expect(await head.text()).toBe('');
    const uploadedResponse = await app.upload(bytes, 'Мой бэкап.sqlite');
    expect(uploadedResponse.status).toBe(201);
    const uploaded: BackupEntry = await uploadedResponse.json();
    expect(uploaded).toMatchObject({ source: 'upload', name: 'Мой бэкап.sqlite', selected: false });
    writeFileSync(join(app.updateBackupDir, `${Date.now()}-fixture.sqlite`), bytes);
    const updater = (await app.json<BackupOverview>('/api/backups')).backups.find(entry => entry.source === 'update')!;
    expect(updater).toBeDefined();
    await app.task('Later data');
    await app.json(`/api/backups/${updater.id}/select`, 'POST');
    expect((await app.json<Task[]>('/api/tasks')).map(task => task.id)).toEqual([original.id]);
    expect((await app.request(`/api/backups/${updater.id}`, 'DELETE')).status).toBe(409);
    await app.json(`/api/backups/${encodeURIComponent(uploaded.id)}/select`, 'POST');
    expect((await app.request(`/api/backups/${updater.id}`, 'DELETE')).status).toBe(200);
    await app.task('Changes after selecting this backup');
    await app.json(`/api/backups/${encodeURIComponent(uploaded.id)}/select`, 'POST');
    expect((await app.json<Task[]>('/api/tasks')).map(task => task.id)).toEqual([original.id]);
    expect((await app.request(`/api/backups/${encodeURIComponent(uploaded.id)}`, 'DELETE')).status).toBe(409);
  }, 20_000);

  test('invalid uploads, absent origins and invalid selection leave current data intact', async () => {
    const app = await start();
    const original = await app.task('Keep current data');
    expect((await app.upload(Buffer.from('Not SQLite'), 'bad.sqlite')).status).toBe(400);
    expect((await app.upload(Buffer.alloc(0), 'empty.sqlite')).status).toBe(400);
    expect((await app.upload(Buffer.from('bad'), 'bad.sqlite', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await app.request('/api/backups/missing/select', 'POST')).status).toBe(404);
    expect((await app.request('/api/backups', 'POST', { extra: true })).status).toBe(400);
    expect((await fetch(app.origin + '/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.upload(Buffer.from('bad'), 'bad.sqlite', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.json<Task[]>('/api/tasks')).map(task => task.id)).toEqual([original.id]);
    expect((await app.json<BackupOverview>('/api/backups')).backups).toHaveLength(0);
  }, 20_000);

  test('upload body reader rejects an oversized declared body before creating a backup', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'brigd-backup-limit-'));
    const store = new Store(join(folder, 'app.sqlite'));
    const engine = new Engine(store, true);
    try {
      const handler = createHandler(engine, { port: 4310, root: folder });
      const response = await handler(new Request('http://127.0.0.1:4310/api/backups/upload', { method: 'POST',
        headers: { Origin: 'http://127.0.0.1:4310', 'Content-Type': 'application/octet-stream',
          'X-Backup-Name': 'huge.sqlite', 'Content-Length': String(BACKUP_MAX_BYTES + 1) }, body: 'x',
      }));
      expect(response.status).toBe(413);
    } finally { await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  test('failure to save the safety copy leaves the native server able to run workers', async () => {
    if (process.platform === 'win32') return;
    const app = await start();
    const task = await app.task('Continue after failed restoration');
    const backup = await app.json<BackupEntry>('/api/backups', 'POST');
    const backups = new BackupManager({ dbPath: join(app.folder, 'app.sqlite'), updateBackupDir: app.updateBackupDir });
    chmodSync(backups.directory, 0o500);
    try {
      const response = await app.request(`/api/backups/${backup.id}/select`, 'POST');
      expect(response.status).toBe(500);
      expect((await app.json<Task[]>('/api/tasks')).map(entry => entry.id)).toEqual([task.id]);
      expect((await app.request(`/api/tasks/${task.id}/run`, 'POST')).status).toBe(201);
    } finally { chmodSync(backups.directory, 0o700); }
  }, 20_000);
});

function snapshotTitles(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try { return (db.query('SELECT title FROM tasks ORDER BY title').all() as { title: string }[]).map(row => row.title); }
  finally { db.close(); }
}

test('selected backup auto update works without a browser and persists across native server restarts', async () => {
  const app = await start();
  await app.task('Original');
  const backup = await app.json<BackupEntry>('/api/backups', 'POST');
  const untouched = await app.json<BackupEntry>('/api/backups', 'POST');
  await app.json(`/api/backups/${backup.id}/select`, 'POST');
  await app.task('Before enabling');
  const enabled = await app.json<BackupEntry>(`/api/backups/${encodeURIComponent(backup.id)}`, 'PATCH', { autoUpdate: true });
  expect(enabled).toMatchObject({ id: backup.id, name: backup.name, createdAt: backup.createdAt, selected: true, autoUpdate: true });
  const backups = new BackupManager({ dbPath: join(app.folder, 'app.sqlite'), updateBackupDir: app.updateBackupDir });
  const path = backups.download(backup.id).path;
  expect(snapshotTitles(path)).toEqual(['Before enabling', 'Original']);
  await app.task('Background change');
  const deadline = Date.now() + 8_000;
  while (!snapshotTitles(path).includes('Background change')) {
    if (Date.now() > deadline) throw new Error('Selected backup was not automatically updated');
    await Bun.sleep(50);
  }
  expect(snapshotTitles(backups.download(untouched.id).path)).toEqual(['Original']);
  const selected = (await app.json<BackupOverview>('/api/backups')).backups.find(entry => entry.id === backup.id)!;
  expect(selected.updatedAt).toBeGreaterThanOrEqual(enabled.updatedAt);
  expect((await app.request(`/api/backups/${backup.id}`, 'DELETE')).status).toBe(409);
  // Shutdown must flush a final change even before the next five-second tick.
  await app.task('Shutdown change');
  app.child.kill('SIGTERM');
  await app.child.exited;
  expect(snapshotTitles(path)).toContain('Shutdown change');

  const restarted = await start(app.folder);
  expect((await restarted.json<BackupOverview>('/api/backups')).backups.find(entry => entry.id === backup.id)?.autoUpdate).toBe(true);
  await restarted.json(`/api/backups/${backup.id}`, 'PATCH', { autoUpdate: false });
  await restarted.task('Disabled change');
  restarted.child.kill('SIGTERM');
  await restarted.child.exited;
  expect(snapshotTitles(path)).not.toContain('Disabled change');
  expect(backups.getAutoUpdate()).toEqual({ selectedId: backup.id, enabled: false });
}, 20_000);

test('auto update PATCH validates selected backup and payload and resets for a different selection', async () => {
  const app = await start();
  await app.task('Original');
  const first = await app.json<BackupEntry>('/api/backups', 'POST');
  const other = await app.json<BackupEntry>('/api/backups', 'POST');
  expect((await app.request(`/api/backups/${first.id}`, 'PATCH', { autoUpdate: true })).status).toBe(409);
  await app.json(`/api/backups/${first.id}/select`, 'POST');
  for (const value of [{}, { autoUpdate: 'true' }, { autoUpdate: null }, { autoUpdate: true, extra: true }]) {
    expect((await app.request(`/api/backups/${first.id}`, 'PATCH', value)).status).toBe(400);
  }
  expect((await app.request(`/api/backups/${other.id}`, 'PATCH', { autoUpdate: true })).status).toBe(409);
  await app.json(`/api/backups/${first.id}`, 'PATCH', { autoUpdate: true });
  await app.json(`/api/backups/${first.id}/select`, 'POST');
  expect((await app.json<BackupOverview>('/api/backups')).backups.find(entry => entry.id === first.id)?.autoUpdate).toBe(true);
  await app.json(`/api/backups/${other.id}/select`, 'POST');
  const overview = await app.json<BackupOverview>('/api/backups');
  expect(overview.selectedId).toBe(other.id);
  expect(overview.backups.every(entry => entry.autoUpdate === false)).toBe(true);
}, 15_000);
