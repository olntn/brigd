import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAttachment } from '../server/attachments';
import { installDatabaseBackup, restoreBackup, type BackupRestoreRuntime } from '../server/backup-restore';
import { BackupManager } from '../server/backups';
import { Store } from '../server/store';

interface Fixture {
  folder: string;
  path: string;
  dbPath: string;
  backups: BackupManager;
  events: string[];
  runtime: BackupRestoreRuntime;
  readonly store: Store;
}
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.runtime.close();
    rmSync(f.folder, { recursive: true, force: true });
  }
});

function fixture(alias = false): Fixture {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-backup-restore-'));
  const path = join(folder, 'app.sqlite');
  let store = new Store(path);
  let lease = store.acquireLease();
  let open = true;
  const dbPath = alias ? join(folder, 'alias.sqlite') : path;
  if (alias) symlinkSync(path, dbPath);
  const events: string[] = [];
  const backups = new BackupManager({ dbPath, updateBackupDir: join(folder, 'updates') });
  const runtime: BackupRestoreRuntime = {
    dbPath,
    async pause() { events.push('pause'); },
    close() {
      events.push('close');
      if (open) {
        store.releaseLease(lease);
        store.close();
        open = false;
      }
    },
    open() {
      events.push('open');
      const next = new Store(dbPath);
      try { lease = next.acquireLease(); } catch (error) { next.close(); throw error; }
      store = next;
      open = true;
    },
    resume() { events.push('resume'); },
  };
  const f = { folder, path, dbPath, backups, events, runtime, get store() { return store; } };
  fixtures.push(f);
  return f;
}

async function addTask(f: Fixture, title: string, body: string) {
  const file = f.store.stageAttachment(await prepareAttachment(Buffer.from(body), 'text/plain', `${title}.txt`));
  const task = f.store.createTask({ title, instruction: 'Inspect files', provider: 'codex', cwd: f.folder,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, attachmentIds: [file.id] });
  f.store.comment(task.id, null, 'user', `${title} comment`);
  return { task, file };
}

function snapshot<T>(path: string, action: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try { return action(db); } finally { db.close(); }
}

function expectNoTemporaryFiles(f: Fixture) {
  expect(readdirSync(f.folder).filter(name => name.startsWith('.brigd-restore-') || name.includes('.restore-'))).toEqual([]);
}

test('selecting a snapshot restores tasks, comments, settings and attachment bytes, with a durable selected marker', async () => {
  const f = fixture();
  const old = await addTask(f, 'Before', 'old attachment');
  f.store.setDefaultCwd('/tmp');
  f.store.setDefaultSchedule('interval');
  f.store.setCliAccessMode('standard');
  const target = f.backups.create('before.sqlite');
  const originalBytes = readFileSync(f.backups.download(target.id).path);
  const later = await addTask(f, 'After', 'current attachment');
  f.store.setDefaultCwd(f.folder);
  f.store.setDefaultSchedule('auto');
  f.store.setCliAccessMode('full');
  const originalCreate = f.backups.create.bind(f.backups);
  f.backups.create = name => { f.events.push('snapshot'); return originalCreate(name); };
  f.runtime.pause = async () => {
    f.events.push('pause');
    f.store.comment(later.task.id, null, 'system', 'Worker stopped');
  };

  await restoreBackup(f.backups, target.id, f.runtime);

  expect(f.events).toEqual(['pause', 'snapshot', 'close', 'open', 'resume']);
  expect(f.store.listTasks().map(task => task.id)).toEqual([old.task.id]);
  expect(f.store.detail(old.task.id).comments.map(comment => comment.body)).toEqual(['Before comment']);
  expect(Buffer.from(f.store.readAttachment(old.task.id, old.file.id).data).toString()).toBe('old attachment');
  expect(f.store.getDefaultCwd()).toBe('/tmp');
  expect(f.store.getDefaultSchedule()).toBe('interval');
  expect(f.store.getCliAccessMode()).toBe('standard');
  expect(readFileSync(f.backups.download(target.id).path)).toEqual(originalBytes);
  const persisted = new BackupManager({ dbPath: f.dbPath, updateBackupDir: join(f.folder, 'updates') });
  expect(persisted.list()).toMatchObject({ selectedId: target.id });
  expect(persisted.list().backups.find(backup => backup.id === target.id)?.selected).toBe(true);
  expect(() => persisted.delete(target.id)).toThrow('удалить нельзя');
  const rollback = persisted.list().backups.find(backup => backup.id !== target.id)!;
  expect(rollback.name).toStartWith('Перед восстановлением — ');
  const previous = persisted.download(rollback.id).path;
  expect(snapshot(previous, db => db.query('SELECT title FROM tasks ORDER BY created_at,id').all())).toHaveLength(2);
  expect(snapshot(previous, db => db.query("SELECT body FROM comments WHERE body='Worker stopped'").get())).toEqual({ body: 'Worker stopped' });
  expect(snapshot(previous, db => db.query('SELECT default_schedule FROM general_settings').get())).toEqual({ default_schedule: 'auto' });
  expectNoTemporaryFiles(f);
});

test('restoring a copied live lease succeeds and preserves the database symlink and permissions', async () => {
  const f = fixture(true);
  await addTask(f, 'Selected', 'retained bytes');
  chmodSync(f.path, 0o640);
  const target = f.backups.create();
  expect(snapshot(f.backups.download(target.id).path, db => db.query('SELECT pid FROM service_lease').get())).toEqual({ pid: process.pid });
  await addTask(f, 'Later', 'discarded bytes');
  const close = f.runtime.close;
  f.runtime.close = () => {
    close();
    // These are from the retired inode and must disappear before the replacement opens.
    writeFileSync(`${f.path}-wal`, 'stale WAL');
    writeFileSync(`${f.path}-shm`, 'stale SHM');
  };

  await restoreBackup(f.backups, target.id, f.runtime);

  expect(lstatSync(f.dbPath).isSymbolicLink()).toBe(true);
  expect(statSync(f.path).mode & 0o777).toBe(0o640);
  expect(f.store.listTasks().map(task => task.title)).toEqual(['Selected']);
  expect(f.store.db.query('SELECT pid FROM service_lease').get()).toEqual({ pid: process.pid });
  expectNoTemporaryFiles(f);
});

test('a corrupt snapshot is rejected before any running service is paused', async () => {
  const f = fixture();
  await addTask(f, 'Current', 'current bytes');
  const selected = f.backups.create();
  f.backups.select(selected.id);
  const corrupt = f.backups.create();
  writeFileSync(f.backups.download(corrupt.id).path, 'not SQLite');

  await expect(restoreBackup(f.backups, corrupt.id, f.runtime)).rejects.toThrow('повреждён');

  expect(f.events).toEqual([]);
  expect(f.store.listTasks().map(task => task.title)).toEqual(['Current']);
  expect(f.backups.list().selectedId).toBe(selected.id);
  expectNoTemporaryFiles(f);
});

test('schema migration failure is detected on a temporary copy before pausing', async () => {
  const f = fixture();
  await addTask(f, 'Current', 'current bytes');
  const target = f.backups.create();
  const path = f.backups.download(target.id).path;
  const db = new Database(path);
  db.exec('DROP TABLE task_logs; CREATE TABLE task_logs (id TEXT)');
  db.close();
  f.backups.validate(target.id);
  const bytes = readFileSync(path);

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('несовместим');

  expect(f.events).toEqual([]);
  expect(f.store.listTasks().map(task => task.title)).toEqual(['Current']);
  expect(readFileSync(path)).toEqual(bytes);
  expect(f.backups.list().selectedId).toBeNull();
  expectNoTemporaryFiles(f);
});

test('an open failure rolls back all current data and leaves the selected marker intact', async () => {
  const f = fixture();
  await addTask(f, 'Before', 'old bytes');
  const target = f.backups.create();
  const current = await addTask(f, 'Current', 'current bytes');
  f.store.setDefaultSchedule('auto');
  f.store.setDefaultCwd(f.folder);
  f.store.setCliAccessMode('full');
  const selected = f.backups.create();
  f.backups.select(selected.id);
  const open = f.runtime.open;
  let attempts = 0;
  f.runtime.open = () => { if (++attempts === 1) { f.events.push('open failed'); throw new Error('Injected open failure'); } open(); };

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('Предыдущие данные сохранены');

  expect(f.events).toEqual(['pause', 'close', 'open failed', 'close', 'open', 'resume']);
  expect(new Set(f.store.listTasks().map(task => task.title))).toEqual(new Set(['Before', 'Current']));
  expect(f.store.detail(current.task.id).comments.map(comment => comment.body)).toEqual(['Current comment']);
  expect(Buffer.from(f.store.readAttachment(current.task.id, current.file.id).data).toString()).toBe('current bytes');
  expect(f.store.getDefaultSchedule()).toBe('auto');
  expect(f.store.getDefaultCwd()).toBe(f.folder);
  expect(f.store.getCliAccessMode()).toBe('full');
  expect(f.backups.list().selectedId).toBe(selected.id);
  expect(f.backups.list().backups).toHaveLength(3);
  expectNoTemporaryFiles(f);
});

test('a selected-marker write failure rolls back the newly opened database', async () => {
  const f = fixture();
  await addTask(f, 'Before', 'old bytes');
  const target = f.backups.create();
  await addTask(f, 'Current', 'current bytes');
  const selected = f.backups.create();
  f.backups.select(selected.id);
  const select = f.backups.select.bind(f.backups);
  f.backups.select = id => { if (id === target.id) throw new Error('Cannot persist selection'); return select(id); };

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('Предыдущие данные сохранены');

  expect(f.events).toEqual(['pause', 'close', 'open', 'close', 'open', 'resume']);
  expect(f.store.listTasks()).toHaveLength(2);
  expect(f.backups.list().selectedId).toBe(selected.id);
  expectNoTemporaryFiles(f);
});

test.each([true, false])('an activation failure rolls back data and selection (previous selection: %s)', async previousSelection => {
  const f = fixture();
  await addTask(f, 'Before', 'old bytes');
  const target = f.backups.create();
  const current = await addTask(f, 'Current', 'current bytes');
  f.store.setDefaultSchedule('auto');
  const selected = previousSelection ? f.backups.create() : null;
  if (selected) f.backups.select(selected.id);
  const resume = f.runtime.resume;
  let attempts = 0;
  f.runtime.resume = () => { if (++attempts === 1) { f.events.push('resume failed'); throw new Error('Scheduler startup failed'); } resume(); };

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('Предыдущие данные сохранены');

  expect(f.events).toEqual(['pause', 'close', 'open', 'resume failed', 'pause', 'close', 'open', 'resume']);
  expect(f.store.listTasks()).toHaveLength(2);
  expect(Buffer.from(f.store.readAttachment(current.task.id, current.file.id).data).toString()).toBe('current bytes');
  expect(f.store.getDefaultSchedule()).toBe('auto');
  expect(f.backups.list().selectedId).toBe(selected?.id ?? null);
  const reopened = new BackupManager({ dbPath: f.dbPath, updateBackupDir: join(f.folder, 'updates') });
  expect(reopened.list().selectedId).toBe(selected?.id ?? null);
  expectNoTemporaryFiles(f);
});

test('a corrupt integration snapshot is rejected during staged scheduler reconciliation', async () => {
  const f = fixture();
  const { task } = await addTask(f, 'Current', 'current bytes');
  const run = f.store.startManual(task.id, true);
  const target = f.backups.create();
  const path = f.backups.download(target.id).path;
  const db = new Database(path);
  db.query('INSERT INTO integrations (id,run_id,repository_id,state,attempt,snapshot) VALUES (?,?,?,?,?,?)')
    .run('broken-integration', run.id, 'repository', 'checking', 1, '{');
  db.close();
  f.backups.validate(target.id);
  const bytes = readFileSync(path);

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('несовместим');

  expect(f.events).toEqual([]);
  expect(f.store.getRun(run.id).status).toBe('running');
  expect(f.backups.list().selectedId).toBeNull();
  expect(readFileSync(path)).toEqual(bytes);
  expectNoTemporaryFiles(f);
});

test('a pause failure resumes service without closing or replacing the current database', async () => {
  const f = fixture();
  const current = await addTask(f, 'Current', 'current bytes');
  const target = f.backups.create();
  f.runtime.pause = async () => { f.events.push('pause failed'); throw new Error('Worker shutdown timed out'); };

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('Предыдущие данные сохранены');

  expect(f.events).toEqual(['pause failed', 'resume']);
  expect(f.store.getTask(current.task.id).title).toBe('Current');
  expect(f.backups.list().backups).toHaveLength(1);
  expectNoTemporaryFiles(f);
});

test('failure to create the protective snapshot resumes without replacing live data', async () => {
  const f = fixture();
  const current = await addTask(f, 'Current', 'current bytes');
  const target = f.backups.create();
  f.backups.create = () => { throw new Error('Disk full'); };

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toThrow('Предыдущие данные сохранены');

  expect(f.events).toEqual(['pause', 'resume']);
  expect(f.store.getTask(current.task.id).title).toBe('Current');
  expect(f.backups.list().selectedId).toBeNull();
  expectNoTemporaryFiles(f);
});

test('simultaneous restores of the same database are rejected while workers are stopping', async () => {
  const f = fixture();
  await addTask(f, 'Current', 'current bytes');
  const target = f.backups.create();
  let proceed!: () => void;
  f.runtime.pause = () => new Promise<void>(resolve => { f.events.push('pause'); proceed = resolve; });
  const pending = restoreBackup(f.backups, target.id, f.runtime);

  await expect(restoreBackup(f.backups, target.id, f.runtime)).rejects.toMatchObject({ status: 409 });
  proceed();
  await pending;

  expect(f.events).toEqual(['pause', 'close', 'open', 'resume']);
  expectNoTemporaryFiles(f);
});

test('offline replacement leaves the existing database intact when the source is unavailable', () => {
  const f = fixture();
  f.runtime.close();
  const bytes = readFileSync(f.path);

  expect(() => installDatabaseBackup(join(f.folder, 'missing.sqlite'), f.path)).toThrow();

  expect(readFileSync(f.path)).toEqual(bytes);
  expect(existsSync(f.path)).toBe(true);
  expectNoTemporaryFiles(f);
});
