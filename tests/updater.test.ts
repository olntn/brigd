import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startBrigd } from '../scripts/update';

type Behavior = 'success' | 'migration-failure' | 'readiness-timeout' | 'runtime-failure' | 'hold';
interface Observation {
  version: string;
  root: string;
  cwd: string;
  dbPath: string;
  workspacesDir: string;
  cliHome: string;
  defaultCwd: string;
  mode: string;
  persistent: string;
  workspace: string;
  cli: string;
  databaseExistedBeforeOpen: boolean;
}

const configModule = resolve(import.meta.dir, '../server/config.ts');
const temporaryFolders: string[] = [];
const running: { controller: AbortController; result: Promise<unknown> }[] = [];
afterEach(async () => {
  for (const { controller } of running) controller.abort();
  await Promise.allSettled(running.splice(0).map(({ result }) => result));
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// The fixture uses real SQLite and a real subprocess, with the production
// readiness protocol. It never loads an agent, binds a port or uses the network.
function writeApp(root: string, version: string, behavior: Behavior = 'success') {
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'brigd', version, type: 'module', brigdUpdaterProtocol: 1 }));
  writeFileSync(join(root, 'server/index.ts'), `
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readConfig } from ${JSON.stringify(configModule)};
const root = resolve(import.meta.dir, '..');
const config = readConfig(root);
mkdirSync(dirname(config.dbPath), { recursive: true });
const databaseExistedBeforeOpen = existsSync(config.dbPath);
const db = new Database(config.dbPath, { create: true });
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS migration_marks (version TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS persistent(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.query('INSERT OR IGNORE INTO persistent VALUES (?,?)').run('user', 'fresh user data');
db.query('INSERT OR IGNORE INTO migration_marks(version) VALUES (?)').run(${JSON.stringify(version)});
const stop = () => { db.close(); process.exit(0); };
process.on('SIGTERM', ${JSON.stringify(behavior)} === 'readiness-timeout' ? () => {} : stop);
process.on('disconnect', stop);
if (${JSON.stringify(behavior)} === 'migration-failure') {
  db.query('UPDATE persistent SET value=? WHERE key=?').run('candidate corrupted it', 'user');
  db.close();
  process.exit(42);
}
if (${JSON.stringify(behavior)} === 'readiness-timeout') {
  db.query('UPDATE persistent SET value=? WHERE key=?').run('partial timed out migration', 'user');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const activated = new Promise<void>(yes => process.on('message', (message: any) => {
  if (message?.type === 'brigd:activate') yes();
}));
process.send!({ type: 'brigd:ready' });
await activated;
appendFileSync(process.env.UPDATER_FIXTURE_OBSERVATIONS!, JSON.stringify({
  version: ${JSON.stringify(version)}, root, cwd: process.cwd(), databaseExistedBeforeOpen,
  dbPath: config.dbPath, workspacesDir: config.workspacesDir,
  cliHome: config.cliHome, defaultCwd: config.defaultCwd, mode: config.mode,
  persistent: (db.query('SELECT value FROM persistent WHERE key=?').get('user') as any).value,
  workspace: readFileSync(resolve(config.workspacesDir, 'retained-worktree.txt'), 'utf8'),
  cli: readFileSync(resolve(config.cliHome, '.claude/session.txt'), 'utf8'),
}) + '\\n');
process.send!({ type: 'brigd:active' });
if (${JSON.stringify(behavior)} === 'runtime-failure') {
  db.query('UPDATE persistent SET value=? WHERE key=?').run('new user data after activation', 'user');
  await Bun.sleep(25);
  db.close();
  process.exit(42);
}
if (${JSON.stringify(behavior)} === 'hold') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  await Bun.sleep(25);
  stop();
}
`);
}

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'brigd-update-test-'));
  temporaryFolders.push(folder);
  const project = join(folder, 'user project with spaces');
  const root = join(project, 'tools', 'brigd');
  const dbPath = join(root, 'data', 'existing.sqlite');
  const workspacesDir = join(root, 'data', 'custom-workspaces');
  const cliHome = join(root, 'local-cli');
  const observationsPath = join(folder, 'observations.jsonl');
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(workspacesDir, { recursive: true });
  mkdirSync(join(cliHome, '.claude'), { recursive: true });
  writeFileSync(join(workspacesDir, 'retained-worktree.txt'), 'worktree state');
  writeFileSync(join(cliHome, '.claude/session.txt'), 'existing CLI session');
  writeFileSync(join(project, 'package.json'), '{"name":"user-project","version":"7.0.0"}\n');
  writeFileSync(join(project, 'README.md'), 'User project documentation\n');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE persistent (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE migration_marks(version TEXT PRIMARY KEY)');
  db.query('INSERT INTO persistent VALUES (?,?)').run('user', 'existing user data');
  db.close();
  writeApp(root, '0.1.0');
  const env = {
    BRIGD_AUTO_UPDATE: '1', BRIGD_MODE: 'mock', BRIGD_DB: 'data/existing.sqlite',
    BRIGD_WORKSPACES_DIR: 'data/custom-workspaces', BRIGD_CLI_HOME: 'local-cli',
    BRIGD_DEFAULT_CWD: project, UPDATER_FIXTURE_OBSERVATIONS: observationsPath,
  };
  const observations = (): Observation[] => existsSync(observationsPath)
    ? readFileSync(observationsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const readData = () => {
    const saved = new Database(dbPath, { readonly: true });
    try {
      return {
        user: (saved.query('SELECT value FROM persistent WHERE key=?').get('user') as { value: string }).value,
        migrations: (saved.query('SELECT version FROM migration_marks ORDER BY version').all() as { version: string }[]).map(row => row.version),
      };
    } finally { saved.close(); }
  };
  return { folder, project, root, dbPath, workspacesDir, cliHome, env, observations, readData };
}

function candidate(behavior: Behavior = 'success') {
  return async ({ tag }: { tag: string }, { cacheDir }: { cacheDir: string }) => {
    const version = tag.replace(/^v/, '');
    const root = join(cacheDir, 'releases', `fixture-${version}`);
    writeApp(root, version, behavior);
    return root;
  };
}
const latest = async () => ({ tag: 'v0.2.0' });
const noRelease = async () => null;

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Fixture did not reach the expected startup state');
    await Bun.sleep(10);
  }
}

describe('native startup updater', () => {
  test.each(['offline', 'no-release'] as const)('%s starts the installed application with existing data', async availability => {
    const f = fixture();
    const messages: string[] = [];
    const releaseLookup = availability === 'offline' ? async () => { throw new Error('Network unavailable'); } : noRelease;
    const code = await startBrigd(f.root, { env: f.env, releaseLookup, log: message => messages.push(message), startupTimeoutMs: 2000 });
    expect(code).toBe(0);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
    expect(f.readData().user).toBe('existing user data');
    if (availability === 'offline') expect(messages.join('\n')).toContain('Network unavailable');
  });

  test.each(['copied', 'nested-clone'] as const)('%s installation retains database, workspaces, CLI session and the host repository', async installation => {
    const f = fixture();
    expect(Bun.spawnSync(['git', 'init', '--quiet', f.project]).exitCode).toBe(0);
    if (installation === 'nested-clone') expect(Bun.spawnSync(['git', 'init', '--quiet', f.root]).exitCode).toBe(0);
    const hostGitConfig = readFileSync(join(f.project, '.git/config'), 'utf8');
    const appGitConfig = installation === 'nested-clone' ? readFileSync(join(f.root, '.git/config'), 'utf8') : null;
    const code = await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate(), startupTimeoutMs: 2000 });
    expect(code).toBe(0);
    expect(f.observations()).toHaveLength(1);
    expect(f.observations()[0]).toMatchObject({
      version: '0.2.0', cwd: f.root, dbPath: f.dbPath,
      workspacesDir: f.workspacesDir, cliHome: f.cliHome, defaultCwd: f.project,
      mode: 'mock', persistent: 'existing user data', workspace: 'worktree state', cli: 'existing CLI session',
    });
    expect(f.observations()[0]!.root).toStartWith(join(f.root, '.brigd-updates', 'releases'));
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.2.0'] });
    expect(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version).toBe('0.1.0');
    expect(readFileSync(join(f.project, 'package.json'), 'utf8')).toBe('{"name":"user-project","version":"7.0.0"}\n');
    expect(readFileSync(join(f.project, 'README.md'), 'utf8')).toBe('User project documentation\n');
    expect(readFileSync(join(f.project, '.git/config'), 'utf8')).toBe(hostGitConfig);
    if (appGitConfig) expect(readFileSync(join(f.root, '.git/config'), 'utf8')).toBe(appGitConfig);
  });

  test('a candidate that fails after writing migrations restores data before starting the previous application', async () => {
    const f = fixture();
    const code = await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('migration-failure'), startupTimeoutMs: 2000 });
    expect(code).toBe(0);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
    const state = JSON.parse(readFileSync(join(f.root, '.brigd-updates/state.json'), 'utf8'));
    expect(state.current).toBeNull();
    expect(state.pending).toBeUndefined();
  });

  test('a preparation failure leaves the installed code and data usable', async () => {
    const f = fixture();
    let attempted = false;
    const code = await startBrigd(f.root, {
      env: f.env, releaseLookup: latest, startupTimeoutMs: 2000,
      prepareRelease: async () => { attempted = true; throw new Error('Dependency installation failed'); },
    });
    expect(attempted).toBe(true);
    expect(code).toBe(0);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
    expect(f.readData().user).toBe('existing user data');
  });

  test('a failed first-run candidate removes its newly created database before fallback', async () => {
    const f = fixture();
    rmSync(f.dbPath);
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('migration-failure'), startupTimeoutMs: 2000 })).toBe(0);
    expect(f.observations()[0]).toMatchObject({ version: '0.1.0', databaseExistedBeforeOpen: false, persistent: 'fresh user data' });
    expect(f.readData()).toEqual({ user: 'fresh user data', migrations: ['0.1.0'] });
  });

  test('a hung migration is forcibly stopped before its database is restored', async () => {
    const f = fixture();
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('readiness-timeout'), startupTimeoutMs: 500 })).toBe(0);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
  }, 10000);

  test('runtime failure after activation retains the selected release and new user writes', async () => {
    const f = fixture();
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('runtime-failure'), startupTimeoutMs: 2000 })).toBe(42);
    expect(f.readData()).toEqual({ user: 'new user data after activation', migrations: ['0.2.0'] });
    expect(JSON.parse(readFileSync(join(f.root, '.brigd-updates/state.json'), 'utf8')).current)
      .toBe(f.observations()[0]!.root);
  });

  test('the rollback snapshot includes committed data still present only in the old WAL', async () => {
    const f = fixture();
    const crashed = Bun.spawnSync([process.execPath, '-e', `
      import { Database } from 'bun:sqlite';
      const db = new Database(${JSON.stringify(f.dbPath)});
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      db.query('UPDATE persistent SET value=? WHERE key=?').run('committed WAL data', 'user');
      process.kill(process.pid, 'SIGKILL');
    `]);
    expect(crashed.exitCode).not.toBe(0);
    expect(existsSync(f.dbPath + '-wal')).toBe(true);
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('migration-failure'), startupTimeoutMs: 2000 })).toBe(0);
    expect(f.observations()[0]!.persistent).toBe('committed WAL data');
    expect(f.readData()).toEqual({ user: 'committed WAL data', migrations: ['0.1.0'] });
  });

  test.skipIf(process.platform === 'win32')('migration rollback preserves a database symlink and its original target data', async () => {
    const f = fixture();
    const target = join(f.folder, 'external.sqlite');
    renameSync(f.dbPath, target);
    symlinkSync(target, f.dbPath);
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate('migration-failure'), startupTimeoutMs: 2000 })).toBe(0);
    expect(lstatSync(f.dbPath).isSymbolicLink()).toBe(true);
    const db = new Database(target, { readonly: true });
    try { expect(db.query('SELECT value FROM persistent WHERE key=?').get('user')).toEqual({ value: 'existing user data' }); }
    finally { db.close(); }
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
  });

  test('a nonresponding update check is bounded and falls back to the installed app', async () => {
    const f = fixture();
    let lookupSignal: AbortSignal | undefined;
    expect(await startBrigd(f.root, {
      env: { ...f.env, BRIGD_UPDATE_TIMEOUT_MS: '30' }, startupTimeoutMs: 2000,
      releaseLookup: signal => { lookupSignal = signal; return new Promise(() => {}); },
    })).toBe(0);
    expect(lookupSignal!.aborted).toBe(true);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
  });

  test('cancelling preparation stops its subprocess before allowing another startup', async () => {
    const f = fixture();
    const marker = join(f.folder, 'installer-pid');
    const controller = new AbortController();
    const result = startBrigd(f.root, {
      env: f.env, releaseLookup: latest, signal: controller.signal, startupTimeoutMs: 2000,
      prepareRelease: async (_release, { run, root }) => {
        await run([process.execPath, '-e', `
          import { writeFileSync } from 'node:fs';
          writeFileSync(${JSON.stringify(marker)}, String(process.pid));
          setInterval(() => {}, 1000);
        `], root);
        throw new Error('Cancelled installer unexpectedly completed');
      },
    });
    running.push({ controller, result });
    await waitFor(() => existsSync(marker));
    const pid = Number(readFileSync(marker, 'utf8'));
    controller.abort();
    expect(await result).toBe(130);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.observations()).toEqual([]);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: [] });
    expect(await startBrigd(f.root, { env: { ...f.env, BRIGD_AUTO_UPDATE: '0' }, startupTimeoutMs: 2000 })).toBe(0);
  });

  test('disabling network updates continues using the previously activated release', async () => {
    const f = fixture();
    expect(await startBrigd(f.root, { env: f.env, releaseLookup: latest, prepareRelease: candidate(), startupTimeoutMs: 2000 })).toBe(0);
    let lookedUp = false;
    expect(await startBrigd(f.root, {
      env: { ...f.env, BRIGD_AUTO_UPDATE: '0' }, startupTimeoutMs: 2000,
      releaseLookup: async () => { lookedUp = true; throw new Error('Disabled update tried the network'); },
    })).toBe(0);
    expect(lookedUp).toBe(false);
    expect(f.observations().map(row => row.version)).toEqual(['0.2.0', '0.2.0']);
  });

  test('a pending interrupted migration is recovered before running the previous release', async () => {
    const f = fixture();
    const cacheDir = join(f.root, '.brigd-updates');
    const failed = join(cacheDir, 'releases', 'fixture-0.2.0');
    const backup = join(cacheDir, 'backup', 'interrupted.sqlite');
    writeApp(failed, '0.2.0');
    mkdirSync(dirname(backup), { recursive: true });
    const db = new Database(f.dbPath);
    db.query('VACUUM INTO ?').run(backup);
    db.query('UPDATE persistent SET value=? WHERE key=?').run('partial migration', 'user');
    db.query('INSERT INTO migration_marks VALUES (?)').run('0.2.0');
    db.close();
    writeFileSync(join(cacheDir, 'state.json'), JSON.stringify({
      protocol: 1, current: null,
      pending: { previous: null, candidate: failed, backup, dbPath: f.dbPath },
    }));
    expect(await startBrigd(f.root, { env: { ...f.env, BRIGD_AUTO_UPDATE: '0' }, releaseLookup: noRelease, startupTimeoutMs: 2000 })).toBe(0);
    expect(f.observations().map(row => row.version)).toEqual(['0.1.0']);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
    expect(JSON.parse(readFileSync(join(cacheDir, 'state.json'), 'utf8')).pending).toBeUndefined();
  });

  test('concurrent launch is rejected before another candidate can mutate the database', async () => {
    const f = fixture();
    writeApp(f.root, '0.1.0', 'hold');
    const controller = new AbortController();
    const result = startBrigd(f.root, { env: f.env, releaseLookup: noRelease, signal: controller.signal, startupTimeoutMs: 2000 });
    running.push({ controller, result });
    await waitFor(() => f.observations().length === 1);
    let preparationAttempted = false;
    let failed = false;
    try {
      const code = await startBrigd(f.root, {
        env: f.env, releaseLookup: latest, startupTimeoutMs: 2000,
        prepareRelease: async (...args) => { preparationAttempted = true; return candidate('migration-failure')(...args); },
      });
      failed = code !== 0;
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(preparationAttempted).toBe(false);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
    expect(f.observations()).toHaveLength(1);
    controller.abort();
    await result;
  });

  test('one installation cannot update shared release state concurrently using a different database', async () => {
    const f = fixture();
    writeApp(f.root, '0.1.0', 'hold');
    const controller = new AbortController();
    const result = startBrigd(f.root, { env: f.env, releaseLookup: noRelease, signal: controller.signal, startupTimeoutMs: 2000 });
    running.push({ controller, result });
    await waitFor(() => f.observations().length === 1);
    const secondDatabase = join(f.root, 'data', 'second.sqlite');
    let lookedUp = false;
    let prepared = false;
    await expect(startBrigd(f.root, {
      env: { ...f.env, BRIGD_DB: secondDatabase }, startupTimeoutMs: 2000,
      releaseLookup: async () => { lookedUp = true; return latest(); },
      prepareRelease: async (...args) => { prepared = true; return candidate()(...args); },
    })).rejects.toThrow();
    expect(lookedUp).toBe(false);
    expect(prepared).toBe(false);
    expect(existsSync(secondDatabase)).toBe(false);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: ['0.1.0'] });
    expect(f.observations()).toHaveLength(1);
    controller.abort();
    await result;
  });

  test('a live service lease from a direct server start prevents migrations and release preparation', async () => {
    const f = fixture();
    const db = new Database(f.dbPath);
    db.exec('CREATE TABLE service_lease(singleton INTEGER PRIMARY KEY,pid INTEGER,owner TEXT,identity TEXT)');
    db.query('INSERT INTO service_lease VALUES (1,?,?,NULL)').run(process.pid, 'direct-service-owner');
    db.close();
    let preparationAttempted = false;
    await expect(startBrigd(f.root, {
      env: f.env, releaseLookup: latest, startupTimeoutMs: 2000,
      prepareRelease: async (...args) => { preparationAttempted = true; return candidate()(...args); },
    })).rejects.toThrow();
    expect(preparationAttempted).toBe(false);
    expect(f.observations()).toEqual([]);
    expect(f.readData()).toEqual({ user: 'existing user data', migrations: [] });
  });
});
