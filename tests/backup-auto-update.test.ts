import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_AUTO_UPDATE_INTERVAL_MS, BackupAutoUpdater } from '../server/backup-auto-update';
import { BackupManager } from '../server/backups';
import { Store } from '../server/store';

let folder: string, path: string, store: Store, backups: BackupManager, updater: BackupAutoUpdater;
let errors: unknown[];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-backup-auto-update-'));
  path = join(folder, 'app.sqlite');
  store = new Store(path);
  backups = new BackupManager({ dbPath: path, updateBackupDir: join(folder, 'updates') });
  errors = [];
  updater = new BackupAutoUpdater(backups, () => store.db, error => errors.push(error));
});
afterEach(() => {
  updater.stop();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

function task(title: string) {
  return store.createTask({ title, instruction: 'Inspect files', provider: 'codex', cwd: folder,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false });
}

function selected() {
  const backup = backups.create();
  backups.select(backup.id);
  backups.setAutoUpdate(backup.id, true);
  return backup.id;
}

function snapshot<T>(id: string, action: (db: Database) => T): T {
  const db = new Database(backups.download(id).path, { readonly: true });
  try { return action(db); } finally { db.close(); }
}

function savedTitles(id: string): string[] {
  return snapshot(id, db => (db.query('SELECT title FROM tasks ORDER BY title').all() as { title: string }[]).map(row => row.title));
}

test('disabled auto-update never opens the live database or creates snapshots', () => {
  let opened = 0;
  updater = new BackupAutoUpdater(backups, () => { opened++; return store.db; });
  const refresh = spyOn(backups, 'updateSelected');
  updater.start();
  updater.tick();
  updater.flush();
  const saved = backups.create();
  backups.select(saved.id);
  backups.setAutoUpdate(saved.id, false);
  task('Not backed up');
  updater.tick();
  updater.flush();
  expect(opened).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  expect(savedTitles(saved.id)).toEqual([]);
});

test('a selected backup tracks committed Store writes without work on reads or unchanged ticks', () => {
  task('Original');
  const id = selected();
  task('After enabling');
  const refresh = spyOn(backups, 'updateSelected');

  updater.tick();
  expect(savedTitles(id)).toEqual(['After enabling', 'Original']);
  expect(refresh).toHaveBeenCalledTimes(1);
  store.listTasks();
  backups.list();
  updater.tick();
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(1);

  const later = task('Worker result');
  store.comment(later.id, null, 'system', 'Finished in background');
  store.setDefaultCwd(folder);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(savedTitles(id)).toEqual(['After enabling', 'Original', 'Worker result']);
  expect(snapshot(id, db => db.query('SELECT body FROM comments WHERE task_id=?').all(later.id)))
    .toEqual([{ body: 'Finished in background' }]);
  expect(snapshot(id, db => db.query('SELECT default_cwd FROM general_settings').get()))
    .toEqual({ default_cwd: folder });
  expect(errors).toEqual([]);
});

test('commits from another connection trigger an update through SQLite data_version', () => {
  const id = selected();
  updater.tick();
  const refresh = spyOn(backups, 'updateSelected');
  const external = new Database(path);
  try {
    const before = store.db.query('SELECT total_changes() AS changes').get();
    external.exec("UPDATE general_settings SET default_schedule='interval' WHERE singleton=1");
    expect(store.db.query('SELECT total_changes() AS changes').get()).toEqual(before);
    updater.tick();
    updater.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(snapshot(id, db => db.query('SELECT default_schedule FROM general_settings').get()))
      .toEqual({ default_schedule: 'interval' });
  } finally { external.close(); }
});

test('start refreshes immediately, avoids duplicate timers, and stop pauses without overwriting the snapshot', () => {
  const id = selected();
  task('Before startup');
  const refresh = spyOn(backups, 'updateSelected');
  const interval = spyOn(globalThis, 'setInterval');
  try {
    updater.start();
    updater.start();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0]![1]).toBe(BACKUP_AUTO_UPDATE_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(savedTitles(id)).toEqual(['Before startup']);

    task('Paused worker write');
    updater.stop();
    updater.stop();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(savedTitles(id)).toEqual(['Before startup']);

    updater.start();
    expect(interval).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(savedTitles(id)).toEqual(['Before startup', 'Paused worker write']);
  } finally { interval.mockRestore(); }
});

test('switching selection, re-enabling, and reopening the Store invalidate the snapshot baseline', () => {
  const firstId = selected();
  updater.tick();
  const refresh = spyOn(backups, 'updateSelected');

  backups.setAutoUpdate(firstId, false);
  updater.tick();
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(0);
  backups.setAutoUpdate(firstId, true);
  const afterEnable = refresh.mock.calls.length;
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(afterEnable + 1);

  const second = backups.create();
  backups.select(second.id);
  backups.setAutoUpdate(second.id, true);
  const afterSelection = refresh.mock.calls.length;
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(afterSelection + 1);

  const oldDatabase = store.db;
  store.close();
  store = new Store(path);
  expect(store.db).not.toBe(oldDatabase);
  const afterReopen = refresh.mock.calls.length;
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(afterReopen + 1);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(afterReopen + 1);
});

test('failed refreshes keep the previous snapshot and retry the same changes on the next tick', () => {
  const id = selected();
  updater.tick();
  const previous = readFileSync(backups.download(id).path);
  task('Retry this write');
  const failure = new Error('Temporary snapshot failure');
  const refresh = spyOn(backups, 'updateSelected');
  refresh.mockImplementationOnce(() => { throw failure; });

  updater.tick();
  expect(errors).toEqual([failure]);
  expect(readFileSync(backups.download(id).path)).toEqual(previous);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(savedTitles(id)).toEqual(['Retry this write']);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('a commit after the snapshot is detected on the next tick', () => {
  store.setDefaultSchedule('manual');
  const id = selected();
  updater.tick();
  task('Snapshot trigger');
  const external = new Database(path);
  const original = backups.updateSelected.bind(backups);
  const refresh = spyOn(backups, 'updateSelected');
  refresh.mockImplementationOnce(() => {
    const result = original();
    external.exec("UPDATE general_settings SET default_schedule='interval' WHERE singleton=1");
    return result;
  });
  try {
    updater.tick();
    expect(snapshot(id, db => db.query('SELECT default_schedule FROM general_settings').get()))
      .toEqual({ default_schedule: 'manual' });
    updater.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(snapshot(id, db => db.query('SELECT default_schedule FROM general_settings').get()))
      .toEqual({ default_schedule: 'interval' });
  } finally { external.close(); }
});

test('flush captures final worker writes while stopped and a failed flush is retried even without new writes', () => {
  const id = selected();
  updater.start();
  updater.stop();
  task('Final worker status');
  updater.flush();
  expect(savedTitles(id)).toEqual(['Final worker status']);

  const failure = new Error('Temporary flush failure');
  const refresh = spyOn(backups, 'updateSelected');
  refresh.mockImplementationOnce(() => { throw failure; });
  updater.flush();
  expect(errors).toEqual([failure]);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(2);
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('snapshot refreshes are protected against reentrant ticks', () => {
  const id = selected();
  const original = backups.updateSelected.bind(backups);
  const refresh = spyOn(backups, 'updateSelected');
  refresh.mockImplementationOnce(() => {
    updater.tick();
    return original();
  });
  updater.tick();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(savedTitles(id)).toEqual([]);
});
