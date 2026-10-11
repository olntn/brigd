import { dirname, join } from 'node:path';
import type { Integration, Run } from '../src/lib/types';
import { runBoundedProcess } from './adapter';
import { GitWorkspaces } from './workspaces';

class IntegrationError extends Error {
  constructor(readonly status: 'conflict' | 'failed' | 'blocked' | 'queued', message: string) { super(message); }
}
export type IntegrationUpdate = (patch: Partial<Integration>) => void;
export interface Integrator {
  execute(run: Run, job: Integration, signal: AbortSignal, update: IntegrationUpdate): Promise<Partial<Integration> & { status: Integration['status'] }>;
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
const artifact = (path: string) => path.split('/').some(part => /^\.brigd-(?:inputs|outbox)-/.test(part));
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
      if (await git(workspace.path, ['add', '-A', '--', '.', ':(exclude,glob).brigd-inputs-*/**', ':(exclude,glob).brigd-outbox-*/**',
        ':(exclude,glob)**/.brigd-inputs-*/**', ':(exclude,glob)**/.brigd-outbox-*/**'], signal)) throw new IntegrationError('blocked', 'Не удалось сохранить изменения worktree в индексе Git.');
      const staged = readGit(workspace.path, ['diff', '--cached', '--name-only', '-z']).split('\0');
      if (staged.some(artifact)) throw new IntegrationError('blocked', 'В индекс попали служебные вложения задачи. Уберите их из индекса перед слиянием.');
      if (staged.some(Boolean)) {
        const identity = readGit(workspace.path, ['var', 'GIT_AUTHOR_IDENT'], true);
        const options = identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost'];
        if (await git(workspace.path, [...options, 'commit', '-m', `brigd: результат ${run.id}`], signal)) throw new IntegrationError('blocked', 'Не удалось создать коммит результата. Проверьте Git-конфигурацию, hooks и нативные разрешения.');
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
        const conflicts = readGit(candidatePath, ['ls-files', '-u']);
        throw new IntegrationError(conflicts ? 'conflict' : 'blocked', conflicts ? 'Обнаружен конфликт слияния. Исправьте изменения в исходном worktree и повторите проверку.' : 'Git не смог объединить результат. Проверьте конфигурацию и нативные разрешения.');
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
      if (await git(candidatePath, [...(identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost']), 'commit', '-m', `brigd: объединение ${run.id}`], signal)) throw new IntegrationError('blocked', 'Не удалось создать проверенный коммит объединения.');
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
      if (error instanceof IntegrationError) return { status: error.status, error: error.message };
      return { status: 'blocked' as const, error: error instanceof Error ? error.message.slice(0, 1000) : 'Не удалось выполнить проверку и слияние.' };
    }
  }
}
