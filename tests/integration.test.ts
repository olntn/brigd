import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { createHandler } from '../server/http';
import type { Run } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const command = (script: string) => [process.execPath, '-e', script];
const checks = [command('process.exit(0)')];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-integration-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks), maxParallel: 2 });
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
async function configure(argv: string[][], maxPerRepository = 1, autoReconcile = true) {
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces'), argv), maxParallel: 2, maxPerRepository, autoReconcile });
}
function conflictingTarget(content: string) {
  writeFileSync(join(root, 'src/value.txt'), content); git(root, 'add', '.'); git(root, 'commit', '-m', 'target edit');
  return git(root, 'rev-parse', 'HEAD');
}
async function start() {
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.some(call => call.input.workspace?.id === run.id));
  return store.getRun(run.id);
}
function complete(run: Run, content = 'worker result\n') {
  const call = agent.calls.find(call => call.input.workspace?.id === run.workspace!.id)!;
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), content);
  call.resolve(outcome());
}
async function settled(run: Run) {
  await until(() => !!store.integrationForRun(run.id) && !['queued', 'checking', 'merging', 'cancelling'].includes(store.integrationForRun(run.id)!.status));
  return store.integrationForRun(run.id)!;
}

test('combined candidate is checked before a clean target receives the saved result, excluding task artifacts', async () => {
  const marker = join(folder, 'checked');
  await configure([command(`const fs = require('node:fs'); if (fs.readFileSync('src/value.txt','utf8') !== 'worker result\\n' || fs.readFileSync('external.txt','utf8') !== 'external') process.exit(9); fs.writeFileSync(${JSON.stringify(marker)}, 'passed');`)]);
  const run = await start();
  writeFileSync(join(root, 'external.txt'), 'external'); git(root, 'add', '.'); git(root, 'commit', '-m', 'concurrent target change');
  const target = git(root, 'rev-parse', 'HEAD');
  const artifacts = join(run.workspace!.path, '.brigd-outbox-keep'); mkdirSync(artifacts); writeFileSync(join(artifacts, 'answer.txt'), 'private task result');
  complete(run);
  const integration = await settled(run);
  expect(integration.status).toBe('merged'); expect(existsSync(marker)).toBe(true);
  expect(integration.targetCommit).toBe(target); expect(integration.checks[0]?.exitCode).toBe(0);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(integration.resultCommit!);
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('worker result\n');
  expect(git(root, 'ls-files')).not.toContain('.brigd-outbox'); expect(existsSync(join(artifacts, 'answer.txt'))).toBe(true);
  expect(store.getTask(run.taskId).status).toBe('completed');
  expect(store.getRun(run.id).workspace!.lastIntegratedCommit).toBe(integration.sourceCommit!);
});

test('failed checks preserve the target and retain the candidate with failure details', async () => {
  await configure([command('process.exit(7)')]);
  const run = await start(), original = git(root, 'rev-parse', 'HEAD'); complete(run);
  const integration = await settled(run);
  expect(integration.status).toBe('failed'); expect(integration.checks[0]?.exitCode).toBe(7);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(original); expect(existsSync(integration.candidatePath!)).toBe(true);
  expect(store.getTask(run.taskId).status).toBe('merge_failed');
});

test('a textual merge conflict is retained and does not advance the target', async () => {
  await configure(checks, 1, false);
  const run = await start();
  writeFileSync(join(root, 'src/value.txt'), 'conflicting target\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'target edit');
  const target = git(root, 'rev-parse', 'HEAD'); complete(run);
  const integration = await settled(run);
  expect(integration.status).toBe('conflict'); expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
  expect(git(integration.candidatePath!, 'ls-files', '-u')).not.toBe('');
  expect(store.getTask(run.taskId).status).toBe('merge_conflict');
});

test('a conflict is handed to the built-in integrator in the same worktree and its resolution becomes a checked merge commit', async () => {
  const run = await start();
  conflictingTarget('conflicting target\n'); complete(run);
  await until(() => agent.calls.length === 2);
  const call = agent.calls[1]!;
  expect(call.input).toMatchObject({ cwd: run.workspace!.cwd, provider: 'codex', instruction: 'Update the project.', reconcile: { targetBranch: 'main', conflicts: ['src/value.txt'], resultSummary: 'Synthetic result.' } });
  expect(call.input.sessionId).toBeUndefined(); expect(call.input.followup).toBeUndefined();
  const integrator = store.getTask(run.taskId).latestRun!;
  expect(integrator).toMatchObject({ trigger: 'reconcile', status: 'running', workerId: null, worker: { id: 'brigd-integrator', name: 'Интегратор', provider: 'codex', model: null },
    reconcile: { sourceRunId: run.id, targetBranch: 'main', conflicts: ['src/value.txt'], depth: 1 }, workspace: { id: run.workspace!.id } });
  expect(store.integrationForRun(run.id)).toMatchObject({ status: 'conflict', conflicts: ['src/value.txt'] });
  expect(store.integrationForRun(run.id)!.error).toContain('передан Интегратору');
  expect(readFileSync(join(run.workspace!.path, 'src/value.txt'), 'utf8')).toContain('<<<<<<<');
  expect(store.getTask(run.taskId).status).toBe('running');
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'resolved by integrator\n'); call.resolve(outcome('integrator-session'));
  const merged = await settled(integrator);
  expect(merged.status).toBe('merged'); expect(git(root, 'rev-parse', 'HEAD')).toBe(merged.resultCommit!);
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('resolved by integrator\n');
  expect(git(run.workspace!.path, 'log', '-1', '--format=%P', merged.sourceCommit!).split(' ')).toHaveLength(2);
  expect(git(run.workspace!.path, 'log', '-1', '--format=%s', merged.sourceCommit!)).toBe(`brigd: объединение main в brigd/run-${run.id}`);
  expect(store.getTask(run.taskId).status).toBe('completed'); expect(store.getRun(integrator.id).sessionId).toBe('integrator-session');
  expect(store.integrationForRun(run.id)!.status).toBe('conflict');
  // The integrator's saved session can be continued like any other completed run.
  const followup = engine.followup(run.taskId, { sourceRunId: integrator.id, sourceStepIndex: null, body: 'Keep the target version of the comment.', attachmentIds: [], requestId: crypto.randomUUID() });
  expect(followup).toMatchObject({ trigger: 'followup', workerId: null, worker: { id: 'brigd-integrator' }, sessionId: 'integrator-session' });
  await until(() => agent.calls.length === 3);
  expect(agent.calls[2]!.input).toMatchObject({ sessionId: 'integrator-session', cwd: run.workspace!.cwd });
});

test('manual mode keeps the conflict until the HTTP hand-over, which is refused while the integrator is busy or after success', async () => {
  await configure(checks, 1, false);
  const run = await start(); conflictingTarget('conflicting target\n'); complete(run);
  expect((await settled(run)).status).toBe('conflict'); await Bun.sleep(40); expect(agent.calls).toHaveLength(1);
  expect(store.getTask(run.taskId).status).toBe('merge_conflict');
  const handler = createHandler(engine, { port: 4310, root: folder, startedAt: 0 });
  const post = (action: string) => handler(new Request(`http://127.0.0.1:4310/api/runs/${run.id}/${action}`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' }, body: '{}' }));
  const created = await post('reconcile');
  expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ trigger: 'reconcile', reconcile: { sourceRunId: run.id } });
  await until(() => agent.calls.length === 2);
  expect((await post('reconcile')).status).toBe(409); expect((await post('integrate')).status).toBe(409);
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'resolved\n'); agent.calls[1]!.resolve(outcome('integrator-session'));
  await until(() => store.getTask(run.taskId).status === 'completed');
  expect((await post('reconcile')).status).toBe(409);
});

test('repeated conflicts stop after three reconciliations and leave the conflict to a human', async () => {
  const run = await start(); conflictingTarget('target 1\n'); complete(run);
  let latest = run;
  for (let depth = 1; depth <= 3; depth++) {
    await until(() => agent.calls.length === depth + 1);
    latest = store.detail(run.taskId).runs.find(candidate => candidate.reconcile?.depth === depth)!;
    expect(latest.reconcile!.sourceRunId).toBe(depth === 1 ? run.id : store.detail(run.taskId).runs.find(candidate => candidate.reconcile?.depth === depth - 1)!.id);
    expect(store.getTask(run.taskId).latestRun!.id).toBe(latest.id);
    conflictingTarget(`target ${depth + 1}\n`);
    writeFileSync(join(latest.workspace!.path, 'src/value.txt'), `resolved ${depth}\n`); agent.calls[depth]!.resolve(outcome(`integrator-${depth}`));
    await settled(latest);
  }
  const last = store.integrationForRun(latest.id)!;
  expect(last.status).toBe('conflict'); expect(last.error).toContain('3 раза'); expect(agent.calls).toHaveLength(4);
  expect(store.getTask(run.taskId).status).toBe('merge_conflict'); expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('target 4\n');
  expect(() => engine.reconcile(latest.id)).toThrow('3 раза');
});

test('conflict markers left in the source worktree are reported as a conflict; a resolved merge is committed on retry without an agent', async () => {
  await configure(checks, 1, false);
  const run = await start(); const target = conflictingTarget('conflicting target\n'); complete(run);
  expect((await settled(run)).status).toBe('conflict');
  Bun.spawnSync(['git', '-C', run.workspace!.path, 'merge', 'main'], { stdout: 'ignore', stderr: 'ignore' });
  engine.integrate(run.id);
  const again = await settled(run);
  expect(again).toMatchObject({ status: 'conflict', attempt: 2, conflicts: ['src/value.txt'] }); expect(again.error).toContain('маркеры');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'by hand\n');
  engine.integrate(run.id);
  const merged = await settled(run);
  expect(merged.status).toBe('merged'); expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('by hand\n');
  expect(git(root, 'log', '-1', '--format=%P', merged.sourceCommit!).split(' ')).toHaveLength(2); expect(agent.calls).toHaveLength(1);
});

test('an integrator prepared after the target was repaired finishes without an agent and merges', async () => {
  await configure(checks, 1, false);
  const run = await start(); conflictingTarget('conflicting target\n'); complete(run);
  expect((await settled(run)).status).toBe('conflict');
  git(root, 'revert', '--no-edit', 'HEAD');
  const integrator = engine.reconcile(run.id);
  expect(integrator.trigger).toBe('reconcile');
  const merged = await settled(integrator);
  expect(merged.status).toBe('merged'); expect(agent.calls).toHaveLength(1);
  expect(store.getRun(integrator.id)).toMatchObject({ status: 'completed', sessionId: null });
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('worker result\n');
  expect(git(run.workspace!.path, 'status', '--porcelain')).toBe('');
});

test('dirty target files survive a blocked transfer and explicit retry rechecks before applying', async () => {
  const run = await start(); const original = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'user-draft.txt'), 'user draft'); complete(run);
  const blocked = await settled(run);
  expect(blocked.status).toBe('blocked'); expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
  expect(readFileSync(join(root, 'user-draft.txt'), 'utf8')).toBe('user draft');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'save user draft');
  engine.integrate(run.id);
  const merged = await settled(run);
  expect(merged.status).toBe('merged'); expect(merged.attempt).toBe(2);
  expect(readFileSync(join(root, 'user-draft.txt'), 'utf8')).toBe('user draft');
});

test('a target update during checks rebuilds the candidate and reruns checks against the new target', async () => {
  const entered = join(folder, 'entered'), release = join(folder, 'release'), count = join(folder, 'count');
  await configure([command(`const fs=require('node:fs'); const n=fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)},'utf8'))+1 : 1; fs.writeFileSync(${JSON.stringify(count)},String(n)); fs.writeFileSync(${JSON.stringify(entered)},'ready'); while(!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10); if(n>1 && !fs.existsSync('new-target.txt')) process.exit(4);`)]);
  const run = await start(); complete(run); await until(() => existsSync(entered));
  writeFileSync(join(root, 'new-target.txt'), 'new version'); git(root, 'add', '.'); git(root, 'commit', '-m', 'target advanced');
  const target = git(root, 'rev-parse', 'HEAD'); writeFileSync(release, 'continue');
  const merged = await settled(run);
  expect(merged.status).toBe('merged'); expect(merged.attempt).toBe(2); expect(merged.targetCommit).toBe(target);
  expect(readFileSync(count, 'utf8')).toBe('2'); expect(readFileSync(join(root, 'new-target.txt'), 'utf8')).toBe('new version');
});

test('checking processes can be cancelled while later repository work remains queued', async () => {
  const entered = join(folder, 'entered');
  await configure([command(`require('node:fs').writeFileSync(${JSON.stringify(entered)},'ready'); await Bun.sleep(60000);`)]);
  const run = await start(); complete(run); await until(() => existsSync(entered));
  const next = engine.start(store.createTask(taskInput(root)).id);
  expect(next.status).toBe('queued'); expect(engine.cancelIntegration(run.id).status).toBe('cancelling');
  expect(agent.calls).toHaveLength(1); await until(() => agent.calls.length === 2);
  expect(store.integrationForRun(run.id)!.status).toBe('cancelled');
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('base\n');
});

test('interrupted integration keeps its reservation across restart and requires acknowledgement to retry', async () => {
  const entered = join(folder, 'entered'), release = join(folder, 'release');
  await configure([command(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)},'ready'); while(!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`)]);
  const run = await start(); complete(run); await until(() => existsSync(entered));
  const next = engine.start(store.createTask(taskInput(root)).id);
  await engine.shutdown(); store.close(); store = new Store(join(folder, 'data.sqlite'));
  agent = controlledAgent(); engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks) });
  engine.startScheduler();
  expect(store.integrationForRun(run.id)!.status).toBe('interrupted'); expect(store.getTask(run.taskId).status).toBe('merge_interrupted');
  expect(store.getRun(next.id).status).toBe('queued'); expect(() => engine.integrate(run.id)).toThrow('подтвердите');
  const handler = createHandler(engine, { port: 4310, root: folder, startedAt: 0 });
  expect((await handler(new Request(`http://127.0.0.1:4310/api/runs/${run.id}/integrate`, {
    method: 'POST', headers: { origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' }, body: JSON.stringify({ acknowledgeInterruption: 'true' }),
  }))).status).toBe(409);
  writeFileSync(release, 'continue'); engine.integrate(run.id, true);
  expect((await settled(run)).status).toBe('merged'); await until(() => agent.calls.length === 1);
});

test('parallel independent runs have separate branches and their integrations are serialized and checked together', async () => {
  const count = join(folder, 'count');
  await configure([command(`const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(count)},JSON.stringify(fs.readdirSync('src'))+'\\n');`)], 2);
  const first = await start(), second = await start();
  expect(first.workspace!.path).not.toBe(second.workspace!.path); expect(first.workspace!.baseCommit).toBe(second.workspace!.baseCommit);
  writeFileSync(join(first.workspace!.path, 'src/first.txt'), 'one'); agent.calls[0]!.resolve(outcome('first'));
  await until(() => store.integrationForRun(first.id)?.status === 'queued');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(first.workspace!.baseCommit!);
  writeFileSync(join(second.workspace!.path, 'src/second.txt'), 'two'); agent.calls[1]!.resolve(outcome('second'));
  expect((await settled(first)).status).toBe('merged'); expect((await settled(second)).status).toBe('merged');
  expect(git(root, 'ls-files')).toContain('src/first.txt'); expect(git(root, 'ls-files')).toContain('src/second.txt');
  const observations = readFileSync(count, 'utf8').trim().split('\n').map(value => JSON.parse(value) as string[]);
  expect(observations).toHaveLength(2); expect(observations[1]).toContain('first.txt'); expect(observations[1]).toContain('second.txt');
});

test('checks that modify tracked files cannot cause untested code to be transferred', async () => {
  await configure([command("require('node:fs').writeFileSync('src/value.txt','unchecked change')")]);
  const run = await start(), original = git(root, 'rev-parse', 'HEAD'); complete(run);
  expect((await settled(run)).status).toBe('failed'); expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
});

test('source changes while the candidate is checked block transfer', async () => {
  const entered = join(folder, 'entered'), release = join(folder, 'release');
  await configure([command(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)},'ready'); while(!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`)]);
  const run = await start(), original = git(root, 'rev-parse', 'HEAD'); complete(run); await until(() => existsSync(entered));
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'changed after snapshot'); writeFileSync(release, 'continue');
  expect((await settled(run)).status).toBe('blocked'); expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
});

test('follow-up resumes the exact saved workspace and session, then merges only its new result', async () => {
  const run = await start(); complete(run); const first = await settled(run);
  expect(first.status).toBe('merged');
  const followup = engine.followup(run.taskId, { sourceRunId: run.id, sourceStepIndex: null, body: 'Add the second part.', attachmentIds: [], requestId: crypto.randomUUID() });
  await until(() => agent.calls.length === 2);
  expect(agent.calls[1]!.input).toMatchObject({ cwd: run.workspace!.cwd, sessionId: 'saved-session' });
  writeFileSync(join(run.workspace!.path, 'src/second.txt'), 'second part'); agent.calls[1]!.resolve(outcome());
  const second = await settled(followup);
  expect(second.status).toBe('merged'); expect(store.integrationForRun(run.id)!.resultCommit).toBe(first.resultCommit);
  expect(git(root, 'ls-files')).toContain('src/second.txt'); expect(git(root, 'merge-base', '--is-ancestor', first.resultCommit!, 'HEAD')).toBe('');
});

test('integration HTTP actions preserve origin controls and completed idempotence', async () => {
  const run = await start(); complete(run); await settled(run);
  const handler = createHandler(engine, { port: 4310, root: folder, startedAt: 0 });
  const origin = 'http://127.0.0.1:4310';
  const post = (action: string, requestOrigin = origin) => handler(new Request(`${origin}/api/runs/${run.id}/${action}`, {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: '{}',
  }));
  expect((await post('integrate', 'http://evil.invalid')).status).toBe(403);
  expect((await post('integrate')).status).toBe(200);
  expect((await post('cancel-integration')).status).toBe(409);
  const current = store.integrationForRun(run.id)!;
  expect(store.updateIntegration(current.id, current.attempt - 1, { status: 'failed' }, true)!.status).toBe('merged');
});

test('explicit operator checks can repair a saved run that originally had no detectable checks', async () => {
  await configure([]);
  const run = await start(), original = git(root, 'rev-parse', 'HEAD'); complete(run);
  expect((await settled(run)).status).toBe('blocked'); expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks });
  engine.integrate(run.id);
  expect((await settled(run)).status).toBe('merged');
});

test('detached starting HEAD preserves the source result but blocks transfer to an unnamed target', async () => {
  git(root, 'checkout', '--detach'); const run = await start(); complete(run);
  expect((await settled(run)).status).toBe('blocked'); expect(store.getRun(run.id).workspace!.targetBranch).toBeNull();
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('base\n');
});

test('an unchecked-out target is updated with a compare-and-swap while the current branch is preserved', async () => {
  const run = await start(); git(root, 'checkout', '-b', 'other'); const other = git(root, 'rev-parse', 'HEAD');
  complete(run); const integration = await settled(run);
  expect(integration.status).toBe('merged'); expect(git(root, 'rev-parse', 'main')).toBe(integration.resultCommit!);
  expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('other'); expect(git(root, 'rev-parse', 'HEAD')).toBe(other);
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('base\n');
});
