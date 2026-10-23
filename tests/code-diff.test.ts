import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import type { RunCodeDiff } from '../src/lib/code-diff';
import type { Run } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const checks = [[process.execPath, '-e', 'process.exit(0)']];
const integrator = { execute: async () => ({ status: 'blocked' as const, error: 'Test retains uncommitted worktree.' }),
  prepareReconcile: async () => { throw new Error('Not used in this fixture'); } };
const options = () => ({ workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks), integrationChecks: checks, integrator });
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-code-diff-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, options());
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
async function start() {
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length > 0 && store.getRun(run.id).status === 'running');
  return store.getRun(run.id);
}
async function finish(run: Run, session = 'diff-session') {
  agent.calls.find(call => call.input.sessionId === run.sessionId || call.input.workspace?.id === run.workspace!.id)!.resolve(outcome(session));
  await until(() => store.getRun(run.id).status === 'completed' && store.integrationForRun(run.id)?.status === 'blocked');
}
function request(runId: string, headers: Record<string, string> = {}) {
  return createHandler(engine, { port: 4310, root: folder })(new Request(`http://127.0.0.1:4310/api/runs/${runId}/diff`, { headers }));
}
async function diff(runId: string): Promise<RunCodeDiff> {
  const response = await request(runId);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}

test('live diff includes committed, staged, unstaged, deleted, and untracked files without modifying the index', async () => {
  writeFileSync(join(root, 'delete.txt'), 'remove me\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'deletion fixture');
  const run = await start(), cwd = run.workspace!.path;
  writeFileSync(join(cwd, 'committed.ts'), 'export const value = 1;\n'); git(cwd, 'add', 'committed.ts'); git(cwd, 'commit', '-m', 'agent commit');
  writeFileSync(join(cwd, 'staged.ts'), 'export const staged = true;\n'); git(cwd, 'add', 'staged.ts');
  writeFileSync(join(cwd, 'src/value.txt'), 'changed\nsecond\n'); rmSync(join(cwd, 'delete.txt'));
  writeFileSync(join(cwd, 'new.ts'), 'export const draft = true;\n');
  mkdirSync(join(cwd, '.brigd-outbox-run')); writeFileSync(join(cwd, '.brigd-outbox-run', 'private.txt'), 'private artifact');
  writeFileSync(join(root, 'other-task.ts'), 'not this worktree\n');
  const index = git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  const before = readFileSync(index);
  const result = await diff(run.id);
  expect(result).toMatchObject({ state: 'available', live: true, additions: 5, deletions: 2, truncated: false, filesOmitted: false });
  expect(result.files.map(file => file.path)).toEqual(['committed.ts', 'delete.txt', 'new.ts', 'src/value.txt', 'staged.ts']);
  expect(result.files.find(file => file.path === 'src/value.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
  expect(result.files.find(file => file.path === 'delete.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
  expect(result.files.find(file => file.path === 'src/value.txt')!.patch).toContain('-base\n+changed\n+second');
  expect(readFileSync(index).equals(before)).toBe(true);
});

test('a clean verified worktree has an available empty diff', async () => {
  const run = await start();
  expect(await diff(run.id)).toMatchObject({ state: 'available', files: [], additions: 0, deletions: 0, truncated: false, live: true });
});

test('staged renames preserve both the removed and added paths', async () => {
  const run = await start(), cwd = run.workspace!.path;
  git(cwd, 'mv', 'src/value.txt', 'src/renamed.txt');
  const result = await diff(run.id);
  expect(result.files.map(file => [file.path, file.status])).toEqual([['src/renamed.txt', 'added'], ['src/value.txt', 'deleted']]);
});

test('large source and lock files are shown in full; only binary and huge files omit code', async () => {
  const run = await start(), cwd = run.workspace!.path;
  writeFileSync(join(cwd, 'binary.bin'), Buffer.from([1, 0, 2]));
  writeFileSync(join(cwd, 'long-line.ts'), 'x'.repeat(300_000));
  writeFileSync(join(cwd, 'many-lines.ts'), 'const a = 1;\n'.repeat(10_000));
  writeFileSync(join(cwd, 'committed.lock'), 'dependency\n'.repeat(20_000)); git(cwd, 'add', 'committed.lock'); git(cwd, 'commit', '-m', 'lock file');
  writeFileSync(join(cwd, 'huge.log'), 'y'.repeat(5 * 1024 * 1024));
  const result = await diff(run.id);
  expect(result).toMatchObject({ truncated: true, filesOmitted: false });
  expect(result.files.find(file => file.path === 'binary.bin')).toMatchObject({ binary: true, patch: '', truncated: false });
  expect(result.files.find(file => file.path === 'long-line.ts')).toMatchObject({ truncated: false, additions: 1 });
  expect(result.files.find(file => file.path === 'long-line.ts')!.patch).toContain('x'.repeat(300_000));
  const manyLines = result.files.find(file => file.path === 'many-lines.ts')!;
  expect(manyLines).toMatchObject({ truncated: false, additions: 10_000 });
  expect(manyLines.patch.split('\n').filter(line => line === '+const a = 1;')).toHaveLength(10_000);
  expect(result.files.find(file => file.path === 'committed.lock')).toMatchObject({ truncated: false, additions: 20_000 });
  expect(result.files.find(file => file.path === 'huge.log')).toMatchObject({ truncated: true, patch: '' });
});

test('committed files are read from Git objects with their exact contents', async () => {
  const run = await start(), cwd = run.workspace!.path;
  writeFileSync(join(cwd, 'src/value.txt'), 'committed change\n');
  writeFileSync(join(cwd, 'empty.txt'), '');
  writeFileSync(join(cwd, 'binary.bin'), Buffer.from([0, 10, 10, 0]));
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'agent commit');
  const result = await diff(run.id);
  expect(result.files.map(file => [file.path, file.status])).toEqual([['binary.bin', 'added'], ['empty.txt', 'added'], ['src/value.txt', 'modified']]);
  expect(result.files.find(file => file.path === 'binary.bin')).toMatchObject({ binary: true, truncated: false });
  expect(result.files.find(file => file.path === 'empty.txt')).toMatchObject({ truncated: false, additions: 0 });
  expect(result.files.find(file => file.path === 'src/value.txt')!.patch).toContain('-base\n+committed change');
});

test('whole-file additions and deletions match Git hunks without spawning a diff per file', async () => {
  const contents: Record<string, string> = { 'lines.txt': 'a\nb\n', 'no-newline.txt': 'a\nb', 'single.txt': 'a', 'blank.txt': '\n\n',
    'crlf.txt': 'x\r\ny\r\n', 'unicode.txt': 'Привет, мир\n', 'empty.txt': '' };
  const hunks = (file: string) => {
    const raw = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', file], { stdout: 'pipe' }).stdout.toString();
    return raw.indexOf('\n@@') < 0 ? '' : raw.slice(raw.indexOf('\n@@') + 1);
  };
  for (const [name, text] of Object.entries(contents)) writeFileSync(join(root, `old-${name}`), text);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'deletion fixtures');
  const run = await start(), cwd = run.workspace!.path;
  for (const [name, text] of Object.entries(contents)) { writeFileSync(join(cwd, `new-${name}`), text); rmSync(join(cwd, `old-${name}`)); }
  const result = await diff(run.id);
  for (const name of Object.keys(contents)) {
    const expected = hunks(join(cwd, `new-${name}`));
    const added = result.files.find(file => file.path === `new-${name}`)!, deleted = result.files.find(file => file.path === `old-${name}`)!;
    expect(added.patch.slice(added.patch.indexOf('+++ ')).split('\n').slice(1).join('\n')).toBe(expected);
    expect(deleted.patch.slice(deleted.patch.indexOf('+++ ')).split('\n').slice(1).join('\n'))
      .toBe(expected.replace(/^@@ -0,0 \+(\S+) @@/, '@@ -$1 +0,0 @@').replace(/^\+/gm, '-'));
    expect(added.additions).toBe(deleted.deletions);
  }
  expect(result.files.find(file => file.path === 'new-lines.txt')).toMatchObject({ status: 'added', additions: 2 });
});

test('file listing is capped only for an extreme number of changed paths', async () => {
  const run = await start();
  for (let i = 0; i < 1005; i++) writeFileSync(join(run.workspace!.path, `file-${String(i).padStart(4, '0')}.ts`), 'new\n');
  const result = await diff(run.id);
  expect(result).toMatchObject({ state: 'available', truncated: true, filesOmitted: true });
  expect(result.files.length).toBe(1000);
});

test('completed history stays frozen and a followup compares against its own dirty starting point', async () => {
  const run = await start(), cwd = run.workspace!.path;
  writeFileSync(join(cwd, 'src/value.txt'), 'first result\n'); writeFileSync(join(cwd, 'new.ts'), 'first new file\n');
  await finish(run);
  const first = await diff(run.id);
  expect(first.live).toBe(false);
  const followup = engine.followup(run.taskId, { sourceRunId: run.id, sourceStepIndex: null, body: 'Revise the result.', attachmentIds: [], requestId: crypto.randomUUID() });
  await until(() => agent.calls.length === 2);
  expect(await diff(followup.id)).toMatchObject({ state: 'available', files: [], live: true });
  writeFileSync(join(cwd, 'src/value.txt'), 'second result\n');
  const next = await diff(followup.id);
  expect(next.files.map(file => file.path)).toEqual(['src/value.txt']);
  expect(next.files[0]!.patch).toContain('-first result\n+second result');
  expect(await diff(run.id)).toEqual(first);
});

test('frozen diffs survive restart and removal of the task worktree', async () => {
  const run = await start(); writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'persisted\n'); await finish(run);
  const before = await diff(run.id);
  await engine.shutdown(); store.close(); rmSync(run.workspace!.path, { recursive: true, force: true });
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent(); engine = new Engine(store, false, agent.factory, undefined, options());
  expect(await diff(run.id)).toEqual(before);
});

test('unsafe worktree symlink parents are refused without reading outside the task', async () => {
  const run = await start(), cwd = run.workspace!.path, outside = join(folder, 'outside');
  mkdirSync(outside); writeFileSync(join(outside, 'value.txt'), 'private external content\n');
  renameSync(join(cwd, 'src'), join(cwd, 'old-src')); symlinkSync(outside, join(cwd, 'src'));
  const result = await diff(run.id);
  expect(result.state).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('private external content');
});

test('a tracked file replaced by a FIFO cannot block diff reads', async () => {
  const run = await start(), file = join(run.workspace!.path, 'src/value.txt');
  rmSync(file);
  expect(Bun.spawnSync(['mkfifo', file]).exitCode).toBe(0);
  const result = await diff(run.id);
  expect(result).toMatchObject({ state: 'available', truncated: true });
  expect(result.files[0]).toMatchObject({ path: 'src/value.txt', truncated: true, patch: '' });
});

test('an unavailable initial baseline stays unavailable when a later turn becomes readable', async () => {
  const run = await start(), cwd = run.workspace!.path;
  writeFileSync(join(cwd, 'oversized.ts'), 'x'.repeat(5 * 1024 * 1024)); await finish(run);
  const followup = engine.followup(run.taskId, { sourceRunId: run.id, sourceStepIndex: null, body: 'Update the large file.', attachmentIds: [], requestId: crypto.randomUUID() });
  await until(() => agent.calls.length === 2);
  const initial = await diff(followup.id);
  expect(initial.state).toBe('unavailable');
  agent.calls[1]!.resolve(outcome('diff-session', 'needs_input'));
  await until(() => store.getRun(followup.id).status === 'waiting_input');
  writeFileSync(join(cwd, 'oversized.ts'), 'small now\n');
  engine.resume(followup.id, 'Continue.', false);
  await until(() => agent.calls.length === 3);
  expect(await diff(followup.id)).toEqual(initial);
});

test('external diff, textconv, and fsmonitor commands never run while displaying a diff', async () => {
  const run = await start(), cwd = run.workspace!.path, marker = join(folder, 'unsafe-command-ran');
  const helper = join(folder, 'unsafe-helper'); writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(cwd, 'config', 'diff.external', helper); git(cwd, 'config', 'diff.custom.textconv', helper); git(cwd, 'config', 'core.fsmonitor', helper);
  writeFileSync(join(cwd, '.gitattributes'), '*.txt diff=custom\n'); writeFileSync(join(cwd, 'src/value.txt'), 'new text\n');
  expect((await diff(run.id)).state).toBe('available');
  expect(existsSync(marker)).toBe(false);
  // Cleanup invokes the ordinary integrator/workspace helpers, which are outside this viewer assertion.
  git(cwd, 'config', '--unset', 'core.fsmonitor');
});

test('unusual filenames remain literal and cannot be interpreted as pathspecs', async () => {
  const run = await start(), name = '[:literal] $value\tline\n.ts';
  writeFileSync(join(run.workspace!.path, name), 'literal content\n');
  const result = await diff(run.id);
  expect(result.files).toHaveLength(1); expect(result.files[0]!.path).toBe(name);
  expect(result.files[0]!.patch).toContain('+literal content');
});

test('mock and unverified direct runs return explicit unavailable responses; unknown runs remain 404', async () => {
  await engine.shutdown(); engine = new Engine(store, true, agent.factory);
  const run = engine.start(store.createTask(taskInput(root)).id);
  expect(await diff(run.id)).toMatchObject({ state: 'unavailable', files: [], live: false });
  expect((await request('unknown-run')).status).toBe(404);
  expect((await request(run.id, { origin: 'http://evil.invalid' })).status).toBe(403);
  agent.calls[0]!.resolve(outcome());
  await until(() => store.getRun(run.id).status === 'completed');
  await engine.shutdown(); engine = new Engine(store, false, agent.factory);
  const direct = engine.start(store.createTask(taskInput(root)).id);
  expect(await diff(direct.id)).toMatchObject({ state: 'unavailable', files: [], reason: 'Для этого запуска нет подтверждённого Git worktree.' });
});

test('legacy completed runs use frozen integration commits even after their worktree disappears', async () => {
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks), integrationChecks: checks });
  const run = await start(); writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'legacy result\n');
  agent.calls[0]!.resolve(outcome());
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
  store.db.query('DELETE FROM run_code_diffs WHERE run_id=?').run(run.id);
  rmSync(run.workspace!.path, { recursive: true, force: true });
  writeFileSync(join(root, 'src/value.txt'), 'later unrelated target content\n');
  const result = await diff(run.id);
  expect(result).toMatchObject({ state: 'available', live: false });
  expect(result.files[0]!.patch).toContain('-base\n+legacy result');
  expect(JSON.stringify(result)).not.toContain('later unrelated');
  expect(await diff(run.id)).toEqual(result);
  store.startFollowup(run.taskId, { sourceRunId: run.id, sourceStepIndex: null, body: 'A later shared-worktree turn.', attachmentIds: [], requestId: crypto.randomUUID() });
  expect(await diff(run.id)).toEqual(result);
  const integration = store.integrationForRun(run.id)!;
  integration.attempt = 2;
  store.db.query('UPDATE integrations SET attempt=?,snapshot=? WHERE run_id=?').run(2, JSON.stringify(integration), run.id);
  expect((await diff(run.id)).state).toBe('unavailable');
});
