import { expect, test, type Page } from '@playwright/test';
import type { Task, Worker } from '../src/lib/types';

// Read-only task fixtures exercise the dashboard without running agents or changing app data.
const now = Date.now();
const worker = (id: string, name: string): Worker => ({ id, name, description: '', provider: 'codex', model: null,
  ultracode: false, effort: 'default', communicationStyle: '', avatarUrl: null, fallbackWorkerId: null,
  archived: false, createdAt: now, updatedAt: now });
const first = worker('first', 'Alex');
const second = worker('second', 'Sam');
function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: id, instruction: 'Analytics fixture', status: 'ready', provider: 'codex', priority: 'normal',
    cwd: '/workspace', workerId: null, worker: null, steps: [], dependsOnTaskIds: [], dependencies: [], tags: [], tagIds: [],
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, archivedAt: null,
    nextRunAt: null, latestRun: null, runCount: 0, createdAt: now - 60_000, updatedAt: now, ...overrides };
}
const fixtures = [
  task('completed', { status: 'completed', priority: 'high', archivedAt: now, workerId: first.id, worker: first }),
  task('running', { status: 'running', workerId: first.id, worker: first }),
  task('ready', { priority: 'critical', workerId: second.id, worker: second }),
  task('waiting', { status: 'waiting_input', priority: 'high', provider: 'claude' }),
  task('old', { status: 'cancelled', priority: 'low', provider: 'claude', createdAt: now - 40 * 86_400_000 }),
  task('workflow', { status: 'merge_failed', priority: 'critical', steps: [
    { workerId: first.id, title: 'First', instruction: 'First' }, { workerId: second.id, title: 'Second', instruction: 'Second' },
  ] }),
];

async function openAnalytics(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Аналитика', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Аналитика', exact: true })).toBeVisible();
}

function metric(page: Page, name: string) {
  return page.locator('.analytics-metrics > div').filter({ has: page.locator('dt').filter({ hasText: name }) }).locator('dd');
}

test('shows four charts and combines period, provider and archive filters', async ({ page }) => {
  await page.route('**/api/tasks', route => route.fulfill({ json: fixtures }));
  await openAnalytics(page);
  await expect(metric(page, 'Всего задач')).toHaveText(/^6/);
  await expect(metric(page, 'Завершено')).toHaveText(/^1/);
  await expect(metric(page, 'В работе')).toHaveText(/^1/);
  await expect(metric(page, 'Требуют внимания')).toHaveText(/^2/);
  for (const name of ['Динамика создания задач', 'Распределение по статусам', 'Задачи по приоритетам', 'Задачи по исполнителям']) {
    await expect(page.getByRole('figure', { name, exact: true })).toBeVisible();
  }
  await expect(page.locator('.worker-chart > li')).toHaveCount(4);
  await page.getByText('Данные графика', { exact: true }).click();
  const rows = page.getByRole('table', { name: 'Динамика создания задач' }).locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(30);
  const sum = await rows.locator('td').evaluateAll(cells => cells.reduce((total, cell) => total + Number(cell.textContent), 0));
  expect(sum).toBe(6);
  await page.getByLabel('Период создания задач').selectOption('7');
  await expect(metric(page, 'Всего задач')).toHaveText(/^5/);
  await expect(rows).toHaveCount(7);
  await page.getByLabel('Учитывать архив').uncheck();
  await expect(metric(page, 'Всего задач')).toHaveText(/^4/);
  await expect(metric(page, 'Завершено')).toHaveText(/^0/);
  await page.getByLabel('Провайдер задачи').selectOption('codex');
  await expect(metric(page, 'Всего задач')).toHaveText(/^3/);
  await expect(metric(page, 'Требуют внимания')).toHaveText(/^1/);
});

test('refreshes existing data and reports errors with a working retry', async ({ page }) => {
  let failed = true;
  let tasks = fixtures;
  await page.route('**/api/tasks', route => route.fulfill(failed ? { status: 503, json: { error: 'Analytics unavailable' } } : { json: tasks }));
  await openAnalytics(page);
  await expect(page.getByRole('alert')).toContainText('Analytics unavailable');
  await expect(page.getByRole('figure')).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(metric(page, 'Всего задач')).toHaveText(/^6/);
  tasks = [task('new', { createdAt: Date.now() })];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(metric(page, 'Всего задач')).toHaveText(/^1/);
  tasks = [];
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Нет задач для анализа', exact: true })).toBeVisible();
  await expect(metric(page, 'Всего задач')).toHaveText(/^0/);
  await expect(page.getByRole('figure')).toHaveCount(0);
});

test('fits narrow screens in light and dark themes', async ({ page }, testInfo) => {
  const longWorker = worker('long', 'LongWorkerName'.repeat(20));
  await page.route('**/api/tasks', route => route.fulfill({ json: [...fixtures, task('long-name', { workerId: longWorker.id, worker: longWorker })] }));
  await openAnalytics(page);
  for (const scheme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.colorScheme = value, scheme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.getByRole('figure')).toHaveCount(4);
      const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
        html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(size.html).toBeLessThanOrEqual(size.viewport + 1);
      expect(size.body).toBeLessThanOrEqual(size.viewport + 1);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('analytics-dark.png'), fullPage: true });
});

test('populated charts use English labels', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brigd.locale', 'en'));
  await page.route('**/api/tasks', route => route.fulfill({ json: fixtures }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Analytics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible();
  await expect(page.getByRole('figure')).toHaveCount(4);
  await page.getByText('Chart data', { exact: true }).click();
  expect(await page.locator('.analytics').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  await page.getByLabel('Task provider').selectOption('claude');
  await expect(metric(page, 'Total tasks')).toHaveText(/^2/);
});
