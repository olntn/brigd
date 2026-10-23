import { expect, test, type Page } from '@playwright/test';
import type { Task, TaskStatus } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const busy: TaskStatus[] = ['queued', 'preparing', 'running', 'cancelling', 'awaiting_merge', 'integrating'];

/** Opens the board and resolves once its change stream is connected. */
async function openBoard(page: Page) {
  const stream = page.waitForResponse(response => new URL(response.url()).pathname === '/api/events');
  await page.goto('/');
  expect((await stream).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
}

test('a task created elsewhere appears in an open tab at once, and an idle tab sends no list requests', async ({ page, context, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  // Earlier scenarios may still finish mock runs; their writes would legitimately reload the board.
  await expect.poll(async () => ((await (await request.get('/api/tasks')).json()) as Task[]).filter(task => busy.includes(task.status)).length, { timeout: 20_000 }).toBe(0);
  await openBoard(page);
  const other = await context.newPage();
  await openBoard(other);

  const lists: number[] = [];
  other.on('request', item => { if (new URL(item.url()).pathname === '/api/tasks' && item.method() === 'GET') lists.push(Date.now()); });
  // The first stream reloads once; afterwards an idle tab stays silent well past the former two-second poll.
  await other.waitForTimeout(1_500);
  lists.length = 0;
  await other.waitForTimeout(5_000);
  expect(lists).toEqual([]);

  const title = unique('Задача из другой вкладки');
  const started = Date.now();
  const created = await page.request.post('/api/tasks', { headers: origin, data: {
    title, instruction: 'Только проверка обновления интерфейса.', provider: 'codex', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(created.status()).toBe(201);
  await expect(other.locator('.task-card').filter({ hasText: title })).toBeVisible({ timeout: 1_500 });
  await expect(page.locator('.task-card').filter({ hasText: title })).toBeVisible({ timeout: 1_500 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(lists.length).toBe(1);

  const task = await created.json() as Task;
  expect((await request.post(`/api/tasks/${task.id}/archive`, { headers: origin, data: {} })).ok()).toBe(true);
  await expect(other.locator('.task-card').filter({ hasText: title })).toHaveCount(0, { timeout: 1_500 });
  await other.close();
});
