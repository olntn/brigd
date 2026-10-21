import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Task, TaskDetail, Worker } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;

async function createWorker(request: APIRequestContext, label: string, ultracode: boolean) {
  const response = await request.post('/api/workers', { headers: origin, data: { name: unique(label), provider: 'claude', effort: 'high', ultracode, communicationStyle: '', avatarUrl: null } });
  expect(response.ok()).toBe(true);
  const worker = await response.json() as Worker;
  expect(worker.ultracode).toBe(ultracode);
  return worker;
}
async function cwdOf(request: APIRequestContext) {
  const info = await (await request.get('/api/info')).json() as AppInfo;
  return info.cwd;
}
async function openEditor(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.getByLabel('Работник', { exact: true })).toBeEnabled();
  return { editor, checkbox: editor.getByRole('checkbox', { name: 'ultracode', exact: true }), help: editor.locator('#task-ultracode-help') };
}
async function fillSimpleTask(editor: Locator, title: string, cwd: string) {
  await editor.locator('[name="title"]').fill(title);
  await editor.locator('[name="instruction"]').fill('Проверь режим ultracode для этой задачи.');
  await editor.locator('[name="cwd"]').fill(cwd);
}
async function savedTask(request: APIRequestContext, title: string) {
  const tasks = await (await request.get('/api/tasks')).json() as Task[];
  const task = tasks.find(item => item.title === title);
  expect(task, `task "${title}" must be listed by GET /api/tasks`).toBeTruthy();
  return task!;
}
function card(page: Page, title: string) {
  return page.locator('article.task-card').filter({ has: page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }) });
}
const badge = (scope: Locator) => scope.locator('.ultracode-badge');

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/info');
  expect(response.ok()).toBe(true);
  expect((await response.json()).mode, 'Ultracode browser tests must never invoke paid CLI adapters').toBe('mock');
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-task-ultracode.png'), fullPage: true });
});

test('simple task: checkbox follows the worker profile until set by hand, then the saved choice shows as a badge', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const [ultra, plain] = await Promise.all([createWorker(request, 'Ультра', true), createWorker(request, 'Обычный', false)]);
  const title = unique('Задача с ultracode');
  const { editor, checkbox, help } = await openEditor(page);
  await expect(checkbox).not.toBeChecked();
  await expect(help).toContainText('Без работника по умолчанию выключен');
  await editor.getByLabel('Работник', { exact: true }).selectOption(ultra.id);
  await expect(checkbox).toBeChecked();
  await expect(help).toContainText('Как в профиле работника: режим ultracode включён');
  await editor.getByLabel('Работник', { exact: true }).selectOption(plain.id);
  await expect(checkbox).not.toBeChecked();
  await expect(help).toContainText('Как в профиле работника: режим ultracode выключен');
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(help).toContainText('Задано для этой задачи: режим ultracode включён');
  await fillSimpleTask(editor, title, await cwdOf(request));
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  expect((await created).ok()).toBe(true);
  await expect(editor).toBeHidden();
  const task = await savedTask(request, title);
  expect(task.ultracode).toBe(true);
  expect(task.workerId).toBe(plain.id);
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.locator('.drawer-badges')).toContainText('ultracode');
  await expect(badge(drawer.locator('.drawer-badges'))).toHaveText('ultracode');
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await expect(badge(card(page, title))).toHaveText('ultracode');
  expect(errors).toEqual([]);
});

test('editing: unchecking stores false, hides the badge and survives reopening despite the profile', async ({ page, request }) => {
  const worker = await createWorker(request, 'Ультра', true);
  const title = unique('Редактируемая задача');
  const task = await (await request.post('/api/tasks', { headers: origin, data: { title, instruction: 'Сводка.', provider: 'claude', workerId: worker.id, cwd: await cwdOf(request), ultracode: true, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false } })).json() as Task;
  expect(task.ultracode).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(badge(drawer.locator('.drawer-badges'))).toBeVisible();
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  const checkbox = editor.getByRole('checkbox', { name: 'ultracode', exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(editor.locator('#task-ultracode-help')).toContainText('Задано для этой задачи: режим ultracode выключен');
  const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/tasks/${task.id}`);
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  expect((await updated).ok()).toBe(true);
  await expect(editor).toBeHidden();
  expect((await savedTask(request, title)).ultracode).toBe(false);
  expect(((await (await request.get(`/api/tasks/${task.id}`)).json()) as TaskDetail).task.ultracode).toBe(false);
  await expect(badge(drawer.locator('.drawer-badges'))).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  await expect(editor.getByLabel('Работник', { exact: true })).toHaveValue(worker.id);
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toHaveJSProperty('indeterminate', false);
  await expect(editor.locator('#task-ultracode-help')).toContainText('Задано для этой задачи');
  await page.keyboard.press('Escape');
  await expect(badge(drawer.locator('.drawer-badges'))).toHaveCount(0);
});

test('inherit path: an untouched checkbox stores null and the badge follows the worker profile', async ({ page, request }) => {
  const worker = await createWorker(request, 'Ультра', true);
  const title = unique('Наследуемая задача');
  const { editor, checkbox, help } = await openEditor(page);
  await editor.getByLabel('Работник', { exact: true }).selectOption(worker.id);
  await expect(checkbox).toBeChecked();
  await expect(help).toContainText('Как в профиле работника');
  await fillSimpleTask(editor, title, await cwdOf(request));
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  expect((await created).request().postDataJSON().ultracode).toBeNull();
  const task = await savedTask(request, title);
  expect(task.ultracode).toBeNull();
  expect(task.workerId).toBe(worker.id);
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(badge(drawer.locator('.drawer-badges'))).toHaveText('ultracode');
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await expect(badge(card(page, title))).toHaveText('ultracode');
  const patched = await request.patch(`/api/workers/${worker.id}`, { headers: origin, data: { ultracode: false } });
  expect(patched.ok()).toBe(true);
  expect(((await patched.json()) as Worker).ultracode).toBe(false);
  await page.reload();
  await expect(card(page, title)).toBeVisible();
  await expect(badge(card(page, title))).toHaveCount(0);
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await expect(drawer.locator('.drawer-badges .worker-identity')).toContainText(worker.name);
  await expect(badge(drawer.locator('.drawer-badges'))).toHaveCount(0);
  expect((await savedTask(request, title)).ultracode).toBeNull();
});

test('complex task: mixed stage profiles make the checkbox indeterminate, uniform profiles settle it', async ({ page, request }) => {
  const [ultra, plain] = await Promise.all([createWorker(request, 'Ультра', true), createWorker(request, 'Обычный', false)]);
  const { editor, checkbox, help } = await openEditor(page);
  await editor.getByRole('button', { name: 'Сложная задача', exact: true }).click();
  await expect(editor.locator('[name="step-worker-1"]')).toBeVisible();
  await expect(checkbox).toHaveJSProperty('indeterminate', false);
  await expect(help).toContainText('Как в профилях работников этапов');
  await editor.locator('[name="step-worker-0"]').selectOption(ultra.id);
  await editor.locator('[name="step-worker-1"]').selectOption(plain.id);
  await expect(checkbox).toHaveJSProperty('indeterminate', true);
  await expect(help).toContainText('у части этапов режим ultracode включён, у остальных нет');
  await editor.locator('[name="step-worker-1"]').selectOption(ultra.id);
  await expect(checkbox).toHaveJSProperty('indeterminate', false);
  await expect(checkbox).toBeChecked();
  await expect(help).toContainText('Как в профилях работников этапов: режим ultracode включён');
  await editor.locator('[name="step-worker-0"]').selectOption(plain.id);
  await editor.locator('[name="step-worker-1"]').selectOption(plain.id);
  await expect(checkbox).toHaveJSProperty('indeterminate', false);
  await expect(checkbox).not.toBeChecked();
  await expect(help).toContainText('Как в профилях работников этапов: режим ultracode выключен');
  await checkbox.check();
  await expect(help).toContainText('Задано для этой задачи: режим ultracode включён на всех этапах');
  await editor.locator('[name="step-worker-0"]').selectOption(ultra.id);
  await expect(checkbox).toHaveJSProperty('indeterminate', true);
  await expect(help).toContainText('Сейчас как в профилях работников: у части этапов режим ultracode включён, у остальных нет');
});
