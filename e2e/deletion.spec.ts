import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AppInfo, DocPage, Task, Worker } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
async function createTask(request: APIRequestContext, title: string, patch: Partial<Task> = {}) {
  const info = await (await request.get('/api/info')).json() as AppInfo;
  const response = await request.post('/api/tasks', { headers: origin, data: { title, instruction: 'Короткая сводка.', provider: 'codex', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch } });
  expect(response.status()).toBe(201);
  return await response.json() as Task;
}
async function archived(request: APIRequestContext, title: string) {
  const task = await createTask(request, title);
  expect((await request.post(`/api/tasks/${task.id}/archive`, { headers: origin, data: {} })).ok()).toBe(true);
  return task;
}
async function openArchive(page: Page) {
  await page.getByRole('complementary', { name: 'Основная навигация', exact: true }).getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Архив', exact: true })).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  expect((await (await request.get('/api/info')).json()).mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-deletion.png'), fullPage: true });
});

test('a card is deleted for good from its drawer after confirmation', async ({ page, request }) => {
  const title = unique('Удаляемая задача');
  const task = await createTask(request, title);
  await page.reload();
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('button', { name: 'Удалить', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить задачу навсегда?', exact: true });
  await expect(confirmation).toContainText(`«${title}» будет удалена без возможности восстановления`);
  await expect(confirmation.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(drawer).toBeVisible();

  await drawer.getByRole('button', { name: 'Удалить', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Задача удалена' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true })).toHaveCount(0);
  expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404);
});

test('the archive deletes one card from its row and then everything with «Удалить все»', async ({ page, request }) => {
  const single = await archived(request, unique('Архивная одна'));
  const rest = [await archived(request, unique('Архивная вторая')), await archived(request, unique('Архивная третья'))];
  const board = await createTask(request, unique('Остаётся на доске'));
  await openArchive(page);

  await page.getByRole('button', { name: `Удалить: ${single.title}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить задачу навсегда?', exact: true }).getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(page.getByRole('button', { name: `Открыть: ${single.title}`, exact: true })).toHaveCount(0);
  for (const task of rest) await expect(page.getByRole('button', { name: `Открыть: ${task.title}`, exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Удалить все', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить все задачи из архива?', exact: true });
  await expect(confirmation).toContainText('будут удалены без возможности восстановления');
  await confirmation.getByRole('button', { name: 'Удалить все', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Архив пуст', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить все', exact: true })).toHaveCount(0);
  for (const task of [single, ...rest]) expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404);
  expect((await request.get(`/api/tasks/${board.id}`)).ok()).toBe(true);
});

test('a worker is deleted from its card once no card names it', async ({ page, request }) => {
  const name = unique('Удаляемый работник');
  const worker = await (await request.post('/api/workers', { headers: origin, data: { name, provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null } })).json() as Worker;
  const task = await createTask(request, unique('Задача работника'), { workerId: worker.id });
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  await page.getByRole('button', { name: `Удалить работника: ${name}`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить работника навсегда?', exact: true });
  await confirmation.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('Работник назначен в задачах: 1');
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toBeVisible();

  expect((await request.post(`/api/tasks/${task.id}/purge`, { headers: origin, data: {} })).ok()).toBe(true);
  await page.getByRole('button', { name: `Удалить работника: ${name}`, exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Работник удалён' })).toBeVisible();
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toHaveCount(0);
  expect((await request.get(`/api/workers/${worker.id}`)).status()).toBe(404);
});

test('a documentation page is deleted from the page itself: first to the trash, then for good', async ({ page, request }) => {
  const title = unique('Удаляемая статья');
  const created = await (await request.post('/api/docs', { headers: origin, data: { title } })).json() as DocPage;
  await page.goto(`/#/docs/${created.id}`);
  await expect(page.getByLabel('Название страницы', { exact: true })).toHaveValue(title);

  await page.getByRole('button', { name: 'Удалить страницу', exact: true }).click();
  await page.getByRole('dialog', { name: 'Переместить страницу в корзину?', exact: true }).getByRole('button', { name: 'В корзину', exact: true }).click();
  await expect(page.getByText('Страница в корзине. Восстановите её, чтобы редактировать.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить страницу', exact: true })).toHaveCount(0);

  await page.locator('.doc-notice').getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить страницу навсегда?', exact: true }).getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(page.getByLabel('Название страницы', { exact: true })).toHaveCount(0);
  expect((await request.get(`/api/docs/${created.id}`)).status()).toBe(404);
});
