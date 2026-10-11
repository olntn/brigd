import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Integration, Run } from '../src/lib/types';
import { runBoundedProcess } from './adapter';
import { GitWorkspaces } from './workspaces';
import { INTEGRATOR_WORKER } from '../src/lib/workers';

/** Merge commits are authored by the built-in integrator so history separates them from human and worker commits; the committer stays the repository identity. */
export const INTEGRATOR_AUTHOR = `${INTEGRATOR_WORKER.name} <integrator@localhost>`;

class IntegrationError extends Error {
  constructor(readonly status: 'conflict' | 'failed' | 'blocked' | 'queued', message: string, readonly patch: Partial<Integration> = {}) { super(message); }
}
export type IntegrationUpdate = (patch: Partial<Integration>) => void;
/** The current target merged into the saved source worktree; no conflicts means nothing was left to resolve. */
export interface Reconciliation { targetCommit: string; conflicts: string[]; }
export interface Integrator {
  execute(run: Run, job: Integration, signal: AbortSignal, update: IntegrationUpdate): Promise<Partial<Integration> & { status: Integration['status'] }>;
  prepareReconcile(run: Run, signal: AbortSignal): Promise<Reconciliation>;
}
function readGit(cwd: string, args: string[], optional = false): string {
  const child = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (child.exitCode !== 0 && !optional) throw new IntegrationError('blocked', 'Git не смог проверить состояние репозитория. Проверьте путь и нативные разрешения.');
  return child.exitCode === 0 ? child.stdout.toString().trim() : '';
}
async function git(cwd: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return runBoundedProcess(['git', '-C', cwd, ...args], { cwd, signal, onStdout: () => {}, maxOutputBytes: 1024 * 1024 });
}
export const artifact = (path: string) => path.split('/').some(part => /^\.brigd-(?:inputs|outbox)-/.test(part));
export const ARTIFACT_PATHSPECS = [':(exclude,glob).brigd-inputs-*/**', ':(exclude,glob).brigd-outbox-*/**', ':(exclude,glob)**/.brigd-inputs-*/**', ':(exclude,glob)**/.brigd-outbox-*/**'];
export const CONFLICT_LIST_LIMIT = 200;
/** Paths with unmerged index entries, relative to the work tree root. `prefix` addresses Git the way the caller does. */
export function unmergedPaths(prefix: string[], cwd: string): string[] {
  const child = Bun.spawnSync([...prefix, 'ls-files', '-u', '-z', '--full-name'], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (child.exitCode !== 0) throw new Error('Git не смог проверить состояние индекса. Проверьте путь и нативные разрешения.');
  const paths = new Set<string>();
  for (const entry of child.stdout.toString().split('\0')) { const tab = entry.indexOf('\t'); if (tab >= 0) paths.add(entry.slice(tab + 1)); }
  return [...paths];
}
/** Unmerged files whose working copy still carries both conflict markers. A deleted file counts as resolved by deletion. */
export function unresolvedConflicts(workTree: string, paths: string[]): string[] {
  return paths.filter(path => {
    try { const text = readFileSync(join(workTree, path), 'utf8'); return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text); }
    catch { return false; }
  });
}
export const mergeInProgress = (prefix: string[], cwd: string): boolean => {
  const child = Bun.spawnSync([...prefix, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  return child.exitCode === 0;
};
const listed = (paths: string[]) => paths.slice(0, 10).join(', ') + (paths.length > 10 ? ` и ещё ${paths.length - 10}` : '');
function sourceClean(cwd: string): boolean {
  return readGit(cwd, ['status', '--porcelain', '-z']).split('\0').filter(Boolean).every(line => line.startsWith('?? ') && artifact(line.slice(3)));
}
function checkedOutTarget(cwd: string, ref: string): string | null {
  const matches: string[] = []; let path = '';
  for (const line of readGit(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line === `branch ${ref}`) matches.push(path);
  }
  if (matches.length > 1) throw new IntegrationError('blocked', 'Целевая ветка открыта в нескольких worktree. Устраните неоднозначность перед слиянием.');
  return matches[0] ?? null;
}
export class GitIntegrator implements Integrator {
  constructor(private readonly configuredChecks?: string[][]) {}
  async execute(run: Run, job: Integration, signal: AbortSignal, update: IntegrationUpdate) {
    const workspace = run.workspace!;
    try {
      await new GitWorkspaces(dirname(workspace.path)).prepare(workspace);
      signal.throwIfAborted();
      if (!workspace.targetBranch) throw new IntegrationError('blocked', 'Запуск создан из detached HEAD. Для слияния нужна именованная целевая ветка.');
      const targetRef = `refs/heads/${workspace.targetBranch}`;
      // Snapshot only this worktree. Task artifact directories never enter a commit.
      // A merge left in progress by the integrator or by hand becomes a merge
      // commit once no conflict markers remain; `git add` alone would hide them.
      const merging = mergeInProgress(['git', '-C', workspace.path], workspace.path);
      const unresolved = unresolvedConflicts(workspace.path, unmergedPaths(['git', '-C', workspace.path], workspace.path));
      if (unresolved.length) {
        throw new IntegrationError('conflict', `В исходном worktree остались маркеры конфликта: ${listed(unresolved)}. Разрешите конфликт вручную и повторите проверку либо поручите его интегратору.`, { conflicts: unresolved.slice(0, CONFLICT_LIST_LIMIT) });
      }
      if (await git(workspace.path, ['add', '-A', '--', '.', ...ARTIFACT_PATHSPECS], signal)) throw new IntegrationError('blocked', 'Не удалось сохранить изменения worktree в индексе Git.');
      const staged = readGit(workspace.path, ['diff', '--cached', '--name-only', '-z']).split('\0');
      if (staged.some(artifact)) throw new IntegrationError('blocked', 'В индекс попали служебные вложения задачи. Уберите их из индекса перед слиянием.');
      if (staged.some(Boolean) || merging) {
        const identity = readGit(workspace.path, ['var', 'GIT_AUTHOR_IDENT'], true);
        const options = identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost'];
        const message = merging ? `brigd: объединение ${workspace.targetBranch} в ${workspace.branch}` : `brigd: результат ${run.id}`;
        if (await git(workspace.path, [...options, 'commit', ...(merging ? ['--author', INTEGRATOR_AUTHOR] : []), '-m', message], signal)) throw new IntegrationError('blocked', 'Не удалось создать коммит результата. Проверьте Git-конфигурацию, hooks и нативные разрешения.');
      }
      if (!sourceClean(workspace.path)) throw new IntegrationError('blocked', 'В worktree остались несохранённые изменения. Завершите их перед слиянием.');
      const sourceCommit = readGit(workspace.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (readGit(workspace.path, ['diff', '--name-only', '-z', workspace.baseCommit!, sourceCommit]).split('\0').some(artifact)) {
        throw new IntegrationError('blocked', 'Коммиты результата содержат служебные вложения задачи. Удалите их из изменений перед слиянием.');
      }
      const targetCommit = readGit(workspace.path, ['rev-parse', '--verify', `${targetRef}^{commit}`]);
      update({ sourceCommit, targetCommit });
      if (await git(workspace.path, ['merge-base', '--is-ancestor', sourceCommit, targetCommit], signal) === 0) {
        return { status: 'merged' as const, sourceCommit, targetCommit, resultCommit: targetCommit, checks: [], error: null };
      }
      const commands = this.configuredChecks ?? workspace.checkCommands;
      if (!commands?.length) throw new IntegrationError('blocked', 'Нет команд проверки проекта. Настройте BRIGD_INTEGRATION_CHECKS, перезапустите сервис и повторите слияние.');
      const candidatePath = join(dirname(workspace.path), `integration-${job.id}-${job.attempt}`);
      update({ candidatePath });
      if (await git(workspace.repositoryRoot, ['worktree', 'add', '--detach', candidatePath, targetCommit], signal)) throw new IntegrationError('blocked', 'Не удалось подготовить worktree для проверки слияния.');
      if (await git(candidatePath, ['merge', '--no-ff', '--no-commit', sourceCommit], signal)) {
        const conflicts = unmergedPaths(['git', '-C', candidatePath], candidatePath);
        if (!conflicts.length) throw new IntegrationError('blocked', 'Git не смог объединить результат. Проверьте конфигурацию и нативные разрешения.');
        throw new IntegrationError('conflict', `Обнаружен конфликт слияния с веткой ${workspace.targetBranch}: ${listed(conflicts)}. Интегратор может разрешить его в исходном worktree; после ручного исправления повторите проверку.`, { conflicts: conflicts.slice(0, CONFLICT_LIST_LIMIT) });
      }
      const testedTree = readGit(candidatePath, ['write-tree']);
      const checks: Integration['checks'] = [];
      for (const argv of commands) {
        signal.throwIfAborted();
        const exitCode = await runBoundedProcess(argv, { cwd: candidatePath, signal, onStdout: () => {} });
        checks.push({ argv, exitCode }); update({ checks: [...checks] });
        if (exitCode !== 0) throw new IntegrationError('failed', `Проверка ${checks.length} завершилась с кодом ${exitCode}. Целевая ветка сохранена.`);
      }
      if (readGit(candidatePath, ['rev-parse', 'HEAD']) !== targetCommit || readGit(candidatePath, ['write-tree']) !== testedTree ||
          readGit(candidatePath, ['diff', '--name-only'])) throw new IntegrationError('failed', 'Проверки изменили отслеживаемые файлы или Git-состояние кандидата. Нужна повторная проверка неизменённого результата.');
      if (readGit(workspace.path, ['rev-parse', 'HEAD']) !== sourceCommit || !sourceClean(workspace.path)) throw new IntegrationError('blocked', 'Исходный worktree изменился во время проверки. Повторите слияние после завершения изменений.');
      if (readGit(workspace.path, ['rev-parse', targetRef]) !== targetCommit) throw new IntegrationError('queued', 'Целевая ветка изменилась во время проверки. Кандидат будет подготовлен заново.');
      update({ status: 'merging' });
      const identity = readGit(candidatePath, ['var', 'GIT_AUTHOR_IDENT'], true);
      if (await git(candidatePath, [...(identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost']), 'commit', '--author', INTEGRATOR_AUTHOR, '-m', `brigd: объединение ${run.id}`], signal)) throw new IntegrationError('blocked', 'Не удалось создать проверенный коммит объединения.');
      const resultCommit = readGit(candidatePath, ['rev-parse', 'HEAD']);
      if (readGit(candidatePath, ['rev-parse', 'HEAD^{tree}']) !== testedTree) throw new IntegrationError('failed', 'Git hook изменил коммит после проверки. Перенос остановлен.');
      update({ resultCommit });
      signal.throwIfAborted();
      const targetPath = checkedOutTarget(workspace.path, targetRef);
      if (readGit(workspace.path, ['rev-parse', targetRef]) !== targetCommit) throw new IntegrationError('queued', 'Целевая ветка изменилась перед переносом. Кандидат будет проверен заново.');
      if (targetPath) {
        if (readGit(targetPath, ['symbolic-ref', '--quiet', 'HEAD']) !== targetRef || readGit(targetPath, ['rev-parse', 'HEAD']) !== targetCommit ||
            readGit(targetPath, ['status', '--porcelain', '-z'])) throw new IntegrationError('blocked', 'В рабочей папке целевой ветки есть изменения или изменена ветка. Сохраните работу перед переносом результата.');
        if (await git(targetPath, ['merge', '--ff-only', '--no-edit', resultCommit], signal)) throw new IntegrationError('blocked', 'Не удалось перенести проверенный результат. Проверьте состояние целевой ветки и нативные разрешения.');
      } else if (await git(workspace.path, ['update-ref', targetRef, resultCommit, targetCommit], signal)) {
        throw new IntegrationError('blocked', 'Целевая ветка изменилась или Git запретил обновление. Повторите проверку её актуального состояния.');
      }
      return { status: 'merged' as const, sourceCommit, targetCommit, resultCommit, checks, error: null };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' as const, error: 'Слияние отменено. Уже выполненные Git-операции не откатываются.' };
      if (error instanceof IntegrationError) return { status: error.status, error: error.message, ...error.patch };
      return { status: 'blocked' as const, error: error instanceof Error ? error.message.slice(0, 1000) : 'Не удалось выполнить проверку и слияние.' };
    }
  }
  /** Merges the current target into the saved worktree so the integrator can resolve conflicts there. Errors block the run. */
  async prepareReconcile(run: Run, signal: AbortSignal): Promise<Reconciliation> {
    const workspace = run.workspace;
    if (!workspace || workspace.mode !== 'worktree' || !run.reconcile) throw new Error('Интегратор работает только с результатом в отдельном worktree.');
    await new GitWorkspaces(dirname(workspace.path)).prepare(workspace);
    signal.throwIfAborted();
    const prefix = ['git', '-C', workspace.path];
    // A merge abandoned by an earlier attempt is discarded: the worktree was clean before it started.
    if (mergeInProgress(prefix, workspace.path) && await git(workspace.path, ['merge', '--abort'], signal)) throw new Error('Не удалось отменить незавершённое объединение в worktree задачи. Проверьте его состояние вручную.');
    if (!sourceClean(workspace.path)) throw new Error('В worktree задачи остались несохранённые изменения. Сохраните или отмените их перед работой интегратора.');
    const targetCommit = readGit(workspace.path, ['rev-parse', '--verify', `refs/heads/${run.reconcile.targetBranch}^{commit}`]);
    if (await git(workspace.path, ['merge-base', '--is-ancestor', targetCommit, 'HEAD'], signal) === 0) return { targetCommit, conflicts: [] };
    if (await git(workspace.path, ['merge', '--no-ff', '--no-commit', targetCommit], signal) === 0) {
      // Nothing conflicts any more; the ordinary candidate check merges on its own.
      if (await git(workspace.path, ['merge', '--abort'], signal)) throw new Error('Не удалось отменить пробное объединение в worktree задачи.');
      return { targetCommit, conflicts: [] };
    }
    const conflicts = unmergedPaths(prefix, workspace.path);
    if (!conflicts.length) {
      await git(workspace.path, ['merge', '--abort'], signal);
      throw new Error('Git не смог объединить целевую ветку с результатом. Проверьте конфигурацию и нативные разрешения.');
    }
    return { targetCommit, conflicts: conflicts.slice(0, CONFLICT_LIST_LIMIT) };
  }
}
