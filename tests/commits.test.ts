import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths, commitWorkspace } from '../server/commits';
import { Engine } from '../server/engine';
import { AppError } from '../server/errors';
import { Store } from '../server/store';
import { createTaskBroker, type TaskBroker } from '../server/task-mcp';
import type { TaskToolResult } from '../server/task-mcp-protocol';
import { GitWorkspaces } from '../server/workspaces';
import type { Run } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string;
beforeEach(() => { folder = realpathSync(mkdtempSync(join(tmpdir(), 'brigd-commits-'))); root = repository(folder); });
afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

/** The snapshot brigd records before an agent starts in the user's own folder. */
const direct = (cwd = root): Run => ({ id: 'run-1', workspace: { id: 'run-1', mode: 'direct', repositoryRoot: root, repositoryId: join(root, '.git'),
  projectCwd: cwd, path: cwd, cwd, branch: null, baseCommit: null, targetBranch: null, prepared: true } }) as unknown as Run;
async function rejects(action: Promise<unknown>) {
  try { await action; throw new Error('Expected AppError'); } catch (error) { expect(error).toBeInstanceOf(AppError); }
}
const hook = (path: string, marker: string) => { writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(path, 0o755); };

describe('commits for sandboxed agents', () => {
  test('commits the working folder scope only, never artifacts or changes staged elsewhere', async () => {
    writeFileSync(join(root, 'src/value.txt'), 'changed\n');
    writeFileSync(join(root, 'src/new.txt'), 'new\n');
    mkdirSync(join(root, 'src/.brigd-outbox-1')); writeFileSync(join(root, 'src/.brigd-outbox-1/report.txt'), 'private');
    writeFileSync(join(root, 'other.txt'), 'user work\n'); git(root, 'add', 'other.txt');
    const result = await commitWorkspace(direct(join(root, 'src')), 'Agent change');
    expect(result).toMatchObject({ committed: true, branch: 'main', files: ['src/new.txt', 'src/value.txt'], fileCount: 2 });
    expect(result.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'log', '-1', '--format=%B')).toBe('Agent change\n\nBrigd-Run: run-1');
    expect(git(root, 'status', '--porcelain')).toBe('A  other.txt');
  });

  test('explicit paths limit the commit; an empty scope reports nothing to commit', async () => {
    writeFileSync(join(root, 'a.txt'), 'a\n'); writeFileSync(join(root, 'src/value.txt'), 'b\n');
    expect(await commitWorkspace(direct(), 'Only a', ['./a.txt'])).toMatchObject({ committed: true, files: ['a.txt'] });
    expect(git(root, 'status', '--porcelain')).toBe('M src/value.txt');
    const head = git(root, 'rev-parse', 'HEAD');
    expect(await commitWorkspace(direct(), 'Again', ['a.txt'])).toEqual({ committed: false, commit: head, branch: 'main', files: [], fileCount: 0 });
  });

  test('paths stay literal and inside the working folder', () => {
    for (const value of [[], ['../outside'], ['/etc/passwd'], ['src/../../outside'], ['a', 'a'], [''], ['nul\0'], 'a.txt', [5]]) {
      expect(() => commitPaths(value)).toThrow(AppError);
    }
    expect(commitPaths(['src//value.txt', ':(glob)*'])).toEqual(['src/value.txt', ':(glob)*']);
  });

  test('hooks never run, including in-tree hook directories the agent could write', async () => {
    const markers = [join(folder, 'trusted-hook'), join(folder, 'tree-hook')];
    hook(join(root, '.git/hooks/pre-commit'), markers[0]!);
    mkdirSync(join(root, '.husky')); hook(join(root, '.husky/pre-commit'), markers[1]!); git(root, 'config', 'core.hooksPath', '.husky');
    writeFileSync(join(root, 'src/value.txt'), 'changed\n');
    expect((await commitWorkspace(direct(), 'No hooks')).committed).toBe(true);
    expect(markers.filter(existsSync)).toEqual([]);
  });

  test('a missing working folder snapshot or unverifiable repository commits nothing', async () => {
    await rejects(commitWorkspace({ id: 'run-1', workspace: null } as unknown as Run, 'Nothing'));
    writeFileSync(join(root, 'src/value.txt'), 'changed\n');
    const forged = direct(); forged.workspace!.repositoryId = join(folder, 'elsewhere/.git');
    await rejects(commitWorkspace(forged, 'Nothing'));
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});

describe('commit_changes in an isolated worktree', () => {
  let store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>, brokers: TaskBroker[];
  beforeEach(() => {
    store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent(); brokers = [];
    engine = new Engine(store, false, agent.factory, (db, run, fence) => {
      const broker = createTaskBroker(db, run, fence);
      broker.agentConfig.env.BRIGD_TASK_SOCKET = '/tmp/brigd-commit-test.sock';
      brokers.push(broker);
      return broker;
    },
      { workspaces: new GitWorkspaces(join(folder, 'workspaces'), [[process.execPath, '-e', 'process.exit(0)']]) });
  });
  afterEach(async () => {
    for (const call of agent.calls) call.reject(new Error('cleanup'));
    await engine.shutdown(); for (const broker of brokers) broker.close(); store.close();
  });
  async function start() {
    const run = engine.start(store.createTask(taskInput(root)).id);
    await until(() => agent.calls.length === 1 && brokers.length === 1);
    return store.getRun(run.id);
  }
  const commit = (args: unknown): Promise<TaskToolResult> => brokers[0]!.dispatch({ capability: brokers[0]!.agentConfig.env.BRIGD_TASK_CAPABILITY,
    requestId: crypto.randomUUID(), tool: 'commit_changes', arguments: args });
  const parse = (result: TaskToolResult) => { expect(result.isError).not.toBe(true); return JSON.parse((result.content[0] as { text: string }).text); };

  test('the agent commit lands on the run branch and reaches the target through the verified merge', async () => {
    const run = await start();
    expect(agent.calls[0]!.input.taskBridge).toBeDefined();
    writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'agent result\n');
    expect(parse(await commit({ message: 'Agent change' }))).toMatchObject({ committed: true, branch: `brigd/run-${run.id}`, files: ['src/value.txt'], file_count: 1 });
    expect(git(root, 'status', '--porcelain')).toBe('');
    agent.calls[0]!.resolve(outcome());
    await until(() => store.integrationForRun(run.id)?.status === 'merged');
    expect(git(root, 'log', 'main', '--format=%s')).toContain('Agent change');
    expect(git(root, 'show', 'main:src/value.txt')).toBe('agent result');
  });

  test('a rewritten worktree .git file cannot redirect the commit or run its repository config', async () => {
    const run = await start();
    const fake = join(folder, 'fake'), marker = join(folder, 'fsmonitor-ran');
    mkdirSync(fake); git(fake, 'init'); hook(join(fake, 'monitor.sh'), marker); git(fake, 'config', 'core.fsmonitor', join(fake, 'monitor.sh'));
    writeFileSync(join(run.workspace!.path, '.git'), `gitdir: ${join(fake, '.git')}\n`);
    writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'agent result\n');
    expect(parse(await commit({ message: 'Agent change', paths: ['src/value.txt'] }))).toMatchObject({ committed: true, branch: `brigd/run-${run.id}` });
    expect(git(root, 'log', '-1', '--format=%s', `brigd/run-${run.id}`)).toBe('Agent change');
    expect(existsSync(marker)).toBe(false);
    expect((await commit({ message: 'Bad', paths: ['../outside'] })).isError).toBe(true);
  });
});
