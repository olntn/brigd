import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, DocPageSummary, Task, TaskInput } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
// A valid 1×1 PNG; the server re-decodes it before accepting the upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function clearDocs(request: APIRequestContext) {
  for (const page of await (await request.get('/api/docs')).json() as DocPageSummary[]) await request.delete(`/api/docs/${page.id}`, { headers: origin });
  for (const page of await (await request.get('/api/docs/trash')).json() as DocPageSummary[]) await request.post(`/api/docs/${page.id}/purge`, { headers: origin, data: {} });
}
async function createPage(request: APIRequestContext, title: string, markdown: string, parentId: string | null = null) {
  const response = await request.post('/api/docs', { headers: origin, data: { title, parentId, markdown } });
  expect(response.status()).toBe(201);
  return await response.json() as DocPage;
}
async function createTask(request: APIRequestContext, patch: Partial<TaskInput> = {}) {
  const info = await (await request.get('/api/info')).json();
  const response = await request.post('/api/tasks', { headers: origin, data: { title: unique('Задача'), instruction: 'Mock only.', provider: 'codex', cwd: info.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch } });
  expect(response.status()).toBe(201);
  return await response.json() as Task;
}
const blockTypes = (page: Page) => page.locator('.doc-block').evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => name.startsWith('doc-') && name !== 'doc-block')!.slice(4)));
const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'Сохранено' })).toBeVisible({ timeout: 5000 });

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  await clearDocs(request);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, request }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-docs-blocks-state.png'), fullPage: true });
  await clearDocs(request);
});

test('structured blocks: toggles hide content, tables edit by cell, task cards link to the board and undo restores choices', async ({ page, request }) => {
  const task = await createTask(request, { title: unique('Собрать релиз') });
  const doc = await createPage(request, unique('Архитектура'), [
    '# Обзор', '', 'Абзац с **жирным**.', '', '> 💡 Выноска из Markdown становится цитатой', '',
    '<details>', '<summary>Подробности</summary>', '', 'Скрытый текст.', '', '</details>', '',
    '| Команда | Что делает |', '| --- | --- |', '| verify | всё |', '', '[[toc]]', '', '## Проверки', '',
  ].join('\n'));
  await page.goto(`/#/docs/${doc.id}`);
  await expect(page.locator('.doc-block')).toHaveCount(8);
  expect(await blockTypes(page)).toEqual(['heading1', 'paragraph', 'quote', 'toggle', 'paragraph', 'table', 'toc', 'heading2']);
  await expect(page.getByRole('navigation', { name: 'Оглавление страницы' }).getByRole('button')).toHaveText(['Обзор', 'Проверки']);
  await page.getByRole('button', { name: 'Свернуть блок' }).click();
  await expect(page.locator('.doc-block')).toHaveCount(7);
  await expect(page.getByText('Скрытый текст.')).toBeHidden();
  await saved(page);
  await page.getByRole('button', { name: 'Развернуть блок' }).click();
  await expect(page.getByText('Скрытый текст.')).toBeVisible();
  const cell = page.getByRole('textbox', { name: 'Ячейка 2:2' });
  await cell.click();
  const input = page.locator('.doc-cell-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('всё');
  await page.keyboard.type(' сразу');
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc-table tr')).toHaveCount(3);
  await page.keyboard.type('новая');
  await page.keyboard.press('Escape');
  await expect(page.locator('.doc-cell-input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Столбец', exact: true }).click();
  await saved(page);
  let content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks[5]).toMatchObject({ type: 'table', rows: [['Команда', 'Что делает', ''], ['verify', 'всё сразу', ''], ['', 'новая', '']] });
  // A task card chosen through the slash menu, then undone and redone.
  await page.locator('.doc-block-view').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/зада');
  await page.getByRole('option', { name: /^Задача/ }).click();
  const search = page.getByLabel('Поиск задачи');
  await expect(search).toBeFocused();
  await search.fill('релиз');
  await page.getByRole('option', { name: new RegExp(task.title) }).click();
  const card = page.locator('.doc-task-card');
  await expect(card).toContainText(task.title);
  await expect(card).toContainText('К запуску');
  await saved(page);
  await page.keyboard.press('Control+z');
  await expect(page.getByLabel('Поиск задачи')).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(card).toContainText(task.title);
  await card.getByRole('button', { name: 'Открыть' }).click();
  const drawer = page.getByRole('dialog').filter({ hasText: task.title });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await saved(page);
  content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks.at(-1)).toMatchObject({ type: 'task', taskId: task.id });
  // A callout keeps its icon and colour through the block menu and the slash menu.
  await page.locator('.doc-block-view').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/вын');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Запомнить это');
  await page.getByRole('button', { name: 'Сменить иконку выноски' }).click();
  await page.getByLabel('Цвет выноски').selectOption('yellow');
  await saved(page);
  content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks[1]).toMatchObject({ type: 'callout', text: 'Запомнить это', icon: '📌', color: 'yellow' });
  const exported = await (await request.get(`/api/docs/${doc.id}/export`)).json();
  expect(exported.markdown).toContain('> 📌 Запомнить это');
  expect(exported.markdown).toContain(`@task(${task.id})`);
});

test('images are uploaded to the page, shown inline and replaced', async ({ page, request }) => {
  const doc = await createPage(request, unique('Картинки'), 'Первый абзац.');
  await page.goto(`/#/docs/${doc.id}`);
  await page.locator('.doc-block-view').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/изобр');
  await page.keyboard.press('Enter');
  const upload = page.getByRole('button', { name: 'Выбрать изображение' });
  await expect(upload).toBeFocused();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()]);
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  const image = page.locator('.doc-figure img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', new RegExp(`/api/docs/${doc.id}/images/[a-f0-9-]{36}$`));
  await page.getByRole('textbox', { name: 'Подпись к изображению' }).click();
  await page.keyboard.type('Точка');
  await page.keyboard.press('Escape');
  await saved(page);
  const content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks[1]).toMatchObject({ type: 'image', text: 'Точка' });
  const served = await request.get(`/api/docs/${doc.id}/images/${content.blocks[1]!.imageId}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/png');
  await page.locator('.doc-figure').hover();
  await page.getByRole('button', { name: 'Заменить' }).click();
  const again = page.getByRole('button', { name: 'Выбрать изображение' });
  await expect(again).toBeVisible();
  const [second] = await Promise.all([page.waitForEvent('filechooser'), again.click()]);
  await second.setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.locator('.toast').filter({ hasText: 'PNG, JPEG, WebP и GIF' })).toBeVisible();
  await expect(again).toBeVisible();
});

test('search finds pages by text and drag-and-drop rearranges the tree', async ({ page, request }) => {
  const first = await createPage(request, unique('Первая'), 'Очередь выполняет задачи по одной.');
  const second = await createPage(request, unique('Вторая'), 'Про расписание и паузы.');
  const third = await createPage(request, unique('Третья'), 'Ничего особенного.');
  await page.goto('/#/docs');
  await expect(page.locator('.docs-tree-title')).toHaveText([first.title, second.title, third.title]);
  const search = page.getByLabel('Поиск по документации');
  await search.fill('очеред');
  const results = page.getByRole('list', { name: 'Результаты поиска' });
  await expect(results.getByRole('button')).toHaveCount(1);
  await expect(results.locator('mark')).toHaveText('Очередь');
  await results.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`#/docs/${first.id}$`));
  await expect(search).toHaveValue('');
  await search.fill('нет такого слова');
  await expect(page.getByRole('status').filter({ hasText: 'Ничего не найдено' })).toBeVisible();
  await search.press('Escape');
  await expect(page.locator('.docs-tree-title')).toHaveCount(3);
  // Dropping onto the middle nests; dropping on the top edge reorders.
  const thirdTitle = page.getByRole('button', { name: third.title, exact: true });
  await thirdTitle.dragTo(page.getByRole('button', { name: first.title, exact: true }));
  await expect(page.locator('.docs-tree-title')).toHaveText([first.title, third.title, second.title]);
  expect((await (await request.get(`/api/docs/${third.id}`)).json() as DocPage).parentId).toBe(first.id);
  const secondTitle = page.getByRole('button', { name: second.title, exact: true });
  await secondTitle.dragTo(page.getByRole('button', { name: first.title, exact: true }), { targetPosition: { x: 30, y: 2 } });
  await expect(page.locator('.docs-tree-title')).toHaveText([second.title, first.title, third.title]);
  const pages = await (await request.get('/api/docs')).json() as DocPageSummary[];
  expect(pages.find(item => item.id === second.id)).toMatchObject({ parentId: null, position: 0 });
  expect(pages.find(item => item.id === first.id)).toMatchObject({ parentId: null, position: 1 });
});
