import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireStartupLock, assertDatabaseIdle, processIdentity } from '../server/startup-lock';
import { Store } from '../server/store';

const folders: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-startup-test-'));
  folders.push(folder);
  return { folder, path: join(folder, 'tasks.sqlite') };
}
function deadline<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, Bun.sleep(5000).then(() => { throw new Error('Server startup timed out'); })]);
}

test('startup lock excludes a second opener and canonicalizes a database symlink', () => {
  const { path, folder } = fixture();
  const db = new Database(path, { create: true });
  db.exec('CREATE TABLE retained (value TEXT)');
  db.close();
  const alias = join(folder, 'alias.sqlite');
  symlinkSync(path, alias);
  const lock = acquireStartupLock(path);
  try {
    expect(() => acquireStartupLock(path)).toThrow('занята');
    expect(() => acquireStartupLock(alias)).toThrow('занята');
  } finally { lock.release(); }
  acquireStartupLock(alias).release();
});

test('an OS startup lock recovers after SIGKILL without deleting user data', async () => {
  const { path } = fixture();
  let ready!: () => void;
  const started = new Promise<void>(yes => { ready = yes; });
  const child = Bun.spawn([process.execPath, '-e', `
    import { acquireStartupLock } from ${JSON.stringify(resolve(import.meta.dir, '../server/startup-lock.ts'))};
    const lock = acquireStartupLock(${JSON.stringify(path)});
    process.send({type:'locked'});
    setInterval(() => {},1000);
  `], { stdout: 'ignore', stderr: 'inherit', ipc: message => { if (message?.type === 'locked') ready(); } });
  children.push(child);
  await deadline(started);
  expect(() => acquireStartupLock(path)).toThrow('занята');
  child.kill('SIGKILL');
  await child.exited;
  acquireStartupLock(path).release();
});

test('legacy live leases are checked without applying schema migrations', () => {
  const { path } = fixture();
  const db = new Database(path, { create: true });
  db.exec('CREATE TABLE service_lease (singleton INTEGER PRIMARY KEY,pid INTEGER,identity TEXT)');
  db.query('INSERT INTO service_lease VALUES (1,?,?)').run(process.pid, processIdentity(process.pid));
  expect(() => assertDatabaseIdle(path)).toThrow(`PID ${process.pid}`);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'service_lease' }]);
  db.close();
});

test('a migrating managed child still excludes recovery after its launcher is killed', async () => {
  const { path } = fixture();
  const module = resolve(import.meta.dir, '../server/startup-lock.ts');
  const childCode = `
    import { Database } from 'bun:sqlite';
    import { acquireServerStartupLock } from ${JSON.stringify(module)};
    const guard = acquireServerStartupLock(${JSON.stringify(path)});
    const database = new Database(${JSON.stringify(path)}, {create:true});
    database.exec('CREATE TABLE migration_in_progress (value TEXT)');
    process.send({type:'guarded'});
    // Model a synchronous Store constructor before its service_lease is written.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
  `;
  let migratingPid: number | undefined;
  let ready!: () => void;
  const started = new Promise<void>(yes => { ready = yes; });
  const launcher = Bun.spawn([process.execPath, '-e', `
    import { acquireStartupLock } from ${JSON.stringify(module)};
    const lock = acquireStartupLock(${JSON.stringify(path)});
    const child = Bun.spawn([process.execPath,'-e',${JSON.stringify(childCode)}], {
      env:{...process.env,BRIGD_STARTUP_TOKEN:lock.token},stdout:'ignore',stderr:'inherit',
      ipc(message) { if (message?.type === 'guarded') process.send({type:'guarded',pid:child.pid}); }
    });
    await child.exited;
  `], { stdout: 'ignore', stderr: 'inherit', ipc: message => {
    if (message?.type === 'guarded') { migratingPid = message.pid; ready(); }
  } });
  children.push(launcher);
  try {
    await deadline(started);
    launcher.kill('SIGKILL');
    await launcher.exited;
    expect(() => acquireStartupLock(path)).toThrow('занята');
    process.kill(migratingPid!, 'SIGKILL');
    const recovery = async () => {
      for (;;) {
        try { return acquireStartupLock(path); }
        catch { await Bun.sleep(10); }
      }
    };
    const recovered = await deadline(recovery());
    recovered.release();
  } finally {
    if (migratingPid !== undefined) { try { process.kill(migratingPid, 'SIGKILL'); } catch {} }
  }
});

test('managed real server gates HTTP and scheduling until activation', async () => {
  const { path, folder } = fixture();
  const store = new Store(path);
  store.createTask({ title: 'Scheduled mock', instruction: 'mock only', provider: 'codex', cwd: folder,
    schedule: 'interval', intervalMinutes: 1, firstRunAt: Date.now() - 1000, paused: false });
  store.close();
  const lock = acquireStartupLock(path);
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  reservation.stop(true);
  let ready!: () => void;
  let active!: () => void;
  const started = new Promise<void>(yes => { ready = yes; });
  const activated = new Promise<void>(yes => { active = yes; });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
  Object.assign(env, { BRIGD_DB: path, BRIGD_MODE: 'mock', PORT: String(port), BRIGD_HOST: '127.0.0.1',
    BRIGD_MANAGED_START: '1', BRIGD_STARTUP_TOKEN: lock.token, BRIGD_CLI_HOME: folder,
    BRIGD_ALLOWED_HOSTS: `127.0.0.1:${port}`, BRIGD_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../server/index.ts')], {
    env, stdout: 'ignore', stderr: 'inherit', ipc: message => {
      if (message?.type === 'brigd:ready') ready();
      if (message?.type === 'brigd:active') active();
    }
  });
  children.push(child);
  try {
    await deadline(started);
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${origin}/api/info`)).status).toBe(503);
    const readonly = new Database(path, { readonly: true });
    try { expect(readonly.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 }); }
    finally { readonly.close(); }
    child.send({ type: 'brigd:activate' });
    await deadline(activated);
    expect((await fetch(`${origin}/api/info`)).status).toBe(200);
    const readonlyActive = new Database(path, { readonly: true });
    try { expect((readonlyActive.query('SELECT count(*) AS n FROM runs').get() as { n: number }).n).toBe(1); }
    finally { readonlyActive.close(); }
    child.kill('SIGTERM');
    await deadline(child.exited);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    lock.release();
  }
});

test('a busy port stops the server with a clear message and releases the database', async () => {
  const { folder, path } = fixture();
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BRIGD_') && !key.startsWith('TRACKT_')));
    Object.assign(env, { BRIGD_DB: path, BRIGD_MODE: 'mock', PORT: String(port), BRIGD_HOST: '127.0.0.1', BRIGD_CLI_HOME: folder });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../server/index.ts')], { env, stdout: 'ignore', stderr: 'pipe' });
    children.push(child);
    const [code, stderr] = await Promise.all([deadline(child.exited), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain(`Порт ${port} уже занят`);
    // The lease and the OS lock are released, not left for liveness checks to expire.
    const database = new Database(path, { readonly: true });
    try { expect(database.query('SELECT count(*) AS n FROM service_lease').get()).toEqual({ n: 0 }); }
    finally { database.close(); }
    acquireStartupLock(path).release();
  } finally { reservation.stop(true); }
});
