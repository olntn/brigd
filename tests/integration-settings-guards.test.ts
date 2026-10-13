import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { AppError, Store, runFence } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import type { RunStatus } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const checks = [[process.execPath, '-e', 'process.exit(0)']];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-check-settings-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')) });
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
function missingConfiguration(action: () => unknown) {
  try { action(); throw new Error('Expected a configuration error'); }
  catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(409);
    expect((error as Error).message).toContain('BRIGD_INTEGRATION_CHECKS');
  }
}
function rowCount(table: 'runs' | 'execution_requests' | 'integrations') {
  return (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
async function legacyRun(status: Exclude<RunStatus, 'running'>) {
  // Saved worktrees from older versions must also pass the configuration gate.
  const task = store.createTask(taskInput(root));
  const run = store.startManual(task.id, false);
  const provider = new GitWorkspaces(join(folder, 'workspaces'), checks);
  const location = provider.locate(run);
  store.enqueueExecution(run, location);
  const preparing = store.claimExecution(store.pendingExecutions()[0]!, 1)!;
  const workspace = provider.plan(preparing, location);
  store.attachWorkspace(run.id, runFence(preparing), workspace);
  await provider.prepare(workspace); store.beginExecution(run.id, runFence(preparing));
  store.setSession(run.id, 'legacy-session');
  store.finish(run.id, status, 'Saved result', status === 'failed' ? 'Old failure' : null);
  store.settleExecution(run.id, run.turn);
  return store.getRun(run.id);
}

test('manual launch without commands leaves no run, queue request or worktree', () => {
  const task = store.createTask(taskInput(root));
  missingConfiguration(() => engine.start(task.id));
  expect(store.detail(task.id).runs).toHaveLength(0);
  expect(rowCount('execution_requests')).toBe(0);
  expect(rowCount('integrations')).toBe(0);
  expect(existsSync(join(folder, 'workspaces'))).toBe(false);
  expect(agent.calls).toHaveLength(0);
});

test('scheduler preserves a due occurrence until commands are saved', async () => {
  const due = Date.now();
  const task = store.createTask(taskInput(root, { schedule: 'interval', intervalMinutes: 1, firstRunAt: due }));
  engine.tick(due + 3 * 60_000);
  expect(store.getTask(task.id).nextRunAt).toBe(due);
  expect(store.detail(task.id).runs).toHaveLength(0);
  expect(agent.calls).toHaveLength(0);
  engine.setAutopilotSettings({ integrationChecks: checks });
  engine.tick(due + 3 * 60_000);
  await until(() => agent.calls.length === 1);
  expect(store.detail(task.id).runs).toHaveLength(1);
  expect(store.detail(task.id).runs[0]).toMatchObject({ trigger: 'schedule', scheduledFor: due + 3 * 60_000 });
});

test('autopilot cannot enable or consume its pool until commands are saved', async () => {
  const task = store.createTask(taskInput(root, { schedule: 'auto' }));
  missingConfiguration(() => engine.setAutopilot({ enabled: true, until: null }));
  engine.tick();
  expect(store.getAutopilot().enabled).toBe(false);
  expect(store.detail(task.id).runs).toHaveLength(0);
  expect(agent.calls).toHaveLength(0);
  engine.setAutopilotSettings({ integrationChecks: checks });
  engine.setAutopilot({ enabled: true, until: null });
  await until(() => agent.calls.length === 1);
  expect(store.detail(task.id).runs[0]).toMatchObject({ trigger: 'autopilot', status: 'running' });
  missingConfiguration(() => engine.setAutopilotSettings({ integrationChecks: null }));
  expect(engine.getAutopilotSettings().integrationChecks).toEqual(checks);
});

test('saving commands enables launch and changing them updates integration without restart', async () => {
  const firstMarker = join(folder, 'first-check'), currentMarker = join(folder, 'current-check');
  const command = (path: string) => [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'checked')`]];
  engine.setAutopilotSettings({ integrationChecks: command(firstMarker) });
  const task = store.createTask(taskInput(root));
  const run = engine.start(task.id);
  await until(() => agent.calls.length === 1);
  expect(store.getRun(run.id).workspace!.checkCommands).toEqual(command(firstMarker));
  writeFileSync(join(agent.calls[0]!.input.cwd, 'src/value.txt'), 'updated result\n');
  missingConfiguration(() => engine.setAutopilotSettings({ integrationChecks: null }));
  engine.setAutopilotSettings({ integrationChecks: command(currentMarker) });
  agent.calls[0]!.resolve(outcome());
  await until(() => store.integrationForRun(run.id)?.status === 'merged');
  expect(store.getRun(run.id).workspace!.checkCommands).toEqual(command(firstMarker));
  expect(existsSync(firstMarker)).toBe(false);
  expect(readFileSync(currentMarker, 'utf8')).toBe('checked');
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('updated result\n');
  expect(engine.setAutopilotSettings({ integrationChecks: null })).toEqual({ integrationChecks: null, source: null });
});

test.each(['resume', 'retry', 'followup', 'integrate', 'reconcile'] as const)('%s refuses saved work before mutating state or spawning processes', async action => {
  const source = await legacyRun(action === 'resume' ? 'waiting_input' : action === 'retry' ? 'failed' : 'completed');
  if (action === 'reconcile') {
    const job = store.queueIntegration(source.id)!;
    store.updateIntegration(job.id, job.attempt, { status: 'conflict', conflicts: ['src/value.txt'], targetCommit: git(root, 'rev-parse', 'HEAD') }, true);
  }
  const before = store.detail(source.taskId), integration = store.integrationForRun(source.id);
  const queueRows = rowCount('execution_requests');
  missingConfiguration(() => {
    if (action === 'resume') return engine.resume(source.id, 'Continue', false);
    if (action === 'retry') return engine.retry(source.id);
    if (action === 'followup') return engine.followup(source.taskId, { sourceRunId: source.id, sourceStepIndex: null, body: 'Continue', attachmentIds: [], requestId: crypto.randomUUID() });
    if (action === 'integrate') return engine.integrate(source.id);
    return engine.reconcile(source.id);
  });
  expect(store.detail(source.taskId)).toEqual(before);
  expect(store.integrationForRun(source.id)).toEqual(integration);
  expect(rowCount('execution_requests')).toBe(queueRows);
  expect(agent.calls).toHaveLength(0);
});

test('pending saved execution and integration remain queued without configured commands', async () => {
  const source = await legacyRun('completed');
  store.queueIntegration(source.id);
  const task = store.createTask(taskInput(repository(folder, 'another')));
  const queued = store.startManual(task.id, false);
  const provider = new GitWorkspaces(join(folder, 'workspaces'));
  store.enqueueExecution(queued, provider.locate(queued));
  engine.startScheduler();
  await Bun.sleep(30);
  expect(store.getRun(queued.id).status).toBe('queued');
  expect(store.integrationForRun(source.id)?.status).toBe('queued');
  expect(agent.calls).toHaveLength(0);
  expect(rowCount('runs')).toBe(2);
});

test('waiting exact sessions prevent clearing the last configured commands', async () => {
  const source = await legacyRun('waiting_input');
  engine.setAutopilotSettings({ integrationChecks: checks });
  missingConfiguration(() => engine.setAutopilotSettings({ integrationChecks: null }));
  expect(store.getRun(source.id).status).toBe('waiting_input');
  expect(engine.getAutopilotSettings()).toEqual({ integrationChecks: checks, source: 'settings' });
});

test('environment commands stay available when the saved override is cleared', async () => {
  await engine.shutdown();
  engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks });
  const override = [[process.execPath, '-e', 'process.exit(3)']];
  expect(engine.getAutopilotSettings()).toEqual({ integrationChecks: checks, source: 'environment' });
  engine.setAutopilotSettings({ integrationChecks: override });
  expect(engine.getAutopilotSettings()).toEqual({ integrationChecks: override, source: 'settings' });
  const run = engine.start(store.createTask(taskInput(root)).id);
  await until(() => agent.calls.length === 1);
  expect(engine.setAutopilotSettings({ integrationChecks: null })).toEqual({ integrationChecks: checks, source: 'environment' });
  expect(store.getRun(run.id).status).toBe('running');
});
