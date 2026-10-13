import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Run, WorkspaceSnapshot } from '../src/lib/types';

export class WorkspaceError extends Error {}
export interface RepositoryLocation {
  repositoryId: string;
  repositoryRoot: string;
  projectCwd: string;
}
export interface WorkspaceProvider {
  locate(run: Pick<Run, 'cwd' | 'workspace'>): RepositoryLocation;
  plan(run: Run, location: RepositoryLocation): WorkspaceSnapshot;
  prepare(workspace: WorkspaceSnapshot): void | Promise<void>;
}
// Argument arrays preserve literal paths; Git is never invoked through a shell.
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (result.exitCode !== 0) throw new WorkspaceError('Git не смог проверить рабочую папку. Нужен доступный репозиторий с сохранённым коммитом.');
  return result.stdout.toString().trim();
}
function canonical(cwd: string): string {
  try { const path = realpathSync(cwd); if (statSync(path).isDirectory()) return path; } catch { /* Explain without leaking command output. */ }
  throw new WorkspaceError('Рабочая папка недоступна. Проверьте путь и нативные разрешения.');
}
function repository(cwd: string): RepositoryLocation {
  const projectCwd = canonical(cwd);
  return { projectCwd, repositoryRoot: canonical(git(projectCwd, ['rev-parse', '--show-toplevel'])),
    repositoryId: canonical(git(projectCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) };
}
function direct(run: Run, location: RepositoryLocation): WorkspaceSnapshot {
  return { ...location, id: run.id, path: location.projectCwd, cwd: run.cwd,
    branch: null, baseCommit: null, targetBranch: null, mode: 'direct', prepared: true };
}
/** Demos and injected factories perform no Git or worktree mutations. */
export class DirectWorkspaces implements WorkspaceProvider {
  locate(run: Pick<Run, 'cwd' | 'workspace'>): RepositoryLocation {
    let path = resolve(run.cwd);
    try { path = realpathSync(path); } catch { /* Synthetic test folders need not exist. */ }
    return { projectCwd: path, repositoryRoot: path, repositoryId: path };
  }
  plan(run: Run, location: RepositoryLocation) { return run.workspace ?? direct(run, location); }
  prepare() {}
}
export class GitWorkspaces implements WorkspaceProvider {
  constructor(readonly root: string, private readonly checks?: string[][] | (() => string[][] | undefined)) {}
  locate(run: Pick<Run, 'cwd' | 'workspace'>): RepositoryLocation {
    if (run.workspace) return { repositoryId: run.workspace.repositoryId, repositoryRoot: run.workspace.repositoryRoot, projectCwd: run.workspace.projectCwd };
    return repository(run.cwd);
  }
  plan(run: Run, location: RepositoryLocation): WorkspaceSnapshot {
    if (run.workspace) return run.workspace;
    // Existing exact sessions retain their original directory, including old
    // completed workflow sessions followed up after the migration.
    if (run.sessionId) return direct(run, location);
    const baseCommit = git(location.projectCwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    let targetBranch: string | null = null;
    try { targetBranch = git(location.projectCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* Detached HEAD is supported. */ }
    const bucket = createHash('sha256').update(location.repositoryId).digest('hex').slice(0, 20);
    const path = resolve(this.root, bucket, run.id);
    const subdirectory = relative(location.repositoryRoot, location.projectCwd);
    if (subdirectory === '..' || subdirectory.startsWith(`..${sep}`) || isAbsolute(subdirectory)) throw new WorkspaceError('Рабочая папка находится вне репозитория.');
    let checkCommands = typeof this.checks === 'function' ? this.checks() : this.checks;
    if (!checkCommands) {
      // Choose commands from the trusted starting commit, before an agent can
      // change package scripts. Other projects can configure explicit argv.
      try {
        const manifest = JSON.parse(git(location.projectCwd, ['show', `${baseCommit}:package.json`]));
        const manager = /^pnpm@/.test(manifest.packageManager ?? '') ? 'pnpm' : /^yarn@/.test(manifest.packageManager ?? '') ? 'yarn' : /^npm@/.test(manifest.packageManager ?? '') ? 'npm' : 'bun';
        const scripts = manifest.scripts ?? {};
        const names = typeof scripts.verify === 'string' ? ['verify'] : ['check', 'test', 'build'].filter(name => typeof scripts[name] === 'string');
        if (names.length) checkCommands = [[manager, 'install', ...(manager === 'bun' || manager === 'pnpm' || manager === 'yarn' ? ['--frozen-lockfile'] : [])], ...names.map(name => [manager, 'run', name])];
      } catch { /* A changed project requires explicitly configured checks. */ }
    }
    return { ...location, id: run.id, path, cwd: join(path, subdirectory), branch: `brigd/run-${run.id}`,
      baseCommit, targetBranch, mode: 'worktree', prepared: false, checkCommands: checkCommands ?? [] };
  }
  async prepare(workspace: WorkspaceSnapshot) {
    if (repository(workspace.mode === 'direct' ? workspace.cwd : workspace.repositoryRoot).repositoryId !== workspace.repositoryId) {
      throw new WorkspaceError('Исходный репозиторий изменён. Восстановите рабочее окружение перед продолжением.');
    }
    if (workspace.mode === 'direct') return;
    if (!existsSync(workspace.path)) {
      if (workspace.prepared) throw new WorkspaceError('Сохранённый worktree отсутствует. Восстановите его; продолжение в новой папке не заменяет прежнюю сессию.');
      mkdirSync(resolve(workspace.path, '..'), { recursive: true, mode: 0o700 });
      const child = Bun.spawn(['git', '-C', workspace.repositoryRoot, 'worktree', 'add', '-b', workspace.branch!, workspace.path, workspace.baseCommit!],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 60_000 });
      if (await child.exited !== 0) throw new WorkspaceError('Не удалось создать Git worktree. Проверьте место на диске и нативные разрешения Git; рабочая папка проекта сохранена.');
    }
    const located = repository(workspace.path);
    if (located.repositoryId !== workspace.repositoryId || located.repositoryRoot !== canonical(workspace.path) ||
        git(workspace.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== workspace.branch) {
      throw new WorkspaceError('Сохранённый worktree изменён или относится к другому репозиторию. Восстановите рабочее окружение перед продолжением.');
    }
    canonical(workspace.cwd);
  }
}
