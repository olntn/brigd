import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-queue-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), maxParallel: 2 });
});
afterEach(async () => {
  for (const call of agent.calls) { call.ignoreCancel = false; call.reject(new Error('cleanup')); }
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});

test('same repository is serialized across subdirectories and symlinks while another repository can run', async () => {
  const alias = join(folder, 'alias'); symlinkSync(root, alias);
  const first = engine.start(store.createTask(taskInput(root)).id);
  const second = engine.start(store.createTask(taskInput(join(alias, 'src'))).id);
  const other = engine.start(store.createTask(taskInput(repository(folder, 'other'))).id);
  expect(second.status).toBe('queued');
  await until(() => agent.calls.length === 2);
  expect(store.getRun(other.id).status).toBe('running');
  const original = readFileSync(join(root, 'src/value.txt'), 'utf8');
  writeFileSync(join(agent.calls[0]!.input.cwd, 'src/value.txt'), 'agent change\n');
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe(original);
  agent.calls[0]!.resolve(outcome());
  await until(() => agent.calls.length === 3);
  expect(agent.calls[2]!.input.cwd.endsWith('/src')).toBe(true);
  expect(store.getRun(first.id).workspace?.path).not.toBe(store.getRun(second.id).workspace?.path);
});

test('queued cancellation never invokes an agent and cancelling a running agent holds the repository until it settles', async () => {
  const first = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1); agent.calls[0]!.ignoreCancel = true;
  const abandoned = engine.start(store.createTask(taskInput(root)).id);
  const next = engine.start(store.createTask(taskInput(root)).id);
  expect(engine.cancel(abandoned.id).status).toBe('cancelled');
  expect(engine.cancel(first.id).status).toBe('cancelling');
  await Bun.sleep(40); expect(agent.calls).toHaveLength(1);
  agent.calls[0]!.resolve(outcome());
  await until(() => agent.calls.length === 2);
  expect(store.getRun(first.id).status).toBe('cancelled');
  expect(store.getRun(next.id).status).toBe('running');
});

test('waiting work releases the process slot; its queued answer resumes the same directory and exact session', async () => {
  const first = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const savedCwd = agent.calls[0]!.input.cwd;
  agent.calls[0]!.resolve(outcome('exact-first', 'needs_input'));
  await until(() => store.getRun(first.id).status === 'waiting_input');
  const second = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 2);
  expect(engine.resume(first.id, 'Persist this answer', false).status).toBe('queued');
  agent.calls[1]!.resolve(outcome('second'));
  await until(() => agent.calls.length === 3);
  expect(agent.calls[2]!.input).toMatchObject({ cwd: savedCwd, sessionId: 'exact-first', answer: 'Persist this answer' });
  expect(store.getRun(second.id).status).toBe('completed');
});

test('scheduled requests wait durably and coalesce to one latest interval instead of being dropped', async () => {
  const first = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const now = Date.now();
  const scheduled = store.createTask(taskInput(root, { schedule: 'interval', intervalMinutes: 1, firstRunAt: now }));
  engine.tick(now); engine.tick(now + 3 * 60_000);
  const queued = store.detail(scheduled.id).runs;
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ status: 'queued', scheduledFor: now + 3 * 60_000 });
  agent.calls[0]!.resolve(outcome());
  await until(() => agent.calls.length === 2);
  expect(store.getRun(first.id).status).toBe('completed');
});

test('restart preserves queued work and requires acknowledgement before releasing an uncertain process reservation', async () => {
  const first = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const queued = engine.start(store.createTask(taskInput(root)).id);
  await engine.shutdown(); store.close();
  store = new Store(join(folder, 'data.sqlite'));
  agent = controlledAgent(); engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')) });
  engine.startScheduler(); await Bun.sleep(40);
  expect(agent.calls).toHaveLength(0);
  expect(store.getRun(queued.id).status).toBe('queued');
  expect(() => engine.cancel(first.id)).toThrow('подтвердите');
  engine.cancel(first.id, true);
  await until(() => agent.calls.length === 1);
  expect(store.getRun(queued.id).status).toBe('running');
});

test('a missing saved worktree blocks exact-session resumption rather than silently creating a new directory', async () => {
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  agent.calls[0]!.resolve(outcome('exact', 'needs_input'));
  await until(() => store.getRun(run.id).status === 'waiting_input');
  const path = store.getRun(run.id).workspace!.path; rmSync(path, { recursive: true, force: true });
  engine.resume(run.id, 'Continue', false);
  await until(() => store.getRun(run.id).status === 'blocked');
  expect(agent.calls).toHaveLength(1); expect(existsSync(path)).toBe(false);
});

test('a queued worktree starts from the latest saved commit, preserving dirty source files', async () => {
  const first = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  const next = engine.start(store.createTask(taskInput(root)).id);
  writeFileSync(join(root, 'src/value.txt'), 'new saved version\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'external change');
  const latest = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/value.txt'), 'user unsaved change\n');
  agent.calls[0]!.resolve(outcome());
  await until(() => agent.calls.length === 2);
  expect(store.getRun(next.id).workspace!.baseCommit).toBe(latest);
  expect(readFileSync(join(agent.calls[1]!.input.cwd, 'src/value.txt'), 'utf8')).toBe('new saved version\n');
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('user unsaved change\n');
  expect(store.getRun(first.id).status).toBe('completed');
});

test('two database connections cannot reserve the same repository or exceed the global process limit', () => {
  const one = store.startManual(store.createTask(taskInput(root)).id, false);
  const two = store.startManual(store.createTask(taskInput(root)).id, false);
  const provider = new GitWorkspaces(join(folder, 'workspaces'));
  store.enqueueExecution(one, provider.locate(one)); store.enqueueExecution(two, provider.locate(two));
  const requests = store.pendingExecutions(), other = new Store(join(folder, 'data.sqlite'));
  try {
    expect(store.claimExecution(requests[0]!, 1)).not.toBeNull();
    expect(other.claimExecution(requests[0]!, 1)).toBeNull();
    expect(other.claimExecution(requests[1]!, 1)).toBeNull();
  } finally { other.close(); }
});

test('legacy exact sessions remain exclusive even when independent worktree concurrency is enabled', async () => {
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), maxParallel: 2, maxPerRepository: 2 });
  const legacy = store.startManual(store.createTask(taskInput(root)).id, false);
  store.setSession(legacy.id, 'legacy-exact'); store.finish(legacy.id, 'waiting_input', 'Question', null);
  engine.resume(legacy.id, 'Continue', false); await until(() => agent.calls.length === 1);
  expect(agent.calls[0]!.input.cwd).toBe(root); expect(agent.calls[0]!.input.sessionId).toBe('legacy-exact');
  const next = engine.start(store.createTask(taskInput(root)).id);
  expect(next.status).toBe('queued');
  agent.calls[0]!.resolve(outcome('legacy-exact', 'needs_input'));
  await until(() => store.getRun(legacy.id).status === 'waiting_input');
  await Bun.sleep(30); expect(agent.calls).toHaveLength(1);
  engine.cancel(legacy.id); await until(() => agent.calls.length === 2);
  expect(agent.calls[1]!.input.cwd).not.toBe(root);
});

test('default integration commands are chosen from committed project scripts rather than dirty files', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0', scripts: { verify: 'npm test', test: 'test command', build: 'build command' } }));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'project checks');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'dirty script' } }));
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  expect(store.getRun(run.id).workspace!.checkCommands).toEqual([['npm', 'install'], ['npm', 'run', 'verify']]);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('dirty script');
});
