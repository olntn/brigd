import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CheckTriage, Integration, IntegrationCheck, Run, TargetCheck, TriageCommand } from '../src/lib/types';
import { CHECK_OUTPUT_LIMIT } from '../src/lib/integration-checks';
import { CHECK_TRIAGE_TIME_LIMIT_MS } from '../src/lib/check-triage';
import { AgentRunError, runBoundedProcess } from './adapter';
import { GitWorkspaces } from './workspaces';
import { gitExit, removeTree, TARGET_SUFFIX } from './workspace-storage';
import { INTEGRATOR_WORKER } from '../src/lib/workers';
import { clock } from './clock';

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
  /** Merges the target commit a hand-back failed on into the saved worktree, so the worker resumes on the tested code. */
  prepareHandback?(run: Run, signal: AbortSignal): Promise<{ merged: boolean }>;
}
export interface TriageOptions {
  /** Read when a check fails, so the switch in the settings applies to the next failure without a restart. */
  enabled?: () => boolean;
  /** Reruns and the target check of one attempt together; CHECK_TRIAGE_TIME_LIMIT_MS by default. */
  timeLimitMs?: number;
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
/** The last `limit` bytes of a process's stdout and stderr in arrival order, cut at a UTF-8 character boundary. */
export class OutputTail {
  private chunks: string[] = [];
  private bytes = 0;
  private cut = false;
  constructor(private readonly limit = CHECK_OUTPUT_LIMIT) {}
  readonly push = (chunk: string) => {
    this.chunks.push(chunk); this.bytes += Buffer.byteLength(chunk);
    // Trimmed once twice the limit is buffered, so a chatty check costs constant amortised work per chunk.
    if (this.bytes > 2 * this.limit) this.trim();
  };
  private trim() {
    if (this.bytes <= this.limit) return;
    const encoded = Buffer.from(this.chunks.join(''));
    let start = encoded.length - this.limit;
    // Continuation bytes (10xxxxxx) belong to a character that starts before the cut.
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
    this.chunks = [encoded.subarray(start).toString('utf8')]; this.bytes = encoded.length - start; this.cut = true;
  }
  result(): Pick<IntegrationCheck, 'output' | 'outputTruncated'> {
    this.trim();
    return { output: this.chunks.join(''), ...(this.cut ? { outputTruncated: true } : {}) };
  }
}
/** Runs one check command and keeps the end of its output. Past `timeoutMs` the process tree is stopped and exitCode is null. */
async function runCheck(argv: string[], cwd: string, signal: AbortSignal, timeoutMs?: number): Promise<TriageCommand> {
  const tail = new OutputTail();
  try {
    const exitCode = await runBoundedProcess(argv, { cwd, signal, onStdout: tail.push, onStderr: tail.push, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return { argv, exitCode, ...tail.result() };
  } catch (error) {
    if (error instanceof AgentRunError && error.code === 'TIMEOUT' && !signal.aborted) return { argv, exitCode: null, ...tail.result() };
    throw error;
  }
}
/** A triage command within the attempt's remaining budget; nothing starts once it is spent. */
async function budgeted(triage: CheckTriage, argv: string[], cwd: string, signal: AbortSignal): Promise<TriageCommand> {
  const remaining = triage.limitMs - triage.spentMs;
  if (remaining <= 0) return { argv, exitCode: null };
  const started = performance.now();
  try { return await runCheck(argv, cwd, signal, Math.ceil(remaining)); }
  finally { triage.spentMs = Math.min(triage.limitMs, triage.spentMs + Math.round(performance.now() - started)); }
}
/** Removes a worktree brigd created for itself, without the abort signal: it runs after a cancellation too. */
async function discardWorktree(repositoryRoot: string, path: string): Promise<void> {
  const remove = () => gitExit(['-C', repositoryRoot, 'worktree', 'remove', '--force', '--force', path]);
  await remove();
  if (existsSync(path)) { removeTree(path); await remove(); }
}
const command = (argv: string[]) => argv.join(' ');
const minutes = (milliseconds: number) => Math.max(1, Math.round(milliseconds / 60_000));
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
  constructor(private readonly configuredChecks?: string[][] | (() => string[][] | undefined), private readonly triageOptions: TriageOptions = {}) {}
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
      const configuredChecks = typeof this.configuredChecks === 'function' ? this.configuredChecks() : this.configuredChecks;
      const commands = configuredChecks ?? workspace.checkCommands;
      if (!commands?.length) throw new IntegrationError('blocked', 'Нет команд проверки проекта. Укажите BRIGD_INTEGRATION_CHECKS в настройках → Автопилот и повторите слияние.');
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
      let triage: CheckTriage | null = null;
      const report = () => update({ checks: [...checks], ...(triage ? { triage: structuredClone(triage) } : {}) });
      const failure = (message: string) => new IntegrationError('failed', message, triage ? { checks: [...checks], triage: structuredClone(triage) } : {});
      for (const [index, argv] of commands.entries()) {
        signal.throwIfAborted();
        const { exitCode, ...tail } = await runCheck(argv, candidatePath, signal);
        checks.push({ ...tail, exitCode: exitCode! }); report();
        if (exitCode === 0) continue;
        if (!this.triageOptions.enabled?.()) throw failure(`Проверка ${index + 1} завершилась с кодом ${exitCode}. Целевая ветка сохранена.`);
        // Exit codes alone decide: one rerun tells a flaky check from a failing one, the target commit tells whose failure it is.
        triage ??= { stage: 'retry', startedAt: clock(), limitMs: this.triageOptions.timeLimitMs ?? CHECK_TRIAGE_TIME_LIMIT_MS, spentMs: 0, retries: [], target: null, handback: null, outcome: null };
        triage.stage = 'retry'; triage.retries.push({ check: index, exitCode: null }); report();
        const { argv: _argv, ...retry } = await budgeted(triage, argv, candidatePath, signal);
        triage.retries[triage.retries.length - 1] = { check: index, ...retry };
        const stopped = `Разбор упавшей проверки ${index + 1} остановлен: повтор и проверка целевой ветки вместе превысили лимит ${minutes(triage.limitMs)} мин. Задача не возвращена работнику.`;
        if (retry.exitCode === null) { Object.assign(triage, { stage: 'done', outcome: 'timeout' }); throw failure(stopped); }
        if (retry.exitCode === 0) { triage.stage = 'done'; report(); continue; }
        const verdict = await this.checkTarget(workspace.repositoryRoot, `${candidatePath}${TARGET_SUFFIX}`, targetCommit, commands.slice(0, index + 1), signal, triage, report);
        const target = triage.target!.checks.at(-1)!;
        triage.stage = 'done';
        if (verdict === 'timeout') { triage.outcome = 'timeout'; throw failure(stopped); }
        if (verdict === 'failed') {
          triage.outcome = 'target_failed';
          throw failure(`Целевая ветка ${workspace.targetBranch} не проходит проверку ${command(target.argv)}: код ${target.exitCode} на коммите ${targetCommit.slice(0, 12)}. Задача не возвращена работнику; исправьте целевую ветку и повторите проверку.`);
        }
        // The outcome is left to the engine: it hands the result back or explains why it did not.
        throw failure(`Проверка ${index + 1} (${command(argv)}) завершилась с кодом ${exitCode}, при повторе — с кодом ${retry.exitCode}, а на целевой ветке ${workspace.targetBranch} проходит: причина в результате задачи.`);
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
      return { status: 'merged' as const, sourceCommit, targetCommit, resultCommit, checks, ...(triage ? { triage } : {}), error: null };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' as const, error: 'Слияние отменено. Уже выполненные Git-операции не откатываются.' };
      if (error instanceof IntegrationError) return { status: error.status, error: error.message, ...error.patch };
      return { status: 'blocked' as const, error: error instanceof Error ? error.message.slice(0, 1000) : 'Не удалось выполнить проверку и слияние.' };
    }
  }
  /** The failed command and the commands before it (dependencies are installed by them) on the target commit in a clean worktree. */
  private async checkTarget(repositoryRoot: string, path: string, commit: string, commands: string[][], signal: AbortSignal, triage: CheckTriage, report: () => void): Promise<'passed' | 'failed' | 'timeout'> {
    const target: TargetCheck = { commit, checks: [], passed: null };
    Object.assign(triage, { stage: 'target', target }); report();
    if (existsSync(path)) await discardWorktree(repositoryRoot, path);
    if (await git(repositoryRoot, ['worktree', 'add', '--detach', path, commit], signal)) throw new IntegrationError('blocked', 'Не удалось подготовить отдельный worktree целевой ветки для разбора упавшей проверки.', { triage: structuredClone(triage) });
    try {
      for (const argv of commands) {
        target.checks.push({ argv, exitCode: null }); report();
        const result = await budgeted(triage, argv, path, signal);
        target.checks[target.checks.length - 1] = result;
        if (result.exitCode === null) return 'timeout';
        if (result.exitCode !== 0) { target.passed = false; return 'failed'; }
      }
      target.passed = true;
      return 'passed';
    } finally {
      report();
      await discardWorktree(repositoryRoot, path).catch(() => {});
    }
  }
  /** Brings the saved worktree to the exact tested code: the target commit of the failed candidate, merged with a commit of its own. */
  async prepareHandback(run: Run, signal: AbortSignal): Promise<{ merged: boolean }> {
    const workspace = run.workspace, failure = run.followup?.checkFailure;
    if (!workspace || workspace.mode !== 'worktree' || !failure) throw new Error('Возврат после упавшей проверки работает только с результатом в отдельном worktree.');
    const prefix = ['git', '-C', workspace.path];
    if (mergeInProgress(prefix, workspace.path)) throw new Error('В worktree задачи осталось незавершённое объединение. Завершите или отмените его перед возвратом работнику.');
    if (!sourceClean(workspace.path)) throw new Error('В worktree задачи остались несохранённые изменения. Сохраните или отмените их перед возвратом работнику.');
    if (await git(workspace.path, ['merge-base', '--is-ancestor', failure.targetCommit, 'HEAD'], signal) === 0) return { merged: false };
    if (await git(workspace.path, ['merge', '--no-ff', '--no-commit', failure.targetCommit], signal)) {
      if (mergeInProgress(prefix, workspace.path)) await git(workspace.path, ['merge', '--abort'], signal);
      throw new Error(`Не удалось объединить проверенный коммит ветки ${failure.targetBranch} с worktree задачи. Разрешите расхождение вручную и отправьте дополнительный запрос.`);
    }
    const identity = readGit(workspace.path, ['var', 'GIT_AUTHOR_IDENT'], true);
    if (await git(workspace.path, [...(identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost']), 'commit', '--author', INTEGRATOR_AUTHOR, '-m', `brigd: объединение ${failure.targetBranch} в ${workspace.branch}`], signal)) {
      await git(workspace.path, ['merge', '--abort'], signal);
      throw new Error('Не удалось создать merge-коммит проверенной целевой ветки в worktree задачи. Проверьте Git-конфигурацию, hooks и нативные разрешения.');
    }
    return { merged: true };
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
