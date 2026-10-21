import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DocPage, DocPageSummary } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;

async function clearDocs(request: APIRequestContext) {
  for (const page of await (await request.get('/api/docs')).json() as DocPageSummary[]) await request.delete(`/api/docs/${page.id}`, { headers: origin });
  for (const page of await (await request.get('/api/docs/trash')).json() as DocPageSummary[]) await request.post(`/api/docs/${page.id}/purge`, { headers: origin, data: {} });
}
async function openDocs(page: Page) {
  await page.getByRole('button', { name: 'Документация', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Документация', exact: true })).toBeVisible();
}
async function createPage(request: APIRequestContext, title: string, parentId: string | null = null, blocks: DocPage['blocks'] = []) {
  const created = await (await request.post('/api/docs', { headers: origin, data: { title, parentId } })).json() as DocPage;
  if (blocks.length) await request.put(`/api/docs/${created.id}`, { headers: origin, data: { title, blocks, version: created.version } });
  return created;
}
const editorTitle = (page: Page) => page.getByLabel('Название страницы', { exact: true });
const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: 'Сохранено' })).toBeVisible({ timeout: 5000 });
const blockTypes = (page: Page) => page.locator('.doc-block').evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => name.startsWith('doc-') && name !== 'doc-block')!.slice(4)));

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  await clearDocs(request);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, request }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-docs-state.png'), fullPage: true });
  await clearDocs(request);
});

test('writes a page with shortcuts and the slash menu, autosaves, deep links and outlines headings', async ({ page, request }, testInfo) => {
  await openDocs(page);
  await expect(page.getByText('Документация рядом с задачами', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Новая страница', exact: true }).click();
  await expect(editorTitle(page)).toBeFocused();
  await expect(page).toHaveURL(/#\/docs\/[a-f0-9-]{36}$/);
  const title = unique('Архитектура');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc-block-text')).toBeFocused();
  await page.keyboard.type('# Обзор');
  await expect(page.locator('.doc-block').first()).toHaveClass(/doc-heading1/);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Сервис на **Bun** и `SQLite`.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Тип блока' });
  await expect(menu.getByRole('option')).toHaveCount(16);
  await page.keyboard.type('цит');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await page.keyboard.type('Цитата');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Первый');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Вложенный');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('[x] Готово');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
  await page.keyboard.type('bun test');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('---');
  await page.keyboard.type('## Итоги');
  await page.keyboard.press('Escape');
  await saved(page);
  expect(await blockTypes(page)).toEqual(['heading1', 'paragraph', 'quote', 'bulleted', 'bulleted', 'todo', 'code', 'divider', 'heading2']);
  await expect(page.locator('.doc-block-view').nth(1).locator('strong')).toHaveText('Bun');
  await expect(page.locator('.doc-bulleted').nth(1)).toHaveAttribute('style', /--indent: 1/);
  await expect(page.locator('.doc-todo input[type=checkbox]')).toBeChecked();
  await expect(page.getByRole('list', { name: 'Заголовки страницы' }).getByRole('button')).toHaveText(['Обзор', 'Итоги']);
  const url = page.url();
  await page.goto(url);
  await expect(editorTitle(page)).toHaveValue(title);
  expect(await blockTypes(page)).toHaveLength(9);
  await expect(page.getByRole('button', { name: 'Документация', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.docs-tree-title')).toHaveText([title]);
  await page.screenshot({ path: testInfo.outputPath('brigd-docs-written.png'), fullPage: true });
  await page.getByRole('list', { name: 'Заголовки страницы' }).getByRole('button', { name: 'Итоги' }).click();
  await expect(page.locator('.doc-heading2 .doc-block-view')).toBeFocused();
  const stored = await (await request.get('/api/docs')).json() as DocPageSummary[];
  expect(stored).toHaveLength(1);
  const content = await (await request.get(`/api/docs/${stored[0]!.id}`)).json() as DocPage;
  expect(content.blocks.map(block => block.type)).toEqual(['heading1', 'paragraph', 'quote', 'bulleted', 'bulleted', 'todo', 'code', 'divider', 'heading2']);
  expect(content.blocks[1]).toMatchObject({ text: 'Сервис на **Bun** и `SQLite`.' });
  expect(content.blocks[5]).toMatchObject({ type: 'todo', text: 'Готово', checked: true });
});

test('edits blocks in place: click to edit, merge, convert, reorder and delete through the block menu', async ({ page, request }) => {
  const doc = await createPage(request, unique('Правки'), null, [
    { id: 'one', type: 'paragraph', text: 'Первый абзац' }, { id: 'two', type: 'paragraph', text: 'Второй абзац' }, { id: 'three', type: 'paragraph', text: 'Третий абзац' },
  ]);
  await page.goto(`/#/docs/${doc.id}`);
  await expect(page.locator('.doc-block')).toHaveCount(3);
  await page.locator('.doc-block-view').nth(1).click();
  const field = page.locator('.doc-block-text');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Второй абзац');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.doc-block')).toHaveCount(2);
  await expect(field).toHaveValue('Первый абзацВторой абзац');
  expect(await field.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe('Первый абзац'.length);
  await page.keyboard.press('Enter');
  await expect(page.locator('.doc-block')).toHaveCount(3);
  await expect(field).toHaveValue('Второй абзац');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('жирный');
  await expect(field).toHaveValue('**жирный**Второй абзац');
  await page.keyboard.press('Escape');
  await expect(page.locator('.doc-block-view').nth(1).locator('strong')).toHaveText('жирный');
  await page.locator('.doc-block').nth(2).hover();
  await page.getByRole('button', { name: 'Действия с блоком 3: Текст', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Действия с блоком 3' });
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Заголовок 2' }).click();
  await expect(page.locator('.doc-block').nth(2)).toHaveClass(/doc-heading2/);
  await expect(page.locator('.doc-block-text')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Действия с блоком 3: Заголовок 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Переместить выше' }).click();
  expect(await blockTypes(page)).toEqual(['paragraph', 'heading2', 'paragraph']);
  await page.getByRole('button', { name: 'Действия с блоком 2: Заголовок 2', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Удалить блок' }).click();
  await expect(page.locator('.doc-block')).toHaveCount(2);
  await page.locator('.doc-block-handle').first().dragTo(page.locator('.doc-block').nth(1), { targetPosition: { x: 200, y: 30 } });
  await saved(page);
  const content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks.map(block => block.text)).toEqual(['**жирный**Второй абзац', 'Первый абзац']);
});

test('manages the page tree: subpages, reordering, trash, restore and permanent deletion', async ({ page, request }) => {
  const first = await createPage(request, unique('Первая'));
  const second = await createPage(request, unique('Вторая'));
  await openDocs(page);
  await expect(page.locator('.docs-tree-title')).toHaveText([first.title, second.title]);
  await page.getByRole('button', { name: `Действия: ${first.title}`, exact: true }).click();
  const menu = page.getByRole('menu', { name: `Действия со страницей: ${first.title}` });
  await expect(menu.getByRole('menuitem', { name: 'Добавить подстраницу' })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'Переместить выше' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: `Действия: ${first.title}`, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await menu.getByRole('menuitem', { name: 'Добавить подстраницу' }).click();
  await expect(editorTitle(page)).toBeFocused();
  const childTitle = unique('Подстраница');
  await page.keyboard.type(childTitle);
  await saved(page);
  await expect(page.locator('.docs-tree-title')).toHaveText([first.title, childTitle, second.title]);
  await expect(page.getByRole('button', { name: `Свернуть: ${first.title}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Действия: ${second.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Переместить выше' }).click();
  await expect(page.locator('.docs-tree-title')).toHaveText([second.title, first.title, childTitle]);
  await page.getByRole('button', { name: `Действия: ${first.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Вложить в предыдущую' }).click();
  await expect(page.locator('.docs-tree-title')).toHaveText([second.title, first.title, childTitle]);
  expect((await (await request.get(`/api/docs/${first.id}`)).json() as DocPage).parentId).toBe(second.id);
  await page.getByRole('button', { name: `Действия: ${first.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Вынести на уровень выше' }).click();
  expect((await (await request.get(`/api/docs/${first.id}`)).json() as DocPage).parentId).toBeNull();
  await page.getByRole('button', { name: `Действия: ${first.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'В корзину' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Переместить страницу в корзину?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(page.locator('.docs-tree-title')).toHaveCount(3);
  await page.getByRole('button', { name: `Действия: ${first.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'В корзину' }).click();
  await confirmation.getByRole('button', { name: 'В корзину', exact: true }).click();
  await expect(page.locator('.docs-tree-title')).toHaveText([second.title]);
  await expect(page.getByRole('status').filter({ hasText: 'Только чтение' })).toBeVisible();
  const trash = page.getByRole('region', { name: 'Корзина' });
  await trash.getByRole('button', { name: 'Корзина' }).click();
  await expect(trash.locator('.docs-tree-title')).toHaveText([first.title]);
  await trash.getByRole('button', { name: `Восстановить: ${first.title}`, exact: true }).click();
  await expect(page.locator('.docs-tree-title')).toHaveText([second.title, first.title, childTitle]);
  await expect(editorTitle(page)).toHaveValue(first.title);
  await expect(editorTitle(page)).toBeEnabled();
  await page.getByRole('button', { name: `Действия: ${second.title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'В корзину' }).click();
  await confirmation.getByRole('button', { name: 'В корзину', exact: true }).click();
  await trash.getByRole('button', { name: `Удалить навсегда: ${second.title}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить страницу навсегда?', exact: true }).getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(trash).toBeHidden();
  expect(await (await request.get('/api/docs/trash')).json()).toEqual([]);
  expect((await request.get(`/api/docs/${second.id}`)).status()).toBe(404);
});

test('a page edited in another tab reports the conflict and reloads on request', async ({ page, request, browser }) => {
  const doc = await createPage(request, unique('Общая'), null, [{ id: 'p', type: 'paragraph', text: 'Исходный текст' }]);
  await page.goto(`/#/docs/${doc.id}`);
  await expect(page.locator('.doc-block')).toHaveCount(1);
  const other = await browser.newPage({ baseURL: 'http://127.0.0.1:4318' });
  await other.goto(`/#/docs/${doc.id}`);
  await other.locator('.doc-block-view').click();
  await other.keyboard.press('End');
  await other.keyboard.type(' из второй вкладки');
  await other.keyboard.press('Escape');
  await saved(other);
  await other.close();
  await page.locator('.doc-block-view').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' из первой вкладки');
  await page.keyboard.press('Escape');
  const conflict = page.getByRole('alert').filter({ hasText: 'Страница изменена в другом окне' });
  await expect(conflict).toBeVisible({ timeout: 5000 });
  await conflict.getByRole('button', { name: 'Загрузить новую версию' }).click();
  await expect(page.locator('.doc-block-view')).toHaveText('Исходный текст из второй вкладки');
  await saved(page);
  const content = await (await request.get(`/api/docs/${doc.id}`)).json() as DocPage;
  expect(content.blocks[0]!.text).toBe('Исходный текст из второй вкладки');
});

test('stays usable on a narrow screen without horizontal overflow', async ({ page, request }) => {
  const doc = await createPage(request, unique('Узкий экран'), null, [
    { id: 'h', type: 'heading1', text: 'Очень длинный заголовок, который должен переноситься на несколько строк без переполнения' },
    { id: 'c', type: 'code', text: 'bun run verify && bun run test:e2e && bun run test:smoke && bun run test:attachments-runtime', language: 'sh' },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/docs/${doc.id}`);
  await expect(page.locator('.doc-block')).toHaveCount(2);
  await page.locator('.doc-block-view').first().click();
  await page.keyboard.press('Escape');
  for (const scope of [page.locator('html'), page.locator('body'), page.locator('.docs-layout')]) {
    const size = await scope.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(size.content).toBeLessThanOrEqual(size.width + 1);
  }
  await expect(page.locator('.docs-nav')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая страница', exact: true })).toBeVisible();
});
