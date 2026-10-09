import { expect, test as base, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ModelCatalogEntry, ModelCatalogInput, Provider, Task, TaskDetail, Worker } from '../src/lib/types';
import { MODEL_ID_LIMIT, MODEL_LABEL_LIMIT } from '../src/lib/workers';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const modelsRoute = /\/api\/models(?:\?.*)?$/;
const test = base.extend<{ modelPrefix: string }>({
  modelPrefix: async ({}, use) => { await use(`e2e-model-${crypto.randomUUID()}`); },
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

async function catalog(request: APIRequestContext) {
  const response = await request.get('/api/models');
  expect(response.status()).toBe(200);
  return await response.json() as ModelCatalogEntry[];
}

async function createModel(request: APIRequestContext, input: ModelCatalogInput) {
  const response = await request.post('/api/models', { headers: origin, data: input });
  expect(response.status()).toBe(201);
  return await response.json() as ModelCatalogEntry;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await expect(settings.getByRole('heading', { name: 'Модели', exact: true })).toBeVisible();
  return settings;
}

async function addForm(settings: Locator, provider: Provider = 'codex') {
  await settings.getByRole('button', { name: provider === 'codex' ? 'Добавить модель Codex' : 'Добавить модель Claude Code', exact: true }).click();
  const form = settings.getByRole('form', { name: 'Добавить модель', exact: true });
  await expect(form.getByLabel('Провайдер модели', { exact: true })).toHaveValue(provider);
  await expect(form.getByLabel('Название модели', { exact: true })).toBeFocused();
  return form;
}

async function fillModel(form: Locator, model: ModelCatalogInput) {
  await form.getByLabel('Название модели', { exact: true }).fill(model.label);
  await form.getByLabel('ID модели', { exact: true }).fill(model.modelId);
  await form.getByLabel('Провайдер модели', { exact: true }).selectOption(model.provider);
}

function modelRow(settings: Locator, entry: Pick<ModelCatalogEntry, 'id'>) {
  return settings.locator(`article[data-model-id="${entry.id}"]`);
}

async function editModel(settings: Locator, entry: ModelCatalogEntry, input: ModelCatalogInput) {
  await modelRow(settings, entry).getByRole('button', { name: `Изменить модель: ${entry.label}`, exact: true }).click();
  const form = settings.getByRole('form', { name: 'Редактировать модель', exact: true });
  await expect(form.getByLabel('Название модели', { exact: true })).toBeFocused();
  await fillModel(form, input);
  await form.getByRole('button', { name: 'Сохранить модель', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(modelRow(settings, entry)).toHaveAttribute('aria-label', `Модель: ${input.label}`);
  if (entry.provider === input.provider) {
    await expect(modelRow(settings, entry).getByRole('button', { name: `Изменить модель: ${input.label}`, exact: true })).toBeFocused();
  } else {
    await expect(settings.getByRole('button', { name: input.provider === 'codex' ? 'Добавить модель Codex' : 'Добавить модель Claude Code', exact: true })).toBeFocused();
  }
  return { ...entry, ...input };
}

async function openWorker(page: Page, worker?: Worker) {
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  await page.getByRole('button', { name: worker ? `Изменить работника: ${worker.name}` : 'Новый работник', exact: true }).click();
  return page.getByRole('dialog', { name: worker ? 'Редактировать работника' : 'Новый работник', exact: true });
}

async function expectOptions(editor: Locator, entries: ModelCatalogEntry[], provider: Provider) {
  await editor.getByLabel('Провайдер', { exact: true }).selectOption(provider);
  await expect(editor.locator('[name="workerModel"] option')).toHaveText([
    'По умолчанию CLI', ...entries.filter(entry => entry.provider === provider).map(entry => `${entry.label} · ${entry.modelId}`), 'Другая модель…',
  ]);
}

async function noOverflow(page: Page, settings: Locator) {
  const documentSize = await page.evaluate(() => ({ width: document.documentElement.clientWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(documentSize.html).toBeLessThanOrEqual(documentSize.width + 1);
  expect(documentSize.body).toBeLessThanOrEqual(documentSize.width + 1);
  const size = await settings.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { width: node.clientWidth, content: node.scrollWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(size.content).toBeLessThanOrEqual(size.width + 1);
  expect(size.left).toBeGreaterThanOrEqual(-1);
  expect(size.right).toBeLessThanOrEqual(size.viewportWidth + 1);
  expect(size.top).toBeGreaterThanOrEqual(-1);
  expect(size.bottom).toBeLessThanOrEqual(size.viewportHeight + 1);
}

test.beforeEach(async ({ page, request }) => {
  expect((await (await request.get('/api/info')).json()).mode).toBe('mock');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, request, modelPrefix }, testInfo) => {
  try {
    if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-model-catalog-state.png'), fullPage: true });
  } finally {
    // The mock database is shared with the other specs. Never delete their rows or seeded presets.
    for (const entry of (await catalog(request)).filter(entry => entry.modelId.startsWith(modelPrefix))) {
      expect((await request.delete(`/api/models/${entry.id}`, { headers: origin })).ok()).toBe(true);
    }
  }
});

test('catalog CRUD persists, moves between providers and updates worker choices without a reload', async ({ page, request, modelPrefix }, testInfo) => {
  const initial = { provider: 'codex' as const, modelId: `${modelPrefix}/original`, label: unique('Моя модель') };
  let settings = await openSettings(page);
  const form = await addForm(settings);
  await fillModel(form, initial);
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models' && response.request().method() === 'POST');
  await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  let entry = await response.json() as ModelCatalogEntry;
  await expect(form).toHaveCount(0);
  await expect(settings.getByRole('region', { name: 'Модели Codex', exact: true }).getByRole('article', { name: `Модель: ${initial.label}`, exact: true })).toContainText(initial.modelId);
  await expect(settings.getByRole('status')).toHaveText('Модель добавлена');
  await expect(settings.getByRole('button', { name: 'Добавить модель Codex', exact: true })).toBeFocused();
  await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

  let editor = await openWorker(page);
  await expectOptions(editor, await catalog(request), 'codex');
  await editor.getByLabel('Модель', { exact: true }).selectOption(initial.modelId);
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue(initial.modelId);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();

  settings = await openSettings(page);
  const moved = { provider: 'claude' as const, modelId: `${modelPrefix}/moved`, label: unique('Новое название') };
  entry = await editModel(settings, entry, moved);
  await expect(settings.getByRole('region', { name: 'Модели Codex', exact: true }).locator(`[data-model-id="${entry.id}"]`)).toHaveCount(0);
  await expect(settings.getByRole('region', { name: 'Модели Claude Code', exact: true }).locator(`[data-model-id="${entry.id}"]`)).toContainText(moved.modelId);
  expect(await (await request.get(`/api/models/${entry.id}`)).json()).toMatchObject({ id: entry.id, ...moved });
  await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  editor = await openWorker(page);
  await expectOptions(editor, await catalog(request), 'codex');
  await expect(editor.locator('option', { hasText: initial.modelId })).toHaveCount(0);
  await expectOptions(editor, await catalog(request), 'claude');
  await editor.getByLabel('Модель', { exact: true }).selectOption(moved.modelId);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();

  await page.reload();
  settings = await openSettings(page);
  const row = modelRow(settings, entry);
  await expect(row).toContainText(moved.modelId);
  await settings.screenshot({ path: testInfo.outputPath('brigd-model-catalog-edited.png') });
  let deletes = 0;
  page.on('request', req => { if (req.method() === 'DELETE' && new URL(req.url()).pathname === `/api/models/${entry.id}`) deletes++; });
  await row.getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true }).click();
  await expect(row.getByRole('button', { name: 'Удалить из списка', exact: true })).toBeFocused();
  await row.getByRole('button', { name: 'Отмена удаления', exact: true }).click();
  await expect(row.getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true })).toBeFocused();
  expect(deletes).toBe(0);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true }).click();
  await row.getByRole('button', { name: 'Удалить из списка', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Добавить модель Claude Code', exact: true })).toBeFocused();
  expect(deletes).toBe(1);
  expect((await request.get(`/api/models/${entry.id}`)).status()).toBe(404);
  await page.reload();
  settings = await openSettings(page);
  await expect(modelRow(settings, entry)).toHaveCount(0);
  await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  editor = await openWorker(page);
  await expectOptions(editor, await catalog(request), 'claude');
  await expect(editor.locator('option', { hasText: moved.modelId })).toHaveCount(0);
});

test('closing settings or cancelling clears unsaved add and edit drafts', async ({ page, request, modelPrefix }) => {
  const saved = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/saved`, label: unique('Сохранённая модель') });
  await page.reload();
  let settings = await openSettings(page);
  let form = await addForm(settings, 'claude');
  await fillModel(form, { provider: 'claude', modelId: `${modelPrefix}/draft`, label: 'Не сохранять' });
  await form.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Добавить модель Claude Code', exact: true })).toBeFocused();
  form = await addForm(settings);
  await expect(form.getByLabel('Название модели', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('ID модели', { exact: true })).toHaveValue('');
  await fillModel(form, { provider: 'codex', modelId: `${modelPrefix}/draft`, label: 'Не сохранять' });
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeFocused();
  settings = await openSettings(page);
  await expect(settings.getByRole('form')).toHaveCount(0);
  await modelRow(settings, saved).getByRole('button', { name: `Изменить модель: ${saved.label}`, exact: true }).click();
  form = settings.getByRole('form', { name: 'Редактировать модель', exact: true });
  await form.getByLabel('Название модели', { exact: true }).fill('Незавершённое изменение');
  await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  settings = await openSettings(page);
  await expect(settings.getByRole('form')).toHaveCount(0);
  await modelRow(settings, saved).getByRole('button', { name: `Изменить модель: ${saved.label}`, exact: true }).click();
  await expect(settings.getByLabel('Название модели', { exact: true })).toHaveValue(saved.label);
  await expect(settings.getByLabel('ID модели', { exact: true })).toHaveValue(saved.modelId);
  expect((await catalog(request)).filter(entry => entry.modelId.startsWith(modelPrefix))).toEqual([saved]);
});

test('validation, duplicate rejection and failed create retain the draft for a successful retry', async ({ page, request, modelPrefix }) => {
  const existing = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/duplicate`, label: unique('Исходная') });
  await page.reload();
  const settings = await openSettings(page);
  const form = await addForm(settings);
  let posts = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/models') posts++; });
  await form.getByLabel('Название модели', { exact: true }).fill('Проверка ID');
  await expect(form.getByLabel('Название модели', { exact: true })).toHaveAttribute('maxlength', String(MODEL_LABEL_LIMIT));
  await expect(form.getByLabel('ID модели', { exact: true })).toHaveAttribute('maxlength', String(MODEL_ID_LIMIT));
  await form.getByLabel('ID модели', { exact: true }).fill(`${modelPrefix}/validation`);
  await form.getByLabel('Название модели', { exact: true }).fill('   ');
  await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText(/название модели/i);
  expect(posts).toBe(0);
  await form.getByLabel('Название модели', { exact: true }).fill('Проверка ID');
  for (const invalid of ['--unsafe-option', 'model with spaces', 'model;command', '   ']) {
    await form.getByLabel('ID модели', { exact: true }).fill(invalid);
    await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('ID модели');
    expect(posts).toBe(0);
  }
  await form.getByLabel('ID модели', { exact: true }).fill(existing.modelId);
  await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText(/уже/i);
  await expect(form.getByLabel('ID модели', { exact: true })).toHaveValue(existing.modelId);
  expect(posts).toBe(1);

  let fail = true;
  await page.route(modelsRoute, async route => {
    if (route.request().method() === 'POST' && fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: 'Каталог временно недоступен. Повторите сохранение.' } });
    } else await route.continue();
  });
  // The same explicit ID is valid under the other provider.
  await form.getByLabel('Провайдер модели', { exact: true }).selectOption('claude');
  await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Каталог временно недоступен');
  await expect(form.getByLabel('Название модели', { exact: true })).toHaveValue('Проверка ID');
  await expect(form.getByLabel('ID модели', { exact: true })).toHaveValue(existing.modelId);
  await expect(form.getByLabel('Провайдер модели', { exact: true })).toHaveValue('claude');
  await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(posts).toBe(3);
  const ownEntries = (await catalog(request)).filter(entry => entry.modelId === existing.modelId);
  expect(ownEntries.map(entry => entry.provider).sort()).toEqual(['claude', 'codex']);
});

test('failed edit and deletion retain saved data and can be retried', async ({ page, request, modelPrefix }) => {
  let entry = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/retry`, label: unique('Перед изменением') });
  await page.reload();
  const settings = await openSettings(page);
  let failEdit = true;
  let failDelete = true;
  await page.route(`**/api/models/${entry.id}`, async route => {
    const method = route.request().method();
    if (method === 'PATCH' && failEdit) { failEdit = false; await route.abort('failed'); }
    else if (method === 'DELETE' && failDelete) { failDelete = false; await route.fulfill({ status: 503, json: { error: 'Удаление временно недоступно' } }); }
    else await route.continue();
  });
  await modelRow(settings, entry).getByRole('button', { name: `Изменить модель: ${entry.label}`, exact: true }).click();
  const form = settings.getByRole('form', { name: 'Редактировать модель', exact: true });
  const changed = { provider: 'claude' as const, modelId: `${modelPrefix}/retry-edited`, label: unique('После изменения') };
  await fillModel(form, changed);
  await form.getByRole('button', { name: 'Сохранить модель', exact: true }).click();
  await expect(settings.getByRole('alert')).toBeVisible();
  await expect(form.getByLabel('Название модели', { exact: true })).toHaveValue(changed.label);
  await expect(form.getByLabel('ID модели', { exact: true })).toHaveValue(changed.modelId);
  expect(await (await request.get(`/api/models/${entry.id}`)).json()).toEqual(entry);
  await form.getByRole('button', { name: 'Сохранить модель', exact: true }).click();
  await expect(form).toHaveCount(0);
  entry = { ...entry, ...changed };
  const row = modelRow(settings, entry);
  await row.getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true }).click();
  await row.getByRole('button', { name: 'Удалить из списка', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Удаление временно недоступно');
  await expect(row).toBeVisible();
  expect((await request.get(`/api/models/${entry.id}`)).status()).toBe(200);
  await row.getByRole('button', { name: 'Удалить из списка', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await request.get(`/api/models/${entry.id}`)).status()).toBe(404);
});

test('pending create is single-flight, blocks dismissal and survives a stale catalog response', async ({ page, request, modelPrefix }) => {
  const readGate = gate();
  const saveGate = gate();
  const stale = await catalog(request);
  let holdReads = true;
  let reads = 0;
  let finishedReads = 0;
  let saves = 0;
  await page.route(modelsRoute, async route => {
    if (route.request().method() === 'GET' && holdReads) {
      reads++;
      await readGate.promise;
      await route.fulfill({ json: stale });
      finishedReads++;
    } else if (route.request().method() === 'POST') {
      saves++;
      await saveGate.promise;
      await route.continue();
    } else await route.continue();
  });
  try {
    await page.reload();
    const settings = await openSettings(page);
    const form = await addForm(settings);
    const input = { provider: 'codex' as const, modelId: `${modelPrefix}/singleflight`, label: unique('Одна отправка') };
    await fillModel(form, input);
    await form.getByRole('button', { name: 'Добавить модель', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
    for (const label of ['Название модели', 'ID модели', 'Провайдер модели']) await expect(form.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await form.evaluate(node => node.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    await page.keyboard.press('Escape');
    await page.mouse.click(1, 1);
    await expect(settings).toBeVisible();
    await expect(form).toBeVisible();
    saveGate.release();
    await expect(form).toHaveCount(0);
    const row = settings.getByRole('article', { name: `Модель: ${input.label}`, exact: true });
    await expect(row).toBeVisible();
    // All earlier reads are held, including the refresh started by opening settings.
    // A newer read must not accidentally invalidate the one under test before the save does.
    expect(reads).toBeGreaterThan(0);
    const staleReads = reads;
    holdReads = false;
    readGate.release();
    await expect.poll(() => finishedReads).toBe(staleReads);
    // Wait for the response's browser microtasks and Svelte render, not a fixed network delay.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(row).toBeVisible();
    expect(saves).toBe(1);
    expect((await catalog(request)).filter(entry => entry.modelId === input.modelId)).toHaveLength(1);
  } finally { readGate.release(); saveGate.release(); }
});

test('pending delete cannot submit twice or dismiss settings', async ({ page, request, modelPrefix }) => {
  const entry = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/pending-delete`, label: unique('Удалить один раз') });
  const deleteGate = gate();
  let deletes = 0;
  await page.route(`**/api/models/${entry.id}`, async route => {
    if (route.request().method() === 'DELETE') { deletes++; await deleteGate.promise; }
    await route.continue();
  });
  try {
    await page.reload();
    const settings = await openSettings(page);
    const row = modelRow(settings, entry);
    await row.getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true }).click();
    const confirm = row.getByRole('button', { name: 'Удалить из списка', exact: true });
    await confirm.click();
    await expect(row.getByRole('button', { name: 'Отмена удаления', exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await expect(row.locator('button:enabled')).toHaveCount(0);
    await row.getByRole('button', { name: 'Удаляем…', exact: true }).evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.keyboard.press('Escape');
    await page.mouse.click(1, 1);
    await expect(settings).toBeVisible();
    await expect(row).toBeVisible();
    deleteGate.release();
    await expect(row).toHaveCount(0);
    expect(deletes).toBe(1);
  } finally { deleteGate.release(); }
});

test('a slow first read remains single-flight across polling and eventually loads the catalog', async ({ page, request }) => {
  const entries = await catalog(request);
  const readGate = gate();
  let reads = 0;
  await page.route(modelsRoute, async route => {
    if (route.request().method() === 'GET') {
      reads++;
      await readGate.promise;
      await route.fulfill({ json: entries });
    } else await route.continue();
  });
  try {
    await page.clock.install();
    await page.reload();
    const settings = await openSettings(page);
    await expect(settings.getByRole('status')).toContainText('Загружаем список моделей');
    await expect(settings.locator('.model-catalog-empty')).toHaveCount(0);
    await expect.poll(() => reads).toBe(1);
    const poll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tasks');
    await page.clock.fastForward(6500);
    await (await poll).finished();
    expect(reads).toBe(1);
    readGate.release();
    await expect(settings.locator('article[data-model-id]')).toHaveCount(entries.length);
    await expect(settings.getByRole('status')).toHaveCount(0);
    await expect(settings.getByRole('alert')).toHaveCount(0);
  } finally { readGate.release(); }
});

for (const state of ['empty', 'error'] as const) {
  test(`${state} catalog keeps manual model entry available and retry restores real choices`, async ({ page, request, modelPrefix }) => {
    let useRealCatalog = false;
    const entries = await catalog(request);
    await page.route(modelsRoute, async route => {
      if (route.request().method() !== 'GET' || useRealCatalog) await route.continue();
      else if (state === 'empty') await route.fulfill({ json: [] });
      else await route.fulfill({ status: 503, json: { error: 'Список моделей временно недоступен' } });
    });
    await page.reload();
    const settings = await openSettings(page);
    if (state === 'error') {
      await expect(settings.getByRole('alert')).toContainText('Список моделей временно недоступен');
      await expect(settings.locator('.model-catalog-empty')).toHaveCount(0);
    } else {
      await expect(settings.locator('.model-catalog-empty')).toHaveCount(2);
      await expect(settings.getByRole('alert')).toHaveCount(0);
    }
    await expect(settings.locator('article[data-model-id]')).toHaveCount(0);
    await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    const editor = await openWorker(page);
    for (const provider of ['codex', 'claude'] as const) await expectOptions(editor, [], provider);
    if (state === 'error') await expect(editor.getByRole('button', { name: 'Повторить загрузку моделей', exact: true })).toBeVisible();
    const modelId = `${modelPrefix}/manual`;
    const name = unique('Работник без каталога');
    await editor.getByLabel('Имя работника', { exact: true }).fill(name);
    await editor.getByLabel('Модель', { exact: true }).selectOption('__custom__');
    await editor.getByLabel('ID модели', { exact: true }).fill(modelId);
    await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
    await expect(editor).not.toBeVisible();
    const worker = (await (await request.get('/api/workers')).json() as Worker[]).find(row => row.name === name)!;
    expect(worker.model).toBe(modelId);
    const edit = await openWorker(page, worker);
    await expect(edit.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
    await expect(edit.getByLabel('ID модели', { exact: true })).toHaveValue(modelId);
    useRealCatalog = true;
    if (state === 'error') {
      await edit.getByRole('button', { name: 'Повторить загрузку моделей', exact: true }).click();
      await expect(edit.getByRole('button', { name: 'Повторить загрузку моделей', exact: true })).toHaveCount(0);
      await expect(edit.locator('[name="workerModel"] option')).toHaveText([
        'По умолчанию CLI', ...entries.filter(row => row.provider === worker.provider).map(row => `${row.label} · ${row.modelId}`), 'Другая модель…',
      ]);
      await expect(edit.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
      await expect(edit.getByLabel('ID модели', { exact: true })).toHaveValue(modelId);
    }
    await page.reload();
    const reloaded = await openWorker(page, worker);
    await expect(reloaded.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
    await expect(reloaded.getByLabel('ID модели', { exact: true })).toHaveValue(modelId);
  });
}

for (const change of ['rename', 'ID edit', 'move', 'delete', 'read error'] as const) {
  test(`an in-progress worker choice preserves its exact ID after a catalog ${change}`, async ({ page, request, modelPrefix }) => {
    const entry = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/selected`, label: unique('Выбранная модель') });
    await page.reload();
    const editor = await openWorker(page);
    await editor.getByLabel('Имя работника', { exact: true }).fill(unique('Несохранённый выбор'));
    await editor.getByLabel('Модель', { exact: true }).selectOption(entry.modelId);
    await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue(entry.modelId);
    await expect(editor.getByLabel('ID модели', { exact: true })).toHaveCount(0);

    if (change === 'rename') {
      expect((await request.patch(`/api/models/${entry.id}`, { headers: origin, data: { label: unique('Новое название') } })).ok()).toBe(true);
    } else if (change === 'ID edit') {
      expect((await request.patch(`/api/models/${entry.id}`, { headers: origin, data: { modelId: `${modelPrefix}/new-id` } })).ok()).toBe(true);
    } else if (change === 'move') {
      expect((await request.patch(`/api/models/${entry.id}`, { headers: origin, data: { provider: 'claude' } })).ok()).toBe(true);
    } else if (change === 'delete') {
      expect((await request.delete(`/api/models/${entry.id}`, { headers: origin })).ok()).toBe(true);
    } else {
      await page.route(modelsRoute, async route => {
        if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Обновление каталога не удалось' } });
        else await route.continue();
      });
    }
    // Exercise the ordinary poll while this editor remains open, without resetting the draft.
    if (change === 'rename') {
      await expect(editor.locator(`[name="workerModel"] option[value="${entry.modelId}"]`)).toContainText('Новое название', { timeout: 10_000 });
      await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue(entry.modelId);
      await expect(editor.getByLabel('ID модели', { exact: true })).toHaveCount(0);
    } else {
      await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('__custom__', { timeout: 10_000 });
      await expect(editor.getByLabel('ID модели', { exact: true })).toHaveValue(entry.modelId);
      await editor.getByLabel('ID модели', { exact: true }).fill('');
      await expect(editor.getByLabel('ID модели', { exact: true })).toBeVisible();
      await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
      await editor.getByLabel('ID модели', { exact: true }).fill(entry.modelId);
    }
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workers' && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
    const response = await savedResponse;
    expect(response.status()).toBe(201);
    const worker = await response.json() as Worker;
    expect(worker).toMatchObject({ model: entry.modelId, provider: 'codex' });
    await expect(editor).not.toBeVisible();
    const reopened = await openWorker(page, worker);
    await expect(reopened.getByLabel('Модель', { exact: true })).toHaveValue(change === 'rename' ? entry.modelId : '__custom__');
    if (change !== 'rename') await expect(reopened.getByLabel('ID модели', { exact: true })).toHaveValue(entry.modelId);
  });
}

test('catalog rename, model ID edit and deletion preserve worker and live/history run model IDs', async ({ page, request, modelPrefix }, testInfo) => {
  let entry = await createModel(request, { provider: 'codex', modelId: `${modelPrefix}/frozen`, label: unique('Запущенная модель') });
  const workerResponse = await request.post('/api/workers', { headers: origin, data: {
    name: unique('Хранитель ID'), provider: 'codex', model: entry.modelId, effort: 'high', communicationStyle: '', avatarUrl: null,
  } });
  expect(workerResponse.status()).toBe(201);
  const worker = await workerResponse.json() as Worker;
  const info = await (await request.get('/api/info')).json();
  const taskResponse = await request.post('/api/tasks', { headers: origin, data: {
    title: unique('Каталог и история'), instruction: '[ask] Проверь сохранённую модель.', provider: 'codex', workerId: worker.id, cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json() as Task;
  await page.reload();
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const before = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  const originalRun = before.runs[0];
  expect(originalRun.worker?.model).toBe(worker.model);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();

  const assertSnapshots = async () => {
    expect(await (await request.get(`/api/workers/${worker.id}`)).json()).toMatchObject({ model: worker.model, provider: worker.provider });
    const detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
    expect(detail.task.worker?.model).toBe(worker.model);
    expect(detail.runs[0].worker).toEqual(originalRun.worker);
    expect(detail.runs[0].sessionId).toBe(originalRun.sessionId);
  };
  let settings = await openSettings(page);
  entry = await editModel(settings, entry, { ...entry, label: unique('Переименованная модель') });
  await assertSnapshots();
  entry = await editModel(settings, entry, { ...entry, modelId: `${modelPrefix}/replacement` });
  await assertSnapshots();
  await settings.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  let editor = await openWorker(page, worker);
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
  await expect(editor.getByLabel('ID модели', { exact: true })).toHaveValue(worker.model!);
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await assertSnapshots();
  settings = await openSettings(page);
  await modelRow(settings, entry).getByRole('button', { name: `Удалить модель: ${entry.label}`, exact: true }).click();
  await modelRow(settings, entry).getByRole('button', { name: 'Удалить из списка', exact: true }).click();
  await expect(modelRow(settings, entry)).toHaveCount(0);
  await assertSnapshots();
  await page.reload();
  editor = await openWorker(page, worker);
  await expect(editor.getByLabel('Модель', { exact: true })).toHaveValue('__custom__');
  await expect(editor.getByLabel('ID модели', { exact: true })).toHaveValue(worker.model!);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  await drawer.locator('.current-run-instructions summary').click();
  await expect(drawer.locator('.current-run-instructions .worker-run-settings')).toContainText(worker.model!);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Продолжай с прежней моделью.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  await assertSnapshots();
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry')).toContainText(worker.model!);
  await drawer.locator('.run-entry').screenshot({ path: testInfo.outputPath('brigd-model-catalog-frozen-run.png') });
  const resumed = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(resumed.runs[0]).toMatchObject({ id: originalRun.id, sessionId: originalRun.sessionId, turn: 2 });
  await expect(drawer.getByRole('button', { name: 'Запустить снова', exact: true })).toHaveCount(0);
  await drawer.getByRole('tab', { name: /Комментарии/ }).click();
  await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('[ask] Уточни результат с прежней моделью.');
  await drawer.getByRole('button', { name: 'Отправить агенту', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const rerun = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(rerun.runs.map(run => run.worker?.model)).toEqual([worker.model, worker.model]);
  expect(rerun.runs[1].worker).toEqual(originalRun.worker);
  expect(rerun.runs[0]).toMatchObject({ trigger: 'followup', sessionId: originalRun.sessionId, worker: originalRun.worker });
  await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} catalog fits ${size.width}px with ${size.font}px text and maximum-length names`, async ({ page, request, modelPrefix }, testInfo) => {
      const entry = await createModel(request, {
        provider: 'codex', modelId: `${modelPrefix}/${'m'.repeat(128)}`.slice(0, MODEL_ID_LIMIT), label: 'ОченьДлинноеНазваниеБезПробелов'.repeat(3).slice(0, MODEL_LABEL_LIMIT),
      });
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(value => localStorage.setItem('brigd.theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      const settings = await openSettings(page);
      const row = modelRow(settings, entry);
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport();
      await noOverflow(page, settings);
      await settings.screenshot({ path: testInfo.outputPath(`brigd-model-catalog-${theme}-${size.width}-${size.font}.png`) });
      await row.getByRole('button', { name: `Изменить модель: ${entry.label}`, exact: true }).click();
      const form = settings.getByRole('form', { name: 'Редактировать модель', exact: true });
      await expect(form.getByLabel('Название модели', { exact: true })).toHaveValue(entry.label);
      await expect(form.getByLabel('ID модели', { exact: true })).toHaveValue(entry.modelId);
      await noOverflow(page, settings);
      const save = form.getByRole('button', { name: 'Сохранить модель', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await settings.screenshot({ path: testInfo.outputPath(`brigd-model-catalog-form-${theme}-${size.width}-${size.font}.png`) });
      await save.click();
      await expect(form).toHaveCount(0);
      await expect(row).toBeVisible();
      await noOverflow(page, settings);
    });
  }
}
