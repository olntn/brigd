import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, Integration, IntegrationStatus, Run, Task, TaskDetail, TaskStatus } from '../src/lib/types';

const now = Date.UTC(2026, 9, 11);
const states: Record<IntegrationStatus, TaskStatus> = { queued: 'awaiting_merge', checking: 'integrating', merging: 'integrating', cancelling: 'integrating',
  merged: 'completed', conflict: 'merge_conflict', failed: 'merge_failed', blocked: 'merge_blocked', interrupted: 'merge_interrupted', cancelled: 'merge_blocked' };
async function fixture(page: Page, status: IntegrationStatus, checks?: Integration['checks']) {
  const integration: Integration = { id: 'integration-fixture', runId: 'run-fixture', repositoryId: '/project/.git', status, attempt: 1,
    sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), resultCommit: status === 'merged' ? 'c'.repeat(40) : null,
    candidatePath: '/data/workspaces/project/integration-fixture-1', checks: checks ?? [{ argv: ['bun', 'test'], exitCode: status === 'failed' ? 1 : 0 }],
    error: status === 'failed' ? 'Проверка завершилась с кодом 1. Целевая ветка сохранена.' : status === 'conflict' ? 'Обнаружен конфликт слияния с веткой main: src/value.txt.' : null,
    ...(status === 'conflict' ? { conflicts: ['src/value.txt', 'README.md'] } : {}), updatedAt: now };
  const run: Run = { id: integration.runId, taskId: 'task-fixture', workerId: null, worker: null, steps: [], currentStepIndex: null, instructions: [],
    provider: 'codex', cwd: '/project', instruction: 'Добавь изолированное изменение.', trigger: 'manual', scheduledFor: null, status: 'completed',
    sessionId: 'saved-session', startedAt: now, updatedAt: now, finishedAt: now, summary: 'Изменения готовы.', error: null, turn: 1, mock: false, integration,
    workspace: { id: 'workspace-fixture', repositoryId: '/project/.git', repositoryRoot: '/project', projectCwd: '/project', path: '/data/workspaces/run-fixture',
      cwd: '/data/workspaces/run-fixture', branch: 'brigd/run-fixture', baseCommit: 'b'.repeat(40), targetBranch: 'main', mode: 'worktree', prepared: true } };
  const task: Task = { id: run.taskId, title: 'Изолированная задача', instruction: run.instruction, provider: 'codex', cwd: run.cwd, workerId: null, worker: null,
    steps: [], tagIds: [], tags: [], schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null, paused: false, nextRunAt: null, archivedAt: null,
    createdAt: now, updatedAt: now, status: states[status], latestRun: run, runCount: 1 };
  const detail: TaskDetail = { task, runs: [run], comments: [], logs: [] };
  const info: AppInfo = { mode: 'mock', cwd: '/project', scheduler: 'running', startedAt: now, providers: [] };
  const actions: { path: string; body: unknown }[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/api\/runs\/run-fixture\/(integrate|cancel-integration|reconcile)$/.test(path)) {
      actions.push({ path, body: request.postDataJSON() });
      integration.status = path.endsWith('/integrate') ? 'queued' : path.endsWith('/reconcile') ? 'conflict' : 'cancelled'; task.status = states[integration.status];
      await route.fulfill({ json: integration });
    } else if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/tasks') await route.fulfill({ json: [task] });
    else if (path === `/api/tasks/${task.id}`) await route.fulfill({ json: detail });
    else await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(dialog).toBeVisible();
  return { dialog, actions };
}

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
