import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError } from './errors';
import type { BackupEntry, BackupOverview } from '../src/lib/types';
export type { BackupEntry, BackupOverview } from '../src/lib/types';

export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
export interface BackupManagerOptions { dbPath: string; updateBackupDir: string; }
interface BackupState {
  version: 1;
  selectedId: string | null;
  autoUpdate: boolean;
  names: Record<string, string>;
  /** Preserve the creation time of updater files whose names contain no timestamp. */
  createdAt: Record<string, number>;
}
type BackupSource = BackupEntry['source'];
const LOCAL_NAME = /^(manual|upload)-(\d{13})-[a-f0-9-]{36}\.sqlite$/;
const SAFE_NAME = /^[^/\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]{1,240}$/u;
const badState = () => new AppError('Повреждены настройки бэкапов. Восстановите файл state.json перед изменением бэкапов.', 500);
const missing = () => new AppError('Бэкап не найден', 404);

function backupName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('Укажите имя файла бэкапа');
  const name = value.trim().normalize('NFC');
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') throw new AppError('Некорректное имя файла бэкапа');
  return name;
}
function syncPath(path: string) {
  if (process.platform === 'win32' && lstatSync(path).isDirectory()) return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function backupId(source: BackupSource, name: string): string {
  return `${source}:${Buffer.from(name).toString('base64url')}`;
}
function decodeId(id: unknown): { source: BackupSource; filename: string } {
  if (typeof id !== 'string' || id.length > 1_024) throw missing();
  const match = /^(manual|upload|update):([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) throw missing();
  const filename = Buffer.from(match[2]!, 'base64url').toString('utf8');
  if (Buffer.from(filename).toString('base64url') !== match[2] || !SAFE_NAME.test(filename) ||
      filename === '.' || filename === '..' || !filename.endsWith('.sqlite')) throw missing();
  const source = match[1] as BackupSource;
  if (source !== 'update' && LOCAL_NAME.exec(filename)?.[1] !== source) throw missing();
  return { source, filename };
}

/** Inspect a standalone snapshot without migrations or changes to its contents. */
export function validateBackup(path: string): void {
  let db: Database | undefined;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size < 100) throw new Error('Not a database');
    db = new Database(path, { readonly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    const integrity = db.query('PRAGMA integrity_check').all() as Record<string, unknown>[];
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('Integrity check failed');
    // Require the stable original schema, while allowing additive migrations from older releases.
    const required: Record<string, string[]> = {
      tasks: ['id', 'title', 'instruction', 'provider', 'cwd', 'schedule', 'interval_minutes', 'first_run_at', 'next_run_at', 'paused', 'created_at', 'updated_at'],
      runs: ['id', 'task_id', 'provider', 'cwd', 'instruction', 'trigger', 'scheduled_for', 'status', 'session_id', 'started_at', 'updated_at', 'finished_at', 'summary', 'error', 'turn', 'mock'],
      workers: ['id', 'name', 'provider', 'effort', 'communication_style', 'avatar_url', 'archived', 'created_at', 'updated_at'],
      comments: ['seq', 'id', 'task_id', 'run_id', 'kind', 'body', 'created_at'],
    };
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    if (tables.has('attachments')) required.attachments = ['id', 'task_id', 'comment_id', 'run_id', 'step_index', 'attempt_id', 'created_turn', 'source', 'name', 'mime', 'size', 'sha256', 'previewable', 'created_at', 'expires_at', 'data', 'preview', 'preview_size'];
    if (tables.has('general_settings')) required.general_settings = ['singleton', 'default_cwd'];
    for (const [table, columns] of Object.entries(required)) {
      if (!tables.has(table)) throw new Error('Missing application table');
      const present = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
      if (columns.some(column => !present.has(column))) throw new Error('Incompatible application table');
    }
    if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Broken references');
  } catch {
    throw new AppError('Файл повреждён или не является совместимым бэкапом brigd');
  } finally { db?.close(); }
}

export class BackupManager {
  readonly dbPath: string;
  readonly directory: string;
  private readonly updateDirectory: string;
  private readonly statePath: string;

  constructor(options: BackupManagerOptions) {
    const database = resolve(options.dbPath);
    this.dbPath = existsSync(database) ? realpathSync(database) : database;
    // Databases beside each other must not share imported files or a selected backup.
    const namespace = createHash('sha256').update(this.dbPath).digest('hex').slice(0, 20);
    const root = join(dirname(this.dbPath), 'backups');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new AppError('Папка бэкапов недоступна', 500);
    this.directory = join(root, namespace);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new AppError('Папка бэкапов недоступна', 500);
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
    this.statePath = join(this.directory, 'state.json');
    this.updateDirectory = resolve(options.updateBackupDir);
  }

  list(): BackupOverview {
    const state = this.readState();
    const backups: BackupEntry[] = [];
    for (const [directory, update] of [[this.directory, false], [this.updateDirectory, true]] as const) {
      if (!this.readableDirectory(directory)) continue;
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink() || !SAFE_NAME.test(file.name)) continue;
        const local = LOCAL_NAME.exec(file.name);
        if (update ? !file.name.endsWith('.sqlite') : !local) continue;
        const source: BackupSource = update ? 'update' : local![1] as BackupSource;
        try { backups.push(this.entry(backupId(source, file.name), state)); }
        catch (error) { if (!(error instanceof AppError) || error.status !== 404) throw error; }
      }
    }
    backups.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { backups, selectedId: state.selectedId };
  }

  create(name?: string): BackupEntry {
    const state = this.readState();
    const now = Date.now();
    const filename = `manual-${now}-${randomUUID()}.sqlite`;
    const display = name === undefined ? `brigd-${new Date(now).toISOString().replace(/[:.]/g, '-')}.sqlite` : backupName(name);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let db: Database | undefined;
    try {
      // VACUUM INTO includes committed WAL contents and produces a standalone consistent database.
      writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
      db = new Database(this.dbPath, { readonly: true });
      db.exec('PRAGMA busy_timeout=5000');
      db.query('VACUUM INTO ?').run(temporary);
      db.close();
      db = undefined;
      return this.publish(temporary, filename, 'manual', display, state);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Не удалось создать бэкап базы данных', 500);
    } finally { db?.close(); rmSync(temporary, { force: true }); }
  }

  upload(data: Uint8Array, name: string): BackupEntry {
    if (!(data instanceof Uint8Array) || !data.byteLength) throw new AppError('Выберите файл бэкапа SQLite');
    if (data.byteLength > BACKUP_MAX_BYTES) throw new AppError('Размер бэкапа не должен превышать 256 МБ', 413);
    const display = backupName(name);
    const state = this.readState();
    const filename = `upload-${Date.now()}-${randomUUID()}.sqlite`;
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
      validateBackup(temporary);
      return this.publish(temporary, filename, 'upload', display, state);
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${temporary}${suffix}`, { force: true });
    }
  }

  validate(id: string): void { validateBackup(this.file(id).path); }

  /** Persist only after the caller has successfully restored the selected database. */
  select(id: string, autoUpdate?: boolean): BackupEntry {
    const state = this.readState();
    const entry = this.entry(id, state);
    if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') throw new AppError('Автообновление должно быть boolean');
    const next = { ...state, selectedId: id,
      autoUpdate: autoUpdate ?? (state.selectedId === id && state.autoUpdate),
      createdAt: { ...state.createdAt, [id]: entry.createdAt } };
    this.commitState(state, next);
    return this.entry(id, next);
  }

  /** Clear a newly selected marker when restoration rolls back to an unselected database. */
  clearSelection(): void {
    const state = this.readState();
    this.commitState(state, { ...state, selectedId: null, autoUpdate: false });
  }

  /** The monitor reads only the external manifest, without listing or opening snapshots. */
  getAutoUpdate(): { selectedId: string | null; enabled: boolean } {
    const state = this.readState();
    return { selectedId: state.selectedId, enabled: state.autoUpdate };
  }

  setAutoUpdate(id: string, enabled: unknown): BackupEntry {
    if (typeof enabled !== 'boolean') throw new AppError('Автообновление должно быть boolean');
    const state = this.readState();
    if (state.selectedId !== id) throw new AppError('Автообновление доступно только для выбранного бэкапа', 409);
    const entry = this.entry(id, state);
    if (enabled) return this.replaceWithSnapshot(id, state, true);
    this.commitState(state, { ...state, autoUpdate: false });
    return { ...entry, autoUpdate: false };
  }

  /** Replace only the selected file; historical and nonselected snapshots stay untouched. */
  updateSelected(): BackupEntry | null {
    const state = this.readState();
    if (!state.selectedId || !state.autoUpdate) return null;
    return this.replaceWithSnapshot(state.selectedId, state, true);
  }

  rename(id: string, value: unknown): BackupEntry {
    const name = backupName(value);
    const state = this.readState();
    const entry = this.entry(id, state);
    if (entry.name === name) return entry;
    try { this.commitState(state, { ...state, names: { ...state.names, [id]: name } }); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Не удалось переименовать бэкап. Попробуйте ещё раз.', 500);
    }
    return { ...entry, name };
  }

  delete(id: string): void {
    const state = this.readState();
    if (state.selectedId === id) throw new AppError('Текущий выбранный бэкап удалить нельзя', 409);
    const { path } = this.file(id);
    rmSync(path);
    syncPath(dirname(path));
    if (Object.hasOwn(state.names, id) || Object.hasOwn(state.createdAt, id)) {
      delete state.names[id];
      delete state.createdAt[id];
      this.writeState(state);
    }
  }

  download(id: string): { path: string; name: string } {
    const state = this.readState();
    return { path: this.file(id).path, name: this.entry(id, state).name };
  }

  private readableDirectory(path: string): boolean {
    try { const file = lstatSync(path); return file.isDirectory() && !file.isSymbolicLink(); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  }

  private file(id: string) {
    const { source, filename } = decodeId(id);
    const directory = source === 'update' ? this.updateDirectory : this.directory;
    if (source !== 'update') this.assertLocalDirectory();
    if (!this.readableDirectory(directory)) throw missing();
    const path = join(directory, filename);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw missing();
      return { path, filename, source, stat };
    } catch (error: any) { if (error.code === 'ENOENT') throw missing(); throw error; }
  }

  private entry(id: string, state: BackupState): BackupEntry {
    const { filename, source, stat } = this.file(id);
    const timestamp = /^(?:manual-|upload-)?(\d{13})-/.exec(filename)?.[1];
    const selected = state.selectedId === id;
    return { id, name: state.names[id] ?? filename, source,
      createdAt: state.createdAt[id] ?? (timestamp ? Number(timestamp) : stat.mtimeMs), updatedAt: stat.mtimeMs,
      size: stat.size, selected, autoUpdate: selected && state.autoUpdate };
  }

  private replaceWithSnapshot(id: string, state: BackupState, autoUpdate: boolean): BackupEntry {
    const entry = this.entry(id, state);
    const target = this.file(id);
    const directory = dirname(target.path);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const previous = join(directory, `.${randomUUID()}.previous.tmp`);
    const next = { ...state, autoUpdate, createdAt: { ...state.createdAt, [id]: entry.createdAt } };
    const changeState = state.autoUpdate !== autoUpdate || state.createdAt[id] !== entry.createdAt;
    let db: Database | undefined;
    let replaced = false;
    let stateChanged = false;
    try {
      writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
      db = new Database(this.dbPath, { readonly: true });
      db.exec('PRAGMA busy_timeout=5000');
      db.query('VACUUM INTO ?').run(temporary);
      db.close();
      db = undefined;
      syncPath(temporary);
      const current = this.file(id);
      if (current.stat.dev !== target.stat.dev || current.stat.ino !== target.stat.ino) throw missing();
      // Keep the last valid inode until the replacement and its directory entry are durable.
      linkSync(target.path, previous);
      if (changeState) {
        this.commitState(state, next);
        stateChanged = true;
      }
      renameSync(temporary, target.path);
      replaced = true;
      syncPath(directory);
      return this.entry(id, next);
    } catch (error) {
      if (replaced) {
        try { renameSync(previous, target.path); syncPath(directory); } catch {}
      }
      if (stateChanged) { try { this.writeState(state); } catch {} }
      if (error instanceof AppError) throw error;
      throw new AppError('Не удалось обновить выбранный бэкап базы данных', 500);
    } finally {
      db?.close();
      rmSync(temporary, { force: true });
      rmSync(previous, { force: true });
    }
  }

  private publish(temporary: string, filename: string, source: BackupSource, name: string, state: BackupState): BackupEntry {
    const path = join(this.directory, filename);
    const id = backupId(source, filename);
    syncPath(temporary);
    renameSync(temporary, path);
    try {
      syncPath(this.directory);
      state.names[id] = name;
      this.writeState(state);
      return this.entry(id, state);
    } catch (error) { rmSync(path, { force: true }); throw error; }
  }

  private readState(): BackupState {
    this.assertLocalDirectory();
    let fd: number;
    try {
      if (lstatSync(this.statePath).isSymbolicLink()) throw badState();
      fd = openSync(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error: any) { if (error.code === 'ENOENT') return { version: 1, selectedId: null, autoUpdate: false, names: {}, createdAt: {} }; throw badState(); }
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.size > 1024 * 1024) throw badState();
      const state = JSON.parse(readFileSync(fd, 'utf8')) as BackupState;
      if (!state || state.version !== 1 || (state.selectedId !== null && typeof state.selectedId !== 'string') ||
          !state.names || typeof state.names !== 'object' || Array.isArray(state.names)) throw badState();
      // Version 1 manifests from before auto-update remain valid and opt out by default.
      if (!Object.hasOwn(state, 'autoUpdate')) state.autoUpdate = false;
      if (!Object.hasOwn(state, 'createdAt')) state.createdAt = {};
      if (typeof state.autoUpdate !== 'boolean' || (state.autoUpdate && state.selectedId === null) ||
          !state.createdAt || typeof state.createdAt !== 'object' || Array.isArray(state.createdAt)) throw badState();
      if (state.selectedId !== null) decodeId(state.selectedId);
      for (const [id, name] of Object.entries(state.names)) { decodeId(id); backupName(name); }
      for (const [id, createdAt] of Object.entries(state.createdAt)) {
        decodeId(id);
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) throw badState();
      }
      return state;
    } catch { throw badState(); }
    finally { closeSync(fd); }
  }

  private writeState(state: BackupState): void {
    this.assertLocalDirectory();
    const temporary = join(this.directory, `.${randomUUID()}.json.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
      syncPath(temporary);
      renameSync(temporary, this.statePath);
      syncPath(this.directory);
    } finally { rmSync(temporary, { force: true }); }
  }

  private commitState(state: BackupState, next: BackupState): void {
    try { this.writeState(next); }
    catch (error) {
      // A directory fsync can fail after rename; preserve the previous manifest if possible.
      try { this.writeState(state); } catch {}
      throw error;
    }
  }

  private assertLocalDirectory(): void {
    if (!this.readableDirectory(dirname(this.directory)) || !this.readableDirectory(this.directory)) {
      throw new AppError('Папка бэкапов недоступна', 500);
    }
  }
}
