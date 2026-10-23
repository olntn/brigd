import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type EngineOptions } from '../server/engine';
import { Store } from '../server/store';
import { createHandler } from '../server/http';
import { GitWorkspaces } from '../server/workspaces';
import { buildPrompt } from '../server/adapter';
import { handbackOutput } from '../server/followups';
import { CHECK_HANDBACK_LIMIT, CHECK_HANDBACK_OUTPUT_LIMIT, passedOnRetry } from '../src/lib/check-triage';
import { translateServer } from '../src/lib/i18n';
import type { Integration, Run } from '../src/lib/types';
import { controlledAgent, git, outcome, repository, taskInput, until } from './repository-helpers';

let folder: string, root: string, store: Store, engine: Engine, agent: ReturnType<typeof controlledAgent>;
const command = (script: string) => [process.execPath, '-e', script];
const pass = command('process.exit(0)');
/** Fails on the worker's result and passes on the target branch alone: the task's own failure. */
const failsOnResult = command("const fs = require('node:fs'); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') { console.log('\\u001b[31mFAIL\\u001b[0m value is kept'); process.exit(5); } console.log('ok');");
/** Everything the card and the logs show for a task has an English rendering. */
function expectEnglish(taskId: string) {
  const detail = store.detail(taskId);
  const texts = [...detail.runs.flatMap(run => [run.integration?.error, run.followup?.request]), ...detail.comments.filter(comment => comment.kind === 'system').map(comment => comment.body),
    ...detail.logs!.flatMap(entry => [entry.summary, ...entry.details])].filter((text): text is string => !!text);
  expect(texts.filter(text => /[А-Яа-яЁё]/.test(translateServer('en', text).replace(/Интегратор <integrator@localhost>/g, '')))).toEqual([]);
}
const finished = (job: Integration | null) => !!job && !['queued', 'checking', 'merging', 'cancelling'].includes(job.status);

function open(checks: string[][], options: EngineOptions = {}) {
  return new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces'), checks), integrationChecks: checks, maxParallel: 2, ...options });
}
async function configure(checks: string[][], options: EngineOptions = {}) {
  await engine.shutdown();
  engine = open(checks, options);
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-triage-')); root = repository(folder);
  store = new Store(join(folder, 'data.sqlite')); agent = controlledAgent();
  engine = open([pass]);
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true });
});
async function start(patch: Parameters<typeof taskInput>[1] = {}) {
  const calls = agent.calls.length;
  const run = engine.start(store.createTask(taskInput(root, patch)).id);
  await until(() => agent.calls.length > calls);
  return store.getRun(run.id);
}
/** The newest agent call finishes its turn, after optionally writing the value file in its worktree. */
async function finishTurn(content?: string) {
  const call = agent.calls.at(-1)!;
  if (content !== undefined) writeFileSync(join(call.input.workspace!.path, 'src/value.txt'), content);
  call.resolve(outcome());
}
async function settled(runId: string) {
  await until(() => finished(store.integrationForRun(runId)));
  return store.integrationForRun(runId)!;
}
function targetEdit(file: string, content = 'target\n') {
  writeFileSync(join(root, file), content); git(root, 'add', '.'); git(root, 'commit', '-m', `target ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}

test('a check that passes on its rerun lets the merge go on and is marked, with the output of both attempts', async () => {
  const marker = join(folder, 'first-failure');
  const flaky = command(`const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ''); console.log('flaky failure'); process.exit(1); } console.log('passed');`);
  await configure([pass, flaky]);
  const run = await start(); await finishTurn('worker result\n');
  const integration = await settled(run.id);
  expect(integration.status).toBe('merged');
  expect(integration.checks[1]).toEqual({ argv: flaky, exitCode: 1, output: 'flaky failure\n' });
  expect(integration.triage).toMatchObject({ stage: 'done', outcome: null, target: null, handback: null, retries: [{ check: 1, exitCode: 0, output: 'passed\n' }] });
  expect(passedOnRetry(integration.triage)).toBe(true);
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('worker result\n');
  expect(agent.calls).toHaveLength(1);
  expect(engine.getCheckTriageSettings().counts).toEqual({ flaky: 1, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 });
  expect(store.detail(run.taskId).logs!.flatMap(entry => entry.details)).toContain('Повтор проверки 2: код 0.');
  // The board keeps the mark but not the outputs it polls every two seconds.
  expect(store.listTasks()[0]!.latestRun!.integration!.triage!.retries).toEqual([{ check: 1, exitCode: 0 }]);
  expectEnglish(run.taskId);
});

test('a check that also fails on the current target commit keeps the result failed without asking the worker', async () => {
  // The target breaks after the task started: its base commit is green, so only the current target can tell.
  const broken = command("const fs = require('node:fs'); if (fs.existsSync('broken.txt')) { console.error('broken on main'); process.exit(4); }");
  await configure([pass, broken]);
  const run = await start();
  const target = targetEdit('broken.txt');
  await finishTurn('worker result\n');
  const integration = await settled(run.id);
  expect(integration.status).toBe('failed');
  expect(integration.targetCommit).toBe(target);
  expect(integration.triage).toMatchObject({ stage: 'done', outcome: 'target_failed', handback: null, retries: [{ check: 1, exitCode: 4 }],
    target: { commit: target, passed: false, checks: [{ argv: pass, exitCode: 0 }, { argv: broken, exitCode: 4, output: 'broken on main\n' }] } });
  expect(integration.error).toBe(`Целевая ветка main не проходит проверку ${broken.join(' ')}: код 4 на коммите ${target.slice(0, 12)}. Задача не возвращена работнику; исправьте целевую ветку и повторите проверку.`);
  expect(agent.calls).toHaveLength(1);
  expect(store.detail(run.taskId).runs).toHaveLength(1);
  expect(store.getTask(run.taskId).status).toBe('merge_failed');
  // The clean target worktree is gone; the candidate stays for inspection.
  expect(existsSync(`${integration.candidatePath}-target`)).toBe(false);
  expect(existsSync(integration.candidatePath!)).toBe(true);
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('-target');
  expect(engine.getCheckTriageSettings().counts.targetFailed).toBe(1);
  expectEnglish(run.taskId);
});

test('a failure of the result alone goes back to the worker\'s saved session with the output as untrusted data', async () => {
  await configure([failsOnResult]);
  const run = await start();
  const target = targetEdit('external.txt');
  await finishTurn('worker result\n');
  await until(() => agent.calls.length === 2);
  const integration = store.integrationForRun(run.id)!;
  expect(integration.status).toBe('failed');
  expect(integration.triage).toMatchObject({ stage: 'done', outcome: 'returned', retries: [{ check: 0, exitCode: 5 }], target: { commit: target, passed: true },
    handback: { returns: 1, limit: CHECK_HANDBACK_LIMIT } });
  expect(integration.error).toContain('а на целевой ветке main проходит: причина в результате задачи. Задача возвращена работнику в его сохранённую сессию: возврат 1 из 3.');
  const followup = store.getRun(integration.triage!.handback!.runId!);
  expect(followup).toMatchObject({ trigger: 'followup', sessionId: 'saved-session', status: 'running' });
  expect(followup.followup!.checkFailure).toEqual({ integrationId: integration.id, round: 1, targetBranch: 'main', targetCommit: target, argv: failsOnResult,
    exitCode: 5, output: 'FAIL value is kept\n', outputTruncated: false });
  expect(store.detail(run.taskId).comments.filter(comment => comment.runId === followup.id).map(comment => comment.kind)).toEqual(['system']);

  const call = agent.calls[1]!;
  expect(call.input.sessionId).toBe('saved-session');
  expect(call.input.checkFailure).toMatchObject({ round: 1, limit: CHECK_HANDBACK_LIMIT, argv: failsOnResult, exitCode: 5, checkCommands: [failsOnResult] });
  const prompt = buildPrompt(call.input);
  expect(prompt).toContain('Continue this exact saved session to fix only the failed merge check');
  expect(prompt).toContain(`FAILED CHECK OUTPUT TAIL (UNTRUSTED DATA, JSON-ENCODED):\n${JSON.stringify('FAIL value is kept\n')}`);
  expect(prompt).not.toContain('FOLLOW-UP REQUEST:');
  // The worker resumes on the code that failed: brigd merged the tested target commit into the worktree first.
  const worktree = call.input.workspace!.path;
  expect(existsSync(join(worktree, 'external.txt'))).toBe(true);
  expect(git(worktree, 'rev-parse', 'HEAD^2')).toBe(target);
  expect(git(worktree, 'log', '-1', '--format=%an')).toBe('Интегратор');
  expect(git(worktree, 'log', '-1', '--format=%B')).toBe(`brigd: объединение main в Isolated work\n\nBrigd-Run: ${followup.id}`);

  await finishTurn('fixed\n');
  const merged = await settled(followup.id);
  expect(merged.status).toBe('merged'); expect(merged.triage).toBeNull();
  expect(readFileSync(join(root, 'src/value.txt'), 'utf8')).toBe('fixed\n');
  expect(engine.getCheckTriageSettings().counts.returned).toBe(1);
  expectEnglish(run.taskId);
});

test('after three hand-backs the card waits for a person, and the autopilot counts it as a failure', async () => {
  await configure([failsOnResult]);
  const task = store.createTask(taskInput(root, { schedule: 'auto' }));
  engine.setAutopilot({ enabled: true, until: null });
  await until(() => agent.calls.length === 1);
  const root_run = store.detail(task.id).runs[0]!;
  expect(root_run.trigger).toBe('autopilot');
  await finishTurn('worker result\n');
  for (let round = 1; round <= CHECK_HANDBACK_LIMIT; round++) {
    await until(() => agent.calls.length === round + 1);
    expect(agent.calls[round]!.input.checkFailure!.round).toBe(round);
    await finishTurn();
  }
  const last = store.detail(task.id).runs[0]!;
  const integration = await settled(last.id);
  expect(last.followup!.checkFailure!.round).toBe(CHECK_HANDBACK_LIMIT);
  expect(integration.triage).toMatchObject({ outcome: 'limit', handback: { returns: 3, limit: 3, runId: null } });
  expect(integration.error).toContain('Лимит автоматических возвратов исчерпан: 3 из 3. Нужно решение человека');
  expect(agent.calls).toHaveLength(CHECK_HANDBACK_LIMIT + 1);
  expect(store.detail(task.id).runs).toHaveLength(CHECK_HANDBACK_LIMIT + 1);
  expect(store.getTask(task.id).status).toBe('merge_failed');
  expect(store.getAutopilot().failures).toBe(1);
  expect(store.autopilotOverview().triage).toEqual({ flaky: 0, targetFailed: 0, returned: 3, exhausted: 1, notReturned: 0, stopped: 0 });
  expectEnglish(task.id);
});

test('a run without a saved session is not handed back, and the card says why', async () => {
  const gate = join(folder, 'gate');
  const gated = command(`const fs = require('node:fs'); while (!fs.existsSync(${JSON.stringify(gate)})) Bun.sleepSync(10); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') process.exit(5);`);
  await configure([gated]);
  const run = await start(); await finishTurn('worker result\n');
  await until(() => store.integrationForRun(run.id)?.status === 'checking');
  store.db.query('UPDATE runs SET session_id=NULL WHERE id=?').run(run.id);
  writeFileSync(gate, '');
  const integration = await settled(run.id);
  expect(integration.triage).toMatchObject({ outcome: 'no_session', target: { passed: true }, handback: { returns: 0, runId: null } });
  const note = 'Автоматический возврат не выполнен: CLI не сохранил ID сессии работника, а продолжить можно только её. Исправьте результат вручную или поставьте задачу заново.';
  expect(integration.error).toEndWith(note);
  expect(store.detail(run.taskId).comments.at(-1)).toMatchObject({ kind: 'system', body: note });
  expect(agent.calls).toHaveLength(1);
  expect(engine.getCheckTriageSettings().counts.notReturned).toBe(1);
  expectEnglish(run.taskId);
});

test('a multi-stage result is not handed back automatically', async () => {
  await configure([failsOnResult]);
  const worker = store.createWorker({ name: 'Ada', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
  const run = await start({ steps: [{ workerId: worker.id, title: 'Code', instruction: 'Write it' }, { workerId: worker.id, title: 'Review', instruction: 'Check it' }] });
  await finishTurn('worker result\n');
  await until(() => agent.calls.length === 2);
  await finishTurn();
  const integration = await settled(run.id);
  expect(integration.triage).toMatchObject({ outcome: 'workflow', target: { passed: true }, handback: { returns: 0, runId: null } });
  expect(integration.error).toContain('Задача с этапами не возвращается автоматически');
  expect(agent.calls).toHaveLength(2);
  expectEnglish(run.taskId);
});

test('reruns and the target check stop at the time limit without a hand-back', async () => {
  const marker = join(folder, 'first-failure');
  const hanging = command(`const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ''); process.exit(1); } console.log('stuck'); setTimeout(() => {}, 60_000);`);
  await configure([hanging], { checkTriageTimeLimitMs: 400 });
  const startedAt = performance.now();
  const run = await start(); await finishTurn('worker result\n');
  const integration = await settled(run.id);
  expect(performance.now() - startedAt).toBeLessThan(5_000);
  expect(integration.status).toBe('failed');
  expect(integration.triage).toMatchObject({ stage: 'done', outcome: 'timeout', limitMs: 400, target: null, retries: [{ check: 0, exitCode: null, output: 'stuck\n' }] });
  expect(integration.triage!.spentMs).toBeLessThanOrEqual(400);
  expect(integration.error).toBe('Разбор упавшей проверки 1 остановлен: повтор и проверка целевой ветки вместе превысили лимит 1 мин. Задача не возвращена работнику.');
  expect(agent.calls).toHaveLength(1);
  expect(engine.getCheckTriageSettings().counts.stopped).toBe(1);
  expectEnglish(run.taskId);
});

test('the time limit also stops the target check and removes its worktree', async () => {
  const stalling = command("const fs = require('node:fs'); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') process.exit(5); setTimeout(() => {}, 60_000);");
  await configure([stalling], { checkTriageTimeLimitMs: 1_500 });
  const run = await start(); await finishTurn('worker result\n');
  const integration = await settled(run.id);
  expect(integration.triage).toMatchObject({ outcome: 'timeout', retries: [{ exitCode: 5 }], target: { passed: null, checks: [{ argv: stalling, exitCode: null }] } });
  expect(existsSync(`${integration.candidatePath}-target`)).toBe(false);
  expect(agent.calls).toHaveLength(1);
});

test('a restart in the middle of the triage leaves the merge interrupted until a person confirms and retries it', async () => {
  const gate = join(folder, 'gate');
  // The result fails at once; the target check waits for the gate, so the service stops during it.
  const gated = command(`const fs = require('node:fs'); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') process.exit(5); while (!fs.existsSync(${JSON.stringify(gate)})) Bun.sleepSync(10);`);
  await configure([gated]);
  const run = await start(); await finishTurn('worker result\n');
  await until(() => store.integrationForRun(run.id)?.triage?.stage === 'target' && !!store.integrationForRun(run.id)?.triage?.target?.checks.length);
  const first = store.integrationForRun(run.id)!;
  expect(existsSync(`${first.candidatePath}-target`)).toBe(true);
  await engine.shutdown(); store.close();
  store = new Store(join(folder, 'data.sqlite')); engine = open([gated]);
  const interrupted = store.integrationForRun(run.id)!;
  expect(interrupted.status).toBe('interrupted');
  expect(interrupted.triage).toMatchObject({ stage: 'done', outcome: 'interrupted', target: { passed: null } });
  expect(agent.calls).toHaveLength(1);
  expect(() => engine.integrate(run.id)).toThrow('Сначала подтвердите');
  writeFileSync(gate, '');
  expect(engine.integrate(run.id, true).triage).toBeNull();
  await until(() => agent.calls.length === 2);
  const retried = store.integrationForRun(run.id)!;
  expect(retried).toMatchObject({ attempt: 2, status: 'failed', triage: { outcome: 'returned', handback: { returns: 1 } } });
  expect(existsSync(`${first.candidatePath}-target`)).toBe(false);
  expect(engine.getCheckTriageSettings().counts).toMatchObject({ stopped: 1, returned: 1 });
});

test('switched off, a failed check stays failed as before; switched off mid-triage, nothing is handed back', async () => {
  expect(engine.getCheckTriageSettings()).toMatchObject({ enabled: true, saved: null, defaultEnabled: true, timeLimitMinutes: 30, handbackLimit: 3 });
  await configure([failsOnResult]);
  engine.setCheckTriageSettings({ enabled: false });
  const run = await start(); await finishTurn('worker result\n');
  const off = await settled(run.id);
  expect(off).toMatchObject({ status: 'failed', checks: [{ exitCode: 5 }], error: 'Проверка 1 завершилась с кодом 5. Целевая ветка сохранена.' });
  expect(off.triage ?? null).toBeNull();

  const gate = join(folder, 'gate');
  const gated = command(`const fs = require('node:fs'); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') process.exit(5); while (!fs.existsSync(${JSON.stringify(gate)})) Bun.sleepSync(10);`);
  await configure([gated]);
  engine.setCheckTriageSettings({ enabled: true });
  const second = await start(); await finishTurn('worker result\n');
  await until(() => store.integrationForRun(second.id)?.triage?.stage === 'target');
  engine.setCheckTriageSettings({ enabled: false });
  writeFileSync(gate, '');
  const disabled = await settled(second.id);
  expect(disabled.triage).toMatchObject({ outcome: 'disabled', target: { passed: true }, handback: { returns: 0, runId: null } });
  expect(agent.calls).toHaveLength(2);
  expectEnglish(second.taskId);
  expect(engine.setCheckTriageSettings({ enabled: null })).toMatchObject({ enabled: true, saved: null });
  expect(() => engine.setCheckTriageSettings({ enabled: 'yes' })).toThrow('enabled должен быть true, false или null');
});

test('the output handed to the worker is readable text within the follow-up limit', () => {
  expect(handbackOutput('\u001b[1;31mFAIL\u001b[0m a\r\nprogress\r100%\u0007\n', false)).toEqual({ output: 'FAIL a\nprogress\n100%\n', outputTruncated: false });
  expect(handbackOutput('ok', true)).toEqual({ output: 'ok', outputTruncated: true });
  const long = handbackOutput(`start${'x'.repeat(CHECK_HANDBACK_OUTPUT_LIMIT)}end`, false);
  expect(long.outputTruncated).toBe(true); expect(long.output).toHaveLength(CHECK_HANDBACK_OUTPUT_LIMIT); expect(long.output.endsWith('end')).toBe(true);
  // A cut never leaves half of a surrogate pair.
  const emoji = handbackOutput(`${'😀'.repeat(CHECK_HANDBACK_OUTPUT_LIMIT)}.`, false);
  expect(emoji.output).toHaveLength(CHECK_HANDBACK_OUTPUT_LIMIT - 1); expect(emoji.output.startsWith('😀')).toBe(true); expect(emoji.output.endsWith('😀.')).toBe(true);
});

test('a corrupted hand-back snapshot stops the run instead of being trusted', async () => {
  await configure([failsOnResult]);
  const run = await start(); await finishTurn('worker result\n');
  await until(() => agent.calls.length === 2);
  const followup: Run = store.detail(run.taskId).runs[0]!;
  const snapshot = JSON.parse((store.db.query('SELECT followup_snapshot FROM runs WHERE id=?').get(followup.id) as { followup_snapshot: string }).followup_snapshot);
  store.db.query('UPDATE runs SET followup_snapshot=? WHERE id=?').run(JSON.stringify({ ...snapshot, checkFailure: { ...snapshot.checkFailure, round: 9 } }), followup.id);
  expect(() => store.getRun(followup.id)).toThrow('Повреждён снимок запуска');
  store.db.query('UPDATE runs SET followup_snapshot=? WHERE id=?').run(JSON.stringify(snapshot), followup.id);
  expect(store.getRun(followup.id).followup!.checkFailure!.round).toBe(1);
});

test('an integrator result whose check fails goes back to the worker\'s session, not to the integrator\'s', async () => {
  await configure([failsOnResult]);
  const run = await start();
  writeFileSync(join(root, 'src/value.txt'), 'target edit\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'conflicting target edit');
  await finishTurn('worker result\n');
  await until(() => agent.calls.length === 2);
  const integrator = agent.calls[1]!;
  expect(integrator.input.reconcile?.conflicts).toEqual(['src/value.txt']);
  // The integrator keeps the task's side, which still fails the check on the combined code.
  writeFileSync(join(integrator.input.workspace!.path, 'src/value.txt'), 'worker result\n');
  integrator.resolve(outcome('integrator-session'));
  await until(() => agent.calls.length === 3);
  const reconcile = store.detail(run.taskId).runs.find(entry => entry.trigger === 'reconcile')!;
  expect(store.integrationForRun(reconcile.id)!.triage).toMatchObject({ outcome: 'returned', handback: { returns: 1 } });
  const followup = store.detail(run.taskId).runs[0]!;
  expect(followup.followup).toMatchObject({ sourceRunId: run.id, checkFailure: { round: 1, exitCode: 5 } });
  expect(followup.sessionId).toBe('saved-session');
  expect(agent.calls[2]!.input.sessionId).toBe('saved-session');
});

test('a cancellation during the triage stops it and removes its target worktree with the candidate', async () => {
  const gate = join(folder, 'gate');
  const gated = command(`const fs = require('node:fs'); if (fs.readFileSync('src/value.txt', 'utf8') === 'worker result\\n') process.exit(5); while (!fs.existsSync(${JSON.stringify(gate)})) Bun.sleepSync(10);`);
  await configure([gated]);
  const run = await start(); await finishTurn('worker result\n');
  await until(() => !!store.integrationForRun(run.id)?.triage?.target?.checks.length);
  const running = store.integrationForRun(run.id)!;
  engine.cancelIntegration(run.id);
  const cancelled = await settled(run.id);
  expect(cancelled).toMatchObject({ status: 'cancelled', triage: { stage: 'done', outcome: 'stopped', handback: null } });
  expect(existsSync(`${running.candidatePath}-target`)).toBe(false);
  expect(existsSync(running.candidatePath!)).toBe(false);
  expect(agent.calls).toHaveLength(1);
});

test('a target worktree left behind belongs to its attempt: inspectable with the candidate, replaced by the next attempt', async () => {
  await configure([command('process.exit(3)')]);
  const run = await start(); await finishTurn('worker result\n');
  const failed = await settled(run.id);
  expect(failed.triage!.outcome).toBe('target_failed');
  const leftover = `${failed.candidatePath}-target`;
  git(root, 'worktree', 'add', '--detach', leftover, failed.targetCommit!);
  const entry = (await engine.storageOverview()).entries.find(item => item.path === leftover);
  expect(entry).toMatchObject({ kind: 'candidate', retained: true, reason: 'failed', optional: true, runId: run.id });
  engine.integrate(run.id);
  expect(await settled(run.id)).toMatchObject({ attempt: 2, status: 'failed' });
  expect(existsSync(leftover)).toBe(false);
  expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(leftover);
});

test('HTTP reads and switches the triage; the choice survives a restart and null returns to the default', async () => {
  const handler = createHandler(engine, { port: 4310, root: folder });
  const origin = 'http://127.0.0.1:4310';
  const request = (method: string, value?: unknown) => handler(new Request(`${origin}/api/settings/check-triage`, {
    method, headers: { origin, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(value) }));
  const counts = { flaky: 0, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 };
  expect(await (await request('GET')).json()).toEqual({ enabled: true, saved: null, defaultEnabled: true, timeLimitMinutes: 30, handbackLimit: 3, counts });
  const off = await request('PATCH', { enabled: false });
  expect(off.status).toBe(200); expect(await off.json()).toMatchObject({ enabled: false, saved: false });
  for (const value of [{}, { enabled: 'no' }, { enabled: false, extra: 1 }, { enabled: 0 }]) expect((await request('PATCH', value)).status).toBe(400);
  await engine.shutdown(); store.close();
  store = new Store(join(folder, 'data.sqlite')); engine = open([pass], { checkTriage: false });
  expect(engine.getCheckTriageSettings()).toMatchObject({ enabled: false, saved: false, defaultEnabled: false });
  expect(engine.setCheckTriageSettings({ enabled: true })).toMatchObject({ enabled: true, saved: true });
  expect(engine.setCheckTriageSettings({ enabled: null })).toMatchObject({ enabled: false, saved: null });
});
