import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { readConfig } from '../server/config';
import { acquireStartupLock, assertDatabaseIdle, canonicalDatabasePath } from '../server/startup-lock';

type Environment = Record<string, string | undefined>;
export interface LatestRelease { tag: string; }
export interface PrepareContext {
  root: string;
  cacheDir: string;
  env: Environment;
  signal: AbortSignal;
  run(command: string[], cwd: string): Promise<string>;
}
export interface StartOptions {
  env?: Environment;
  log?: (message: string) => void;
  releaseLookup?: (signal: AbortSignal) => Promise<LatestRelease | null>;
  prepareRelease?: (release: LatestRelease, context: PrepareContext) => Promise<string>;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
}
interface PendingUpdate { previous: string | null; candidate: string; backup: string | null; dbPath: string; }
interface UpdateState { protocol: 1; current: string | null; pending?: PendingUpdate; }
interface Manifest { name: string; version: string; brigdUpdaterProtocol?: number; }
const repository = 'https://github.com/olntn/brigd.git';
const releaseEndpoint = 'https://api.github.com/repos/olntn/brigd/releases/latest';
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = () => new Error('Запуск отменён');

/** Only stable semantic versions may enter the automatic update channel. */
export function stableVersion(value: string): number[] | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compareVersions(left: string, right: string): number {
  const a = stableVersion(left), b = stableVersion(right);
  if (!a || !b) throw new Error('Версия brigd должна иметь формат X.Y.Z');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  return 0;
}
function manifest(source: string): Manifest {
  const value: Manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (value.name !== 'brigd' || typeof value.version !== 'string' || !stableVersion(value.version) ||
      value.brigdUpdaterProtocol !== 1 || !existsSync(join(source, 'server', 'index.ts'))) {
    throw new Error('Выпуск brigd не поддерживает безопасный управляемый запуск');
  }
  return value;
}
function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  syncFile(path);
}
function writeState(path: string, state: UpdateState) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    syncFile(temporary);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}
function managedSource(cacheDir: string, path: unknown): string {
  if (typeof path !== 'string' || !resolve(path).startsWith(`${join(cacheDir, 'releases')}${sep}`)) {
    throw new Error('Некорректный путь сохранённого выпуска brigd');
  }
  return resolve(path);
}
function readState(path: string, cacheDir: string): UpdateState {
  if (!existsSync(path)) return { protocol: 1, current: null };
  const value: UpdateState = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.protocol !== 1 || (value.current !== null && typeof value.current !== 'string')) {
    throw new Error('Повреждено состояние обновлений brigd; сохраните каталог .brigd-updates для восстановления');
  }
  if (value.current !== null) managedSource(cacheDir, value.current);
  if (value.pending) {
    const pending = value.pending;
    if (!pending || typeof pending !== 'object' || typeof pending.dbPath !== 'string' ||
        (pending.backup !== null && (typeof pending.backup !== 'string' || !resolve(pending.backup).startsWith(`${join(cacheDir, 'backup')}${sep}`)))) {
      throw new Error('Повреждён журнал незавершённого обновления brigd');
    }
    if (pending.previous !== null) managedSource(cacheDir, pending.previous);
    managedSource(cacheDir, pending.candidate);
  }
  return value;
}
function snapshotDatabase(dbPath: string, cacheDir: string): string | null {
  if (!existsSync(dbPath)) return null;
  const backupDir = join(cacheDir, 'backup');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `${Date.now()}-${randomUUID()}.sqlite`);
  const db = new Database(dbPath, { readonly: true });
  try { db.query('VACUUM INTO ?').run(backup); } finally { db.close(); }
  if (process.platform !== 'win32') chmodSync(backup, 0o600);
  syncFile(backup);
  syncDirectory(backupDir);
  return backup;
}
function restoreDatabase(pending: PendingUpdate) {
  assertDatabaseIdle(pending.dbPath);
  if (pending.backup !== null && !existsSync(pending.backup)) {
    throw new Error(`Резервная копия отсутствует: ${pending.backup}. Автоматический запуск остановлен`);
  }
  // SQLite's WAL belongs to the failed candidate, never to the restored snapshot.
  for (const suffix of ['-wal', '-shm']) rmSync(`${pending.dbPath}${suffix}`, { force: true });
  if (pending.backup === null) rmSync(pending.dbPath, { force: true });
  else {
    const temporary = `${pending.dbPath}.${randomUUID()}.restore`;
    try {
      copyFileSync(pending.backup, temporary);
      if (process.platform !== 'win32') chmodSync(temporary, 0o600);
      syncFile(temporary);
      renameSync(temporary, pending.dbPath);
    } finally { rmSync(temporary, { force: true }); }
  }
  syncDirectory(dirname(pending.dbPath));
}
async function latestRelease(signal: AbortSignal): Promise<LatestRelease | null> {
  const response = await fetch(releaseEndpoint, { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'brigd-updater' } });
  if (response.status === 404) return null; // No stable releases have been published yet.
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const release = await response.json() as { draft?: boolean; prerelease?: boolean; tag_name?: unknown };
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !stableVersion(release.tag_name)) return null;
  return { tag: release.tag_name };
}
async function prepareRelease(release: LatestRelease, context: PrepareContext): Promise<string> {
  const { cacheDir, root, run } = context;
  const bare = join(cacheDir, 'repository.git');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  if (!existsSync(bare)) await run(['git', 'init', '--bare', bare], root);
  // Explicit --git-dir and URL never resolve the enclosing user's repository.
  await run(['git', '--git-dir', bare, 'fetch', '--no-tags', '--depth=1', repository,
    `+refs/tags/${release.tag}:refs/tags/${release.tag}`], root);
  const sha = (await run(['git', '--git-dir', bare, 'rev-parse', '--verify', `refs/tags/${release.tag}^{commit}`], root)).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Git вернул некорректный идентификатор выпуска');
  const source = join(cacheDir, 'releases', sha);
  if (!existsSync(source)) {
    mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
    await run(['git', '--git-dir', bare, 'worktree', 'add', '--detach', source, sha], root);
  }
  const candidate = manifest(source);
  if (compareVersions(candidate.version, release.tag) !== 0) throw new Error('Версия package.json не совпадает с тегом выпуска');
  await run([process.execPath, 'install', '--frozen-lockfile'], source);
  await run([process.execPath, 'run', 'build'], source);
  return source;
}
type Child = ReturnType<typeof Bun.spawn>;
function signalChild(child: Child, signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* The process may already have exited. */ }
}
async function stopChild(child: Child) {
  signalChild(child, 'SIGTERM');
  const timer = setTimeout(() => signalChild(child, 'SIGKILL'), 3_000);
  try { await child.exited; } finally {
    clearTimeout(timer);
    // Installer/build grandchildren share this group and must not survive cancellation.
    signalChild(child, 'SIGKILL');
  }
}
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, signal: AbortSignal, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(aborted());
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Keeps application code separate from persistent user paths and switches only after gated startup. */
export async function startBrigd(installRoot: string, options: StartOptions = {}): Promise<number> {
  const root = resolve(installRoot);
  const env = { ...process.env, ...options.env };
  const log = options.log ?? console.log;
  const config = readConfig(root, env);
  // Preserve an existing DB symlink: snapshot/restore replaces its target, never the link.
  config.dbPath = canonicalDatabasePath(config.dbPath);
  const cacheDir = join(root, '.brigd-updates');
  const statePath = join(cacheDir, 'state.json');
  const controller = new AbortController();
  let exitCode = 130;
  const cancel = () => controller.abort();
  const interrupt = () => { exitCode = 130; cancel(); };
  const terminate = () => { exitCode = 143; cancel(); };
  const children = new Set<Child>();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let lock: ReturnType<typeof acquireStartupLock> | undefined;
  let installationLock: ReturnType<typeof acquireStartupLock> | undefined;
  try {
    if (controller.signal.aborted) return exitCode;
    // State and the Git/build cache are shared even when callers select different DBs.
    installationLock = acquireStartupLock(join(cacheDir, 'installation'));
    lock = acquireStartupLock(config.dbPath);
    assertDatabaseIdle(config.dbPath);
    const childEnv: Environment = { ...env, BRIGD_DB: config.dbPath, BRIGD_WORKSPACES_DIR: config.workspacesDir,
      BRIGD_CLI_HOME: config.cliHome, BRIGD_DEFAULT_CWD: resolve(root, config.defaultCwd ?? root),
      BRIGD_STARTUP_TOKEN: lock.token, BRIGD_MANAGED_START: '1' };
    let state = readState(statePath, cacheDir);
    if (state.pending) {
      if (state.pending.dbPath !== config.dbPath) throw new Error(`Незавершённое обновление относится к базе ${state.pending.dbPath}; запустите с прежним BRIGD_DB`);
      restoreDatabase(state.pending);
      state = { protocol: 1, current: state.pending.previous };
      writeState(statePath, state);
      log('[brigd] Восстановлена база после незавершённого обновления');
    }
    const base = manifest(root);
    let source = root;
    let installed = base;
    if (state.current !== null) {
      try {
        const cached = manifest(state.current);
        if (compareVersions(cached.version, base.version) > 0) { source = state.current; installed = cached; }
        else { state = { protocol: 1, current: null }; writeState(statePath, state); }
      } catch (error) {
        // The database might already require this release: never silently downgrade it.
        throw new Error(`Сохранённый выпуск недоступен: ${describe(error)}. Восстановите ${state.current}`);
      }
    }
    const run = async (command: string[], cwd: string): Promise<string> => {
      if (controller.signal.aborted) throw aborted();
      const child = Bun.spawn(command, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32' });
      children.add(child);
      const onAbort = () => { void stopChild(child); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { void stopChild(child); }, 300_000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (controller.signal.aborted) throw aborted();
        if (code !== 0) throw new Error(`${command[0]}: ${stderr.trim().slice(-2_000) || `код ${code}`}`);
        return stdout;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        children.delete(child);
      }
    };
    const launch = async (application: string, commit?: () => void): Promise<number> => {
      if (controller.signal.aborted) throw aborted();
      let ready!: () => void, active!: () => void;
      let rejectReady!: (error: Error) => void, rejectActive!: (error: Error) => void;
      const readyPromise = new Promise<void>((yes, no) => { ready = yes; rejectReady = no; });
      const activePromise = new Promise<void>((yes, no) => { active = yes; rejectActive = no; });
      // Both promises may reject on an early child exit, before the second one is awaited.
      void activePromise.catch(() => {});
      const child = Bun.spawn([process.execPath, join(application, 'server', 'index.ts')], {
        cwd: root, env: childEnv, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', detached: process.platform !== 'win32',
        ipc(message: unknown) {
          const type = (message as { type?: unknown } | null)?.type;
          if (type === 'brigd:ready') ready();
          if (type === 'brigd:active') active();
        }
      });
      children.add(child);
      const onAbort = () => { void stopChild(child); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      void child.exited.then(code => {
        const error = new Error(`Сервер завершился до подтверждения запуска (код ${code})`);
        rejectReady(error); rejectActive(error);
      });
      try {
        const timeout = options.startupTimeoutMs ?? 15_000;
        await withTimeout(readyPromise, timeout, controller.signal, 'Сервер не подтвердил безопасный запуск');
        if (controller.signal.aborted) throw aborted();
        commit?.();
        child.send({ type: 'brigd:activate' });
        await withTimeout(activePromise, timeout, controller.signal, 'Сервер не подтвердил активацию');
        const code = await child.exited;
        return controller.signal.aborted ? exitCode : code;
      } catch (error) {
        await stopChild(child);
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
        children.delete(child);
      }
    };
    let release: LatestRelease | null = null;
    if (env.BRIGD_AUTO_UPDATE !== '0') {
      const requestedTimeout = Number(env.BRIGD_UPDATE_TIMEOUT_MS ?? 5_000);
      const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 60_000) : 5_000;
      const lookupController = new AbortController();
      const cancelLookup = () => lookupController.abort();
      controller.signal.addEventListener('abort', cancelLookup, { once: true });
      try {
        release = await withTimeout((options.releaseLookup ?? latestRelease)(lookupController.signal), timeout, controller.signal, 'Проверка обновлений превысила время ожидания');
      } catch (error) {
        if (controller.signal.aborted) return exitCode;
        log(`[brigd] Проверка обновлений недоступна, запускается установленная версия: ${describe(error)}`);
      } finally { lookupController.abort(); controller.signal.removeEventListener('abort', cancelLookup); }
    }
    if (release && stableVersion(release.tag) && compareVersions(release.tag, installed.version) > 0) {
      let pending: PendingUpdate | undefined;
      let committed = false;
      try {
        log(`[brigd] Подготовка обновления ${installed.version} → ${release.tag}`);
        const candidate = managedSource(cacheDir, await (options.prepareRelease ?? prepareRelease)(release, { root, cacheDir, env, signal: controller.signal, run }));
        const candidateManifest = manifest(candidate);
        if (compareVersions(candidateManifest.version, release.tag) !== 0) throw new Error('Версия package.json не совпадает с тегом выпуска');
        if (controller.signal.aborted) return exitCode;
        assertDatabaseIdle(config.dbPath);
        pending = { previous: state.current, candidate, backup: snapshotDatabase(config.dbPath, cacheDir), dbPath: config.dbPath };
        state = { protocol: 1, current: state.current, pending };
        writeState(statePath, state);
        return await launch(candidate, () => {
          // Commit before activation: from this point, user writes must never be rolled back.
          writeState(statePath, { protocol: 1, current: candidate });
          committed = true;
          log(`[brigd] Установлена версия ${candidateManifest.version}${pending!.backup ? `; резервная копия: ${pending!.backup}` : ''}`);
        });
      } catch (error) {
        if (committed) throw error;
        if (pending) {
          restoreDatabase(pending);
          state = { protocol: 1, current: pending.previous };
          writeState(statePath, state);
        }
        if (controller.signal.aborted) return exitCode;
        log(`[brigd] Обновление не применено, запускается версия ${installed.version}: ${describe(error)}`);
      }
    }
    if (controller.signal.aborted) return exitCode;
    log(`[brigd] Запуск версии ${installed.version}`);
    return await launch(source);
  } catch (error) {
    if (controller.signal.aborted) return exitCode;
    throw error;
  } finally {
    await Promise.all([...children].map(stopChild));
    lock?.release();
    installationLock?.release();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    options.signal?.removeEventListener('abort', cancel);
  }
}
