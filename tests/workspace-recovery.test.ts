import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { isRegistered } from '../server/workspace-storage';
import { git, repository, taskInput } from './repository-helpers';

let folder: string, root: string, store: Store;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-recovery-'));
  root = repository(folder);
  store = new Store(join(folder, 'data.sqlite'));
});
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });

describe('worktree recovery with literal paths', () => {
  test.each(['workspaces\nline', 'workspaces '])('recreates a removed folder under %j without losing another registration', async name => {
    const provider = new GitWorkspaces(join(folder, name));
    const run = store.startManual(store.createTask(taskInput(root)).id, false);
    const workspace = provider.plan(run, provider.locate(run));
    await provider.prepare(workspace);
    writeFileSync(join(workspace.path, 'src/value.txt'), 'saved result\n');
    git(workspace.path, 'add', '.'); git(workspace.path, 'commit', '-m', 'saved result');
    const tip = git(workspace.path, 'rev-parse', 'HEAD');
    const other = join(folder, 'other\nworktree ');
    git(root, 'worktree', 'add', '--detach', other);
    rmSync(other, { recursive: true, force: true });
    rmSync(workspace.path, { recursive: true, force: true });
    expect(isRegistered(workspace.repositoryId, workspace.path)).toBe(true);
    expect(isRegistered(workspace.repositoryId, other)).toBe(true);

    await provider.prepare({ ...workspace, prepared: true, removedAt: Date.now(), lastIntegratedCommit: tip });

    expect(readFileSync(join(workspace.path, 'src/value.txt'), 'utf8')).toBe('saved result\n');
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(isRegistered(workspace.repositoryId, workspace.path)).toBe(true);
    expect(isRegistered(workspace.repositoryId, other)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  test('a newline in another worktree path cannot look like a branch checkout', async () => {
    const provider = new GitWorkspaces(join(folder, 'workspaces'));
    const run = store.startManual(store.createTask(taskInput(root)).id, false);
    const workspace = provider.plan(run, provider.locate(run));
    await provider.prepare(workspace);
    git(root, 'worktree', 'remove', workspace.path);
    const other = join(folder, `other\nbranch refs/heads/${workspace.branch}\nend`);
    git(root, 'worktree', 'add', '--detach', other);

    await provider.prepare({ ...workspace, prepared: true, removedAt: Date.now(), lastIntegratedCommit: workspace.baseCommit });

    expect(git(workspace.path, 'symbolic-ref', '--short', 'HEAD')).toBe(workspace.branch!);
    expect(existsSync(other)).toBe(true);
  });
});
