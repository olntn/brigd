import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type Owner = { pid: number; identity: string | null; token: string };
export type StartupLock = { token: string; release(): void };

export function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `${boot}:${readlinkSync(`/proc/${pid}/ns/pid`)}:${start}`;
  } catch { return null; }
}

function alive(owner: Pick<Owner, 'pid' | 'identity'>): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Некорректный PID владельца базы brigd.');
  try { process.kill(owner.pid, 0); }
  catch (error: any) { if (error.code === 'ESRCH') return false; }
  const identity = processIdentity(owner.pid);
  return !(owner.identity && identity && owner.identity !== identity);
}

export function canonicalDatabasePath(dbPath: string): string {
  const absolute = resolve(dbPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  return existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
}

function acquireServerGuard(path: string): () => void {
  const database = new Database(`${path}.brigd-server-lock.sqlite`, { create: true });
  try {
    database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS guard (singleton INTEGER PRIMARY KEY);');
    if (process.platform !== 'win32') chmodSync(`${path}.brigd-server-lock.sqlite`, 0o600);
  } catch (error) {
    database.close();
    throw new Error('Предыдущий сервер brigd ещё работает. Дождитесь его остановки.', { cause: error });
  }
  let released = false;
  return () => { if (!released) { released = true; database.close(); } };
}

// A separate SQLite file supplies an OS lock: a crash releases it automatically.
// Never open the application database for writes until this lock is held.
export function acquireStartupLock(dbPath: string): StartupLock {
  const path = canonicalDatabasePath(dbPath);
  const database = new Database(`${path}.brigd-lock.sqlite`, { create: true });
  const metadata = `${path}.brigd-lock.json`;
  const owner: Owner = { pid: process.pid, identity: processIdentity(process.pid), token: crypto.randomUUID() };
  let releaseGuard: (() => void) | undefined;
  try {
    database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS guard (singleton INTEGER PRIMARY KEY);');
    // An orphaned managed child can still be migrating before it has a DB lease.
    // Probe its lifetime guard before replacing the previous launcher's metadata.
    releaseGuard = acquireServerGuard(path);
    if (process.platform !== 'win32') chmodSync(`${path}.brigd-lock.sqlite`, 0o600);
    const temporary = `${metadata}.${owner.token}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
      renameSync(temporary, metadata);
    } finally { rmSync(temporary, { force: true }); }
  } catch (error) {
    database.close();
    throw new Error('База brigd уже занята другим запуском либо блокировка недоступна. Остановите другой экземпляр перед запуском.', { cause: error });
  } finally { releaseGuard?.(); }
  let released = false;
  return { token: owner.token, release() {
    if (released) return;
    released = true;
    try { rmSync(metadata, { force: true }); }
    finally { database.close(); }
  } };
}

export function acquireServerStartupLock(dbPath: string, env: Record<string, string | undefined> = process.env): StartupLock {
  if (!env.BRIGD_STARTUP_TOKEN) return acquireStartupLock(dbPath);
  const path = canonicalDatabasePath(dbPath);
  // Acquire first, then recheck the parent: a replacement launcher must either
  // see this guard or invalidate our token before any application DB is opened.
  const release = acquireServerGuard(path);
  try {
    let owner: Owner;
    try { owner = JSON.parse(readFileSync(`${path}.brigd-lock.json`, 'utf8')); }
    catch { throw new Error('Не удалось проверить блокировку скрипта запуска brigd.'); }
    if (owner.token !== env.BRIGD_STARTUP_TOKEN || owner.pid !== process.ppid || !alive(owner)) {
      throw new Error('Блокировка brigd принадлежит другому процессу.');
    }
    return { token: owner.token, release };
  } catch (error) {
    release();
    throw error;
  }
}

// Also recognize an already running version from before startup locks existed.
// Read-only access avoids applying migrations before detecting that old server.
export function assertDatabaseIdle(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const database = new Database(dbPath, { readonly: true });
  try {
    if (!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_lease'").get()) return;
    const columns = database.query('PRAGMA table_info(service_lease)').all() as { name: string }[];
    const owner = database.query(`SELECT pid, ${columns.some(column => column.name === 'identity') ? 'identity' : 'NULL AS identity'} FROM service_lease WHERE singleton=1`).get() as Owner | null;
    if (owner && alive(owner)) throw new Error(`База уже занята процессом PID ${owner.pid}. Остановите другой brigd перед запуском.`);
  } finally { database.close(); }
}
