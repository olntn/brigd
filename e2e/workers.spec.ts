import { expect, test, type Page, type Locator } from '@playwright/test';
import type { Worker, Task, TaskDetail } from '../src/lib/types';

const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const origin = { Origin: 'http://127.0.0.1:4318' };

async function openWorkers(page: Page) {
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Работники/ })).toBeVisible();
}
async function newWorker(page: Page) {
  await openWorkers(page);
  const trigger = page.getByRole('button', { name: 'Новый работник', exact: true });
  await trigger.click();
  const editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
  await expect(editor.locator('[name="workerName"]')).toBeFocused();
  return { editor, trigger };
}
async function imageFile(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#836acd'; context.fillRect(0, 0, 600, 300);
    context.fillStyle = '#f9e6aa'; context.fillRect(100, 50, 200, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}
async function noOverflow(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (dialog) expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-workers.png'), fullPage: true });
});

test('profile avatar, task assignment and immutable identity through edit and resume', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const name = unique('Мира');
  const renamed = unique('Новая Мира');
  const title = unique('Проверка с работником');
  const avatarRequests: { type: string; bytes: number }[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/avatars') {
      avatarRequests.push({ type: req.headers()['content-type'], bytes: req.postDataBuffer()?.byteLength ?? 0 });
    }
  });
  const { editor } = await newWorker(page);
  await editor.locator('[name="workerName"]').fill(name);
  await editor.getByLabel('Модель', { exact: true }).selectOption('codex');
  await editor.getByLabel('Уровень усилий', { exact: true }).selectOption('xhigh');
  await editor.getByLabel('Стиль общения', { exact: true }).fill('Коротко и по-русски. Сначала вывод.');
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page));
  await expect(editor.locator('.worker-avatar img')).toHaveAttribute('src', /^blob:/);
  expect(avatarRequests).toEqual([]);
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(avatarRequests).toHaveLength(1);
  expect(avatarRequests[0].bytes).toBeGreaterThan(0);
  expect(avatarRequests[0].bytes).toBeLessThanOrEqual(256 * 1024);
  expect(['image/webp', 'image/png']).toContain(avatarRequests[0].type);
  const profile = page.getByRole('article', { name: `Работник: ${name}`, exact: true });
  await expect(profile).toBeVisible();
  await expect(profile.locator('img')).toHaveJSProperty('complete', true);
  const dimensions = await profile.locator('img').evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  expect(dimensions.width).toBeGreaterThan(0);
  expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(256);
  const worker = (await (await request.get('/api/workers')).json() as Worker[]).find(row => row.name === name)!;
  expect(worker.avatarUrl).toMatch(/^\/api\/avatars\//);

  await page.getByRole('button', { name: 'Все задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const taskEditor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await taskEditor.locator('[name="title"]').fill(title);
  await taskEditor.locator('[name="instruction"]').fill('[ask] Подготовь обзор проекта.');
  await taskEditor.getByLabel('Работник', { exact: true }).selectOption(worker.id);
  await expect(taskEditor.locator('.provider-options')).toHaveCount(0);
  await expect(taskEditor.locator('.worker-assignment')).toContainText(name);
  await taskEditor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const task = (await (await request.get('/api/tasks')).json() as Task[]).find(row => row.title === title)!;
  const sessionId = task.latestRun!.sessionId;
  await expect(drawer.locator('.comment-question .comment-meta strong')).toHaveText(name);
  await expect(drawer.locator('.comment-question img')).toHaveAttribute('src', worker.avatarUrl!);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();

  await openWorkers(page);
  await page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true }).click();
  const workerEditor = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
  await workerEditor.locator('[name="workerName"]').fill(renamed);
  await workerEditor.getByLabel('Модель', { exact: true }).selectOption('claude');
  await expect(workerEditor.getByLabel('Уровень усилий', { exact: true })).toHaveValue('xhigh');
  await workerEditor.getByLabel('Уровень усилий', { exact: true }).selectOption('max');
  await workerEditor.getByLabel('Модель', { exact: true }).selectOption('codex');
  await expect(workerEditor.getByLabel('Уровень усилий', { exact: true })).toHaveValue('default');
  await workerEditor.getByLabel('Модель', { exact: true }).selectOption('claude');
  await workerEditor.getByLabel('Уровень усилий', { exact: true }).selectOption('max');
  await workerEditor.getByLabel('Стиль общения', { exact: true }).fill('Подробно, с примерами.');
  await workerEditor.getByRole('button', { name: 'Убрать аватар', exact: true }).click();
  await workerEditor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(workerEditor).not.toBeVisible();
  await page.getByRole('button', { name: 'Все задачи', exact: true }).click();
  const taskCard = page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true });
  await expect(taskCard.locator('.worker-identity')).toContainText(name);
  await expect(taskCard.locator('.worker-identity')).not.toContainText(renamed);
  await taskCard.click();
  await expect(drawer.locator('.drawer-badges .worker-identity')).toContainText(name);
  await expect(drawer.locator('.task-properties')).toContainText(renamed);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Сначала архитектура.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  await expect(drawer.locator('.comment-result .comment-meta strong')).toHaveText(name);
  await expect(drawer.locator('.comment-result img')).toHaveAttribute('src', worker.avatarUrl!);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry .worker-identity')).toContainText(name);
  let detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0].sessionId).toBe(sessionId);
  expect(detail.runs[0].worker).toMatchObject({ name, provider: 'codex', effort: 'xhigh', avatarUrl: worker.avatarUrl, communicationStyle: 'Коротко и по-русски. Сначала вывод.' });
  await drawer.getByRole('button', { name: 'Запустить снова', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0].worker).toMatchObject({ name: renamed, provider: 'claude', effort: 'max', avatarUrl: null, communicationStyle: 'Подробно, с примерами.' });
  expect(detail.runs[1].worker?.name).toBe(name);
  await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('archive preserves assigned scheduled task, disallows new assignment, and restore is reversible', async ({ page, request }) => {
  const name = unique('Архивный помощник');
  const title = unique('Назначенная задача');
  const info = await (await request.get('/api/info')).json();
  const worker = await (await request.post('/api/workers', { headers: origin, data: { name, provider: 'claude', effort: 'high', communicationStyle: '', avatarUrl: null } })).json() as Worker;
  const task = await (await request.post('/api/tasks', { headers: origin, data: {
    title, instruction: 'Сводка проекта.', provider: 'codex', workerId: worker.id, cwd: info.cwd,
    schedule: 'interval', intervalMinutes: 60, firstRunAt: Date.now() + 86_400_000, paused: false,
  } })).json() as Task;
  await openWorkers(page);
  await page.getByRole('button', { name: `В архив: ${name}`, exact: true }).click();
  await page.getByRole('button', { name: /Архив работников/ }).click();
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toContainText('В архиве');
  let saved = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(saved.task.workerId).toBe(worker.id);
  expect(saved.task.paused).toBe(false);
  expect(saved.task.nextRunAt).toBe(task.nextRunAt);
  await page.getByRole('button', { name: 'Все задачи', exact: true }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(editor.getByLabel('Работник', { exact: true })).toHaveValue(worker.id);
  await expect(editor.getByText(/Работник в архиве. Можно сохранить/)).toBeVisible();
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  saved = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(saved.task.workerId).toBe(worker.id);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const newTask = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(newTask.locator(`select[name="workerId"] option[value="${worker.id}"]`)).toHaveCount(0);
  await expect(newTask.locator('.provider-options')).toBeVisible();
  await page.keyboard.press('Escape');
  await openWorkers(page);
  await page.getByRole('button', { name: /Архив работников/ }).click();
  await page.getByRole('button', { name: `Восстановить работника: ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `В архив: ${name}`, exact: true })).toBeVisible();
  await page.reload();
  await openWorkers(page);
  await expect(page.getByRole('button', { name: `В архив: ${name}`, exact: true })).toBeVisible();
});

test('invalid images, cancellation, draft reset, focus and deferred upload', async ({ page }) => {
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/avatars') uploads++; });
  let { editor, trigger } = await newWorker(page);
  await editor.locator('[name="workerName"]').fill('Черновик, не сохранять');
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(editor.getByRole('alert')).toContainText('PNG, JPEG или WebP');
  await expect(editor.getByRole('button', { name: 'Создать работника', exact: true })).toBeDisabled();
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(editor.getByRole('alert')).toContainText('до 5 МБ');
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(editor.getByRole('alert')).toContainText('Не удалось прочитать изображение');
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page));
  await expect(editor.locator('.worker-avatar img')).toHaveAttribute('src', /^blob:/);
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(uploads).toBe(0);
  await trigger.click();
  editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
  await expect(editor.locator('[name="workerName"]')).toHaveValue('');
  await expect(editor.locator('.worker-avatar img')).toHaveCount(0);
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(uploads).toBe(0);
});

test('profile saves once and ignores a stale workers fetch after create', async ({ page, request }) => {
  const name = unique('Без дублей');
  let releaseRead!: () => void;
  let releaseSave!: () => void;
  const readGate = new Promise<void>(resolve => releaseRead = resolve);
  const saveGate = new Promise<void>(resolve => releaseSave = resolve);
  let reads = 0;
  let saves = 0;
  await page.route('**/api/workers', async route => {
    if (route.request().method() === 'GET' && ++reads === 1) {
      await readGate;
      await route.fulfill({ json: [] });
    } else if (route.request().method() === 'POST') {
      saves++;
      await saveGate;
      await route.continue();
    } else await route.continue();
  });
  await page.reload();
  const { editor } = await newWorker(page);
  await editor.locator('[name="workerName"]').fill(name);
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
  await editor.evaluate(element => {
    const form = element.querySelector('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  });
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  releaseSave();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toBeVisible();
  releaseRead();
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toBeVisible();
  expect(saves).toBe(1);
  const workers = await (await request.get('/api/workers')).json() as Worker[];
  expect(workers.filter(worker => worker.name === name)).toHaveLength(1);
});

for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} worker editor fits ${size.width}px with ${size.font}px text`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(value => localStorage.setItem('brigd.theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      const { editor } = await newWorker(page);
      await editor.locator('[name="workerName"]').fill('ОченьДлинноеИмяРаботника'.repeat(3));
      await editor.getByLabel('Стиль общения', { exact: true }).fill('ДлиннаяИнструкцияБезПробелов'.repeat(100));
      await noOverflow(page, editor);
      const save = editor.getByRole('button', { name: 'Создать работника', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await noOverflow(page, editor);
      await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
      await noOverflow(page);
    });
  }
}
