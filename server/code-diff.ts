import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CodeDiffFile, RunCodeDiff } from '../src/lib/code-diff';
import type { Run } from '../src/lib/types';
import { artifact, ARTIFACT_PATHSPECS } from './integration';
import type { Store } from './store';

const FILE_BYTES = 256 * 1024;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const PATH_LIMIT = 200;
const FILE_LIMIT = 100;
const PATCH_BYTES = 64 * 1024;
const DIFF_BYTES = 512 * 1024;
const GIT_BYTES = 2 * 1024 * 1024;
const ACTIVE = new Set(['preparing', 'running', 'cancelling']);
interface Version { mode: string; data: string | null; binary: boolean; omitted: boolean; }
interface Snapshot { commit: string; dirty: Record<string, Version | null>; truncated: boolean; }
interface SavedDiff { baseline: string | null; result: string | null; }
class DiffError extends Error {}

// No optional locks, index refresh, hooks, diff drivers, textconv, or fsmonitor.
// Clear ambient Git path/config overrides so -C always addresses the saved worktree.
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
function git(cwd: string, args: string[], diff = false): Buffer {
  const child = Bun.spawnSync(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
    { env: gitEnvironment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000, maxBuffer: GIT_BYTES });
  if (child.exitCode !== 0 && !(diff && child.exitCode === 1)) throw new DiffError('Git не смог прочитать изменения рабочей папки.');
  return Buffer.from(child.stdout);
}
const textGit = (cwd: string, args: string[]) => git(cwd, args).toString().trim();
const safePath = (path: string) => !!path && !isAbsolute(path) && !path.split('/').some(part => part === '..' || part === '.git') && !artifact(path);
const paths = (data: Buffer) => data.toString().split('\0').filter(safePath);
const literal = (path: string) => `:(literal)${path}`;
const owns = (values: object, key: string) => Object.hasOwn(values, key);
function verifiedWorkspace(run: Run): string {
  const workspace = run.workspace;
  if (run.mock) throw new DiffError('В деморежиме изменения кода недоступны.');
  if (!workspace || workspace.mode !== 'worktree' || !workspace.baseCommit) throw new DiffError('Для этого запуска нет подтверждённого Git worktree.');
  const root = realpathSync(workspace.path);
  if (realpathSync(textGit(root, ['rev-parse', '--show-toplevel'])) !== root ||
      realpathSync(textGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(workspace.repositoryId) ||
      textGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== workspace.branch) throw new DiffError('Сохранённый Git worktree недоступен или изменён.');
  return root;
}
function workFile(root: string, path: string, budget: { bytes: number }): Version | null {
  if (!safePath(path)) throw new DiffError('Git вернул недопустимый путь.');
  const file = join(root, path);
  try {
    // A tracked path replaced by a directory symlink must never read outside the task.
    const parent = realpathSync(dirname(file));
    const subpath = relative(root, parent);
    if (subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) throw new DiffError('Путь файла выходит за пределы worktree.');
    const info = lstatSync(file);
    const mode = info.isSymbolicLink() ? '120000' : info.isDirectory() ? '160000' : info.mode & 0o111 ? '100755' : '100644';
    if (!info.isFile() && !info.isSymbolicLink() || info.size > FILE_BYTES || budget.bytes + info.size > SNAPSHOT_BYTES) return { mode, data: null, binary: false, omitted: true };
    let data: Buffer;
    if (info.isSymbolicLink()) data = Buffer.from(readlinkSync(file));
    else {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const current = fstatSync(fd);
        if (!current.isFile()) return { mode, data: null, binary: false, omitted: true };
        // Reading at most the bound also covers a file growing after lstat.
        data = Buffer.alloc(Math.min(FILE_BYTES + 1, current.size));
        data = data.subarray(0, readSync(fd, data, 0, data.length, 0));
      } finally { closeSync(fd); }
    }
    if (data.length > FILE_BYTES || budget.bytes + data.length > SNAPSHOT_BYTES) return { mode, data: null, binary: false, omitted: true };
    budget.bytes += data.length;
    return { mode, data: data.toString('base64'), binary: data.includes(0), omitted: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}
function snapshot(root: string, initial = false): Snapshot {
  const commit = textGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const changed = new Set([...paths(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', commit, '--', '.', ...ARTIFACT_PATHSPECS])),
    ...paths(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...ARTIFACT_PATHSPECS]))]);
  // An incomplete starting state cannot safely attribute omitted paths to this run.
  if (initial && changed.size > PATH_LIMIT) throw new DiffError('Слишком много несохранённых файлов для точного снимка изменений запуска.');
  const dirty: Record<string, Version | null> = Object.create(null);
  const budget = { bytes: 0 };
  for (const path of [...changed].sort().slice(0, PATH_LIMIT)) dirty[path] = workFile(root, path, budget);
  const omitted = Object.values(dirty).some(value => value?.omitted);
  if (initial && omitted) throw new DiffError('Исходные несохранённые файлы слишком велики для точного снимка изменений запуска.');
  return { commit, dirty, truncated: changed.size > PATH_LIMIT || omitted };
}
interface TreeEntry { mode: string; object: string; }
function treeEntries(root: string, commit: string, changed: string[]) {
  const result = new Map<string, TreeEntry>();
  if (!changed.length) return result;
  for (const entry of git(root, ['ls-tree', '-r', '-z', commit, '--', ...changed.map(literal)]).toString().split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , object] = entry.slice(0, tab).split(' ');
    if (mode && object) result.set(entry.slice(tab + 1), { mode, object });
  }
  return result;
}
function treeFile(root: string, value: TreeEntry | undefined, budget: { bytes: number }): Version | null {
  if (!value) return null;
  if (value.mode === '160000') return { mode: value.mode, data: Buffer.from(value.object + '\n').toString('base64'), binary: false, omitted: false };
  const size = Number(textGit(root, ['cat-file', '-s', value.object]));
  if (size > FILE_BYTES || budget.bytes + size > SNAPSHOT_BYTES) return { mode: value.mode, data: null, binary: false, omitted: true };
  const data = git(root, ['cat-file', 'blob', value.object]);
  budget.bytes += data.length;
  return { mode: value.mode, data: data.toString('base64'), binary: data.includes(0), omitted: false };
}
const unavailable = (run: Run, reason: string): RunCodeDiff => ({ runId: run.id, state: 'unavailable', reason, files: [], additions: 0, deletions: 0,
  truncated: false, baseCommit: null, headCommit: null, capturedAt: Date.now(), live: false });

function fileDiff(root: string, path: string, before: Version | null, after: Version | null, temp: string): CodeDiffFile | null {
  if (!before && !after || before && after && !before.omitted && !after.omitted && before.mode === after.mode && before.data === after.data) return null;
  const status = !before ? 'added' : !after ? 'deleted' : before.mode !== after.mode ? 'typechanged' : 'modified';
  const result: CodeDiffFile = { path, oldPath: null, status, additions: 0, deletions: 0, binary: !!(before?.binary || after?.binary),
    truncated: !!(before?.omitted || after?.omitted), patch: '' };
  if (result.truncated || result.binary) return result;
  const oldFile = join(temp, 'before'), newFile = join(temp, 'after');
  writeFileSync(oldFile, Buffer.from(before?.data ?? '', 'base64'));
  writeFileSync(newFile, Buffer.from(after?.data ?? '', 'base64'));
  let raw: string;
  try { raw = git(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', '--', oldFile, newFile], true).toString(); }
  catch { result.truncated = true; return result; }
  const hunkAt = raw.indexOf('\n@@');
  const hunks = hunkAt < 0 ? '' : raw.slice(hunkAt + 1);
  for (const line of hunks.split('\n')) {
    if (line.startsWith('+')) result.additions++;
    else if (line.startsWith('-')) result.deletions++;
  }
  const modes = !before ? `new file mode ${after!.mode}\n` : !after ? `deleted file mode ${before.mode}\n` : before.mode !== after.mode ? `old mode ${before.mode}\nnew mode ${after.mode}\n` : '';
  const headers = `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\n${modes}--- ${before ? JSON.stringify('a/' + path) : '/dev/null'}\n+++ ${after ? JSON.stringify('b/' + path) : '/dev/null'}\n`;
  result.patch = headers + hunks;
  if (Buffer.byteLength(result.patch) > PATCH_BYTES) {
    result.patch = Buffer.from(result.patch).subarray(0, PATCH_BYTES).toString('utf8');
    const end = result.patch.lastIndexOf('\n');
    result.patch = end < 0 ? '' : result.patch.slice(0, end + 1);
    result.truncated = true;
  }
  return result;
}
function compare(run: Run, root: string, baseline: Snapshot, endpoint: Snapshot, live: boolean): RunCodeDiff {
  const changed = [...new Set([...paths(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', baseline.commit, endpoint.commit, '--', '.', ...ARTIFACT_PATHSPECS])),
    ...Object.keys(baseline.dirty), ...Object.keys(endpoint.dirty)])].filter(safePath).sort();
  const selected = changed.slice(0, PATH_LIMIT);
  const beforeTree = treeEntries(root, baseline.commit, selected), afterTree = treeEntries(root, endpoint.commit, selected);
  const result: RunCodeDiff = { runId: run.id, state: 'available', reason: null, files: [], additions: 0, deletions: 0,
    truncated: changed.length > PATH_LIMIT || baseline.truncated || endpoint.truncated, baseCommit: baseline.commit, headCommit: endpoint.commit, capturedAt: Date.now(), live };
  const temp = mkdtempSync(join(tmpdir(), 'brigd-code-diff-'));
  const beforeBudget = { bytes: 0 }, afterBudget = { bytes: 0 };
  let patchBytes = 0;
  try {
    for (const path of selected) {
      const before = owns(baseline.dirty, path) ? baseline.dirty[path]! : treeFile(root, beforeTree.get(path), beforeBudget);
      const after = owns(endpoint.dirty, path) ? endpoint.dirty[path]! : treeFile(root, afterTree.get(path), afterBudget);
      const file = fileDiff(root, path, before, after, temp);
      if (!file) continue;
      if (result.files.length >= FILE_LIMIT) { result.truncated = true; break; }
      if (patchBytes + Buffer.byteLength(file.patch) > DIFF_BYTES) { file.patch = ''; file.truncated = true; }
      patchBytes += Buffer.byteLength(file.patch);
      result.files.push(file); result.additions += file.additions; result.deletions += file.deletions;
      result.truncated ||= file.truncated;
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return result;
}

/** Baselines and completed responses are stored separately from the shared workspace. */
export class RunCodeDiffs {
  constructor(private readonly store: Store) {}
  private saved(runId: string) { return this.store.db.query('SELECT baseline,result FROM run_code_diffs WHERE run_id=?').get(runId) as SavedDiff | null; }
  begin(run: Run) {
    const saved = this.saved(run.id);
    if (saved) {
      if (saved.baseline) this.store.db.query('UPDATE run_code_diffs SET result=NULL WHERE run_id=?').run(run.id);
      return;
    }
    let baseline: Snapshot | null = null, result: RunCodeDiff | null = null;
    try { baseline = snapshot(verifiedWorkspace(run), true); }
    catch (error) { result = unavailable(run, error instanceof DiffError ? error.message : 'Не удалось прочитать Git worktree запуска.'); }
    this.store.db.query('INSERT OR REPLACE INTO run_code_diffs(run_id,baseline,result) VALUES (?,?,?)').run(run.id, baseline ? JSON.stringify(baseline) : null, result ? JSON.stringify(result) : null);
  }
  get(run: Run): RunCodeDiff {
    const saved = this.saved(run.id);
    if (saved?.result) return JSON.parse(saved.result) as RunCodeDiff;
    if (!saved?.baseline) return this.legacy(run) ?? unavailable(run, run.mock ? 'В деморежиме изменения кода недоступны.' : 'Для этого запуска нет сохранённого снимка изменений.');
    if (!ACTIVE.has(run.status)) return unavailable(run, 'Итоговый снимок изменений этого запуска недоступен.');
    return this.capture(run, JSON.parse(saved.baseline), true);
  }
  private legacy(run: Run): RunCodeDiff | null {
    const workspace = run.workspace;
    const endpoint = run.integration?.sourceCommit;
    if (run.mock || run.status !== 'completed' || workspace?.mode !== 'worktree' || !endpoint || run.reconcile || run.integration!.attempt > 1) return null;
    // A later turn may have reused this worktree before an old integration was
    // retried. Without a per-run snapshot, that provenance cannot be recovered.
    const later = this.store.db.query('SELECT id FROM runs WHERE workspace_id=? AND rowid>(SELECT rowid FROM runs WHERE id=?) LIMIT 1').get(workspace.id, run.id);
    if (later && run.integration!.status !== 'merged') return null;
    const predecessor = run.followup ? this.store.getRun(run.followup.sourceRunId).integration : null;
    if (run.followup && (predecessor?.attempt !== 1 || predecessor.status !== 'merged' || predecessor.updatedAt > run.startedAt)) return null;
    const baseline = run.followup ? predecessor?.sourceCommit : workspace.baseCommit;
    if (!baseline || !/^[a-f0-9]{40,64}$/.test(baseline) || !/^[a-f0-9]{40,64}$/.test(endpoint)) return null;
    try {
      // Completed legacy runs can be read from immutable commits even after their
      // worktree is removed. Never compare their baseline with today's files.
      const root = realpathSync(workspace.repositoryRoot);
      if (realpathSync(textGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(workspace.repositoryId)) return null;
      const result = compare(run, root, { commit: baseline, dirty: {}, truncated: false }, { commit: endpoint, dirty: {}, truncated: false }, false);
      result.capturedAt = run.finishedAt ?? run.updatedAt;
      return result;
    } catch { return null; }
  }
  private capture(run: Run, baseline: Snapshot, live: boolean): RunCodeDiff {
    try { const root = verifiedWorkspace(run); return compare(run, root, baseline, snapshot(root), live); }
    catch (error) { return unavailable(run, error instanceof DiffError ? error.message : 'Не удалось прочитать Git worktree запуска.'); }
  }
  freeze(run: Run) {
    if (ACTIVE.has(run.status) || run.status === 'queued') return;
    const saved = this.saved(run.id);
    if (!saved?.baseline || saved.result) return;
    const result = this.capture(run, JSON.parse(saved.baseline), false);
    this.store.db.query('UPDATE run_code_diffs SET result=? WHERE run_id=?').run(JSON.stringify(result), run.id);
  }
}
