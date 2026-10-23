import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, AutopilotOverview, CheckTriage, Integration, IntegrationStatus, Run, Task, TaskDetail, TaskStatus } from '../src/lib/types';

const now = Date.UTC(2026, 9, 11);
const states: Record<IntegrationStatus, TaskStatus> = { awaiting_manual: 'awaiting_manual_transfer', skipped: 'completed', queued: 'awaiting_merge', checking: 'integrating', merging: 'integrating', cancelling: 'integrating',
  merged: 'completed', conflict: 'merge_conflict', failed: 'merge_failed', blocked: 'merge_blocked', interrupted: 'merge_interrupted', cancelled: 'merge_blocked' };
async function fixture(page: Page, status: IntegrationStatus, checks?: Integration['checks'], patch: { integration?: Partial<Integration>; run?: Partial<Run>; english?: boolean } = {}) {
  const integration: Integration = { id: 'integration-fixture', runId: 'run-fixture', repositoryId: '/project/.git', status, attempt: 1,
    sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), resultCommit: status === 'merged' ? 'c'.repeat(40) : null,
    candidatePath: '/data/workspaces/project/integration-fixture-1', checks: checks ?? [{ argv: ['bun', 'test'], exitCode: status === 'failed' ? 1 : 0 }],
    error: status === 'failed' ? 'Проверка завершилась с кодом 1. Целевая ветка сохранена.' : status === 'conflict' ? 'Обнаружен конфликт слияния с веткой main: src/value.txt.' : null,
    ...(status === 'conflict' ? { conflicts: ['src/value.txt', 'README.md'] } : {}), updatedAt: now, ...patch.integration };
  const run: Run = { id: integration.runId, taskId: 'task-fixture', workerId: null, worker: null, steps: [], currentStepIndex: null, instructions: [],
    provider: 'codex', cwd: '/project', instruction: 'Добавь изолированное изменение.', trigger: 'manual', scheduledFor: null, status: 'completed',
    sessionId: 'saved-session', startedAt: now, updatedAt: now, finishedAt: now, summary: 'Изменения готовы.', error: null, turn: 1, mock: false, integration,
    workspace: { id: 'workspace-fixture', repositoryId: '/project/.git', repositoryRoot: '/project', projectCwd: '/project', path: '/data/workspaces/run-fixture',
      cwd: '/data/workspaces/run-fixture', branch: 'brigd/run-fixture', baseCommit: 'b'.repeat(40), targetBranch: 'main', mode: 'worktree', prepared: true }, ...patch.run };
  const task: Task = { id: run.taskId, title: 'Изолированная задача', instruction: run.instruction, provider: 'codex', cwd: run.cwd, workerId: null, worker: null,
    steps: [], dependsOnTaskIds: [], dependencies: [], tagIds: [], tags: [], schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null, paused: false, nextRunAt: null, archivedAt: null,
    createdAt: now, updatedAt: now, status: states[status], latestRun: run, runCount: 1 };
  const detail: TaskDetail = { task, runs: [run], comments: [], logs: [] };
  const info: AppInfo = { mode: 'mock', cwd: '/project', scheduler: 'running', startedAt: now, providers: [] };
  const overview: AutopilotOverview = { enabled: false, until: null, startedAt: now - 1000, stoppedAt: now, stopReason: 'manual', failures: 0, updatedAt: now,
    pool: [], attempts: [run], triage: { flaky: 0, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 }, usage: null };
  const actions: { path: string; body: unknown }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/api\/runs\/run-fixture\/(integrate|skip-integration|cancel-integration|reconcile)$/.test(path)) {
      actions.push({ path, body: request.postDataJSON() });
      integration.status = path.endsWith('/skip-integration') ? 'skipped' : path.endsWith('/integrate') ? 'queued' : path.endsWith('/reconcile') ? 'conflict' : 'cancelled'; task.status = states[integration.status];
      await route.fulfill({ json: integration });
    } else if (path === '/api/autopilot') await route.fulfill({ json: overview });
    else if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/tasks') await route.fulfill({ json: [task] });
    else if (path === `/api/tasks/${task.id}`) await route.fulfill({ json: detail });
    else await route.fulfill({ json: [] });
  });
  if (patch.english) await page.addInitScript(() => localStorage.setItem('brigd.locale', 'en'));
  await page.goto('/');
  const card = page.locator('.task-card').filter({ hasText: task.title });
  await page.getByRole('button', { name: `${patch.english ? 'Open task' : 'Открыть задачу'}: ${task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, actions, card };
}
const verify = ['bun', 'run', 'verify'];
const triaged = (patch: Partial<CheckTriage>): CheckTriage => ({ stage: 'done', startedAt: now, limitMs: 30 * 60_000, spentMs: 95_000, retries: [], target: null, handback: null, outcome: null, ...patch });

test('integration progress is visible and has its own cancellation action', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'checking');
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  await expect(panel.getByText('Проверка объединённого кода', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отменить запуск', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'В архив', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Отменить слияние', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/cancel-integration', body: { acknowledgeInterruption: false } }]);
});

test('a failed check shows details and retries through the integration queue', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'failed');
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  await expect(panel).toContainText('Проверка 1: код 1'); await expect(panel).toContainText('Целевая ветка сохранена.');
  await panel.getByRole('button', { name: 'Повторить проверку и слияние', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/integrate', body: { acknowledgeInterruption: false } }]);
});

test('a check keeps the end of its output in a collapsed monospaced block that wraps on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const output = `tests/value.test.ts:\n(fail) value is kept [3.00ms]\n${'x'.repeat(300)}\n 1 fail\n`;
  const { dialog } = await fixture(page, 'failed', [{ argv: ['bun', 'install'], exitCode: 0 }, { argv: ['bun', 'run', 'verify'], exitCode: 1, output, outputTruncated: true }]);
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  // A record saved before output was kept, like the first check here, shows no block.
  await expect(panel.locator('.integration-output')).toHaveCount(1);
  const summary = panel.getByText('Вывод проверки: последние 16 КБ', { exact: true });
  const text = panel.locator('.integration-output pre');
  await expect(summary).toBeVisible(); await expect(text).toBeHidden();
  await summary.click();
  await expect(text).toBeVisible(); expect(await text.textContent()).toBe(output);
  expect(await text.evaluate(node => getComputedStyle(node).fontFamily)).toContain('monospace');
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});

test('a conflict lists the files and offers the built-in integrator beside a manual retry', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'conflict');
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  await expect(panel.getByText('Конфликт слияния', { exact: true })).toBeVisible();
  await expect(panel.locator('.integration-conflicts li')).toHaveText(['src/value.txt', 'README.md']);
  await expect(panel.getByRole('button', { name: 'Повторить проверку и слияние', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Поручить интегратору', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/reconcile', body: { acknowledgeInterruption: false } }]);
  await expect(page.getByText(/Интегратор объединит результат/)).toBeVisible();
});

test('interrupted integration requires explicit process-stop acknowledgement before retry', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'interrupted');
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  const retry = panel.getByRole('button', { name: 'Повторить проверку и слияние', exact: true });
  await expect(retry).toBeDisabled(); await expect(panel.getByRole('button', { name: 'Отменить слияние', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox').check(); await expect(retry).toBeEnabled(); await retry.click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/integrate', body: { acknowledgeInterruption: true } }]);
});

test('merged history shows the checked result without active integration controls on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await fixture(page, 'merged');
  await expect(dialog.getByRole('region', { name: 'Слияние результата', exact: true })).toContainText('Изменения перенесены');
  await dialog.getByRole('tab', { name: /Запуски/ }).click();
  const history = dialog.getByRole('tabpanel', { name: /Запуски/ });
  await expect(history.getByRole('region', { name: 'Слияние результата', exact: true })).toContainText('cccccccccccc');
  await expect(history.getByRole('button', { name: /слияние/ })).toHaveCount(0);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});

test('a check that passed only on its rerun is marked on the board and in the card with both outputs', async ({ page }) => {
  const triage = triaged({ retries: [{ check: 0, exitCode: 0, output: 'second attempt passed\n' }] });
  const { dialog, card } = await fixture(page, 'merged', [{ argv: verify, exitCode: 1, output: 'first attempt failed\n' }], { integration: { triage } });
  await expect(card.getByText('Проверка прошла со второй попытки', { exact: true })).toBeVisible();
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  await expect(panel.getByRole('note')).toContainText('Проверка прошла со второй попытки');
  await expect(panel.getByRole('note')).toContainText('Повтор мог скрыть гонку');
  await expect(panel.locator('.integration-checks').first()).toContainText('Проверка 1: прошла со второй попытки');
  await panel.getByText('Вывод первой попытки', { exact: true }).click();
  await panel.getByText('Вывод повтора', { exact: true }).click();
  await expect(panel.locator('.integration-output pre')).toHaveText(['first attempt failed\n', 'second attempt passed\n']);
  const stages = panel.getByRole('region', { name: 'Разбор упавшей проверки', exact: true }).locator('.triage-stage');
  await expect(stages).toHaveCount(3);
  await expect(stages.nth(0)).toContainText('Повторпройдено');
  await expect(stages.nth(1)).toContainText('Не понадобилась: проверка прошла со второй попытки.');
  await expect(stages.nth(2)).toContainText('Возврат работнику 0 из 3');
});

test('the stages of a hand-back show the rerun, the target branch check and the return number', async ({ page }) => {
  const triage = triaged({ retries: [{ check: 1, exitCode: 1, output: 'FAIL again\n' }], outcome: 'returned', handback: { returns: 2, limit: 3, runId: 'run-next' },
    target: { commit: 'b'.repeat(40), passed: true, checks: [{ argv: ['bun', 'install'], exitCode: 0 }, { argv: verify, exitCode: 0, output: 'green on main\n' }] } });
  const { dialog } = await fixture(page, 'failed', [{ argv: ['bun', 'install'], exitCode: 0 }, { argv: verify, exitCode: 1, output: 'FAIL\n' }], { integration: { triage,
    error: 'Проверка 2 (bun run verify) завершилась с кодом 1, при повторе — с кодом 1, а на целевой ветке main проходит: причина в результате задачи. Задача возвращена работнику в его сохранённую сессию: возврат 2 из 3.' } });
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  await expect(panel.getByRole('note')).toHaveCount(0);
  const region = panel.getByRole('region', { name: 'Разбор упавшей проверки', exact: true });
  const stages = region.locator('.triage-stage');
  await expect(stages.nth(0)).toHaveClass(/triage-failed/); await expect(stages.nth(0)).toContainText('Проверка 2: снова код 1');
  await expect(stages.nth(1)).toHaveClass(/triage-passed/); await expect(stages.nth(1)).toContainText('Проходит на коммите bbbbbbbbbbbb: ошибка в результате задачи.');
  await expect(stages.nth(1).locator('.integration-checks li')).toHaveCount(2);
  await expect(stages.nth(2)).toHaveClass(/triage-passed/);
  await expect(stages.nth(2)).toContainText('Возврат работнику 2 из 3');
  await expect(stages.nth(2)).toContainText('Отправлен в сохранённую сессию работника.');
  await expect(region).toContainText('не дольше 30 мин');
  await expect(panel).toContainText('Задача возвращена работнику в его сохранённую сессию: возврат 2 из 3.');
});

test('a broken target branch says the task was not handed back', async ({ page }) => {
  const broken = triaged({ retries: [{ check: 0, exitCode: 3 }], outcome: 'target_failed', target: { commit: 'b'.repeat(40), passed: false, checks: [{ argv: verify, exitCode: 3 }] } });
  const { dialog } = await fixture(page, 'failed', [{ argv: verify, exitCode: 3 }], { integration: { triage: broken,
    error: `Целевая ветка main не проходит проверку bun run verify: код 3 на коммите ${'b'.repeat(12)}. Задача не возвращена работнику; исправьте целевую ветку и повторите проверку.` } });
  const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
  const stages = panel.locator('.triage-stage');
  await expect(stages.nth(1)).toHaveClass(/triage-failed/);
  await expect(stages.nth(1)).toContainText('Не проходит на коммите bbbbbbbbbbbb: bun run verify, код 3. Целевая ветка сломана, задача не возвращается.');
  await expect(stages.nth(2)).toContainText('Не нужен: проверка не проходит и на целевой ветке.');
  await expect(panel.locator('.integration-error')).toContainText('Целевая ветка main не проходит проверку bun run verify');
});

test('an exhausted hand-back limit waits for a person, in English too', async ({ page }) => {
  const exhausted = triaged({ retries: [{ check: 0, exitCode: 1 }], outcome: 'limit', handback: { returns: 3, limit: 3, runId: null }, target: { commit: 'b'.repeat(40), passed: true, checks: [{ argv: verify, exitCode: 0 }] } });
  const { dialog } = await fixture(page, 'failed', [{ argv: verify, exitCode: 1 }], { english: true, integration: { triage: exhausted,
    error: 'Проверка 1 (bun run verify) завершилась с кодом 1, при повторе — с кодом 1, а на целевой ветке main проходит: причина в результате задачи. Лимит автоматических возвратов исчерпан: 3 из 3. Нужно решение человека: отправьте дополнительный запрос или исправьте результат вручную.' } });
  const panel = dialog.getByRole('region', { name: 'Merging the result', exact: true });
  const stages = panel.getByRole('region', { name: 'Failed check triage', exact: true }).locator('.triage-stage');
  await expect(stages.nth(0)).toContainText('Check 1: exit code 1 again');
  await expect(stages.nth(1)).toContainText('Passes on commit bbbbbbbbbbbb: the failure is in the task result.');
  await expect(stages.nth(2)).toHaveClass(/triage-failed/);
  await expect(stages.nth(2)).toContainText('Hand-back to the worker 3 of 3');
  await expect(stages.nth(2)).toContainText('Limit reached: a person decides.');
  await expect(panel.locator('.integration-error')).toHaveText('Check 1 (bun run verify) exited with code 1, with code 1 on its rerun, and passes on target branch main: the cause is in the task result. The automatic hand-back limit is reached: 3 of 3. A person decides: send a follow-up or fix the result by hand.');
});

test('a running hand-back shows its number, the failed command and the output given to the worker', async ({ page }) => {
  const checkFailure = { integrationId: 'integration-before', round: 2, targetBranch: 'main', targetCommit: 'b'.repeat(40), argv: verify, exitCode: 1, output: 'FAIL value is kept\n', outputTruncated: false };
  const { dialog, card } = await fixture(page, 'queued', [], { run: { trigger: 'followup', status: 'running', integration: null, finishedAt: null, summary: null,
    followup: { sourceRunId: 'run-before', sourceStepIndex: null, request: 'Проверка слияния bun run verify не прошла и при повторе (код 1), а на целевой ветке main проходит. brigd возвращает задачу работнику: возврат 2 из 3.', workflow: null, checkFailure } } });
  await expect(card.getByText('Возврат после упавшей проверки · 2 из 3', { exact: true })).toBeVisible();
  const section = dialog.getByRole('region', { name: 'Возврат после упавшей проверки', exact: true });
  await expect(section).toContainText('возврат 2 из 3');
  await expect(section).toContainText('bun run verify · код 1');
  await expect(section).toContainText('на целевой ветке main проходит');
  await section.getByText('Вывод, переданный работнику', { exact: true }).click();
  await expect(section.locator('pre')).toHaveText('FAIL value is kept\n');
  await dialog.getByRole('tab', { name: /Запуски/ }).click();
  await expect(dialog.getByRole('tabpanel', { name: /Запуски/ })).toContainText('Возврат после упавшей проверки · 2 из 3');
});

for (const action of ['integrate', 'skip-integration'] as const) {
  test(`a manual result exposes its separate status and ${action} action`, async ({ page }) => {
    const { dialog, actions, card } = await fixture(page, 'awaiting_manual', [], { integration: { attempt: 0, candidatePath: null } });
    await expect(card).toContainText('Ожидает ручного переноса');
    const panel = dialog.getByRole('region', { name: 'Слияние результата', exact: true });
    await expect(panel.getByText('Ожидает ручного переноса', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Проверить и перенести', exact: true })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Не переносить', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: action === 'integrate' ? 'Проверить и перенести' : 'Не переносить', exact: true }).click();
    await expect.poll(() => actions).toEqual([{ path: `/api/runs/run-fixture/${action}`, body: { acknowledgeInterruption: false } }]);
  });
}

test('a skipped result keeps a transfer button and English labels', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'skipped', [], { english: true, integration: { attempt: 0, candidatePath: null } });
  const panel = dialog.getByRole('region', { name: 'Merging the result', exact: true });
  await expect(panel.getByText('Transfer deferred', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Do not transfer', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check and transfer', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/integrate', body: { acknowledgeInterruption: false } }]);
});

test('manual results count separately in the autopilot session report', async ({ page }) => {
  const { dialog } = await fixture(page, 'awaiting_manual', [], { integration: { attempt: 0, candidatePath: null } });
  await dialog.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  const report = page.getByRole('region', { name: 'Итоги сессии автопилота', exact: true });
  await expect(report).toContainText('Ждут ручного переноса: 1.');
  await expect(report).toContainText('Ошибки и блокировки: 0');
});

test('the run history keeps the transfer action for a skipped result', async ({ page }) => {
  const { dialog, actions } = await fixture(page, 'skipped', [], { integration: { attempt: 0, candidatePath: null } });
  await dialog.getByRole('tab', { name: /Запуски/ }).click();
  const history = dialog.getByRole('tabpanel', { name: /Запуски/ });
  await history.getByRole('button', { name: 'Проверить и перенести', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ path: '/api/runs/run-fixture/integrate', body: { acknowledgeInterruption: false } }]);
});
