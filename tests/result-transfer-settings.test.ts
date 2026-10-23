import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from '../server/backups';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import type { Run } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

const checks = [[process.execPath, '-e', 'process.exit(0)']];
let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-result-transfer-'));
  root = repository(folder);
  store = new Store(join(folder, 'app.sqlite'));
  agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, {
    workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks, maxParallel: 4,
  });
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
async function start() {
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => store.getRun(run.id).status === 'running');
  return store.getRun(run.id);
}
async function complete(run: Run, expected = 'awaiting_manual') {
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'worker result\n');
  [...agent.calls].reverse().find(call => call.input.workspace?.id === run.workspace!.id)!.resolve(outcome());
  await until(() => store.integrationForRun(run.id)?.status === expected);
  return store.integrationForRun(run.id)!;
}
function editTarget() {
  writeFileSync(join(root, 'src/value.txt'), 'target conflict\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'target edit');
  return git(root, 'rev-parse', 'HEAD');
}

test('settings default to automatic / continue, validate partial patches and survive reopening and backup', () => {
  expect(engine.getResultTransferSettings()).toEqual({ mode: 'automatic', manualWait: 'continue' });
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  for (const value of [{}, { other: true }, { mode: null }, { manualWait: true }, { mode: 'auto' }, { manualWait: 'wait', extra: 1 }]) {
    expect(() => engine.setResultTransferSettings(value)).toThrow(AppError);
    expect(engine.getResultTransferSettings()).toEqual({ mode: 'manual', manualWait: 'wait' });
  }
  const backups = new BackupManager({ dbPath: join(folder, 'app.sqlite'), updateBackupDir: join(folder, 'updates') });
  const backup = backups.create();
  const snapshot = new Store(backups.download(backup.id).path);
  try { expect(snapshot.getResultTransferSettings()).toEqual({ mode: 'manual', manualWait: 'wait' }); }
  finally { snapshot.close(); }
  engine.setResultTransferSettings({ mode: 'automatic' });
  const reopened = new Store(join(folder, 'app.sqlite'));
  try { expect(reopened.getResultTransferSettings()).toEqual({ mode: 'automatic', manualWait: 'wait' }); }
  finally { reopened.close(); }
});

test('HTTP reads and patches policy and exposes manual transfer actions', async () => {
  const handler = createHandler(engine, { port: 4310, root: folder });
  const request = (path: string, method = 'GET', body?: unknown) => handler(new Request('http://127.0.0.1:4310' + path, {
    method, headers: { origin: 'http://127.0.0.1:4310', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }));
  expect(await (await request('/api/settings/result-transfer')).json()).toEqual({ mode: 'automatic', manualWait: 'continue' });
  expect((await request('/api/settings/result-transfer', 'PATCH', { mode: 'invalid' })).status).toBe(400);
  expect(await (await request('/api/settings/result-transfer', 'PATCH', { mode: 'manual' })).json()).toEqual({ mode: 'manual', manualWait: 'continue' });
  const run = await start(); await complete(run);
  expect((await request(`/api/runs/${run.id}/skip-integration`, 'POST')).status).toBe(200);
  expect(store.integrationForRun(run.id)?.status).toBe('skipped');
  expect((await request(`/api/runs/${run.id}/integrate`, 'POST')).status).toBe(200);
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
});

test('default policy transfers results automatically, even when manualWait is wait', async () => {
  engine.setResultTransferSettings({ manualWait: 'wait' });
  const run = await start();
  await complete(run, 'merged');
  expect(store.getTask(run.taskId).status).toBe('completed');
  expect(git(root, 'show', 'HEAD:src/value.txt')).toBe('worker result');
});

test('manual mode saves the usual result commit, excludes artifacts and lets new work start from the current target', async () => {
  engine.setResultTransferSettings({ mode: 'manual' });
  const target = git(root, 'rev-parse', 'HEAD');
  const run = await start();
  mkdirSync(join(run.workspace!.path, '.brigd-outbox-secret'));
  writeFileSync(join(run.workspace!.path, '.brigd-outbox-secret/secret.txt'), 'private');
  const job = await complete(run);
  expect(job).toMatchObject({ attempt: 0, checks: [], resultCommit: null, targetCommit: null, error: null });
  expect(store.getTask(run.taskId).status).toBe('awaiting_manual_transfer');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
  expect(git(root, 'log', '-1', '--format=%B', run.workspace!.branch!)).toBe(`brigd: Isolated work\n\nBrigd-Run: ${run.id}`);
  expect(git(root, 'ls-tree', '-r', '--name-only', job.sourceCommit!)).not.toContain('.brigd-outbox');
  const next = await start();
  expect(next.workspace!.baseCommit).toBe(target);
  expect(git(next.workspace!.path, 'show', 'HEAD:src/value.txt')).toBe('base');
  engine.integrate(run.id);
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
  expect(store.integrationForRun(run.id)?.checks[0]?.exitCode).toBe(0);
});

test.each(['skip', 'transfer'] as const)('wait policy holds repository requests until %s, preserving the branch on skip', async action => {
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  const target = git(root, 'rev-parse', 'HEAD');
  const run = await start(); const job = await complete(run);
  const next = engine.start(store.createTask(taskInput(root)).id);
  await Bun.sleep(30);
  expect(store.getRun(next.id).status).toBe('queued');
  expect(store.getTask(next.taskId).launchWaitReason).toContain('ручного переноса');
  if (action === 'skip') {
    engine.skipIntegration(run.id);
    expect(store.integrationForRun(run.id)?.status).toBe('skipped');
    expect(store.getTask(run.taskId).status).toBe('completed');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(root, 'rev-parse', run.workspace!.branch!)).toBe(job.sourceCommit!);
    engine.skipIntegration(run.id); // Idempotent release.
  } else engine.integrate(run.id);
  await until(() => store.getRun(next.id).status === 'running');
  expect(store.getTask(next.taskId).launchWaitReason).toBeUndefined();
  if (action === 'skip') {
    engine.integrate(run.id);
    await until(() => store.integrationForRun(run.id)?.status === 'merged');
  }
});

test('a result uses completion-time settings, and toggles never enqueue waiting results', async () => {
  const run = await start();
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  await complete(run);
  const next = engine.start(store.createTask(taskInput(root)).id);
  expect(store.getRun(next.id).status).toBe('queued');
  engine.setResultTransferSettings({ manualWait: 'continue' });
  await until(() => store.getRun(next.id).status === 'running');
  engine.setResultTransferSettings({ mode: 'automatic', manualWait: 'wait' });
  expect(store.integrationForRun(run.id)?.status).toBe('awaiting_manual');
  const third = engine.start(store.createTask(taskInput(root)).id);
  expect(store.getRun(third.id).status).toBe('queued'); // Per-repository capacity still applies.
  await complete(store.getRun(next.id), 'merged');
  await until(() => store.getRun(third.id).status === 'running');
  expect(store.integrationForRun(run.id)?.status).toBe('awaiting_manual');
});

test('already queued and active transfers continue when switched to manual mode', async () => {
  engine.setConcurrencySettings({ maxParallel: 1 });
  const otherRoot = repository(folder, 'other');
  const blocker = engine.start(store.createTask(taskInput(otherRoot)).id);
  await until(() => store.getRun(blocker.id).status === 'running');
  const run = store.startManual(store.createTask(taskInput(root)).id, false);
  // Queue a saved result while another repository owns the only process slot.
  const workspaces = new GitWorkspaces(join(folder, 'workspaces'));
  const workspace = workspaces.plan(run, workspaces.locate(run));
  await workspaces.prepare(workspace);
  store.db.query('INSERT INTO workspaces (id,snapshot) VALUES (?,?)').run(workspace.id, JSON.stringify({ ...workspace, prepared: true }));
  store.db.query('UPDATE runs SET workspace_id=? WHERE id=?').run(workspace.id, run.id);
  store.finish(run.id, 'completed', 'ready', null);
  store.queueIntegration(run.id);
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  expect(store.integrationForRun(run.id)?.status).toBe('queued');
  agent.calls[0]!.resolve(outcome());
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
});

test('an externally merged manual result is marked merged without creating another commit', async () => {
  engine.setResultTransferSettings({ mode: 'manual' });
  const run = await start(); await complete(run);
  git(root, 'merge', '--no-ff', '-m', 'human merge', run.workspace!.branch!);
  const target = git(root, 'rev-parse', 'HEAD');
  engine.integrate(run.id);
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
  expect(store.integrationForRun(run.id)).toMatchObject({ checks: [], resultCommit: target });
});

test('manual transfer runs conflict reconciliation even while another result holds the repository', async () => {
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  engine.setConcurrencySettings({ maxPerRepository: 2 });
  const run = await start(), waiting = await start();
  await complete(waiting);
  const target = editTarget(); await complete(run);
  expect(agent.calls).toHaveLength(2);
  engine.integrate(run.id);
  await until(() => agent.calls.length === 3);
  const reconcile = store.getTask(run.taskId).latestRun!;
  expect(reconcile.trigger).toBe('reconcile');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
  writeFileSync(join(reconcile.workspace!.path, 'src/value.txt'), 'resolved\n');
  agent.calls[2]!.resolve(outcome('integrator-session'));
  await until(() => store.integrationForRun(reconcile.id)?.status === 'merged');
  expect(git(root, 'show', 'HEAD:src/value.txt')).toBe('resolved');
  expect(store.integrationForRun(reconcile.id)?.checks[0]?.exitCode).toBe(0);
  expect(store.integrationForRun(waiting.id)?.status).toBe('awaiting_manual');
});

test('a failed manual check returns and transfers automatically while another result waits', async () => {
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  engine.setConcurrencySettings({ maxPerRepository: 2 });
  engine.setAutopilotSettings({ integrationChecks: [[process.execPath, '-e', "if (require('node:fs').readFileSync('src/value.txt','utf8').includes('worker')) process.exit(9)"]] });
  const run = await start(), waiting = await start();
  await complete(waiting); await complete(run);
  engine.integrate(run.id);
  await until(() => agent.calls.length === 3);
  const handback = store.getTask(run.taskId).latestRun!;
  expect(handback.followup?.checkFailure).toBeDefined();
  writeFileSync(join(handback.workspace!.path, 'src/value.txt'), 'corrected\n');
  agent.calls[2]!.resolve(outcome());
  await until(() => store.integrationForRun(handback.id)?.status === 'merged');
  expect(git(root, 'show', 'HEAD:src/value.txt')).toBe('corrected');
});

test('an ordinary follow-up creates another manual result', async () => {
  engine.setResultTransferSettings({ mode: 'manual' });
  const run = await start(); await complete(run); engine.skipIntegration(run.id);
  const followup = engine.followup(run.taskId, { sourceRunId: run.id, sourceStepIndex: null, body: 'Refine this', attachmentIds: [], requestId: crypto.randomUUID() });
  await until(() => agent.calls.length === 2);
  const next = store.getRun(followup.id);
  await complete(next);
  expect(store.getTask(run.taskId).status).toBe('awaiting_manual_transfer');
});

test.each(['continue', 'wait'] as const)('autopilot follows manual waiting policy %s without counting failures', async manualWait => {
  engine.setResultTransferSettings({ mode: 'manual', manualWait });
  const first = store.createTask(taskInput(root, { schedule: 'auto' }));
  const second = store.createTask(taskInput(root, { schedule: 'auto' }));
  engine.setAutopilot({ enabled: true, until: null });
  await until(() => agent.calls.length === 1);
  const run = store.getTask(first.id).latestRun!;
  await complete(run);
  engine.tick();
  expect(store.getAutopilot()).toMatchObject({ enabled: true, failures: 0 });
  if (manualWait === 'wait') {
    expect(store.getTask(second.id).latestRun).toBeNull();
    expect(engine.autopilotOverview().pool[0]?.launchWaitReason).toContain('ручного переноса');
    engine.skipIntegration(run.id); engine.tick();
  }
  await until(() => agent.calls.length === 2);
  expect(store.getTask(second.id).latestRun?.workspace?.baseCommit).toBe(run.workspace!.baseCommit);
});

test('waiting and skipped result states survive restart without automatic integration', async () => {
  engine.setResultTransferSettings({ mode: 'manual' });
  const first = await start(); await complete(first);
  const second = await start(); await complete(second); engine.skipIntegration(second.id);
  await engine.shutdown(); store.close();
  store = new Store(join(folder, 'app.sqlite'));
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks });
  engine.startScheduler();
  expect(store.integrationForRun(first.id)?.status).toBe('awaiting_manual');
  expect(store.integrationForRun(second.id)?.status).toBe('skipped');
  expect(git(root, 'rev-parse', first.workspace!.branch!)).toBe(store.integrationForRun(first.id)!.sourceCommit!);
});

test('an active check keeps blocking new repository starts when mode changes to manual / continue', async () => {
  const marker = join(folder, 'check-started'), gate = join(folder, 'check-release');
  engine.setAutopilotSettings({ integrationChecks: [[process.execPath, '-e',
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'started'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.exit(0); } }, 10);`]] });
  const run = await start();
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'worker result\n');
  agent.calls[0]!.resolve(outcome());
  await until(() => existsSync(marker));
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'continue' });
  const next = engine.start(store.createTask(taskInput(root)).id);
  expect(store.getRun(next.id).status).toBe('queued');
  writeFileSync(gate, 'release');
  await until(() => store.getRun(next.id).status === 'running');
  expect(store.integrationForRun(run.id)?.status).toBe('merged');
});

test.skipIf(process.platform === 'win32')('cancelling a manual result save stops its Git hook and releases the execution slot', async () => {
  engine.setResultTransferSettings({ mode: 'manual' });
  const marker = join(folder, 'hook-started');
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);\n`);
  chmodSync(hook, 0o755);
  const run = await start();
  writeFileSync(join(run.workspace!.path, 'src/value.txt'), 'worker result\n');
  agent.calls[0]!.resolve(outcome());
  await until(() => existsSync(marker));
  engine.cancel(run.id);
  await until(() => store.getRun(run.id).status === 'cancelled');
  expect(store.integrationForRun(run.id)).toBeNull();
  const next = await start();
  expect(next.status).toBe('running');
});

test('manual waiting requests reserve no autopilot process slots for other repositories', async () => {
  engine.setResultTransferSettings({ mode: 'manual', manualWait: 'wait' });
  engine.setConcurrencySettings({ maxParallel: 1 });
  const run = await start(); await complete(run);
  const waiting = engine.start(store.createTask(taskInput(root)).id);
  expect(store.getRun(waiting.id).status).toBe('queued');
  const otherRoot = repository(folder, 'independent');
  const other = store.createTask(taskInput(otherRoot, { schedule: 'auto' }));
  engine.setAutopilot({ enabled: true, until: null });
  await until(() => store.getTask(other.id).latestRun?.status === 'running');
  expect(store.getRun(waiting.id).status).toBe('queued');
});
