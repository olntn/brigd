import { expect, test, type Page } from '@playwright/test';

const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
async function createThroughUi(page: Page, title: string, instruction: string) {
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="instruction"]').fill(instruction);
  await form.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Демонстрационный режим', { exact: true })).toBeVisible();
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('trackt-ui.png'), fullPage: true });
});

test('create, note, clarify, resume exact session, history and reload', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const title = unique('Обзор проекта');
  const drawer = await createThroughUi(page, title, '[ask] Подготовь краткий обзор проекта.');
  await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('Важны простота и воспроизводимость.');
  await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  await expect(drawer.getByText('Важны простота и воспроизводимость.', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const tasks = await (await request.get('/api/tasks')).json();
  const task = tasks.find((row: any) => row.title === title);
  expect(task.latestRun.mock).toBe(true);
  expect(task.latestRun.status).toBe('waiting_input');
  const originalSession = task.latestRun.sessionId;
  const duplicate = await request.post(`/api/tasks/${task.id}/run`, { headers: { Origin: 'http://127.0.0.1:4318' }, data: {} });
  expect(duplicate.status()).toBe(409);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Сначала архитектура и точки входа.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry')).toHaveCount(1);
  await expect(drawer.getByText('Ход 2', { exact: false })).toBeVisible();
  const detail = await (await request.get(`/api/tasks/${task.id}`)).json();
  expect(detail.runs[0].sessionId).toBe(originalSession);
  expect(detail.runs[0].turn).toBe(2);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await expect(page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('trackt-board.png'), fullPage: true });
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: title }).getByText('Важны простота и воспроизводимость.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('editor validation, nested dismiss, interval and pause survive reload', async ({ page, request }) => {
  const title = unique('Регулярная сводка');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  let form = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await form.locator('[name="title"]').fill('Этот черновик будет закрыт');
  await page.keyboard.press('Escape');
  await expect(form).not.toBeVisible();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  form = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(form.locator('[name="title"]')).toHaveValue('');
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="instruction"]').fill('Только прочитай проект и составь сводку.');
  const cwd = await form.locator('[name="cwd"]').inputValue();
  await form.locator('[name="cwd"]').fill('/path-that-does-not-exist-trackt');
  await form.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Рабочая папка');
  await form.locator('[name="cwd"]').fill(cwd);
  await form.getByRole('button', { name: 'По расписанию', exact: true }).click();
  await form.locator('[name="intervalMinutes"]').fill('30');
  await form.getByLabel('Сохранить расписание на паузе').check();
  await form.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.getByText('На паузе', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await editor.locator('[name="title"]').fill('Не сохранять');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const task = (await (await request.get('/api/tasks')).json()).find((row: any) => row.title === title);
  expect(task.paused).toBe(true);
  expect(task.intervalMinutes).toBe(30);
  expect(task.runCount).toBe(0);
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: title }).getByText('На паузе', { exact: true })).toBeVisible();
});

test('cancel a running turn, inspect other status and keep cancellation durable', async ({ page, request }) => {
  const title = unique('Отмена проверки');
  const drawer = await createThroughUi(page, title, 'Демонстрация отмены.');
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByRole('button', { name: /Другие статусы/ }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: title }).locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
  const task = (await (await request.get('/api/tasks')).json()).find((row: any) => row.title === title);
  expect(task.latestRun.status).toBe('cancelled');
});

test('mobile list, provider filter and dialogs remain usable', async ({ page, request }) => {
  const title = unique('Мобильная карточка');
  const info = await (await request.get('/api/info')).json();
  await request.post('/api/tasks', { headers: { Origin: 'http://127.0.0.1:4318' }, data: {
    title, instruction: 'Демонстрация адаптивного интерфейса.', provider: 'claude', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByLabel('Фильтр по агенту', { exact: true }).selectOption('codex');
  await expect(page.getByText('Задачи не найдены', { exact: true })).toBeVisible();
  await page.getByLabel('Фильтр по агенту', { exact: true }).selectOption('claude');
  await page.getByRole('button', { name: `Открыть: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer).toBeVisible();
  const bounds = await drawer.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Закрыть форму', exact: true }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await expect(drawer).not.toBeVisible();
});
