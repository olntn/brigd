import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { Store, runFence } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { candidateRetention, isRegistered, measure, ownedWorktree, workspaceRetention, WorkspaceStorage, type WorkspaceRun } from '../server/workspace-storage';
import { formatBytes } from '../src/lib/format';
import type { Run, StorageOverview } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const command = (script: string) => [process.execPath, '-e', script];
const checks = [command('process.exit(0)')];
const workspacesRoot = () => join(folder, 'workspaces');
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-storage-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(workspacesRoot(), checks), integrationChecks: checks, maxParallel: 2 });
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
async function configure(argv: string[][], autoReconcile = false) {
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(workspacesRoot(), argv), integrationChecks: argv, maxParallel: 2, autoReconcile });
}
async function start() {
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.some(call => call.input.workspace?.id === run.id));
  return store.getRun(run.id);
}
function complete(run: Run, content = 'worker result\n') {
  const call = agent.calls.find(call => call.input.workspace?.id === run.workspace!.id && !call.input.sessionId)!;
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), content);
  call.resolve(outcome());
}
async function settled(run: Run) {
  await until(() => !!store.integrationForRun(run.id) && !['queued', 'checking', 'merging', 'cancelling'].includes(store.integrationForRun(run.id)!.status));
  return store.integrationForRun(run.id)!;
}
function conflictingTarget(content: string) {
  writeFileSync(join(root, 'src/value.txt'), content); git(root, 'add', '.'); git(root, 'commit', '-m', 'target edit');
}
const entry = (overview: StorageOverview, path: string) => overview.entries.find(item => item.path === path);
const run = (status: WorkspaceRun['status'], integrationStatus: WorkspaceRun['integrationStatus'] = null): WorkspaceRun => ({ id: crypto.randomUUID(), status, integrationStatus, integrationUpdatedAt: null, startedAt: 1 });

describe('retention rules', () => {
  test('a worktree stays while anything after its last merged result can still be continued or merged', () => {
    expect(workspaceRetention([])).toEqual({ retained: false, reason: 'unknown' });
    expect(workspaceRetention([run('completed', 'merged')])).toEqual({ retained: false, reason: 'merged' });
    expect(workspaceRetention([run('completed', 'merged'), run('cancelled')])).toEqual({ retained: false, reason: 'merged' });
    expect(workspaceRetention([run('completed', 'conflict'), run('completed', 'merged')])).toEqual({ retained: false, reason: 'merged' });
    expect(workspaceRetention([run('cancelled'), run('cancelled')])).toEqual({ retained: false, reason: 'cancelled' });
    expect(workspaceRetention([run('completed', 'merged'), run('completed', 'queued')])).toEqual({ retained: true, reason: 'active' });
    expect(workspaceRetention([run('completed', 'merged'), run('completed', null)])).toEqual({ retained: true, reason: 'unmerged' });
    expect(workspaceRetention([run('completed', 'cancelled')])).toEqual({ retained: true, reason: 'unmerged' });
    expect(workspaceRetention([run('completed', 'conflict')])).toEqual({ retained: true, reason: 'conflict' });
    expect(workspaceRetention([run('completed', 'failed')])).toEqual({ retained: true, reason: 'failed' });
    expect(workspaceRetention([run('completed', 'blocked')])).toEqual({ retained: true, reason: 'failed' });
    expect(workspaceRetention([run('completed', 'interrupted')])).toEqual({ retained: true, reason: 'interrupted' });
    expect(workspaceRetention([run('failed'), run('cancelled')])).toEqual({ retained: true, reason: 'failed' });
    expect(workspaceRetention([run('blocked')])).toEqual({ retained: true, reason: 'failed' });
    expect(workspaceRetention([run('interrupted')])).toEqual({ retained: true, reason: 'interrupted' });
    for (const status of ['queued', 'preparing', 'running', 'cancelling', 'waiting_input'] as const) expect(workspaceRetention([run(status)])).toEqual({ retained: true, reason: 'active' });
    // The strongest reason wins when several runs share the folder.
    expect(workspaceRetention([run('completed', 'conflict'), run('completed', 'merged'), run('failed'), run('running')])).toEqual({ retained: true, reason: 'active' });
    expect(workspaceRetention([run('completed', 'merged'), run('completed', 'failed'), run('interrupted')])).toEqual({ retained: true, reason: 'interrupted' });
    // An older result whose merge was re-queued holds the folder even though a later result is merged.
    for (const status of ['queued', 'checking', 'merging', 'cancelling'] as const) expect(workspaceRetention([run('completed', status), run('completed', 'merged')])).toEqual({ retained: true, reason: 'active' });
    expect(workspaceRetention([run('completed', 'interrupted'), run('completed', 'merged')])).toEqual({ retained: true, reason: 'interrupted' });
    expect(workspaceRetention([run('completed', 'conflict'), run('completed', 'merged')])).toEqual({ retained: false, reason: 'merged' });
    expect(workspaceRetention([{ ...run('completed', 'failed'), integrationUpdatedAt: 2 }, { ...run('completed', 'merged'), integrationUpdatedAt: 2 }])).toEqual({ retained: true, reason: 'failed' });
  });
  test('a candidate stays only for the unfinished or inspectable current attempt of its own merge', () => {
    const record = { id: 'job', runId: 'run', attempt: 2, candidatePath: null, updatedAt: 1 };
    expect(candidateRetention(undefined, 1)).toEqual({ retained: false, reason: 'unknown' });
    expect(candidateRetention({ ...record, status: 'conflict' }, 1)).toEqual({ retained: false, reason: 'stale' });
    expect(candidateRetention({ ...record, status: 'merged' }, 2)).toEqual({ retained: false, reason: 'merged' });
    expect(candidateRetention({ ...record, status: 'queued' }, 2)).toEqual({ retained: false, reason: 'stale' });
    expect(candidateRetention({ ...record, status: 'cancelled' }, 2)).toEqual({ retained: false, reason: 'stale' });
    expect(candidateRetention({ ...record, status: 'conflict' }, 2)).toEqual({ retained: true, reason: 'conflict' });
    expect(candidateRetention({ ...record, status: 'failed' }, 2)).toEqual({ retained: true, reason: 'failed' });
    expect(candidateRetention({ ...record, status: 'blocked' }, 2)).toEqual({ retained: true, reason: 'failed' });
    expect(candidateRetention({ ...record, status: 'interrupted' }, 2)).toEqual({ retained: true, reason: 'interrupted' });
    for (const status of ['checking', 'merging', 'cancelling'] as const) expect(candidateRetention({ ...record, status }, 2)).toEqual({ retained: true, reason: 'active' });
    const runs = [{ ...run('completed', 'conflict'), id: record.runId }, { ...run('completed', 'merged'), integrationUpdatedAt: 2 }];
    for (const status of ['conflict', 'failed', 'blocked'] as const) expect(candidateRetention({ ...record, status }, 2, runs)).toEqual({ retained: false, reason: 'stale' });
    expect(candidateRetention({ ...record, status: 'failed', updatedAt: 3 }, 2, runs)).toEqual({ retained: true, reason: 'failed' });
    expect(candidateRetention({ ...record, status: 'interrupted' }, 2, runs)).toEqual({ retained: true, reason: 'interrupted' });
    for (const status of ['checking', 'merging', 'cancelling'] as const) expect(candidateRetention({ ...record, status }, 2, runs)).toEqual({ retained: true, reason: 'active' });
  });
  test('sizes come from an lstat walk that never follows symlinks', async () => {
    const target = join(folder, 'measured'); mkdirSync(join(target, 'nested'), { recursive: true });
    writeFileSync(join(target, 'a.txt'), 'x'.repeat(10)); writeFileSync(join(target, 'nested', 'b.txt'), 'y'.repeat(20));
    symlinkSync(root, join(target, 'link'));
    const size = await measure(target);
    expect(size.files).toBe(3); expect(size.bytes).toBeGreaterThanOrEqual(30); expect(size.bytes).toBeLessThan(64 * 1024);
    expect(await measure(join(folder, 'missing'))).toEqual({ bytes: 0, files: 0 });
    expect(formatBytes(512)).toBe('512 Б'); expect(formatBytes(1536)).toBe('1,5 КБ'); expect(formatBytes(3 * 1024 * 1024)).toBe('3 МБ');
  });
  test('sparse files count their allocated blocks rather than their logical length', async () => {
    const sparse = join(folder, 'sparse');
    writeFileSync(sparse, ''); truncateSync(sparse, 1024 * 1024 * 1024);
    expect(await measure(sparse)).toEqual({ bytes: lstatSync(sparse).blocks * 512, files: 1 });
  });
  test('registration parsing preserves unusual path characters', () => {
    const path = join(folder, 'worktree\nwith trailing space ');
    const unusualRoot = repository(folder, 'project\nwith trailing space ');
    git(unusualRoot, 'worktree', 'add', '--detach', path);
    expect(isRegistered(join(unusualRoot, '.git'), path)).toBe(true);
    expect(ownedWorktree(path, [join(unusualRoot, '.git')])?.repositoryId).toBe(join(unusualRoot, '.git'));
  });
});

describe('automatic reclamation', () => {
  test('a merged run frees its worktree and candidate, and a continuation recreates the folder from the branch', async () => {
    const first = await start(); complete(first);
    const merged = await settled(first);
    expect(merged.status).toBe('merged');
    expect(existsSync(first.workspace!.path)).toBe(false); expect(existsSync(merged.candidatePath!)).toBe(false);
    expect(git(root, 'for-each-ref', '--format=%(refname)', `refs/heads/${first.workspace!.branch}`)).toBe('');
    expect(existsSync(dirname(first.workspace!.path))).toBe(false); expect(existsSync(workspacesRoot())).toBe(true);
    const overview = await engine.storageOverview();
    expect(overview).toMatchObject({ available: true, root: workspacesRoot(), totalBytes: 0, reclaimableBytes: 0, entries: [] });
    const followup = engine.followup(first.taskId, { sourceRunId: first.id, sourceStepIndex: null, body: 'Add more.', attachmentIds: [], requestId: crypto.randomUUID() });
    await until(() => agent.calls.length === 2);
    expect(agent.calls[1]!.input).toMatchObject({ cwd: first.workspace!.cwd, sessionId: 'saved-session' });
    expect(readFileSync(join(first.workspace!.path, 'src/value.txt'), 'utf8')).toBe('worker result\n');
    expect(git(first.workspace!.path, 'symbolic-ref', '--short', 'HEAD')).toBe(`brigd/run-${first.id}`);
    expect(store.getRun(followup.id).workspace!.removedAt).toBeNull();
    writeFileSync(join(first.workspace!.path, 'src/second.txt'), 'second'); agent.calls[1]!.resolve(outcome());
    expect((await settled(followup)).status).toBe('merged');
    expect(git(root, 'show', 'main:src/second.txt')).toBe('second');
    expect(existsSync(first.workspace!.path)).toBe(false);
    expect(store.getRun(first.id).workspace!.removedAt).toBeGreaterThan(0);
    const logs = store.detail(first.taskId).logs!.filter(item => item.summary === 'Рабочая папка запуска удалена после слияния');
    expect(logs).toHaveLength(2); expect(logs[0]!.details.join(' ')).toContain('Освобождено');
  });
  test('an automatically removed branch is rebuilt from the last merged commit', async () => {
    const first = await start(); complete(first, 'kept result\n');
    const merged = await settled(first);
    expect(git(root, 'for-each-ref', '--format=%(refname)', `refs/heads/brigd/run-${first.id}`)).toBe('');
    engine.followup(first.taskId, { sourceRunId: first.id, sourceStepIndex: null, body: 'Continue.', attachmentIds: [], requestId: crypto.randomUUID() });
    await until(() => agent.calls.length === 2);
    expect(git(first.workspace!.path, 'rev-parse', 'HEAD')).toBe(merged.sourceCommit!);
    expect(git(first.workspace!.path, 'symbolic-ref', '--short', 'HEAD')).toBe(`brigd/run-${first.id}`);
    expect(readFileSync(join(first.workspace!.path, 'src/value.txt'), 'utf8')).toBe('kept result\n');
  });
  test('a folder that vanished without brigd still blocks the exact session', async () => {
    const first = await start();
    agent.calls[0]!.resolve(outcome('exact', 'needs_input'));
    await until(() => store.getRun(first.id).status === 'waiting_input');
    rmSync(first.workspace!.path, { recursive: true, force: true });
    engine.resume(first.id, 'Continue', false);
    await until(() => store.getRun(first.id).status === 'blocked');
    expect(store.getRun(first.id).error).toContain('Сохранённый worktree отсутствует');
    expect(existsSync(first.workspace!.path)).toBe(false);
  });
  test('recreation clears only its own stale registration, rebuilds debris and refuses a moved branch', async () => {
    const task = store.createTask(taskInput(root));
    const provider = new GitWorkspaces(workspacesRoot(), checks);
    const legacy = store.startManual(task.id, false);
    store.enqueueExecution(legacy, provider.locate(legacy));
    const preparing = store.claimExecution(store.pendingExecutions()[0]!, 1)!;
    const workspace = provider.plan(preparing, provider.locate(preparing));
    store.attachWorkspace(legacy.id, runFence(preparing), workspace);
    await provider.prepare(workspace); store.beginExecution(legacy.id, runFence(preparing));
    writeFileSync(join(workspace.path, 'src/value.txt'), 'kept\n'); git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-m', 'kept');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    store.finish(legacy.id, 'completed', 'done', null); store.settleExecution(legacy.id, legacy.turn);
    // A user's own worktree whose folder is away for a while must stay registered.
    const away = join(folder, 'user-feature'); git(root, 'worktree', 'add', '-b', 'user-feature', away); renameSync(away, join(folder, 'user-feature-moved'));
    // A folder deleted by hand after brigd recorded the removal leaves a stale registration that only this worktree may lose.
    store.markWorkspaceRemoved(workspace.id, Date.now(), tip, 'merge');
    rmSync(workspace.path, { recursive: true, force: true });
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain(workspace.path);
    await provider.prepare(store.getWorkspace(workspace.id));
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain(join(folder, 'user-feature'));
    // Debris of a removal that stopped halfway is cleared before the folder comes back.
    store.markWorkspaceRemoved(workspace.id, Date.now(), tip, 'cleanup');
    git(root, 'worktree', 'remove', '--force', '--force', workspace.path);
    mkdirSync(workspace.path, { recursive: true }); writeFileSync(join(workspace.path, 'half.txt'), 'debris');
    await provider.prepare(store.getWorkspace(workspace.id));
    expect(existsSync(join(workspace.path, 'half.txt'))).toBe(false); expect(readFileSync(join(workspace.path, 'src/value.txt'), 'utf8')).toBe('kept\n');
    // A branch moved by hand no longer matches the merged commit the saved session worked with.
    store.markWorkspaceRemoved(workspace.id, Date.now(), tip, 'merge');
    git(root, 'worktree', 'remove', '--force', '--force', workspace.path);
    git(root, 'branch', '-f', workspace.branch!, workspace.baseCommit!);
    await expect(provider.prepare(store.getWorkspace(workspace.id))).rejects.toThrow('указывает не на перенесённый коммит');
    expect(existsSync(workspace.path)).toBe(false); expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path);
    // A branch checked out elsewhere is named instead of a generic failure.
    git(root, 'branch', '-f', workspace.branch!, tip);
    git(root, 'worktree', 'add', join(folder, 'inspect'), workspace.branch!);
    await expect(provider.prepare(store.getWorkspace(workspace.id))).rejects.toThrow('уже открыта в другом worktree');
  });
  test('a merge that a cancellation overtook stays merged', async () => {
    const first = await start(); complete(first);
    const merged = await settled(first);
    expect(merged.status).toBe('merged');
    // The stored transform: a cancellation requested after the target moved cannot undo it.
    store.db.query("UPDATE integrations SET state='cancelling',snapshot=? WHERE id=?").run(JSON.stringify({ ...merged, status: 'cancelling' }), merged.id);
    const finished = store.updateIntegration(merged.id, merged.attempt, { status: 'merged', sourceCommit: merged.sourceCommit, targetCommit: merged.targetCommit, resultCommit: merged.resultCommit, checks: [], error: null }, true);
    expect(finished).toMatchObject({ status: 'merged', error: null });
    expect(store.getRun(first.id).workspace!.lastIntegratedCommit).toBe(merged.sourceCommit!);
  });
  test('conflicts and failed checks keep the worktree and candidate; a retry discards the superseded candidate', async () => {
    await configure([command('process.exit(7)')]);
    const failing = await start(); complete(failing);
    const failed = await settled(failing);
    expect(failed.status).toBe('failed'); expect(existsSync(failing.workspace!.path)).toBe(true); expect(existsSync(failed.candidatePath!)).toBe(true);
    let overview = await engine.storageOverview();
    expect(entry(overview, failing.workspace!.path)).toMatchObject({ kind: 'worktree', retained: true, reason: 'failed', runId: failing.id, taskId: failing.taskId, taskTitle: 'Isolated work' });
    expect(entry(overview, failed.candidatePath!)).toMatchObject({ kind: 'candidate', retained: true, reason: 'failed', runId: failing.id, taskTitle: 'Isolated work' });
    expect(overview.reclaimableBytes).toBe(0); expect(overview.retainedBytes).toBe(overview.totalBytes); expect(overview.totalBytes).toBeGreaterThan(0);
    engine.setAutopilotSettings({ integrationChecks: checks });
    engine.integrate(failing.id);
    const merged = await settled(failing);
    expect(merged).toMatchObject({ status: 'merged', attempt: 2 });
    expect(existsSync(failed.candidatePath!)).toBe(false); expect(existsSync(merged.candidatePath!)).toBe(false); expect(existsSync(failing.workspace!.path)).toBe(false);
    const conflicted = await start(); conflictingTarget('conflicting target\n'); complete(conflicted, 'second result\n');
    const conflict = await settled(conflicted);
    expect(conflict.status).toBe('conflict'); expect(existsSync(conflicted.workspace!.path)).toBe(true); expect(existsSync(conflict.candidatePath!)).toBe(true);
    overview = await engine.storageOverview();
    expect(entry(overview, conflicted.workspace!.path)).toMatchObject({ retained: true, reason: 'conflict' });
    expect(entry(overview, conflict.candidatePath!)).toMatchObject({ kind: 'candidate', retained: true, reason: 'conflict' });
    expect(store.getRun(conflicted.id).workspace!.removedAt).toBeFalsy();
  });
  test('a merged earlier result keeps the shared worktree while a later unmerged continuation exists', async () => {
    await configure([command('process.exit(7)')]);
    const first = await start(); complete(first);
    expect((await settled(first)).status).toBe('failed');
    const followup = engine.followup(first.taskId, { sourceRunId: first.id, sourceStepIndex: null, body: 'Try again.', attachmentIds: [], requestId: crypto.randomUUID() });
    await until(() => agent.calls.length === 2);
    writeFileSync(join(first.workspace!.path, 'src/more.txt'), 'more'); agent.calls[1]!.resolve(outcome());
    expect((await settled(followup)).status).toBe('failed');
    engine.setAutopilotSettings({ integrationChecks: checks });
    engine.integrate(first.id);
    expect((await settled(first)).status).toBe('merged');
    // The follow-up's own merge is still recorded as failed, so its folder is kept until that record moves on.
    expect(existsSync(first.workspace!.path)).toBe(true);
    expect(entry(await engine.storageOverview(), first.workspace!.path)).toMatchObject({ retained: true, reason: 'failed' });
    engine.integrate(followup.id);
    expect((await settled(followup)).status).toBe('merged');
    expect(existsSync(first.workspace!.path)).toBe(false);
  });
  test('a successful continuation reclaims failed candidates from earlier runs of its shared worktree', async () => {
    await configure([command('process.exit(7)')]);
    const first = await start(); complete(first);
    const failed = await settled(first);
    expect(failed.status).toBe('failed');
    const followup = engine.followup(first.taskId, { sourceRunId: first.id, sourceStepIndex: null, body: 'Fix the result.', attachmentIds: [], requestId: crypto.randomUUID() });
    await until(() => agent.calls.length === 2);
    engine.setAutopilotSettings({ integrationChecks: checks });
    writeFileSync(join(first.workspace!.path, 'src/more.txt'), 'fixed'); agent.calls[1]!.resolve(outcome());
    expect((await settled(followup)).status).toBe('merged');
    expect(store.integrationForRun(first.id)!.status).toBe('failed');
    expect(existsSync(failed.candidatePath!)).toBe(false);
    expect(existsSync(first.workspace!.path)).toBe(false);
    // Simulate an old retained candidate left by an earlier version: the overview and manual cleanup agree with automatic cleanup.
    git(root, 'worktree', 'add', '--detach', failed.candidatePath!, failed.targetCommit!);
    expect(entry(await engine.storageOverview(), failed.candidatePath!)).toMatchObject({ kind: 'candidate', retained: false, reason: 'stale' });
    expect(await engine.cleanupStorage()).toMatchObject({ removed: 1, failures: [] });
    expect(existsSync(failed.candidatePath!)).toBe(false);
    // Recreating the shared worktree and checking an older result again produces a new inspectable attempt.
    await new GitWorkspaces(workspacesRoot(), checks).prepare(store.getWorkspace(first.workspace!.id));
    writeFileSync(join(first.workspace!.path, 'src/recheck.txt'), 'new work');
    engine.setAutopilotSettings({ integrationChecks: [command('process.exit(7)')] }); engine.integrate(first.id);
    const rechecked = await settled(first);
    expect(rechecked).toMatchObject({ status: 'failed', attempt: 2 });
    const overview = await engine.storageOverview();
    expect(entry(overview, first.workspace!.path)).toMatchObject({ retained: true, reason: 'failed' });
    expect(entry(overview, rechecked.candidatePath!)).toMatchObject({ retained: true, reason: 'failed' });
    expect(await engine.cleanupStorage()).toMatchObject({ removed: 0, failures: [] });
    expect(existsSync(first.workspace!.path)).toBe(true); expect(existsSync(rechecked.candidatePath!)).toBe(true);
  });
  test('a cancelled merge keeps the worktree but drops its scratch candidate', async () => {
    const entered = join(folder, 'entered');
    await configure([command(`require('node:fs').writeFileSync(${JSON.stringify(entered)},'ready'); await Bun.sleep(60000);`)]);
    const first = await start(); complete(first); await until(() => existsSync(entered));
    const candidatePath = store.integrationForRun(first.id)!.candidatePath!;
    expect(existsSync(candidatePath)).toBe(true);
    engine.cancelIntegration(first.id);
    expect((await settled(first)).status).toBe('cancelled');
    expect(existsSync(candidatePath)).toBe(false); expect(existsSync(first.workspace!.path)).toBe(true);
    expect(entry(await engine.storageOverview(), first.workspace!.path)).toMatchObject({ retained: true, reason: 'unmerged' });
  });
});

describe('manual cleanup', () => {
  test('a candidate name does not authorize deleting a different bucket or a moved recorded path', async () => {
    await configure([command('process.exit(7)')]);
    const first = await start(); complete(first);
    const failed = await settled(first);
    const other = join(workspacesRoot(), '0123456789abcdef0123', `integration-${failed.id}-0`);
    mkdirSync(other, { recursive: true }); writeFileSync(join(other, 'keep.txt'), 'keep');
    const moved = { ...failed, candidatePath: join(folder, 'elsewhere', `integration-${failed.id}-${failed.attempt}`) };
    store.db.query('UPDATE integrations SET snapshot=? WHERE id=?').run(JSON.stringify(moved), failed.id);
    for (const path of [other, failed.candidatePath!]) expect(entry(await engine.storageOverview(), path)).toMatchObject({ kind: 'unknown', retained: true, reason: 'foreign' });
    expect(await engine.cleanupStorage({ includeCandidates: true })).toMatchObject({ removed: 0, failures: [] });
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(failed.candidatePath!)).toBe(true);
  });
  test('candidate and orphan worktrees keep local submodule repositories during cleanup and retries', async () => {
    await configure([command('process.exit(7)')]);
    const first = await start(); complete(first);
    const failed = await settled(first);
    const library = repository(folder, 'library');
    git(failed.candidatePath!, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor/library');
    const orphan = await start();
    git(orphan.workspace!.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor/library');
    engine.cancel(orphan.id); await until(() => store.getRun(orphan.id).status === 'cancelled');
    store.db.query('UPDATE runs SET workspace_id=NULL WHERE id=?').run(orphan.id);
    store.db.query('DELETE FROM workspaces WHERE id=?').run(orphan.workspace!.id);
    const overview = await engine.storageOverview();
    for (const path of [failed.candidatePath!, orphan.workspace!.path]) expect(entry(overview, path)).toMatchObject({ retained: true, reason: 'submodules', optional: false });
    expect(await engine.cleanupStorage({ includeCandidates: true })).toMatchObject({ removed: 0, failures: [] });
    engine.setAutopilotSettings({ integrationChecks: checks }); engine.integrate(first.id);
    expect((await settled(first)).status).toBe('merged');
    expect(existsSync(first.workspace!.path)).toBe(false);
    for (const path of [failed.candidatePath!, orphan.workspace!.path]) {
      expect(existsSync(join(path, 'vendor/library/src/value.txt'))).toBe(true);
      expect(git(root, 'worktree', 'list', '--porcelain')).toContain(path);
    }
    expect(await engine.cleanupStorage({ includeCandidates: true })).toMatchObject({ removed: 0, failures: [] });
  });
  test('reclaims cancelled runs, stale candidates and recordless brigd worktrees while reporting foreign and moved entries', async () => {
    await configure([command('process.exit(7)')]);
    const failing = await start(); complete(failing);
    const failed = await settled(failing);
    expect(failed.status).toBe('failed');
    const cancelled = await start();
    engine.cancel(cancelled.id);
    await until(() => store.getRun(cancelled.id).status === 'cancelled');
    // A worktree whose record vanished with an older restored backup still proves it is ours through Git's own back-pointer.
    const orphan = await start();
    engine.cancel(orphan.id);
    await until(() => store.getRun(orphan.id).status === 'cancelled');
    store.db.query('UPDATE runs SET workspace_id=NULL WHERE id=?').run(orphan.id);
    store.db.query('DELETE FROM workspaces WHERE id=?').run(orphan.workspace!.id);
    const bucket = dirname(failing.workspace!.path);
    const plain = join(bucket, 'orphan-run'); mkdirSync(plain); writeFileSync(join(plain, 'leftover.txt'), 'x'.repeat(2048));
    const stale = join(bucket, `integration-${failed.id}-0`); mkdirSync(stale); writeFileSync(join(stale, 'old.txt'), 'old');
    const outside = join(folder, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(workspacesRoot(), 'link')); writeFileSync(join(workspacesRoot(), 'stray.txt'), 'stray'); writeFileSync(join(bucket, 'note.txt'), 'note');
    mkdirSync(join(workspacesRoot(), 'shared')); writeFileSync(join(workspacesRoot(), 'shared', 'data.bin'), 'x'.repeat(4096));
    const overview = await engine.storageOverview();
    expect(entry(overview, failing.workspace!.path)).toMatchObject({ retained: true, reason: 'failed', startedAt: failing.startedAt });
    expect(entry(overview, failed.candidatePath!)).toMatchObject({ retained: true, reason: 'failed', optional: true });
    expect(entry(overview, cancelled.workspace!.path)).toMatchObject({ kind: 'worktree', retained: false, reason: 'cancelled', taskTitle: 'Isolated work' });
    expect(entry(overview, orphan.workspace!.path)).toMatchObject({ kind: 'worktree', retained: false, reason: 'unknown', runId: null, taskTitle: null });
    expect(entry(overview, stale)).toMatchObject({ kind: 'candidate', retained: false, reason: 'stale', runId: failing.id });
    for (const path of [plain, join(workspacesRoot(), 'link'), join(workspacesRoot(), 'stray.txt'), join(bucket, 'note.txt'), join(workspacesRoot(), 'shared')]) {
      expect(entry(overview, path)).toMatchObject({ kind: 'unknown', retained: true, reason: 'foreign', bytes: 0 });
    }
    expect(overview.entries.filter(item => !item.retained)).toHaveLength(3);
    expect(overview.reclaimableBytes + overview.retainedBytes).toBe(overview.totalBytes);
    expect(overview.entries[0]!.retained).toBe(false);
    const result = await engine.cleanupStorage();
    expect(result).toMatchObject({ removed: 3, failures: [] }); expect(result.freedBytes).toBe(overview.reclaimableBytes);
    expect(existsSync(cancelled.workspace!.path)).toBe(false); expect(existsSync(orphan.workspace!.path)).toBe(false); expect(existsSync(stale)).toBe(false);
    expect(git(root, 'rev-parse', `refs/heads/${cancelled.workspace!.branch}`)).toBe(cancelled.workspace!.baseCommit!);
    expect(git(root, 'rev-parse', `refs/heads/${orphan.workspace!.branch}`)).toBe(orphan.workspace!.baseCommit!);
    for (const path of [plain, join(workspacesRoot(), 'link'), join(workspacesRoot(), 'stray.txt'), join(bucket, 'note.txt'), join(workspacesRoot(), 'shared', 'data.bin'), join(outside, 'keep.txt')]) expect(existsSync(path)).toBe(true);
    expect(existsSync(failing.workspace!.path)).toBe(true); expect(existsSync(failed.candidatePath!)).toBe(true);
    const registered = git(root, 'worktree', 'list', '--porcelain');
    expect(registered).not.toContain(cancelled.workspace!.path); expect(registered).not.toContain(orphan.workspace!.path); expect(registered).toContain(failing.workspace!.path);
    expect(store.getRun(cancelled.id).workspace).toMatchObject({ removedBy: 'cleanup' }); expect(store.getRun(cancelled.id).workspace!.removedAt).toBeGreaterThan(0);
    expect(result.overview.entries.filter(item => !item.retained)).toHaveLength(0);
    expect(result.overview.reclaimableBytes).toBe(0);
    expect(await engine.cleanupStorage()).toMatchObject({ removed: 0, freedBytes: 0, failures: [] });
    // Candidates of failed checks go only when asked for; the run's own worktree stays for a retry.
    const optional = await engine.cleanupStorage({ includeCandidates: true });
    expect(optional).toMatchObject({ removed: 1, failures: [] });
    expect(existsSync(failed.candidatePath!)).toBe(false); expect(existsSync(failing.workspace!.path)).toBe(true);
    // A record whose path no longer matches the folder (moved database or root) is reported, never touched.
    const snapshot = store.getWorkspace(failing.workspace!.id);
    store.db.query('UPDATE workspaces SET snapshot=? WHERE id=?').run(JSON.stringify({ ...snapshot, path: join(folder, 'elsewhere', failing.workspace!.id) }), snapshot.id);
    expect(entry(await engine.storageOverview(), failing.workspace!.path)).toMatchObject({ kind: 'worktree', retained: true, reason: 'moved', runId: failing.id });
    expect(await engine.cleanupStorage({ includeCandidates: true })).toMatchObject({ removed: 0 });
    expect(existsSync(failing.workspace!.path)).toBe(true);
  });
  test('a root that holds the database or a home directory is reported and never scanned', async () => {
    const storage = new WorkspaceStorage(folder, store);
    const overview = await storage.overview();
    expect(overview).toMatchObject({ available: false, root: folder, entries: [] });
    expect(overview.note).toContain('содержит базу данных');
    expect(await storage.cleanup()).toMatchObject({ removed: 0, freedBytes: 0, failures: [], overview: { available: false } });
    expect(existsSync(join(folder, 'data.sqlite'))).toBe(true);
  });
  test('a worktree with submodule repositories is kept after the merge because their commits live only there', async () => {
    const library = repository(folder, 'library');
    const first = await start();
    git(first.workspace!.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'vendor/library');
    writeFileSync(join(first.workspace!.path, 'vendor/library/src/value.txt'), 'library change\n');
    git(join(first.workspace!.path, 'vendor/library'), 'add', '.'); git(join(first.workspace!.path, 'vendor/library'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'library change');
    complete(first);
    const merged = await settled(first);
    expect(merged.status).toBe('merged');
    expect(existsSync(first.workspace!.path)).toBe(true); expect(existsSync(merged.candidatePath!)).toBe(false);
    expect(store.getRun(first.id).workspace!.removedAt).toBeFalsy();
    expect(store.detail(first.taskId).logs!.map(item => item.summary)).toContain('Рабочая папка запуска сохранена после слияния');
    const overview = await engine.storageOverview();
    expect(entry(overview, first.workspace!.path)).toMatchObject({ retained: true, reason: 'submodules' });
    expect(await engine.cleanupStorage({ includeCandidates: true })).toMatchObject({ removed: 0 });
  });
  test('the scheduler claims nothing while a cleanup runs, and only one cleanup runs at a time', async () => {
    const cleaning = engine.cleanupStorage();
    expect(() => engine.cleanupStorage()).toThrow('уже выполняется');
    const queued = engine.start(store.createTask(taskInput(root)).id);
    expect(queued.status).toBe('queued'); expect(agent.calls).toHaveLength(0);
    await cleaning;
    await until(() => agent.calls.length === 1);
    expect(store.getRun(queued.id).status).toBe('running');
    expect(await engine.cleanupStorage()).toMatchObject({ removed: 0 });
    expect(entry(await engine.storageOverview(), store.getRun(queued.id).workspace!.path)).toMatchObject({ retained: true, reason: 'active' });
  });
  test('HTTP exposes the overview and the cleanup with the usual origin and body rules', async () => {
    const handler = createHandler(engine, { port: 4310, root: folder, startedAt: 0 });
    const request = (path: string, method = 'GET', body?: string, origin = 'http://127.0.0.1:4310') => handler(new Request(`http://127.0.0.1:4310${path}`, {
      method, headers: { origin, 'content-type': 'application/json' }, body }));
    const first = await start(); engine.cancel(first.id);
    await until(() => store.getRun(first.id).status === 'cancelled');
    const read = await request('/api/settings/storage');
    expect(read.status).toBe(200);
    const overview = await read.json() as StorageOverview;
    expect(overview).toMatchObject({ available: true, root: workspacesRoot() });
    expect(overview.entries).toHaveLength(1); expect(overview.entries[0]).toMatchObject({ reason: 'cancelled', retained: false });
    expect((await request('/api/settings/storage/cleanup', 'POST', '{}', 'http://evil.invalid')).status).toBe(403);
    expect((await request('/api/settings/storage/cleanup', 'POST', '{"force":true}')).status).toBe(400);
    expect((await request('/api/settings/storage/cleanup', 'POST', '{"includeCandidates":"yes"}')).status).toBe(400);
    const cleaned = await request('/api/settings/storage/cleanup', 'POST', '{"includeCandidates":true}');
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toMatchObject({ removed: 1, failures: [], overview: { entries: [], reclaimableBytes: 0 } });
    expect(existsSync(first.workspace!.path)).toBe(false);
  });
  test('demo mode reports no storage and refuses to clean', async () => {
    const demo = new Engine(store, true);
    try {
      expect(await demo.storageOverview()).toMatchObject({ available: false, root: null, entries: [] });
      expect(() => demo.cleanupStorage()).toThrow('очищать нечего');
      const handler = createHandler(demo, { port: 4310, root: folder, startedAt: 0 });
      const response = await handler(new Request('http://127.0.0.1:4310/api/settings/storage/cleanup', { method: 'POST', headers: { origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' }, body: '{}' }));
      expect(response.status).toBe(409);
    } finally { await demo.shutdown(); }
  });
});
