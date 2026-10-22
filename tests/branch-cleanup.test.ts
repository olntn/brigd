import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const checks = [[process.execPath, '-e', 'process.exit(0)']];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-branch-cleanup-'));
  root = repository(folder);
  store = new Store(join(folder, 'data.sqlite'));
  agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, {
    workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks), integrationChecks: checks,
  });
});

afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

const branchExists = (branch: string) => Bun.spawnSync(['git', '-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).exitCode === 0;

async function mergedRun(keepOldBranch = true) {
  const started = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const run = store.getRun(started.id);
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'merged task result\n');
  agent.calls[0]!.resolve(outcome());
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
  const sourceCommit = store.integrationForRun(run.id)!.sourceCommit!;
  const workspace = store.getRun(run.id).workspace!;
  expect(existsSync(workspace.path)).toBe(false);
  expect(branchExists(workspace.branch!)).toBe(false);
  // Earlier releases removed the folder but left exactly this source branch behind.
  if (keepOldBranch) git(root, 'branch', workspace.branch!, sourceCommit);
  return { run, workspace, sourceCommit };
}

test('cleanup finds and removes a merged branch whose worktree was already reclaimed', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  const before = await engine.storageOverview();
  expect(before.entries).toEqual([]);
  expect(before.reclaimableBranches).toEqual([workspace.branch!]);
  expect(before.reclaimableBytes).toBe(0);

  const result = await engine.cleanupStorage();

  expect(result).toMatchObject({ removed: 0, removedBranches: 1, freedBytes: 0, failures: [] });
  expect(result.overview.reclaimableBranches).toEqual([]);
  expect(branchExists(workspace.branch!)).toBe(false);
  expect(git(root, 'merge-base', sourceCommit, 'main')).toBe(sourceCommit);
  expect(store.getWorkspace(workspace.id).lastIntegratedCommit).toBe(sourceCommit);
  expect((await engine.cleanupStorage()).removedBranches).toBe(0);
});

test('cleanup removes a legacy merged worktree before deleting its checked-out branch', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  git(root, 'worktree', 'add', workspace.path, workspace.branch!);

  const before = await engine.storageOverview();
  expect(before.entries).toHaveLength(1);
  expect(before.entries[0]).toMatchObject({ path: workspace.path, kind: 'worktree', retained: false });
  expect(before.reclaimableBranches).toEqual([workspace.branch!]);

  const result = await engine.cleanupStorage();

  expect(result).toMatchObject({ removed: 1, removedBranches: 1, failures: [] });
  expect(existsSync(workspace.path)).toBe(false);
  expect(branchExists(workspace.branch!)).toBe(false);
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path);
  expect(git(root, 'merge-base', sourceCommit, 'main')).toBe(sourceCommit);
});

test('cleanup preserves a source branch advanced by a new local commit', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  const newCommit = git(root, 'commit-tree', `${sourceCommit}^{tree}`, '-p', sourceCommit, '-m', 'unmerged local work');
  git(root, 'update-ref', `refs/heads/${workspace.branch}`, newCommit, sourceCommit);

  expect((await engine.storageOverview()).reclaimableBranches).toEqual([]);
  const result = await engine.cleanupStorage();

  expect(result).toMatchObject({ removedBranches: 0, failures: [] });
  expect(git(root, 'rev-parse', `refs/heads/${workspace.branch}`)).toBe(newCommit);
});

test('cleanup removes a cancelled worktree but keeps its unmerged local commit', async () => {
  const started = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const workspace = store.getRun(started.id).workspace!;
  writeFileSync(join(workspace.path, 'local.txt'), 'unfinished work');
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '-m', 'local work before cancellation');
  const sourceCommit = git(workspace.path, 'rev-parse', 'HEAD');
  engine.cancel(started.id);
  await until(() => store.getRun(started.id).status === 'cancelled');

  const result = await engine.cleanupStorage();

  expect(result).toMatchObject({ removed: 1, removedBranches: 0, failures: [] });
  expect(existsSync(workspace.path)).toBe(false);
  expect(git(root, 'rev-parse', `refs/heads/${workspace.branch}`)).toBe(sourceCommit);
  expect(git(root, 'show', `${workspace.branch}:local.txt`)).toBe('unfinished work');
});

test('cleanup preserves the source after the target is reset before the merged result', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  git(root, 'reset', '--hard', workspace.baseCommit!);

  expect((await engine.storageOverview()).reclaimableBranches).toEqual([]);
  expect((await engine.cleanupStorage()).removedBranches).toBe(0);
  expect(git(root, 'rev-parse', `refs/heads/${workspace.branch}`)).toBe(sourceCommit);
  expect(git(root, 'rev-parse', 'main')).toBe(workspace.baseCommit!);
});

test.each([false, true])('cleanup preserves a branch checked out elsewhere, even with missing folder=%j', async missing => {
  const { workspace, sourceCommit } = await mergedRun();
  const other = join(folder, 'user-worktree');
  git(root, 'worktree', 'add', other, workspace.branch!);
  if (missing) rmSync(other, { recursive: true, force: true });

  expect((await engine.storageOverview()).reclaimableBranches).toEqual([]);
  expect((await engine.cleanupStorage()).removedBranches).toBe(0);
  expect(git(root, 'rev-parse', `refs/heads/${workspace.branch}`)).toBe(sourceCommit);
  expect(git(root, 'worktree', 'list', '--porcelain')).toContain(other);
});

test('a detached worktree path containing a branch marker does not prevent cleanup', async () => {
  const { workspace } = await mergedRun();
  const other = join(folder, `user\nbranch refs/heads/${workspace.branch}\nworktree`);
  git(root, 'worktree', 'add', '--detach', other);

  expect((await engine.cleanupStorage()).removedBranches).toBe(1);
  expect(branchExists(workspace.branch!)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

test('cleanup preserves a task ref changed into a symbolic ref and its referent', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  git(root, 'branch', 'user-result', sourceCommit);
  git(root, 'symbolic-ref', `refs/heads/${workspace.branch}`, 'refs/heads/user-result');

  expect((await engine.storageOverview()).reclaimableBranches).toEqual([]);
  expect((await engine.cleanupStorage()).removedBranches).toBe(0);
  expect(git(root, 'symbolic-ref', `refs/heads/${workspace.branch}`)).toBe('refs/heads/user-result');
  expect(git(root, 'rev-parse', 'user-result')).toBe(sourceCommit);
});

test('cleanup preserves the source when its recorded target becomes a symbolic ref', async () => {
  const { workspace, sourceCommit } = await mergedRun();
  git(root, 'branch', 'user-target', 'main');
  git(root, 'symbolic-ref', 'refs/heads/main', 'refs/heads/user-target');

  expect((await engine.storageOverview()).reclaimableBranches).toEqual([]);
  expect((await engine.cleanupStorage()).removedBranches).toBe(0);
  expect(git(root, 'rev-parse', `refs/heads/${workspace.branch}`)).toBe(sourceCommit);
  expect(git(root, 'symbolic-ref', 'refs/heads/main')).toBe('refs/heads/user-target');
});

test('a continuation recreates the deleted branch at the saved result after main advances', async () => {
  const { run, workspace, sourceCommit } = await mergedRun(false);
  writeFileSync(join(root, 'later.txt'), 'later target change');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'later target change');
  const targetCommit = git(root, 'rev-parse', 'main');

  const followup = engine.followup(run.taskId, {
    sourceRunId: run.id, sourceStepIndex: null, body: 'Continue.', attachmentIds: [], requestId: crypto.randomUUID(),
  });
  await until(() => agent.calls.length === 2);

  expect(store.getRun(followup.id).status).toBe('running');
  expect(git(workspace.path, 'symbolic-ref', '--short', 'HEAD')).toBe(workspace.branch!);
  expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(sourceCommit);
  expect(git(root, 'rev-parse', 'main')).toBe(targetCommit);
  expect(readFileSync(join(workspace.path, 'src/value.txt'), 'utf8')).toBe('merged task result\n');
  expect(existsSync(join(workspace.path, 'later.txt'))).toBe(false);
  expect(agent.calls[1]!.input.sessionId).toBe('saved-session');
  expect(store.getWorkspace(workspace.id).removedAt).toBeNull();
});
