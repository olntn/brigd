import { expect, test, type Page, type Locator } from '@playwright/test';
import type { ModelCatalogEntry, Worker, Task, TaskDetail } from '../src/lib/types';

const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const origin = { Origin: 'http://127.0.0.1:4318' };
const privateInstructions = 'PRIVATE_WORKER_INSTRUCTIONS: Коротко и по-русски. Сначала вывод.';
const changedPrivateInstructions = 'PRIVATE_WORKER_INSTRUCTIONS_EDITED: Подробно, с примерами.';
const publicDescription = 'Помогает разобраться в архитектуре проекта.';
const changedDescription = 'Редактор технических обзоров и итоговых отчётов.';

async function noPrivateInstructions(scope: Locator) {
  await expect(scope).not.toContainText('PRIVATE_WORKER_INSTRUCTIONS');
  expect(await scope.evaluate(element => element.outerHTML)).not.toContain('PRIVATE_WORKER_INSTRUCTIONS');
  await expect(scope.getByText('Стиль общения', { exact: true })).toHaveCount(0);
  await expect(scope.getByText('Личные инструкции', { exact: true })).toHaveCount(0);
}

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

test.beforeEach(async ({ page, request }) => {
  expect((await (await request.get('/api/info')).json()).mode, 'Worker browser tests must never invoke paid CLI adapters').toBe('mock');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-workers.png'), fullPage: true });
});

test('profile avatar, task assignment and immutable identity through edit and resume', async ({ page, request }, testInfo) => {
  const catalog = await (await request.get('/api/models')).json() as ModelCatalogEntry[];
  const codex = catalog.find(model => model.provider === 'codex')!;
  const claude = catalog.find(model => model.provider === 'claude')!;
  expect(codex).toBeDefined();
  expect(claude).toBeDefined();
  const codexModel = codex.modelId;
  const claudeModel = claude.modelId;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const name = unique('Мира');
  const renamed = unique('Новая Мира');
  const title = unique('Проверка с работником');
  const avatarRequests: { type: string }[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/avatars') {
      avatarRequests.push({ type: req.headers()['content-type'] });
    }
  });
  const { editor } = await newWorker(page);
  await editor.locator('[name="workerName"]').fill(name);
  await editor.locator('[name="workerName"]').press('Tab');
  await expect(editor.getByLabel('Описание', { exact: true })).toBeFocused();
  await editor.getByLabel('Описание', { exact: true }).fill(publicDescription);
  await expect(editor.getByLabel('Описание', { exact: true })).toHaveAttribute('maxlength', '1000');
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).not.toHaveAttribute('placeholder');
  await expect(editor.getByLabel('Стиль общения', { exact: true })).toHaveCount(0);
  await editor.getByLabel('Провайдер', { exact: true }).selectOption('codex');
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await editor.getByLabel('Модель', { exact: true }).selectOption(codexModel);
  await editor.getByLabel('Уровень усилий', { exact: true }).selectOption('xhigh');
  await editor.getByLabel('Личные инструкции', { exact: true }).fill(privateInstructions);
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page));
  await expect(editor.locator('.worker-avatar img')).toHaveAttribute('src', /^blob:/);
  expect(avatarRequests).toEqual([]);
  await editor.screenshot({ path: testInfo.outputPath('brigd-worker-profile-before-save.png') });
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(avatarRequests).toHaveLength(1);
  expect(['image/webp', 'image/png']).toContain(avatarRequests[0].type);
  const profile = page.getByRole('article', { name: `Работник: ${name}`, exact: true });
  await expect(profile).toBeVisible();
  await expect(profile.locator('img')).toHaveJSProperty('complete', true);
  const dimensions = await profile.locator('img').evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  expect(dimensions).toEqual({ width: 256, height: 128 });
  const worker = (await (await request.get('/api/workers')).json() as Worker[]).find(row => row.name === name)!;
  expect(worker.avatarUrl).toMatch(/^\/api\/avatars\//);
  expect(worker.model).toBe(codexModel);
  expect(worker).toMatchObject({ description: publicDescription, communicationStyle: privateInstructions });
  await expect(profile.locator('.worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(page.locator('body'));
  await expect(profile.locator('.worker-model-label')).toHaveText(codex.label);
  // Chromium may omit browser Blob bodies from Playwright request events.
  // Assert the real persisted bytes rather than treating a missing event body as empty.
  const savedAvatar = await request.get(worker.avatarUrl!);
  expect(savedAvatar.status()).toBe(200);
  expect(savedAvatar.headers()['content-type']).toBe(avatarRequests[0].type);
  const savedAvatarBytes = await savedAvatar.body();
  expect(savedAvatarBytes.byteLength).toBeGreaterThan(0);
  expect(savedAvatarBytes.byteLength).toBeLessThanOrEqual(256 * 1024);
  await expect(profile.locator('img')).toHaveAttribute('src', worker.avatarUrl!);
  await page.screenshot({ path: testInfo.outputPath('brigd-workers-with-avatar.png'), fullPage: true });

  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const taskEditor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await taskEditor.locator('[name="title"]').fill(title);
  await taskEditor.locator('[name="instruction"]').fill('[ask] Подготовь обзор проекта.');
  await taskEditor.getByLabel('Работник', { exact: true }).selectOption(worker.id);
  await expect(taskEditor.locator('.provider-options')).toHaveCount(0);
  await expect(taskEditor.locator('.worker-assignment')).toContainText(name);
  await expect(taskEditor.locator('.worker-assignment')).toContainText(codex.label);
  await expect(taskEditor.locator('.worker-assignment .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(taskEditor);
  await taskEditor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const task = (await (await request.get('/api/tasks')).json() as Task[]).find(row => row.title === title)!;
  const sessionId = task.latestRun!.sessionId;
  await expect(drawer.locator('.comment-question .comment-meta strong')).toHaveText(name);
  await expect(drawer.locator('.comment-question img')).toHaveAttribute('src', worker.avatarUrl!);
  await expect(drawer.locator('.comment-question .worker-description')).toHaveText(publicDescription);
  await expect(drawer.locator('.drawer-badges .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(drawer);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();

  await openWorkers(page);
  await page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true }).click();
  const workerEditor = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
  await expect(workerEditor.getByLabel('Описание', { exact: true })).toHaveValue(publicDescription);
  await expect(workerEditor.getByLabel('Личные инструкции', { exact: true })).toHaveValue(privateInstructions);
  await workerEditor.getByLabel('Описание', { exact: true }).fill(changedDescription);
  await workerEditor.locator('[name="workerName"]').fill(renamed);
  await expect(workerEditor.getByLabel('Модель', { exact: true })).toHaveValue(codexModel);
  await workerEditor.getByLabel('Провайдер', { exact: true }).selectOption('claude');
  await expect(workerEditor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await workerEditor.getByLabel('Модель', { exact: true }).selectOption(claudeModel);
  await expect(workerEditor.getByLabel('Уровень усилий', { exact: true })).toHaveValue('xhigh');
  await workerEditor.getByLabel('Уровень усилий', { exact: true }).selectOption('max');
  await workerEditor.getByLabel('Провайдер', { exact: true }).selectOption('codex');
  await expect(workerEditor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await expect(workerEditor.getByLabel('Уровень усилий', { exact: true })).toHaveValue('default');
  await workerEditor.getByLabel('Провайдер', { exact: true }).selectOption('claude');
  await expect(workerEditor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await workerEditor.getByLabel('Модель', { exact: true }).selectOption(claudeModel);
  await workerEditor.getByLabel('Уровень усилий', { exact: true }).selectOption('max');
  await workerEditor.getByLabel('Личные инструкции', { exact: true }).fill(changedPrivateInstructions);
  await workerEditor.getByRole('button', { name: 'Убрать аватар', exact: true }).click();
  await workerEditor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(workerEditor).not.toBeVisible();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  const taskCard = page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true });
  await expect(taskCard.locator('.worker-identity')).toContainText(name);
  await expect(taskCard.locator('.worker-identity')).not.toContainText(renamed);
  await expect(taskCard.locator('.worker-model-label')).toHaveText(`Codex · ${codex.label}`);
  await expect(taskCard.locator('.worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(taskCard);
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  const taskRow = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `Открыть: ${title}`, exact: true }) });
  await expect(taskRow.locator('.worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(taskRow);
  await page.getByRole('button', { name: 'Доска', exact: true }).click();
  await taskCard.click();
  await expect(drawer.locator('.drawer-badges .worker-identity')).toContainText(name);
  await expect(drawer.locator('.task-properties')).toContainText(renamed);
  await expect(drawer.locator('.task-properties')).toContainText(claude.label);
  await expect(drawer.locator('.drawer-badges .worker-description')).toHaveText(publicDescription);
  await expect(drawer.locator('.task-properties .worker-description')).toHaveText(changedDescription);
  await drawer.locator('.current-run-instructions summary').click();
  await expect(drawer.locator('.current-run-instructions .worker-run-settings')).toContainText(codexModel);
  await expect(drawer.locator('.current-run-instructions .worker-run-settings')).not.toContainText(claudeModel);
  await expect(drawer.locator('.current-run-instructions .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(drawer);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Сначала архитектура.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  await expect(drawer.locator('.comment-result .comment-meta strong')).toHaveText(name);
  await expect(drawer.locator('.comment-result img')).toHaveAttribute('src', worker.avatarUrl!);
  await expect(drawer.locator('.comment-result .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(drawer);
  await drawer.locator('.comment-result').screenshot({ path: testInfo.outputPath('brigd-worker-frozen-comment.png') });
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry .run-meta .worker-identity')).toContainText(name);
  await expect(drawer.locator('.run-entry .run-meta .worker-model-label')).toHaveText(`Codex · ${codex.label}`);
  await expect(drawer.locator('.run-entry .run-meta .worker-description')).toHaveText(publicDescription);
  await drawer.locator('.run-entry .run-instruction-snapshot summary').click();
  await expect(drawer.locator('.run-entry .worker-run-settings .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(drawer);
  await drawer.locator('.run-entry').screenshot({ path: testInfo.outputPath('brigd-worker-frozen-run.png') });
  let detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0].sessionId).toBe(sessionId);
  expect(detail.runs[0].worker).toMatchObject({ name, provider: 'codex', model: codexModel, effort: 'xhigh', avatarUrl: worker.avatarUrl, communicationStyle: privateInstructions, description: publicDescription });
  await drawer.getByRole('button', { name: 'Запустить снова', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0].worker).toMatchObject({ name: renamed, provider: 'claude', model: claudeModel, effort: 'max', avatarUrl: null, communicationStyle: changedPrivateInstructions, description: changedDescription });
  expect(detail.runs[1].worker).toMatchObject({ name, description: publicDescription, communicationStyle: privateInstructions });
  await expect(drawer.locator('.drawer-badges .worker-description')).toHaveText(changedDescription);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  const latestEntry = drawer.locator('.run-entry').nth(0);
  const historicalEntry = drawer.locator('.run-entry').nth(1);
  await expect(latestEntry.locator('.run-meta .worker-description')).toHaveText(changedDescription);
  await expect(historicalEntry.locator('.run-meta .worker-description')).toHaveText(publicDescription);
  for (const entry of [latestEntry, historicalEntry]) {
    const snapshot = entry.locator('.run-instruction-snapshot');
    if (!await snapshot.evaluate(element => (element as HTMLDetailsElement).open)) await snapshot.locator('summary').click();
  }
  await expect(latestEntry.locator('.worker-run-settings .worker-description')).toHaveText(changedDescription);
  await expect(historicalEntry.locator('.worker-run-settings .worker-description')).toHaveText(publicDescription);
  await noPrivateInstructions(drawer);
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
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
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
  await editor.getByLabel('Описание', { exact: true }).fill('Несохранённое описание');
  await editor.getByLabel('Личные инструкции', { exact: true }).fill(privateInstructions);
  await editor.getByLabel('Модель', { exact: true }).selectOption('__custom__');
  await editor.getByLabel('ID модели', { exact: true }).fill('custom-draft-model');
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
  await expect(editor.getByLabel('Описание', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).not.toHaveAttribute('placeholder');
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('ID модели', { exact: true })).toHaveCount(0);
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

test('custom model validation, save retry, reload and provider reset preserve explicit choices', async ({ page, request }) => {
  const catalog = await (await request.get('/api/models')).json() as ModelCatalogEntry[];
  const name = unique('Модель по ID');
  const customModel = 'org/custom-model-v1:preview+fast@region[1m]';
  let saves = 0;
  await page.route('**/api/workers', async route => {
    if (route.request().method() === 'POST' && ++saves === 1) {
      await route.fulfill({ status: 503, json: { error: 'Профиль пока не сохранён. Попробуйте ещё раз.' } });
    } else await route.continue();
  });
  const { editor } = await newWorker(page);
  await editor.getByLabel('Имя работника', { exact: true }).fill(name);
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('ID модели', { exact: true })).toHaveCount(0);
  await expect(editor.locator('[name="workerModel"] option')).toHaveText([
    'По умолчанию CLI', ...catalog.filter(model => model.provider === 'codex').map(model => `${model.label} · ${model.modelId}`), 'Другая модель…',
  ]);
  await editor.getByLabel('Модель', { exact: true }).selectOption('__custom__');
  for (const invalid of ['--unsafe-option', 'model with spaces', 'model;command', '   ']) {
    await editor.getByLabel('ID модели', { exact: true }).fill(invalid);
    await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('ID модели');
    await expect(editor).toBeVisible();
    expect(saves).toBe(0);
  }
  await editor.getByLabel('ID модели', { exact: true }).fill(customModel);
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Профиль пока не сохранён');
  await expect(editor.getByLabel('ID модели', { exact: true })).toHaveValue(customModel);
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(saves).toBe(2);
  const worker = (await (await request.get('/api/workers')).json() as Worker[]).find(item => item.name === name)!;
  expect(worker.model).toBe(customModel);
  await expect(page.getByRole('article', { name: `Работник: ${name}`, exact: true })).toContainText(customModel);

  await page.reload();
  await openWorkers(page);
  await page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
  await expect(edit.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
  await expect(edit.getByLabel('ID модели', { exact: true })).toHaveValue(customModel);
  await edit.getByLabel('Провайдер', { exact: true }).selectOption('claude');
  await expect(edit.getByLabel('Модель', { exact: true })).toHaveValue('');
  await expect(edit.getByLabel('ID модели', { exact: true })).toHaveCount(0);
  await expect(edit.locator('[name="workerModel"] option')).toHaveText([
    'По умолчанию CLI', ...catalog.filter(model => model.provider === 'claude').map(model => `${model.label} · ${model.modelId}`), 'Другая модель…',
  ]);
  await edit.getByLabel('Модель', { exact: true }).selectOption('__custom__');
  await expect(edit.getByLabel('ID модели', { exact: true })).toHaveValue('');
  await edit.getByLabel('Модель', { exact: true }).selectOption('');
  await edit.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(edit).not.toBeVisible();
  const saved = (await (await request.get('/api/workers')).json() as Worker[]).find(item => item.id === worker.id)!;
  expect(saved).toMatchObject({ provider: 'claude', model: null });
  await page.reload();
  await openWorkers(page);
  await page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true }).click();
  await expect(edit.getByLabel('Провайдер', { exact: true })).toHaveValue('claude');
  await expect(edit.getByLabel('Модель', { exact: true })).toHaveValue('');
  await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
});

for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} worker editor fits ${size.width}px with ${size.font}px text`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(value => localStorage.setItem('brigd.theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      const { editor } = await newWorker(page);
      const name = unique('ОченьДлинноеИмяРаботника'.repeat(3).slice(0, 71));
      await editor.locator('[name="workerName"]').fill(name);
      await editor.getByLabel('Модель', { exact: true }).selectOption('__custom__');
      await editor.getByLabel('ID модели', { exact: true }).fill('m'.repeat(128));
      await expect(editor.getByLabel('ID модели', { exact: true })).toHaveAttribute('maxlength', '128');
      const longDescription = 'ДлинноеОписаниеБезПробелов'.repeat(40).slice(0, 1000);
      await editor.getByLabel('Описание', { exact: true }).fill(longDescription);
      await editor.getByLabel('Личные инструкции', { exact: true }).fill(`${privateInstructions} ${'ДлиннаяИнструкцияБезПробелов'.repeat(100)}`);
      await expect(editor.getByLabel('Личные инструкции', { exact: true })).not.toHaveAttribute('placeholder');
      await noOverflow(page, editor);
      await editor.evaluate(node => { node.scrollTop = 0; });
      await editor.screenshot({ path: testInfo.outputPath(`brigd-worker-editor-${theme}-${size.width}-${size.font}-top.png`) });
      const save = editor.getByRole('button', { name: 'Создать работника', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await noOverflow(page, editor);
      await editor.screenshot({ path: testInfo.outputPath(`brigd-worker-editor-${theme}-${size.width}-${size.font}-fields.png`) });
      await save.click();
      await expect(editor).not.toBeVisible();
      const card = page.getByRole('article', { name: `Работник: ${name}`, exact: true });
      await expect(card.locator('.worker-model-label')).toHaveText('m'.repeat(128));
      await expect(card.locator('.worker-description')).toHaveText(longDescription);
      await noPrivateInstructions(card);
      await noOverflow(page);
      await card.screenshot({ path: testInfo.outputPath(`brigd-worker-card-${theme}-${size.width}-${size.font}.png`) });
    });
  }
}
