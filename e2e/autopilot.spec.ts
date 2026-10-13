import { expect, test } from '@playwright/test';
import type { AutopilotOverview, Task, TaskDetail } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  expect((await request.patch('/api/settings/autopilot', { headers: origin, data: { integrationChecks: null } })).ok()).toBe(true);
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
  // Leftover pool tasks from earlier runs stay out of this session's queue.
  const tasks = await (await request.get('/api/tasks')).json() as Task[];
  for (const task of tasks) {
    if (task.schedule !== 'auto' || task.archivedAt !== null || task.paused) continue;
    expect((await request.patch(`/api/tasks/${task.id}`, { headers: origin, data: { paused: true } })).ok()).toBe(true);
  }
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test('autopilot tab shows the queue, starts pool tasks once enabled and reports the session', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const info = await (await request.get('/api/info')).json();
  const title = unique('Ночная задача');
  const created = await request.post('/api/tasks', { headers: origin, data: {
    title, instruction: 'Проверь проект и опиши структуру.', provider: 'codex', cwd: info.cwd, schedule: 'auto', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(created.status()).toBe(201);
  const task = await created.json() as Task;

  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Автопилот', exact: true })).toBeVisible();
  const status = page.getByRole('region', { name: 'Состояние автопилота' });
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  const queue = page.getByRole('region', { name: 'Очередь автопилота' });
  await expect(queue.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();

  // Deferring keeps the task in autopilot mode but out of the queue; returning it restores the order.
  await queue.getByRole('button', { name: `Отложить: ${title}`, exact: true }).click();
  await expect(queue.getByRole('button', { name: `Вернуть в очередь: ${title}`, exact: true })).toBeVisible();
  await queue.getByRole('button', { name: `Вернуть в очередь: ${title}`, exact: true }).click();
  await expect(queue.getByRole('button', { name: `Отложить: ${title}`, exact: true })).toBeVisible();

  await status.getByLabel('Остановить в').uncheck();
  await status.getByRole('button', { name: 'Включить автопилот', exact: true }).click();
  await expect(status.getByText('Включён', { exact: true })).toBeVisible();
  await expect(queue.getByText('Очередь пуста', { exact: true })).toBeVisible();
  const report = page.getByRole('region', { name: 'Итоги сессии автопилота' });
  await expect(report.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();
  await expect(report.getByText('Завершено', { exact: true })).toBeVisible();

  const overview = await (await request.get('/api/autopilot')).json() as AutopilotOverview;
  expect(overview.enabled).toBe(true);
  expect(overview.attempts.map(run => run.taskId)).toEqual([task.id]);
  const detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0]).toMatchObject({ trigger: 'autopilot', status: 'completed', mock: true });

  await status.getByRole('button', { name: 'Выключить автопилот', exact: true }).click();
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  await expect(status.getByText(/выключен вручную/)).toBeVisible();

  // The run history names the trigger.
  await report.getByRole('button', { name: `Открыть: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-meta').getByText('Автопилот', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
