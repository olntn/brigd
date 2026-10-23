import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Integration, IntegrationStatus, Run, RunStatus, StorageCleanupResult, StorageEntry, StorageOverview, StorageReason, WorkspaceSnapshot } from '../src/lib/types';
import { formatBytes } from '../src/lib/format';
import type { Store } from './store';

/** Chronological statuses of the runs sharing one worktree; the integration status belongs to that run's own merge. */
export interface WorkspaceRun { id: string; status: RunStatus; integrationStatus: IntegrationStatus | null; integrationUpdatedAt: number | null; startedAt: number; }
export interface Retention { retained: boolean; reason: StorageReason; }
const ACTIVE_RUNS: readonly RunStatus[] = ['queued', 'preparing', 'running', 'cancelling', 'waiting_input'];
const HOLDING_INTEGRATIONS: readonly IntegrationStatus[] = ['queued', 'checking', 'merging', 'cancelling'];
const RANK: Record<StorageReason, number> = { active: 9, interrupted: 8, submodules: 7, moved: 7, foreign: 7, conflict: 4, failed: 3, unmerged: 2, merged: 0, cancelled: 0, deleted: 0, stale: 0, unknown: 0 };
/** Retained while any run holds the folder (open, interrupted or merging), and while anything after the last merged result can
 * still be continued, retried, merged or reconciled; cancelled runs never can. */
export function workspaceRetention(runs: readonly WorkspaceRun[]): Retention {
  // Position does not matter for a run that is using the folder right now: an older result can be re-queued for merging.
  if (runs.some(run => ACTIVE_RUNS.includes(run.status) || run.integrationStatus && HOLDING_INTEGRATIONS.includes(run.integrationStatus))) return { retained: true, reason: 'active' };
  if (runs.some(run => run.status === 'interrupted' || run.integrationStatus === 'interrupted')) return { retained: true, reason: 'interrupted' };
  let merged = -1;
  runs.forEach((run, index) => { if (run.integrationStatus === 'merged') merged = index; });
  const mergedAt = Math.max(0, ...runs.filter(run => run.integrationStatus === 'merged').map(run => run.integrationUpdatedAt ?? 0));
  let reason: StorageReason | null = null;
  for (const [index, run] of runs.entries()) {
    // An older result can be retried after a newer result merged; its new failure/conflict must still be inspectable.
    const rechecked = run.integrationStatus && ['conflict', 'failed', 'blocked'].includes(run.integrationStatus) &&
      run.integrationUpdatedAt != null && run.integrationUpdatedAt >= mergedAt;
    if (index <= merged && !rechecked) continue;
    const current: StorageReason | null = run.status === 'cancelled' ? null
      : run.status === 'failed' || run.status === 'blocked' || run.integrationStatus === 'failed' || run.integrationStatus === 'blocked' ? 'failed'
      : run.integrationStatus === 'conflict' ? 'conflict' : 'unmerged';
    if (current && (!reason || RANK[current] > RANK[reason])) reason = current;
  }
  if (reason) return { retained: true, reason };
  return { retained: false, reason: merged >= 0 ? 'merged' : runs.length ? 'cancelled' : 'unknown' };
}
export interface IntegrationRecord { id: string; runId: string; status: IntegrationStatus; attempt: number; candidatePath: string | null; updatedAt: number; }
/** A candidate stays for inspection of its own unfinished attempt; superseded, merged, rechecked and cancelled attempts are scratch. */
export function candidateRetention(record: IntegrationRecord | undefined, attempt: number, runs: readonly WorkspaceRun[] = []): Retention {
  if (!record) return { retained: false, reason: 'unknown' };
  if (record.attempt !== attempt || record.status === 'queued' || record.status === 'cancelled') return { retained: false, reason: 'stale' };
  if (record.status === 'merged') return { retained: false, reason: 'merged' };
  const index = runs.findIndex(run => run.id === record.runId);
  if (index >= 0 && ['conflict', 'failed', 'blocked'].includes(record.status) && runs.slice(index + 1).some(run =>
    run.integrationStatus === 'merged' && run.integrationUpdatedAt != null && run.integrationUpdatedAt > record.updatedAt)) {
    return { retained: false, reason: 'stale' };
  }
  return { retained: true, reason: record.status === 'conflict' ? 'conflict' : record.status === 'interrupted' ? 'interrupted'
    : record.status === 'failed' || record.status === 'blocked' ? 'failed' : 'active' };
}
export const CANDIDATE_NAME = /^integration-([a-f0-9-]{36})-(\d+)$/;
const BUCKET_NAME = /^[a-f0-9]{20}$/;
/** Allocated size of a folder from an lstat walk that never follows symlinks; unreadable entries count as empty. */
export async function measure(path: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const pending = [path];
  while (pending.length) {
    const current = pending.pop()!;
    let info;
    try { info = await lstat(current); } catch { continue; }
    bytes += Number.isFinite(info.blocks) && info.blocks >= 0 ? info.blocks * 512 : info.size;
    if (!info.isDirectory()) { files++; continue; }
    let names: string[];
    try { names = await readdir(current); } catch { continue; }
    for (const name of names) pending.push(join(current, name));
  }
  return { bytes, files };
}
export const inside = (root: string, path: string) => { const sub = relative(root, path); return !!sub && sub !== '..' && !sub.startsWith(`..${sep}`) && !isAbsolute(sub); };
function realpathOrNull(path: string): string | null { try { return realpathSync(path); } catch { return null; } }
const samePath = (left: string, right: string) => resolve(left) === resolve(right) || !!realpathOrNull(left) && realpathOrNull(left) === realpathOrNull(right);
/** Removes a directory tree without following symlinks; read-only folders left by tools are opened up first on a retry. */
export function removeTree(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Удаляются только обычные папки.');
  try { rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); }
  catch {
    const pending = [path];
    while (pending.length) {
      const current = pending.pop()!;
      try {
        const entry = lstatSync(current);
        if (!entry.isDirectory()) continue;
        chmodSync(current, entry.mode | 0o700);
        for (const name of readdirSync(current)) pending.push(join(current, name));
      } catch { /* The retry reports what is still in the way. */ }
    }
    rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  }
  if (existsSync(path)) throw new Error('Папка не удалена полностью. Проверьте права доступа и открытые файлы.');
}
export function gitExit(args: string[], timeout = 60_000): Promise<number> {
  try { return Bun.spawn(['git', ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout }).exited; }
  catch { return Promise.resolve(-1); }
}
export function gitOutput(args: string[]): string | null {
  const child = Bun.spawnSync(['git', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  return child.exitCode === 0 ? child.stdout.toString() : null;
}
/** Paths registered as linked worktrees of the repository whose common Git directory is `repositoryId`. */
export function registeredWorktrees(repositoryId: string): string[] {
  const listing = gitOutput(['--git-dir', repositoryId, 'worktree', 'list', '--porcelain', '-z']) ?? '';
  return listing.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
}
export const isRegistered = (repositoryId: string, path: string) => registeredWorktrees(repositoryId).some(registered => samePath(registered, path));
/** The admin directory of a linked worktree whose `.git` file points into one of the given repositories and is pointed back at.
 * The file is agent-writable, so only this round trip proves that brigd's repository owns the folder. */
export function ownedWorktree(path: string, repositoryIds: readonly string[]): { repositoryId: string; admin: string } | null {
  try {
    const pointer = join(path, '.git');
    if (!lstatSync(pointer).isFile()) return null;
    const contents = readFileSync(pointer, 'utf8');
    const target = contents.startsWith('gitdir: ') ? contents.slice(8).replace(/\n$/, '') : null;
    if (!target) return null;
    const admin = realpathOrNull(resolve(path, target));
    if (!admin) return null;
    for (const repositoryId of repositoryIds) {
      const common = realpathOrNull(repositoryId);
      if (!common || dirname(dirname(admin)) !== common || basename(dirname(admin)) !== 'worktrees') continue;
      const back = readFileSync(join(admin, 'gitdir'), 'utf8').replace(/\n$/, '');
      if (samePath(dirname(back), path) && basename(back) === '.git') return { repositoryId, admin };
    }
  } catch { /* Anything unreadable is not ours. */ }
  return null;
}
/** Git keeps a linked worktree's submodule repositories in its admin directory; removing it would destroy their commits. */
export const hasSubmoduleData = (admin: string) => existsSync(join(admin, 'modules'));
export const UNAVAILABLE_STORAGE: StorageOverview = { available: false, note: null, root: null, totalBytes: 0, reclaimableBytes: 0, retainedBytes: 0, entries: [], reclaimableBranches: [], scannedAt: 0 };
export interface CleanupOptions { /** Also reclaim candidates of attempts that failed their checks or were blocked. */ includeCandidates?: boolean; }
export interface SettledFolders { summary: string; details: string[]; }
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
interface Found { path: string; name: string; inBucket: boolean; directory: boolean; symlink: boolean; }
interface BranchRemoval { sourceRef: string; sourceCommit: string; targetRef: string; targetCommit: string; }

/** Folders under the workspaces root: run worktrees, merge candidates and anything else brigd did not create. */
export class WorkspaceStorage {
  private scanning: Promise<StorageOverview> | null = null;
  constructor(readonly root: string, private readonly store: Store) {}
  overview(): Promise<StorageOverview> {
    return this.scanning ??= this.scan().finally(() => { this.scanning = null; });
  }
  /** Reclaims every entry nothing can use any more. Callers keep the scheduler from claiming work while this runs,
   * so the scan is taken fresh here and every decision is re-checked against the database right before removal. */
  async cleanup(options: CleanupOptions = {}): Promise<StorageCleanupResult> {
    const before = await this.scan();
    const failures: StorageCleanupResult['failures'] = [];
    let removed = 0, removedBranches = 0, freedBytes = 0;
    if (before.available) {
      for (const entry of before.entries) {
        if (entry.retained && !(options.includeCandidates && entry.optional)) continue;
        try {
          if (!this.stillReclaimable(entry, options)) continue;
          await this.removeEntry(entry);
          removed++; freedBytes += entry.bytes;
        } catch (error) { failures.push({ path: entry.path, error: describe(error) }); }
      }
      // Older versions already reclaimed folders while keeping their branches. Those branches still have durable workspace records.
      for (const record of this.store.listWorkspaceRecords()) {
        try { if (this.removeMergedBranch(record.snapshot, record.runs)) removedBranches++; }
        catch (error) { failures.push({ path: `${record.snapshot.repositoryId}: ${record.snapshot.branch}`, error: describe(error) }); }
      }
      this.pruneBuckets();
    }
    return { removed, removedBranches, freedBytes, failures, overview: await this.scan() };
  }
  /** Before an attempt's final status is stored: scratch candidates go, and a merged result's worktree goes once nothing holds it.
   * `job.status` is the status about to be stored. Returns the task-log entry describing what happened to the worktree. */
  async settleAttempt(run: Run, job: Integration): Promise<SettledFolders | null> {
    const workspace = run.workspace;
    if (workspace?.mode === 'worktree' && job.candidatePath && ['merged', 'queued', 'cancelled'].includes(job.status) &&
        samePath(job.candidatePath, join(dirname(workspace.path), `integration-${job.id}-${job.attempt}`)) &&
        inside(this.root, job.candidatePath) && !this.submoduleData(job.candidatePath, workspace.repositoryId)) {
      await this.removeFolder(job.candidatePath, workspace?.repositoryId ?? null);
    }
    if (job.status !== 'merged' || workspace?.mode !== 'worktree') return null;
    const record = this.store.workspaceRecord(workspace.id);
    // This run counts as merged already; the database learns that right after the folders are gone.
    if (!record) return null;
    const runs = record.runs.map(entry => entry.id === job.runId ? { ...entry, integrationStatus: 'merged' as const, integrationUpdatedAt: Date.now() } : entry);
    await this.discardCandidates(workspace.path, workspace.repositoryId, runs);
    if (!existsSync(workspace.path) || workspaceRetention(runs).retained) return null;
    const owned = ownedWorktree(workspace.path, [workspace.repositoryId]);
    if (owned && hasSubmoduleData(owned.admin)) {
      return { summary: 'Рабочая папка запуска сохранена после слияния', details: ['В worktree есть репозитории подмодулей Git; их коммиты хранятся только в этой папке, поэтому она не удаляется автоматически.', `Папка: ${workspace.path}.`] };
    }
    const size = await measure(workspace.path);
    // Marked first, together with the merged commit: a crash halfway through must not leave a continuation refusing to recreate the folder.
    this.store.markWorkspaceRemoved(workspace.id, Date.now(), job.sourceCommit, 'merge');
    await this.removeFolder(workspace.path, workspace.repositoryId);
    const branchDetails: string[] = [];
    try {
      if (this.removeMergedBranch(this.store.getWorkspace(workspace.id), runs)) branchDetails.push(`Ветка ${workspace.branch} удалена; её коммиты доступны в целевой ветке.`);
    } catch (error) { branchDetails.push(`Не удалось удалить ветку ${workspace.branch}: ${describe(error)}. Повторите очистку в настройках хранилища.`); }
    this.pruneBuckets(job.runId);
    return { summary: 'Рабочая папка запуска удалена после слияния', details: [`Освобождено ${formatBytes(size.bytes)}.`, `Папка: ${workspace.path}.`,
      ...branchDetails, 'Ответ или дополнительный запрос создаст папку и при необходимости ветку заново из последнего перенесённого коммита, без неотслеживаемых файлов прежней сессии.'] };
  }
  /** Only an unchanged task branch whose committed result is still reachable from its target may go. */
  private branchRemoval(workspace: WorkspaceSnapshot, runs: readonly WorkspaceRun[], removingFolder = false): BranchRemoval | null {
    if (workspace.mode !== 'worktree' || !inside(this.root, workspace.path) || workspaceRetention(runs).retained ||
        (!workspace.removedAt && !removingFolder) || (existsSync(workspace.path) && !removingFolder) ||
        workspace.branch !== `brigd/run-${workspace.id}` || !workspace.lastIntegratedCommit || !/^[a-f0-9]{40,64}$/.test(workspace.lastIntegratedCommit) ||
        !workspace.targetBranch || workspace.targetBranch === workspace.branch) return null;
    const prefix = ['--git-dir', workspace.repositoryId];
    const sourceRef = `refs/heads/${workspace.branch}`, targetRef = `refs/heads/${workspace.targetBranch}`;
    if (gitOutput([...prefix, 'check-ref-format', targetRef]) === null || gitOutput([...prefix, 'symbolic-ref', '--quiet', sourceRef]) !== null ||
        gitOutput([...prefix, 'symbolic-ref', '--quiet', targetRef]) !== null) return null;
    const sourceCommit = gitOutput([...prefix, 'rev-parse', '--verify', '--quiet', sourceRef])?.trim();
    if (sourceCommit !== workspace.lastIntegratedCommit) return null;
    const targetCommit = gitOutput([...prefix, 'rev-parse', '--verify', '--quiet', `${targetRef}^{commit}`])?.trim();
    if (!targetCommit || !/^[a-f0-9]{40,64}$/.test(targetCommit) || gitOutput([...prefix, 'merge-base', '--is-ancestor', sourceCommit, targetCommit]) === null) return null;
    // A failed listing is not evidence that the branch is unused. Preserve registrations of missing user worktrees too.
    const listing = gitOutput([...prefix, 'worktree', 'list', '--porcelain', '-z']);
    if (listing === null) return null;
    let path = '';
    for (const line of listing.split('\0')) {
      if (line.startsWith('worktree ')) path = line.slice(9);
      if (line === `branch ${sourceRef}` && !(removingFolder && samePath(path, workspace.path))) return null;
    }
    return { sourceRef, sourceCommit, targetRef, targetCommit };
  }
  private removeMergedBranch(workspace: WorkspaceSnapshot, runs: readonly WorkspaceRun[]): boolean {
    const branch = this.branchRemoval(workspace, runs);
    if (!branch) return false;
    // Compare both refs in one transaction: a concurrent new task commit or target reset must preserve the branch.
    // --no-deref also prevents a substituted symbolic ref from causing deletion of its referent.
    const child = Bun.spawnSync(['git', '--git-dir', workspace.repositoryId, 'update-ref', '--no-deref', '--stdin'], {
      stdin: Buffer.from(`verify ${branch.targetRef} ${branch.targetCommit}\ndelete ${branch.sourceRef} ${branch.sourceCommit}\n`),
      stdout: 'ignore', stderr: 'ignore', timeout: 10_000,
    });
    if (child.exitCode !== 0) throw new Error('Git не удалил ветку: ссылки изменились или недоступны для записи.');
    return true;
  }
  /** Earlier attempts of the same merge are superseded once a new attempt starts. */
  async discardOlderCandidates(run: Run, job: Integration): Promise<void> {
    const workspace = run.workspace;
    if (workspace?.mode !== 'worktree' || !inside(this.root, workspace.path)) return;
    const bucket = dirname(workspace.path);
    let names: string[];
    try { names = readdirSync(bucket); } catch { return; }
    for (const name of names) {
      const match = CANDIDATE_NAME.exec(name);
      if (match?.[1] === job.id && Number(match[2]) !== job.attempt && !this.submoduleData(join(bucket, name), workspace.repositoryId)) {
        await this.removeFolder(join(bucket, name), workspace.repositoryId);
      }
    }
  }
  /** A later successful result supersedes inspectable candidates from earlier runs sharing this worktree. */
  private async discardCandidates(workspacePath: string, repositoryId: string, runs: readonly WorkspaceRun[]): Promise<void> {
    if (!inside(this.root, workspacePath)) return;
    const bucket = dirname(workspacePath);
    const records = new Map(this.store.listIntegrationRecords().filter(record => runs.some(run => run.id === record.runId)).map(record => [record.id, record]));
    let names: string[];
    try { names = readdirSync(bucket); } catch { return; }
    for (const name of names) {
      const match = CANDIDATE_NAME.exec(name);
      const record = match ? records.get(match[1]!) : undefined;
      const path = join(bucket, name);
      if (!record || !match || (record.attempt === Number(match[2]) && record.candidatePath && !samePath(record.candidatePath, path))) continue;
      if (!candidateRetention(record, Number(match[2]), runs).retained && !this.submoduleData(path, repositoryId)) await this.removeFolder(path, repositoryId);
    }
  }
  private submoduleData(path: string, repositoryId: string | null): boolean {
    const owned = repositoryId ? ownedWorktree(path, [repositoryId]) : null;
    return !!owned && hasSubmoduleData(owned.admin);
  }
  /** Refuses roots that hold more than brigd's own folders, so a scan never walks a home directory or the database. */
  private rootNote(): string | null {
    const root = resolve(this.root);
    const database = dirname(resolve(this.store.db.filename));
    if (root === resolve('/') || root === resolve(homedir())) return 'Каталог рабочих папок совпадает с корнем или домашней папкой; brigd не управляет таким каталогом. Укажите отдельную папку в BRIGD_WORKSPACES_DIR.';
    if (root === database || inside(root, database)) return 'Каталог рабочих папок содержит базу данных brigd; очистка отключена. Укажите отдельную папку в BRIGD_WORKSPACES_DIR.';
    return null;
  }
  private async scan(): Promise<StorageOverview> {
    const note = this.rootNote();
    if (note) return { ...UNAVAILABLE_STORAGE, note, root: this.root, scannedAt: Date.now() };
    const found = this.listEntries();
    // Records are read after the listing: a workspace row always precedes its folder.
    const workspaces = this.store.listWorkspaceRecords();
    const integrations = new Map(this.store.listIntegrationRecords().map(record => [record.id, record]));
    const repositoryIds = [...new Set(workspaces.map(workspace => workspace.snapshot.repositoryId))];
    const entries: StorageEntry[] = [];
    for (const item of found) {
      let classified = this.classify(item, workspaces, integrations, repositoryIds);
      if (classified.kind !== 'unknown' && (!classified.retained || classified.optional)) {
        const owned = ownedWorktree(item.path, repositoryIds);
        if (owned && hasSubmoduleData(owned.admin)) classified = { ...classified, retained: true, reason: 'submodules', optional: false };
      }
      const size = classified.reason === 'foreign' ? { bytes: 0, files: 0 } : await measure(item.path);
      entries.push({ ...classified, ...size });
    }
    entries.sort((left, right) => Number(left.retained) - Number(right.retained) || right.bytes - left.bytes || left.path.localeCompare(right.path));
    const sum = (selected: StorageEntry[]) => selected.reduce((total, entry) => total + entry.bytes, 0);
    const removableFolders = new Set(entries.filter(entry => entry.kind === 'worktree' && !entry.retained).map(entry => entry.path));
    const reclaimableBranches = workspaces.filter(record => this.branchRemoval(record.snapshot, record.runs, removableFolders.has(record.snapshot.path)))
      .map(record => record.snapshot.branch!);
    return { available: true, note: null, root: this.root, totalBytes: sum(entries), reclaimableBytes: sum(entries.filter(entry => !entry.retained)),
      retainedBytes: sum(entries.filter(entry => entry.retained)), entries, reclaimableBranches, scannedAt: Date.now() };
  }
  private classify(item: Found, workspaces: ReturnType<Store['listWorkspaceRecords']>, integrations: Map<string, IntegrationRecord>, repositoryIds: string[]): Omit<StorageEntry, 'bytes' | 'files'> {
    const base = { path: item.path, kind: 'unknown' as const, retained: true, reason: 'foreign' as StorageReason, runId: null, taskId: null, taskTitle: null, startedAt: null };
    // Only real directories inside brigd's bucket folders are ever touched; files, symlinks and stray root entries are reported.
    if (!item.inBucket || item.symlink || !item.directory) return base;
    const candidate = CANDIDATE_NAME.exec(item.name);
    if (candidate) {
      const record = integrations.get(candidate[1]!);
      const owner = record ? workspaces.find(workspace => workspace.runs.some(run => run.id === record.runId)) : undefined;
      const run = owner?.runs.find(entry => entry.id === record!.runId);
      if (record && (!owner || owner.snapshot.mode !== 'worktree' || !samePath(dirname(owner.snapshot.path), dirname(item.path)) ||
          record.attempt === Number(candidate[2]) && record.candidatePath && !samePath(record.candidatePath, item.path))) return base;
      if (!record && !ownedWorktree(item.path, repositoryIds)) return base;
      const retention = candidateRetention(record, Number(candidate[2]), owner?.runs);
      return { ...base, kind: 'candidate', ...retention, optional: retention.retained && retention.reason === 'failed', runId: record?.runId ?? null,
        taskId: owner?.taskId ?? null, taskTitle: owner?.taskTitle ?? null, startedAt: run?.startedAt ?? null };
    }
    const record = workspaces.find(workspace => workspace.snapshot.id === item.name);
    if (!record) return ownedWorktree(item.path, repositoryIds) ? { ...base, kind: 'worktree', retained: false, reason: 'unknown' } : base;
    const latest = record.runs.at(-1);
    const common = { ...base, kind: 'worktree' as const, runId: latest?.id ?? null, taskId: record.taskId, taskTitle: record.taskTitle, startedAt: latest?.startedAt ?? null };
    if (record.snapshot.mode !== 'worktree' || !samePath(record.snapshot.path, item.path)) return { ...common, reason: 'moved' };
    // A record without runs outlived its deleted task: nothing can continue or merge the folder any more.
    const retention: Retention = record.runs.length ? workspaceRetention(record.runs) : { retained: false, reason: 'deleted' };
    if (!retention.retained) {
      const owned = ownedWorktree(item.path, [record.snapshot.repositoryId]);
      if (owned && hasSubmoduleData(owned.admin)) return { ...common, retained: true, reason: 'submodules' };
    }
    return { ...common, ...retention };
  }
  /** Direct children of bucket folders plus anything unexpected at either level. Symlinks are never followed. */
  private listEntries(): Found[] {
    const result: Found[] = [];
    let buckets: string[];
    try { buckets = readdirSync(this.root); } catch { return result; }
    for (const bucket of buckets) {
      const path = join(this.root, bucket);
      let info;
      try { info = lstatSync(path); } catch { continue; }
      if (info.isSymbolicLink() || !info.isDirectory() || !BUCKET_NAME.test(bucket)) { result.push({ path, name: bucket, inBucket: false, directory: info.isDirectory(), symlink: info.isSymbolicLink() }); continue; }
      let names: string[];
      try { names = readdirSync(path); } catch { continue; }
      for (const name of names) {
        const child = join(path, name);
        let childInfo;
        try { childInfo = lstatSync(child); } catch { continue; }
        result.push({ path: child, name, inBucket: true, directory: childInfo.isDirectory(), symlink: childInfo.isSymbolicLink() });
      }
    }
    return result;
  }
  /** The overview may be seconds old; the database decides again right before anything is removed. */
  private stillReclaimable(entry: StorageEntry, options: CleanupOptions): boolean {
    const name = basename(entry.path);
    if (entry.kind === 'candidate') {
      const match = CANDIDATE_NAME.exec(name);
      const record = this.store.listIntegrationRecords().find(item => item.id === match?.[1]);
      const owner = record ? this.store.listWorkspaceRecords().find(workspace => workspace.runs.some(run => run.id === record.runId)) : undefined;
      if (record && (!owner || !samePath(dirname(owner.snapshot.path), dirname(entry.path)) ||
          record.attempt === Number(match?.[2]) && record.candidatePath && !samePath(record.candidatePath, entry.path))) return false;
      const retention = candidateRetention(record, Number(match?.[2]), owner?.runs);
      return !retention.retained || !!options.includeCandidates && retention.reason === 'failed';
    }
    const record = this.store.workspaceRecord(name);
    if (entry.kind === 'worktree' && (entry.runId || entry.reason === 'deleted')) {
      if (!record || !samePath(record.snapshot.path, entry.path) || workspaceRetention(record.runs).retained) return false;
      // Marked first: a crash halfway through must not leave a continuation refusing to recreate the folder.
      this.store.markWorkspaceRemoved(record.snapshot.id, Date.now(), null, 'cleanup');
      return true;
    }
    return !record && entry.reason === 'unknown';
  }
  private async removeEntry(entry: StorageEntry): Promise<void> {
    if (!inside(this.root, entry.path) || lstatSync(entry.path).isSymbolicLink()) throw new Error('Папка находится вне каталога рабочих папок.');
    const name = basename(entry.path);
    const record = entry.kind === 'worktree' && (entry.runId || entry.reason === 'deleted') ? this.store.workspaceRecord(name) : null;
    const repositoryIds = record ? [record.snapshot.repositoryId] : [...new Set(this.store.listWorkspaceRecords().map(workspace => workspace.snapshot.repositoryId))];
    // Git is only ever invoked for a repository brigd recorded, never for one named by the folder's own .git file.
    await this.removeFolder(entry.path, record?.snapshot.repositoryId ?? ownedWorktree(entry.path, repositoryIds)?.repositoryId ?? null);
  }
  /** `git worktree remove` keeps the repository's bookkeeping exact and also clears a registration whose folder is already gone;
   * a plain removal covers folders Git refuses. Nothing here follows symlinks or touches paths outside the root. */
  private async removeFolder(path: string, repositoryId: string | null): Promise<void> {
    if (!inside(this.root, path) || existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Папка находится вне каталога рабочих папок или заменена символической ссылкой.');
    if (this.submoduleData(path, repositoryId)) throw new Error('В worktree есть репозитории подмодулей Git; их локальные коммиты нужно сохранить перед удалением.');
    const remove = () => repositoryId ? gitExit(['--git-dir', repositoryId, 'worktree', 'remove', '--force', '--force', path]) : Promise.resolve(0);
    if (existsSync(path)) {
      await remove();
      if (existsSync(path)) {
        if (!inside(this.root, path)) throw new Error('Git не смог удалить worktree, а папка находится вне каталога рабочих папок.');
        removeTree(path);
      }
    }
    if (repositoryId && isRegistered(repositoryId, path)) await remove();
  }
  /** Empty buckets go, except one whose repository has a run being prepared right now: its folder is about to appear there.
   * `mergedRunId` names a run whose merge is about to be stored, so its own still-merging record does not count as busy. */
  private pruneBuckets(mergedRunId?: string) {
    let buckets: string[];
    try { buckets = readdirSync(this.root); } catch { return; }
    const busy = new Set(this.store.listWorkspaceRecords()
      .filter(record => workspaceRetention(record.runs.map(run => run.id === mergedRunId ? { ...run, integrationStatus: 'merged' } : run)).reason === 'active')
      .map(record => dirname(record.snapshot.path)));
    for (const bucket of buckets) {
      const path = join(this.root, bucket);
      if (busy.has(path)) continue;
      try { if (BUCKET_NAME.test(bucket) && lstatSync(path).isDirectory() && !readdirSync(path).length) rmdirSync(path); } catch { /* A busy bucket stays. */ }
    }
  }
}
