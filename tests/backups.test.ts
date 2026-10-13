import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_MAX_BYTES, BackupManager, validateBackup } from '../server/backups';
import { AppError } from '../server/errors';
import { Store } from '../server/store';
import { prepareAttachment } from '../server/attachments';

let folder: string, path: string, updateBackupDir: string, store: Store, backups: BackupManager;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-backups-'));
  path = join(folder, 'app.sqlite');
  updateBackupDir = join(folder, '.brigd-updates', 'backup');
  store = new Store(path);
  backups = new BackupManager({ dbPath: path, updateBackupDir });
});
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
function status(action: () => unknown, expected: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(expected); }
}
function task(title = 'Before backup', attachmentIds?: string[]) {
  return store.createTask({ title, instruction: 'Inspect safely', provider: 'codex', cwd: folder, schedule: 'manual',
    intervalMinutes: null, firstRunAt: null, paused: false, attachmentIds });
}
function snapshotRows(id: string, query: string) {
  const db = new Database(backups.download(id).path, { readonly: true });
  try { return db.query(query).all(); } finally { db.close(); }
}

test('manual backups contain committed WAL data, settings and attachment bytes in a standalone snapshot', async () => {
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  const file = store.stageAttachment(await prepareAttachment(Buffer.from('saved attachment'), 'text/plain', 'note.txt'));
  const saved = task('Before backup', [file.id]);
  store.db.query('UPDATE general_settings SET default_cwd=? WHERE singleton=1').run(folder);
  const backup = backups.create();
  expect(backup).toMatchObject({ source: 'manual', selected: false });
  expect(backup.size).toBeGreaterThan(100);
  expect(backups.list()).toEqual({ backups: [backup], selectedId: null });
  task('After backup');
  const downloaded = backups.download(backup.id);
  validateBackup(downloaded.path);
  const db = new Database(downloaded.path, { readonly: true });
  try {
    expect(db.query('SELECT id,title FROM tasks').all()).toEqual([{ id: saved.id, title: 'Before backup' }]);
    expect(db.query('SELECT default_cwd FROM general_settings').get()).toEqual({ default_cwd: folder });
    expect(Buffer.from((db.query('SELECT data FROM attachments WHERE id=?').get(file.id) as { data: Uint8Array }).data).toString()).toBe('saved attachment');
  } finally { db.close(); }
  if (process.platform !== 'win32') {
    expect(statSync(downloaded.path).mode & 0o777).toBe(0o600);
    expect(statSync(backups.directory).mode & 0o777).toBe(0o700);
  }
});

test('upload preserves snapshot bytes and display name without opening it through Store migrations', () => {
  task();
  store.db.exec('UPDATE autopilot SET enabled=1 WHERE singleton=1');
  const original = backups.create();
  const bytes = readFileSync(backups.download(original.id).path);
  const imported = backups.upload(bytes, 'резервная копия.sqlite');
  expect(imported).toMatchObject({ name: 'резервная копия.sqlite', source: 'upload', selected: false, size: bytes.length });
  const downloaded = backups.download(imported.id);
  expect(downloaded.name).toBe('резервная копия.sqlite');
  expect(readFileSync(downloaded.path)).toEqual(bytes);
  const db = new Database(downloaded.path, { readonly: true });
  try { expect(db.query('SELECT enabled FROM autopilot').get()).toEqual({ enabled: 1 }); }
  finally { db.close(); }
  const reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.list().backups.find(entry => entry.id === imported.id)).toEqual(imported);
});

test('uploads reject non-SQLite, corrupt or unrelated SQLite and leave no files behind', () => {
  const before = readdirSync(backups.directory);
  status(() => backups.upload(Buffer.from('not sqlite'), 'bad.sqlite'), 400);
  const unrelatedPath = join(folder, 'other.sqlite');
  const unrelated = new Database(unrelatedPath, { create: true });
  unrelated.exec('CREATE TABLE tasks (id TEXT)');
  unrelated.close();
  status(() => backups.upload(readFileSync(unrelatedPath), 'unrelated.sqlite'), 400);
  const valid = backups.create();
  const corrupt = readFileSync(backups.download(valid.id).path).subarray(0, 150);
  const afterCreate = readdirSync(backups.directory).sort();
  status(() => backups.upload(corrupt, 'truncated.sqlite'), 400);
  expect(readdirSync(backups.directory).sort()).toEqual(afterCreate);
  expect(before).toEqual([]);
});

test('uploads enforce size and safe names before writing to disk', () => {
  status(() => backups.upload(new Uint8Array(BACKUP_MAX_BYTES + 1), 'large.sqlite'), 413);
  for (const name of ['../outside.sqlite', '/tmp/outside.sqlite', 'C:\\outside.sqlite', 'line\n.sqlite', 'a\0.sqlite', '', '..']) {
    status(() => backups.upload(Buffer.from('SQLite'), name), 400);
  }
  expect(readdirSync(backups.directory)).toEqual([]);
});

test('explicit selection persists independently of database snapshots and protects deletion on the server', () => {
  const first = backups.create('Перед восстановлением.sqlite');
  const second = backups.create();
  expect(backups.select(first.id)).toEqual({ ...first, selected: true });
  let reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.list().selectedId).toBe(first.id);
  status(() => reopened.delete(first.id), 409);
  expect(existsSync(reopened.download(first.id).path)).toBe(true);
  reopened.select(second.id);
  reopened.delete(first.id);
  reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.list()).toEqual({ backups: [{ ...second, selected: true }], selectedId: second.id });
  status(() => reopened.delete(second.id), 409);
  status(() => reopened.download(first.id), 404);
});

test('clearing selection survives reopening and permits deletion after a restoration rollback', () => {
  const saved = backups.create();
  backups.select(saved.id);
  status(() => backups.delete(saved.id), 409);
  backups.clearSelection();
  const reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.list()).toEqual({ backups: [saved], selectedId: null });
  reopened.delete(saved.id);
  expect(reopened.list()).toEqual({ backups: [], selectedId: null });
});

test('update backups join the same list and support download, selection and protected deletion', () => {
  mkdirSync(updateBackupDir, { recursive: true });
  const firstPath = join(updateBackupDir, '1700000000000-update.sqlite');
  const secondPath = join(updateBackupDir, '1700000000001-update.sqlite');
  store.db.query('VACUUM INTO ?').run(firstPath);
  copyFileSync(firstPath, secondPath);
  writeFileSync(join(updateBackupDir, 'notes.txt'), 'ignored');
  const manual = backups.create();
  const overview = backups.list();
  expect(overview.backups).toHaveLength(3);
  expect(overview.backups[0]!.id).toBe(manual.id);
  const updates = overview.backups.filter(entry => entry.source === 'update');
  expect(updates.map(entry => entry.createdAt)).toEqual([1700000000001, 1700000000000]);
  expect(backups.download(updates[0]!.id).path).toBe(secondPath);
  backups.validate(updates[0]!.id);
  backups.select(updates[0]!.id);
  status(() => backups.delete(updates[0]!.id), 409);
  backups.delete(updates[1]!.id);
  expect(existsSync(firstPath)).toBe(false);
  expect(backups.list().backups.filter(entry => entry.source === 'update')).toHaveLength(1);
});

test('opaque IDs reject paths, alternate sources and symlinked backup files', () => {
  const saved = backups.create();
  const downloaded = backups.download(saved.id);
  const encodedTraversal = `update:${Buffer.from('../app.sqlite').toString('base64url')}`;
  for (const id of ['../app.sqlite', path, encodedTraversal, saved.id.replace('manual:', 'upload:'), `${saved.id}=`, 'update:Li4']) {
    status(() => backups.download(id), 404);
    status(() => backups.select(id), 404);
    status(() => backups.delete(id), 404);
  }
  rmSync(downloaded.path);
  symlinkSync(path, downloaded.path);
  expect(backups.list().backups).toEqual([]);
  status(() => backups.download(saved.id), 404);
  status(() => backups.validate(saved.id), 404);
  status(() => backups.select(saved.id), 404);
  status(() => backups.delete(saved.id), 404);
  expect(existsSync(path)).toBe(true);
  mkdirSync(updateBackupDir, { recursive: true });
  const linkedName = '1700000000000-link.sqlite';
  symlinkSync(path, join(updateBackupDir, linkedName));
  expect(backups.list().backups).toEqual([]);
  status(() => backups.download(`update:${Buffer.from(linkedName).toString('base64url')}`), 404);
});

test('symlinked backup directories are not followed', () => {
  mkdirSync(updateBackupDir, { recursive: true });
  store.db.query('VACUUM INTO ?').run(join(updateBackupDir, '1700000000000-update.sqlite'));
  const updateAlias = join(folder, 'linked-updates');
  symlinkSync(updateBackupDir, updateAlias);
  const linked = new BackupManager({ dbPath: path, updateBackupDir: updateAlias });
  expect(linked.list()).toEqual({ backups: [], selectedId: null });
  rmSync(backups.directory, { recursive: true });
  symlinkSync(updateBackupDir, backups.directory);
  expect(() => new BackupManager({ dbPath: path, updateBackupDir })).toThrow(AppError);
});

test('a damaged or symlinked selection manifest fails closed instead of allowing deletion', () => {
  const saved = backups.create();
  backups.select(saved.id);
  const state = join(backups.directory, 'state.json');
  const original = readFileSync(state);
  writeFileSync(state, '{ damaged');
  status(() => backups.delete(saved.id), 500);
  status(() => backups.select(saved.id), 500);
  expect(existsSync(join(backups.directory, Buffer.from(saved.id.split(':')[1]!, 'base64url').toString()))).toBe(true);
  const outside = join(folder, 'state-copy.json');
  writeFileSync(outside, original);
  rmSync(state);
  symlinkSync(outside, state);
  status(() => backups.delete(saved.id), 500);
  expect(readFileSync(outside)).toEqual(original);
});

test('two databases in one directory keep backup files and selection separate', () => {
  const first = backups.create();
  backups.select(first.id);
  const otherPath = join(folder, 'second.sqlite');
  const otherStore = new Store(otherPath);
  try {
    const other = new BackupManager({ dbPath: otherPath, updateBackupDir });
    expect(other.directory).not.toBe(backups.directory);
    expect(other.list()).toEqual({ backups: [], selectedId: null });
    status(() => other.download(first.id), 404);
  } finally { otherStore.close(); }
});

test('older application snapshots without additive settings or attachments tables remain compatible', () => {
  const legacyPath = join(folder, 'legacy.sqlite');
  const db = new Database(legacyPath, { create: true });
  db.exec(`
    CREATE TABLE workers (id TEXT PRIMARY KEY,name TEXT,provider TEXT,effort TEXT,communication_style TEXT,avatar_url TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,instruction TEXT,provider TEXT,cwd TEXT,schedule TEXT,interval_minutes INTEGER,first_run_at INTEGER,next_run_at INTEGER,paused INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE runs (id TEXT PRIMARY KEY,task_id TEXT,provider TEXT,cwd TEXT,instruction TEXT,trigger TEXT,scheduled_for INTEGER,status TEXT,session_id TEXT,started_at INTEGER,updated_at INTEGER,finished_at INTEGER,summary TEXT,error TEXT,turn INTEGER,mock INTEGER);
    CREATE TABLE comments (seq INTEGER PRIMARY KEY,id TEXT,task_id TEXT,run_id TEXT,kind TEXT,body TEXT,created_at INTEGER);
  `);
  db.close();
  expect(backups.upload(readFileSync(legacyPath), 'legacy.sqlite')).toMatchObject({ source: 'upload', name: 'legacy.sqlite' });
});

test('legacy manifests opt out of auto-update while preserving the selected backup and names', () => {
  const saved = backups.create('Старый бэкап.sqlite');
  writeFileSync(join(backups.directory, 'state.json'), JSON.stringify({ version: 1, selectedId: saved.id,
    names: { [saved.id]: saved.name } }));
  const reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.getAutoUpdate()).toEqual({ selectedId: saved.id, enabled: false });
  expect(reopened.list().backups).toEqual([{ ...saved, selected: true, autoUpdate: false }]);
  expect(reopened.updateSelected()).toBeNull();
  status(() => reopened.delete(saved.id), 409);
});

test('auto-update toggles require a boolean and the selected backup, and persist outside the database', () => {
  const first = backups.create();
  const second = backups.create();
  expect(backups.getAutoUpdate()).toEqual({ selectedId: null, enabled: false });
  status(() => backups.setAutoUpdate(first.id, true), 409);
  backups.select(first.id);
  for (const value of [null, undefined, 1, 'true', {}, []]) status(() => backups.setAutoUpdate(first.id, value), 400);
  status(() => backups.setAutoUpdate(second.id, true), 409);
  expect(backups.setAutoUpdate(first.id, true)).toMatchObject({ selected: true, autoUpdate: true });
  const reopened = new BackupManager({ dbPath: path, updateBackupDir });
  expect(reopened.getAutoUpdate()).toEqual({ selectedId: first.id, enabled: true });
  expect(reopened.list().backups.find(entry => entry.id === second.id)?.autoUpdate).toBe(false);
  expect(reopened.setAutoUpdate(first.id, false)).toMatchObject({ autoUpdate: false });
  expect(new BackupManager({ dbPath: path, updateBackupDir }).getAutoUpdate()).toEqual({ selectedId: first.id, enabled: false });
});

test('enabling immediately refreshes the same selected file with current WAL data, settings and attachments', async () => {
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  task('Original task');
  const selected = backups.create('Рабочий бэкап.sqlite');
  const historical = backups.create();
  const originalPath = backups.download(selected.id).path;
  const historicalBytes = readFileSync(backups.download(historical.id).path);
  backups.select(selected.id);
  const file = store.stageAttachment(await prepareAttachment(Buffer.from('live attachment'), 'text/plain', 'live.txt'));
  const added = task('Latest task', [file.id]);
  store.db.query('UPDATE general_settings SET default_cwd=? WHERE singleton=1').run(folder);
  store.db.exec('UPDATE autopilot SET enabled=1 WHERE singleton=1');
  utimesSync(originalPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const updated = backups.setAutoUpdate(selected.id, true);
  expect(backups.download(updated.id).path).toBe(originalPath);
  expect(updated).toMatchObject({ id: selected.id, name: selected.name, source: selected.source,
    createdAt: selected.createdAt, selected: true, autoUpdate: true });
  expect(updated.updatedAt).toBeGreaterThan(1_700_000_000_000);
  expect(snapshotRows(updated.id, 'SELECT title FROM tasks ORDER BY title')).toEqual([{ title: 'Latest task' }, { title: 'Original task' }]);
  expect(snapshotRows(updated.id, 'SELECT default_cwd FROM general_settings')).toEqual([{ default_cwd: folder }]);
  expect(snapshotRows(updated.id, 'SELECT enabled FROM autopilot')).toEqual([{ enabled: 1 }]);
  const attachments = snapshotRows(updated.id, 'SELECT task_id,data FROM attachments') as { task_id: string; data: Uint8Array }[];
  expect(attachments).toHaveLength(1);
  expect(attachments[0]!.task_id).toBe(added.id);
  expect(Buffer.from(attachments[0]!.data).toString()).toBe('live attachment');
  expect(readFileSync(backups.download(historical.id).path)).toEqual(historicalBytes);
  expect(backups.list().backups).toHaveLength(2);
  if (process.platform !== 'win32') expect(statSync(originalPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(backups.directory).filter(name => name.startsWith('.'))).toEqual([]);
});

test('refresh follows subsequent changes while disabling freezes the last selected snapshot', () => {
  task('Initial');
  const saved = backups.create();
  backups.select(saved.id);
  backups.setAutoUpdate(saved.id, true);
  task('Automatically saved');
  expect(backups.updateSelected()).toMatchObject({ id: saved.id, autoUpdate: true });
  expect(snapshotRows(saved.id, 'SELECT COUNT(*) AS count FROM tasks')).toEqual([{ count: 2 }]);
  const bytes = readFileSync(backups.download(saved.id).path);
  task('Not saved after disabling');
  backups.setAutoUpdate(saved.id, false);
  expect(backups.updateSelected()).toBeNull();
  expect(readFileSync(backups.download(saved.id).path)).toEqual(bytes);
});

test('imported and application-update backups support refresh without changing identity or creation time', () => {
  task('Initial');
  const original = backups.create();
  const imported = backups.upload(readFileSync(backups.download(original.id).path), 'Загруженный.sqlite');
  mkdirSync(updateBackupDir, { recursive: true });
  const updatePath = join(updateBackupDir, 'before-upgrade.sqlite');
  copyFileSync(backups.download(original.id).path, updatePath);
  utimesSync(updatePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const update = backups.list().backups.find(entry => entry.source === 'update')!;
  for (const selected of [imported, update]) {
    backups.select(selected.id);
    const selectedPath = backups.download(selected.id).path;
    task(`Before enabling ${selected.source}`);
    const enabled = backups.setAutoUpdate(selected.id, true);
    expect(enabled).toMatchObject({ id: selected.id, name: selected.name, source: selected.source, createdAt: selected.createdAt });
    expect(backups.download(selected.id).path).toBe(selectedPath);
    task(`After enabling ${selected.source}`);
    const refreshed = backups.updateSelected()!;
    expect(refreshed.createdAt).toBe(selected.createdAt);
    expect(snapshotRows(selected.id, 'SELECT title FROM tasks WHERE title LIKE \'After enabling %\'')).toContainEqual({ title: `After enabling ${selected.source}` });
    const reopened = new BackupManager({ dbPath: path, updateBackupDir });
    expect(reopened.list().backups.find(entry => entry.id === selected.id)).toEqual(refreshed);
    if (process.platform !== 'win32') expect(statSync(selectedPath).mode & 0o777).toBe(0o600);
  }
  expect(readdirSync(updateBackupDir)).toEqual(['before-upgrade.sqlite']);
});

test('reselecting retains auto-update, switching resets it, and rollback can restore it without refreshing', () => {
  task('Initial');
  const first = backups.create();
  const second = backups.create();
  backups.select(first.id);
  backups.setAutoUpdate(first.id, true);
  const bytes = readFileSync(backups.download(first.id).path);
  task('Live data');
  expect(backups.select(first.id).autoUpdate).toBe(true);
  expect(readFileSync(backups.download(first.id).path)).toEqual(bytes);
  expect(backups.select(second.id).autoUpdate).toBe(false);
  expect(backups.getAutoUpdate()).toEqual({ selectedId: second.id, enabled: false });
  expect(backups.select(first.id, true).autoUpdate).toBe(true);
  expect(readFileSync(backups.download(first.id).path)).toEqual(bytes);
  backups.clearSelection();
  expect(backups.getAutoUpdate()).toEqual({ selectedId: null, enabled: false });
  expect(backups.updateSelected()).toBeNull();
  backups.delete(first.id);
});

test('a failed snapshot refresh preserves the last valid file, selection and auto-update flag', () => {
  task('Saved');
  const saved = backups.create();
  backups.select(saved.id);
  backups.setAutoUpdate(saved.id, true);
  const bytes = readFileSync(backups.download(saved.id).path);
  const files = readdirSync(backups.directory).sort();
  const actualDatabase = join(folder, 'held.sqlite');
  store.close();
  renameSync(path, actualDatabase);
  writeFileSync(path, 'broken source database');
  try { status(() => backups.updateSelected(), 500); }
  finally { rmSync(path); renameSync(actualDatabase, path); store = new Store(path); }
  expect(readFileSync(backups.download(saved.id).path)).toEqual(bytes);
  expect(readdirSync(backups.directory).sort()).toEqual(files);
  expect(backups.getAutoUpdate()).toEqual({ selectedId: saved.id, enabled: true });
  backups.validate(saved.id);
});

test('a failed manifest commit when enabling preserves the previous snapshot and disabled flag', () => {
  task('Saved');
  const saved = backups.create();
  backups.select(saved.id);
  const bytes = readFileSync(backups.download(saved.id).path);
  const files = readdirSync(backups.directory).sort();
  task('Changed but not saved');
  const internals = backups as unknown as { writeState: (state: unknown) => void };
  const writer = internals.writeState;
  internals.writeState = () => { throw new Error('Disk write failed'); };
  try { status(() => backups.setAutoUpdate(saved.id, true), 500); }
  finally { internals.writeState = writer; }
  expect(readFileSync(backups.download(saved.id).path)).toEqual(bytes);
  expect(readdirSync(backups.directory).sort()).toEqual(files);
  expect(backups.getAutoUpdate()).toEqual({ selectedId: saved.id, enabled: false });
});

test('a durability failure after replacement rolls back to the previous valid snapshot', () => {
  if (process.platform === 'win32') return;
  task('Saved');
  const saved = backups.create();
  backups.select(saved.id);
  backups.setAutoUpdate(saved.id, true);
  const bytes = readFileSync(backups.download(saved.id).path);
  const files = readdirSync(backups.directory).sort();
  task('Changed');
  const originalSync = fs.fsyncSync;
  let calls = 0;
  const syncing = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (++calls === 2) throw new Error('Directory fsync failed');
    return originalSync(fd);
  });
  try { status(() => backups.updateSelected(), 500); }
  finally { syncing.mockRestore(); }
  expect(calls).toBe(3);
  expect(readFileSync(backups.download(saved.id).path)).toEqual(bytes);
  expect(readdirSync(backups.directory).sort()).toEqual(files);
  expect(backups.getAutoUpdate()).toEqual({ selectedId: saved.id, enabled: true });
  backups.validate(saved.id);
});

test('auto-update rejects replaced symlink files and directories without touching their targets', () => {
  const saved = backups.create();
  backups.select(saved.id);
  backups.setAutoUpdate(saved.id, true);
  const selectedPath = backups.download(saved.id).path;
  const outside = join(folder, 'outside.sqlite');
  const bytes = readFileSync(selectedPath);
  writeFileSync(outside, bytes);
  rmSync(selectedPath);
  symlinkSync(outside, selectedPath);
  status(() => backups.updateSelected(), 404);
  status(() => backups.setAutoUpdate(saved.id, true), 404);
  expect(readFileSync(outside)).toEqual(bytes);
  rmSync(backups.directory, { recursive: true });
  const linkedDirectory = join(folder, 'outside-backups');
  mkdirSync(linkedDirectory);
  symlinkSync(linkedDirectory, backups.directory);
  status(() => backups.getAutoUpdate(), 500);
  status(() => backups.updateSelected(), 500);
  expect(readdirSync(linkedDirectory)).toEqual([]);
});

test('malformed auto-update values in the manifest fail closed', () => {
  const saved = backups.create();
  backups.select(saved.id);
  const statePath = join(backups.directory, 'state.json');
  const manifest = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const autoUpdate of [null, 'true', 1, {}, []]) {
    writeFileSync(statePath, JSON.stringify({ ...manifest, autoUpdate }));
    status(() => backups.getAutoUpdate(), 500);
    status(() => backups.updateSelected(), 500);
  }
  writeFileSync(statePath, JSON.stringify({ ...manifest, selectedId: null, autoUpdate: true }));
  status(() => backups.getAutoUpdate(), 500);
});
