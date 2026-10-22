import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Run, WorkspaceSnapshot } from '../src/lib/types';
import { gitExit, gitOutput, inside, isRegistered, ownedWorktree, removeTree } from './workspace-storage';

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
    if (workspace.removedAt && existsSync(workspace.path) && !isRegistered(workspace.repositoryId, workspace.path)) {
      // Leftovers of a removal that stopped halfway: Git already forgot the folder, so it is cleared before the recreation below.
      const debris = basename(workspace.path) === workspace.id && inside(resolve(workspace.path, '..'), workspace.path) && !lstatSync(workspace.path).isSymbolicLink() &&
        (!existsSync(join(workspace.path, '.git')) || !!ownedWorktree(workspace.path, [workspace.repositoryId]));
      if (!debris) throw new WorkspaceError('Сохранённый worktree изменён или относится к другому репозиторию. Восстановите рабочее окружение перед продолжением.');
      try { removeTree(workspace.path); } catch { throw new WorkspaceError('Не удалось убрать остатки удалённой рабочей папки. Удалите её вручную и повторите.'); }
    }
    if (!existsSync(workspace.path)) {
      if (workspace.prepared && !workspace.removedAt) throw new WorkspaceError('Сохранённый worktree отсутствует. Восстановите его; продолжение в новой папке не заменяет прежнюю сессию.');
      mkdirSync(resolve(workspace.path, '..'), { recursive: true, mode: 0o700 });
      const spawnGit = async (args: string[]) => await gitExit(['-C', workspace.repositoryRoot, ...args]) === 0;
      if (workspace.removedAt) {
        // The folder was reclaimed after a merge: every result is committed on its branch, so the same path comes back from there.
        // Only brigd's own stale registration is cleared; other worktrees of the repository are never pruned.
        if (isRegistered(workspace.repositoryId, workspace.path)) await gitExit(['--git-dir', workspace.repositoryId, 'worktree', 'remove', '--force', '--force', workspace.path]);
        const listing = gitOutput(['--git-dir', workspace.repositoryId, 'worktree', 'list', '--porcelain', '-z']) ?? '';
        if (listing.split('\0').includes(`branch refs/heads/${workspace.branch}`)) throw new WorkspaceError(`Ветка ${workspace.branch} уже открыта в другом worktree. Закройте её там, чтобы воссоздать рабочую папку запуска.`);
        const branchExists = gitOutput(['--git-dir', workspace.repositoryId, 'rev-parse', '--verify', '--quiet', `refs/heads/${workspace.branch}`]) !== null;
        // A branch deleted by hand is rebuilt from the last merged commit, which was stored together with the removal.
        const created = await spawnGit(branchExists ? ['worktree', 'add', workspace.path, workspace.branch!]
          : ['worktree', 'add', '-b', workspace.branch!, workspace.path, workspace.lastIntegratedCommit ?? workspace.baseCommit!]);
        if (!created) throw new WorkspaceError(`Не удалось заново создать Git worktree из ветки ${workspace.branch} после очистки. Проверьте место на диске и состояние ветки.`);
        if (workspace.lastIntegratedCommit && git(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']) !== workspace.lastIntegratedCommit) {
          // The fresh folder goes again, so the next attempt re-evaluates the branch instead of resuming on the wrong tree.
          await gitExit(['--git-dir', workspace.repositoryId, 'worktree', 'remove', '--force', '--force', workspace.path]);
          throw new WorkspaceError(`Ветка ${workspace.branch} указывает не на перенесённый коммит ${workspace.lastIntegratedCommit.slice(0, 12)}; сохранённая сессия работала с ним. Верните ветку на этот коммит или начните новый запуск.`);
        }
        // The project subdirectory may hold only ignored files, which the branch cannot bring back.
        if (inside(workspace.path, workspace.cwd)) mkdirSync(workspace.cwd, { recursive: true });
      } else if (!await spawnGit(['worktree', 'add', '-b', workspace.branch!, workspace.path, workspace.baseCommit!])) {
        throw new WorkspaceError('Не удалось создать Git worktree. Проверьте место на диске и нативные разрешения Git; рабочая папка проекта сохранена.');
      }
    }
    const located = repository(workspace.path);
    if (located.repositoryId !== workspace.repositoryId || located.repositoryRoot !== canonical(workspace.path) ||
        git(workspace.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== workspace.branch) {
      throw new WorkspaceError('Сохранённый worktree изменён или относится к другому репозиторию. Восстановите рабочее окружение перед продолжением.');
    }
    canonical(workspace.cwd);
  }
}
