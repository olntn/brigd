import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Run } from '../src/lib/types';
import { AppError } from './errors';
import { ARTIFACT_PATHSPECS, artifact } from './integration';

export interface CommitResult { committed: boolean; commit: string | null; branch: string | null; files: string[]; fileCount: number; }

/** Literal paths relative to the agent's working folder: no pathspec magic or parent traversal. */
export function commitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || new Set(value).size !== value.length) throw new AppError('Invalid commit paths.');
  return value.map(path => {
    if (typeof path !== 'string' || !path.trim() || path.length > 1000 || path.includes('\0')) throw new AppError('Invalid commit path.');
    const normalized = posix.normalize(path);
    if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new AppError('Commit paths must stay inside the working folder.');
    return normalized;
  });
}

/** Never trust the work tree's own .git file: the agent can point it at a
 * repository whose config runs commands outside the sandbox. */
function linkedGitDirectory(common: string, workTree: string): string {
  let names: string[] = [];
  try { names = readdirSync(join(common, 'worktrees')); } catch { /* No linked work trees. */ }
  for (const name of names) {
    try { if (readFileSync(join(common, 'worktrees', name, 'gitdir'), 'utf8').trim() === join(workTree, '.git')) return join(common, 'worktrees', name); }
    catch { /* Skip incomplete administrative entries. */ }
  }
  throw new AppError('Could not verify the Git repository of this working folder. Nothing was committed.', 409);
}

async function git(argv: string[], cwd: string, optional = false): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code === 0 || optional) return code === 0 ? stdout : '';
  const detail = stderr.trim().slice(-1000);
  throw new AppError(`Git failed${detail ? `: ${detail}` : '.'}`, 409);
}

/** Commits for a sandboxed agent, which cannot write .git itself. */
export async function commitWorkspace(run: Run, message: string, paths?: string[]): Promise<CommitResult> {
  const workspace = run.workspace;
  if (!workspace) throw new AppError('This invocation has no brigd working folder to commit.', 409);
  let workTree: string;
  try { workTree = realpathSync(workspace.mode === 'worktree' ? workspace.path : workspace.repositoryRoot); }
  catch { throw new AppError('The working folder is unavailable. Nothing was committed.', 409); }
  const gitDir = workspace.mode === 'direct' && workspace.repositoryId === join(workTree, '.git') ? workspace.repositoryId : linkedGitDirectory(workspace.repositoryId, workTree);
  // Hooks and fsmonitor would execute files the agent controls (husky scripts,
  // for example) outside the sandbox. Worktree results are still checked on merge.
  const base = ['git', `--git-dir=${gitDir}`, `--work-tree=${workTree}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const scope = paths ? paths.map(path => `:(literal)${path}`) : ['.'];
  await git([...base, 'add', '-A', '--', ...scope, ...ARTIFACT_PATHSPECS], workspace.cwd);
  const files = (await git([...base, 'diff', '--cached', '--name-only', '-z', '--', ...scope], workspace.cwd)).split('\0').filter(Boolean);
  if (files.some(artifact)) throw new AppError('Task artifact directories are staged. Unstage them; nothing was committed.', 409);
  if (files.length) {
    const identity = await git([...base, 'var', 'GIT_AUTHOR_IDENT'], workspace.cwd, true);
    // Paths after -- commit only this scope, never unrelated changes staged elsewhere.
    await git([...base, ...(identity ? [] : ['-c', 'user.name=brigd', '-c', 'user.email=brigd@localhost']),
      'commit', '-m', message, '-m', `Brigd-Run: ${run.id}`, '--', ...scope], workspace.cwd);
  }
  const branch = (await git([...base, 'symbolic-ref', '--quiet', '--short', 'HEAD'], workspace.cwd, true)).trim() || null;
  const commit = (await git([...base, 'rev-parse', '--verify', '--quiet', 'HEAD'], workspace.cwd, true)).trim() || null;
  // The broker reserves a 4 KiB receipt; a commit must never be reported as failed for size.
  const listed: string[] = [];
  let bytes = 0;
  for (const file of files) { bytes += Buffer.byteLength(JSON.stringify(file)) + 1; if (bytes > 2048) break; listed.push(file); }
  return { committed: files.length > 0, commit, branch, files: listed, fileCount: files.length };
}
