import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BackupManager, validateBackup } from './backups';
import { AppError } from './errors';
import { Store } from './store';

export interface BackupRestoreRuntime {
  dbPath: string;
  /** Drain requests and stop workers, keeping the current Store open for its final snapshot. */
  pause(): Promise<void>;
  /** Close the Store and its lease. Must also tolerate an unsuccessful open(). */
  close(): void;
  /** Open the Store, lease and Engine, leaving scheduling paused. */
  open(): void;
  /** Enable requests and scheduling again. */
  resume(): void;
}

const restoring = new Set<string>();

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  if (process.platform !== 'win32') syncFile(path);
}

/** A snapshot copies a live process lease; that lease must never reach a restored Store. */
function finishStaging(db: Database): void {
  if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='service_lease'").get()) {
    db.exec('DELETE FROM service_lease');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
}

function stageSnapshot(source: string, target: string, migrate: boolean): void {
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  validateBackup(target);
  if (migrate) {
    let store: Store | undefined;
    try {
      // Migrations happen on a disposable copy before any running service is stopped.
      store = new Store(target);
      // Opening the scheduler also reconciles interrupted runs and integrations.
      // Validate that startup step here, where malformed saved JSON cannot affect live data.
      store.reconcile();
      finishStaging(store.db);
    } catch {
      throw new AppError('Бэкап несовместим с текущей версией приложения');
    } finally { store?.close(); }
  } else {
    const db = new Database(target);
    try { finishStaging(db); } finally { db.close(); }
  }
  validateBackup(target);
  syncFile(target);
}

/** Install only while all database users are closed. The original database alias is preserved. */
export function installDatabaseBackup(source: string, database: string): void {
  const path = existsSync(database) ? realpathSync(database) : resolve(database);
  const temporary = join(dirname(path), `.${basename(path)}.restore-${randomUUID()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, mode);
    syncFile(temporary);
    // Sidecars belong to the old inode and cannot be replayed against the replacement.
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}

export async function restoreBackup(backups: BackupManager, id: string, runtime: BackupRestoreRuntime): Promise<void> {
  const path = existsSync(runtime.dbPath) ? realpathSync(runtime.dbPath) : resolve(runtime.dbPath);
  if (restoring.has(path)) throw new AppError('Восстановление бэкапа уже выполняется', 409);
  restoring.add(path);
  let staging: string | undefined;
  let pauseStarted = false;
  let closeStarted = false;
  let rollbackPath: string | undefined;
  let previousSelectedId: string | null = null;
  let previousAutoUpdate = false;
  let selectionStarted = false;
  let resumeStarted = false;
  try {
    backups.validate(id);
    staging = mkdtempSync(join(dirname(path), '.brigd-restore-'));
    chmodSync(staging, 0o700);
    const prepared = join(staging, 'selected.sqlite');
    stageSnapshot(backups.download(id).path, prepared, true);

    pauseStarted = true;
    await runtime.pause();
    // Preserve settings from requests that were already accepted before the pause.
    const previous = backups.getAutoUpdate();
    previousSelectedId = previous.selectedId;
    previousAutoUpdate = previous.enabled;
    // Workers can write their final status during shutdown; capture those writes too.
    const rollback = backups.create(`Перед восстановлением — ${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    rollbackPath = join(staging, 'previous.sqlite');
    stageSnapshot(backups.download(rollback.id).path, rollbackPath, false);
    closeStarted = true;
    runtime.close();
    installDatabaseBackup(prepared, path);
    runtime.open();
    selectionStarted = true;
    backups.select(id);
    resumeStarted = true;
    runtime.resume();
  } catch (error) {
    if (closeStarted && rollbackPath) {
      try {
        if (resumeStarted) {
          // Activation may have started work before failing. Stop it before retiring its Store.
          try { await runtime.pause(); } catch { /* close() also handles a partial startup. */ }
        }
        runtime.close();
        installDatabaseBackup(rollbackPath, path);
        runtime.open();
        if (selectionStarted) {
          if (previousSelectedId === null) backups.clearSelection();
          else backups.select(previousSelectedId, previousAutoUpdate);
        }
        runtime.resume();
      } catch {
        throw new AppError('Не удалось восстановить бэкап и открыть предыдущую базу. Резервная копия перед восстановлением сохранена в папке бэкапов.', 500);
      }
    } else if (pauseStarted) runtime.resume();
    throw error instanceof AppError ? error : new AppError('Не удалось восстановить бэкап. Предыдущие данные сохранены.', 500);
  } finally {
    restoring.delete(path);
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
