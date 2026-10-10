import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Tag, Task, TaskDetail } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const createdTagIds: string[] = [];
const tagFilter = (page: Page) => page.getByLabel('Фильтр по тегу', { exact: true });
const taskTags = (drawer: Locator) => drawer.getByRole('region', { name: 'Теги задачи', exact: true });
const coloredTag = (container: Locator, name: string) => container.locator('.task-tag').filter({ hasText: name });

function rgbFromHex(color: string) {
  return `rgb(${[1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16)).join(', ')})`;
}

function luminance(rgb: string) {
  const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255);
  const linear = channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}

async function expectTagPaint(element: Locator, color: string) {
  await expect(element).toHaveCSS('--tag-color', new RegExp(`^\\s*${color}\\s*$`));
  await expect(element).not.toHaveCSS('background-color', rgbFromHex(color));
  await expect(element).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(element).toHaveCSS('border-width', '1px');
  await expect(element).toHaveCSS('border-style', 'solid');
  await expect(element.locator('svg')).toHaveCount(0);
  const paint = await element.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, text: getComputedStyle(node).color, border: getComputedStyle(node).borderTopColor }));
  expect(paint.border).not.toBe('rgba(0, 0, 0, 0)');
  expect(paint.border).not.toBe('transparent');
  expect(paint.border, 'the thin border remains visible against the muted background').not.toBe(paint.background);
  const [lighter, darker] = [luminance(paint.background), luminance(paint.text)].sort((left, right) => right - left);
  expect((lighter + .05) / (darker + .05), `text remains readable on ${color}`).toBeGreaterThanOrEqual(4.5);
}

async function openTags(page: Page) {
  await page.getByRole('button', { name: 'Теги', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Теги/ })).toBeVisible();
}

async function createTag(request: APIRequestContext, name = unique('Мой тег'), color?: string) {
  const response = await request.post('/api/tags', { headers: origin, data: { name, ...(color ? { color } : {}) } });
  expect(response.status()).toBe(201);
  const tag = await response.json() as Tag;
  createdTagIds.push(tag.id);
  return tag;
}

async function createTagThroughUi(page: Page, request: APIRequestContext, name: string, color?: { preset?: string; custom?: string }) {
  await openTags(page);
  await page.getByRole('button', { name: 'Новый тег', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новый тег', exact: true });
  await editor.getByLabel('Название тега', { exact: true }).fill(name);
  const customColor = editor.getByLabel('Свой цвет', { exact: true });
  await expect(customColor).toHaveValue('#7764cf');
  if (color?.preset) {
    const preset = editor.getByRole('button', { name: `Цвет: ${color.preset}`, exact: true });
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
  }
  if (color?.custom) await customColor.fill(color.custom);
  const selectedColor = await customColor.inputValue();
  await expectTagPaint(editor.locator('.tag-preview'), selectedColor);
  await editor.getByRole('button', { name: 'Создать тег', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('article', { name: `Тег: ${name}`, exact: true })).toBeVisible();
  const tags = await (await request.get('/api/tags')).json() as Tag[];
  const tag = tags.find(item => item.name === name);
  expect(tag).toBeDefined();
  expect(tag!.color).toBe(selectedColor);
  createdTagIds.push(tag!.id);
  return tag!;
}

async function createTask(request: APIRequestContext, title: string, tagIds: string[] = [], provider = 'codex', scheduled = false) {
  const info = await (await request.get('/api/info')).json() as AppInfo;
  const response = await request.post('/api/tasks', { headers: origin, data: {
    title, instruction: 'Подготовь короткую сводку проекта.', provider, cwd: info.cwd, tagIds,
    schedule: scheduled ? 'interval' : 'manual', intervalMinutes: scheduled ? 60 : null,
    firstRunAt: scheduled ? Date.now() + 86_400_000 : null, paused: false,
  } });
  expect(response.status()).toBe(201);
  return await response.json() as Task;
}

async function readDetail(request: APIRequestContext, taskId: string) {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as TaskDetail;
}

async function openTask(page: Page, task: Task) {
  await page.goto('/');
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

function taskCard(page: Page, title: string) {
  return page.locator('.task-card').filter({ has: page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }) });
}

function taskRow(page: Page, title: string) {
  return page.locator('.task-row').filter({ has: page.getByRole('button', { name: `Открыть: ${title}`, exact: true }) });
}

async function noOverflow(page: Page, dialog?: Locator) {
  const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(dimensions.html).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
  if (!dialog) return;
  const bounds = await dialog.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
}

test.beforeEach(async ({ page, request }) => {
  createdTagIds.length = 0;
  expect((await (await request.get('/api/info')).json() as AppInfo).mode).toBe('mock');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, request }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-tags.png'), fullPage: true });
  // Only remove this test's tags from the dedicated mock database, so reruns do not hit its tag limit.
  for (const id of createdTagIds) expect([200, 404]).toContain((await request.delete(`/api/tags/${id}`, { headers: origin })).status());
});

test('custom tags can be created in navigation and assigned while creating a task, then survive reload', async ({ page, request }) => {
  const first = await createTagThroughUi(page, request, unique('Разработка'));
  const second = await createTagThroughUi(page, request, unique('Срочно'));
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  const title = unique('Задача с моими тегами');
  await editor.locator('[name="title"]').fill(title);
  await editor.locator('[name="instruction"]').fill('Проверь проект и подготовь сводку.');
  const choices = editor.getByRole('group', { name: 'Теги задачи', exact: true });
  await choices.getByRole('checkbox', { name: first.name, exact: true }).check();
  await choices.getByRole('checkbox', { name: second.name, exact: true }).check();
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(taskTags(drawer).locator('.task-tag')).toHaveText([first.name, second.name]);
  const tasks = await (await request.get('/api/tasks')).json() as Task[];
  const task = tasks.find(item => item.title === title)!;
  expect(task.tagIds.sort()).toEqual([first.id, second.id].sort());
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await expect(taskCard(page, title).locator('.task-tags .task-tag')).toHaveText([first.name, second.name]);
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await expect(taskCard(page, title).locator('.task-tags .task-tag')).toHaveText([first.name, second.name]);
  await taskCard(page, title).getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(edit.getByRole('checkbox', { name: first.name, exact: true })).toBeChecked();
  await expect(edit.getByRole('checkbox', { name: second.name, exact: true })).toBeChecked();
  await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await readDetail(request, task.id)).task.tagIds.sort()).toEqual([first.id, second.id].sort());
});

test('tags on a completed task can change independently of its saved execution, and cancellation discards a draft', async ({ page, request }) => {
  const first = await createTag(request, unique('Исходный тег'));
  const second = await createTag(request, unique('Готовый результат'));
  const task = await createTask(request, unique('Завершённая задача с тегами'), [first.id]);
  expect((await request.post(`/api/tasks/${task.id}/run`, { headers: origin, data: {} })).status()).toBe(201);
  await expect.poll(async () => (await readDetail(request, task.id)).task.status, { timeout: 12_000 }).toBe('completed');
  const before = await readDetail(request, task.id);
  const drawer = await openTask(page, before.task);
  const section = taskTags(drawer);
  await section.getByRole('button', { name: 'Изменить теги', exact: true }).click();
  await section.getByRole('checkbox', { name: first.name, exact: true }).uncheck();
  await section.getByRole('checkbox', { name: second.name, exact: true }).check();
  await section.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Изменить теги', exact: true })).toBeFocused();
  await expect(section.locator('.task-tag')).toHaveText([first.name]);
  expect((await readDetail(request, task.id)).task.tagIds).toEqual([first.id]);
  await section.getByRole('button', { name: 'Изменить теги', exact: true }).click();
  await expect(section.getByRole('checkbox', { name: first.name, exact: true })).toBeChecked();
  await expect(section.getByRole('checkbox', { name: second.name, exact: true })).not.toBeChecked();
  await section.getByRole('checkbox', { name: first.name, exact: true }).uncheck();
  await section.getByRole('checkbox', { name: second.name, exact: true }).check();
  await section.getByRole('button', { name: 'Сохранить теги', exact: true }).click();
  await expect(section.locator('.task-tag')).toHaveText([second.name]);
  await expect(section.getByRole('button', { name: 'Изменить теги', exact: true })).toBeFocused();
  const after = await readDetail(request, task.id);
  expect(after.task.tagIds).toEqual([second.id]);
  expect(after.runs).toEqual(before.runs);
  expect(after.task).toMatchObject({ instruction: before.task.instruction, status: 'completed', latestRun: before.task.latestRun, runCount: before.task.runCount });
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await expect(taskCard(page, task.title).locator('.task-tag')).toHaveText([second.name]);
});

test('tag filtering combines with search, provider and schedule in board and list, and resets with all filters', async ({ page, request }) => {
  const first = await createTag(request);
  const second = await createTag(request);
  const prefix = unique('Фильтрация тегов');
  const scheduled = await createTask(request, `${prefix} по расписанию`, [first.id], 'codex', true);
  const claude = await createTask(request, `${prefix} Claude`, [first.id], 'claude');
  const manual = await createTask(request, `${prefix} вручную`, [first.id]);
  const different = await createTask(request, `${prefix} другой тег`, [second.id]);
  const untagged = await createTask(request, `${prefix} без тегов`);
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(prefix);
  await tagFilter(page).selectOption(first.id);
  await expect(taskCard(page, scheduled.title)).toBeVisible();
  await expect(taskCard(page, claude.title)).toBeVisible();
  await expect(taskCard(page, manual.title)).toBeVisible();
  await expect(taskCard(page, different.title)).toHaveCount(0);
  await expect(taskCard(page, untagged.title)).toHaveCount(0);
  await page.getByLabel('Фильтр по агенту', { exact: true }).selectOption('codex');
  await expect(taskCard(page, claude.title)).toHaveCount(0);
  await page.getByLabel('Фильтр задач', { exact: true }).selectOption('scheduled');
  await expect(taskCard(page, scheduled.title)).toBeVisible();
  await expect(taskCard(page, manual.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(taskRow(page, scheduled.title).locator('.task-tags .task-tag')).toHaveText([first.name]);
  await expect(taskRow(page, claude.title)).toHaveCount(0);
  await page.getByLabel('Поиск задач', { exact: true }).fill(`${prefix} отсутствует`);
  await expect(page.getByRole('heading', { name: 'Задачи не найдены', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Показать все задачи', exact: true }).click();
  await expect(page.getByLabel('Поиск задач', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Фильтр по агенту', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Фильтр задач', { exact: true })).toHaveValue('all');
  await expect(tagFilter(page)).toHaveValue('all');
  await page.getByLabel('Поиск задач', { exact: true }).fill(prefix);
  await tagFilter(page).selectOption('untagged');
  await expect(taskRow(page, untagged.title)).toBeVisible();
  for (const task of [scheduled, claude, manual, different]) await expect(taskRow(page, task.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Доска', exact: true }).click();
  await expect(taskCard(page, untagged.title)).toBeVisible();
  for (const task of [scheduled, claude, manual, different]) await expect(taskCard(page, task.title)).toHaveCount(0);
});

test('renaming updates task labels and deleting a selected tag clears its associations and filter', async ({ page, request }) => {
  const tag = await createTag(request, unique('Переименовать меня'));
  const retained = await createTag(request, unique('Оставить меня'));
  const first = await createTask(request, unique('Два тега'), [tag.id, retained.id]);
  const second = await createTask(request, unique('Один тег'), [tag.id]);
  await page.reload();
  await openTags(page);
  await page.getByRole('button', { name: `Изменить тег: ${tag.name}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать тег', exact: true });
  const changed = unique('Новое название');
  await editor.getByLabel('Название тега', { exact: true }).fill(changed);
  await editor.getByRole('button', { name: 'Сохранить тег', exact: true }).click();
  await expect(page.getByRole('article', { name: `Тег: ${changed}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await tagFilter(page).selectOption(tag.id);
  await expect(taskCard(page, first.title).locator('.task-tag').getByText(changed, { exact: true })).toBeVisible();
  await expect(taskCard(page, second.title).locator('.task-tag')).toHaveText([changed]);
  await page.reload();
  await expect(tagFilter(page).locator(`option[value="${tag.id}"]`)).toHaveText(changed);
  await tagFilter(page).selectOption(tag.id);
  await openTags(page);
  await page.getByRole('button', { name: `Удалить тег: ${changed}`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить тег?', exact: true });
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await readDetail(request, first.id)).task.tagIds).toContain(tag.id);
  await page.getByRole('button', { name: `Удалить тег: ${changed}`, exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить тег', exact: true }).click();
  await expect(page.getByRole('article', { name: `Тег: ${changed}`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await expect(tagFilter(page)).toHaveValue('all');
  await expect(tagFilter(page).locator(`option[value="${tag.id}"]`)).toHaveCount(0);
  await expect(taskCard(page, first.title).locator('.task-tag')).toHaveText([retained.name]);
  await expect(taskCard(page, second.title).locator('.task-tag')).toHaveCount(0);
  expect((await readDetail(request, first.id)).task.tagIds).toEqual([retained.id]);
  expect((await readDetail(request, second.id)).task.tagIds).toEqual([]);
  await page.reload();
  expect((await (await request.get('/api/tags')).json() as Tag[]).some(item => item.id === tag.id)).toBe(false);
  await expect(taskCard(page, first.title).locator('.task-tag')).toHaveText([retained.name]);
});

test('archived tasks retain their tags, can be filtered, and keep those tags after restore', async ({ page, request }) => {
  const tag = await createTag(request, unique('Архивный тег'));
  const prefix = unique('Архив тегов');
  const tagged = await createTask(request, `${prefix} с тегом`, [tag.id]);
  const untagged = await createTask(request, `${prefix} без тега`);
  for (const task of [tagged, untagged]) expect((await request.post(`/api/tasks/${task.id}/archive`, { headers: origin, data: {} })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByLabel('Поиск в архиве', { exact: true }).fill(prefix);
  await tagFilter(page).selectOption(tag.id);
  await expect(taskRow(page, tagged.title).locator('.task-tag')).toHaveText([tag.name]);
  await expect(taskRow(page, untagged.title)).toHaveCount(0);
  await page.getByRole('button', { name: `Открыть: ${tagged.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: tagged.title, exact: true });
  await expect(taskTags(drawer).locator('.task-tag')).toHaveText([tag.name]);
  await expect(drawer.getByRole('button', { name: 'Изменить теги', exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await tagFilter(page).selectOption('untagged');
  await expect(taskRow(page, untagged.title)).toBeVisible();
  await expect(taskRow(page, tagged.title)).toHaveCount(0);
  await tagFilter(page).selectOption(tag.id);
  await page.getByRole('button', { name: `Восстановить: ${tagged.title}`, exact: true }).click();
  await expect(taskRow(page, tagged.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(tagged.title);
  await tagFilter(page).selectOption(tag.id);
  await expect(taskCard(page, tagged.title).locator('.task-tag')).toHaveText([tag.name]);
  await page.reload();
  expect((await readDetail(request, tagged.id)).task).toMatchObject({ archivedAt: null, tagIds: [tag.id] });
});

test('long tag names, management, assignment and filters fit a narrow screen with enlarged text', async ({ page, request }) => {
  const tag = await createTag(request, unique('ДлинноеНазваниеТегаБезПробелов'.repeat(2).slice(0, 40)));
  const task = await createTask(request, unique('Мобильная задача с тегом'), [tag.id]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
  await page.getByRole('button', { name: 'Теги', exact: true }).scrollIntoViewIfNeeded();
  await openTags(page);
  await expect(page.getByRole('article', { name: `Тег: ${tag.name}`, exact: true })).toBeVisible();
  await noOverflow(page);
  await page.getByRole('button', { name: `Изменить тег: ${tag.name}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать тег', exact: true });
  await noOverflow(page, editor);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await tagFilter(page).selectOption(tag.id);
  await expect(taskCard(page, task.title).locator('.task-tag')).toHaveText([tag.name]);
  await noOverflow(page);
  await taskCard(page, task.title).getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await taskTags(drawer).getByRole('button', { name: 'Изменить теги', exact: true }).click();
  await expect(taskTags(drawer).getByRole('checkbox', { name: tag.name, exact: true })).toBeChecked();
  await noOverflow(page, drawer);
  await taskTags(drawer).getByRole('button', { name: 'Отмена', exact: true }).click();
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(taskRow(page, task.title).locator('.task-tag')).toHaveText([tag.name]);
  await noOverflow(page);
});

test('preset and custom tag colors persist after reload and a name-only edit preserves the chosen color', async ({ page, request }) => {
  const preset = await createTagThroughUi(page, request, unique('Красный тег'), { preset: 'Красный' });
  const custom = await createTagThroughUi(page, request, unique('Свой цвет тега'), { custom: '#f5df68' });
  expect(preset.color).not.toBe('#7764cf');
  expect(custom.color).toBe('#f5df68');
  await expectTagPaint(page.getByRole('article', { name: `Тег: ${preset.name}`, exact: true }).locator('.tag-name-badge'), preset.color);
  await expectTagPaint(page.getByRole('article', { name: `Тег: ${custom.name}`, exact: true }).locator('.tag-name-badge'), custom.color);
  await page.reload();
  await openTags(page);
  for (const tag of [preset, custom]) {
    await expectTagPaint(page.getByRole('article', { name: `Тег: ${tag.name}`, exact: true }).locator('.tag-name-badge'), tag.color);
    await page.getByRole('button', { name: `Изменить тег: ${tag.name}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактировать тег', exact: true });
    await expect(editor.getByLabel('Название тега', { exact: true })).toHaveValue(tag.name);
    await expect(editor.getByLabel('Свой цвет', { exact: true })).toHaveValue(tag.color);
    if (tag.id === preset.id) await expect(editor.getByRole('button', { name: 'Цвет: Красный', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  }
  await page.getByRole('button', { name: `Изменить тег: ${custom.name}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать тег', exact: true });
  const renamed = unique('Новое имя цветного тега');
  await editor.getByLabel('Название тега', { exact: true }).fill(renamed);
  await editor.getByRole('button', { name: 'Сохранить тег', exact: true }).click();
  await expectTagPaint(page.getByRole('article', { name: `Тег: ${renamed}`, exact: true }).locator('.tag-name-badge'), custom.color);
  await page.reload();
  await openTags(page);
  await page.getByRole('button', { name: `Изменить тег: ${renamed}`, exact: true }).click();
  await expect(editor.getByLabel('Свой цвет', { exact: true })).toHaveValue(custom.color);
  const saved = (await (await request.get('/api/tags')).json() as Tag[]).find(tag => tag.id === custom.id);
  expect(saved).toMatchObject({ name: renamed, color: custom.color });
});

test('changing only a tag color updates management, task cards, list, drawer and picker with readable text in both themes', async ({ page, request }, testInfo) => {
  const tag = await createTag(request, unique('Цвет меняется'));
  const lightTag = await createTag(request, unique('Светлый фон'), '#f5df68');
  expect(tag.color).toBe('#7764cf');
  const task = await createTask(request, unique('Задача с цветными тегами'), [tag.id, lightTag.id]);
  await page.reload();
  await openTags(page);
  await page.getByRole('button', { name: `Изменить тег: ${tag.name}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать тег', exact: true });
  const changed = '#203a6e';
  await editor.getByLabel('Свой цвет', { exact: true }).fill(changed);
  await expect(editor.getByLabel('Название тега', { exact: true })).toHaveValue(tag.name);
  await expectTagPaint(editor.locator('.tag-preview'), changed);
  await editor.getByRole('button', { name: 'Сохранить тег', exact: true }).click();
  await expectTagPaint(page.getByRole('article', { name: `Тег: ${tag.name}`, exact: true }).locator('.tag-name-badge'), changed);
  const detail = await readDetail(request, task.id);
  expect(detail.task.tagIds).toEqual([tag.id, lightTag.id]);
  expect(detail.task.tags.find(item => item.id === tag.id)).toMatchObject({ name: tag.name, color: changed });

  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await expectTagPaint(coloredTag(taskCard(page, task.title), tag.name), changed);
  await expectTagPaint(coloredTag(taskCard(page, task.title), lightTag.name), lightTag.color);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  const section = taskTags(drawer);
  await expectTagPaint(coloredTag(section, tag.name), changed);
  await section.getByRole('button', { name: 'Изменить теги', exact: true }).click();
  for (const [name, color] of [[tag.name, changed], [lightTag.name, lightTag.color]]) {
    const checkbox = section.getByRole('checkbox', { name, exact: true });
    await expect(checkbox).toBeChecked();
    const option = section.locator('label').filter({ has: page.getByRole('checkbox', { name, exact: true }) });
    await expectTagPaint(option, color);
  }
  await section.getByRole('button', { name: 'Отмена', exact: true }).click();
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expectTagPaint(coloredTag(taskRow(page, task.title), tag.name), changed);
  await expectTagPaint(coloredTag(taskRow(page, task.title), lightTag.name), lightTag.color);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => localStorage.setItem('brigd.theme', value), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
    await expectTagPaint(coloredTag(taskCard(page, task.title), tag.name), changed);
    await expectTagPaint(coloredTag(taskCard(page, task.title), lightTag.name), lightTag.color);
    await taskCard(page, task.title).screenshot({ path: testInfo.outputPath(`brigd-tags-muted-${theme}.png`) });
  }
});

test('many tags stay in a bounded mobile picker and search preserves selections without scrolling the whole task', async ({ page, request }, testInfo) => {
  const prefix = unique('Набор тегов');
  const tags = await Promise.all(Array.from({ length: 50 }, (_, index) => createTag(request, `${prefix} ${String(index + 1).padStart(2, '0')}`)));
  const first = tags[0];
  const last = tags[tags.length - 1];
  const task = await createTask(request, unique('Задача с большим выбором тегов'), tags.slice(1, -1).map(tag => tag.id));
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = await openTask(page, task);
  const section = taskTags(drawer);
  const assigned = section.getByRole('region', { name: 'Назначенные теги', exact: true });
  await expect(assigned.locator('.task-tag')).toHaveCount(48);
  const assignedDimensions = await assigned.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight, viewport: innerHeight }));
  expect(assignedDimensions.content).toBeGreaterThan(assignedDimensions.height);
  expect(assignedDimensions.height).toBeLessThanOrEqual(assignedDimensions.viewport * .2 + 2);
  await section.screenshot({ path: testInfo.outputPath('brigd-tags-assigned-mobile.png') });
  await section.getByRole('button', { name: 'Изменить теги', exact: true }).click();
  const list = section.getByRole('region', { name: 'Список тегов', exact: true });
  const search = section.getByLabel('Поиск тегов', { exact: true });
  const save = section.getByRole('button', { name: 'Сохранить теги', exact: true });
  const cancel = section.getByRole('button', { name: 'Отмена', exact: true });
  await expect(search).toBeFocused();
  await expect(list.getByRole('checkbox')).toHaveCount(50);
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 48');
  await search.fill(unique('Такого тега нет'));
  await expect(list.getByRole('status')).toHaveText('Теги не найдены. Попробуйте другое название.');
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 48');
  await section.getByRole('button', { name: 'Очистить поиск тегов', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(list.getByRole('checkbox')).toHaveCount(50);
  const dimensions = await list.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight, viewport: innerHeight }));
  expect(dimensions.content).toBeGreaterThan(dimensions.height);
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.viewport * .28 + 2);
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await list.hover();
  const scrollPositions = () => drawer.evaluate(node => ({
    document: document.scrollingElement?.scrollTop ?? 0, body: document.body.scrollTop, dialog: node.scrollTop,
    information: node.querySelector('.task-information')!.scrollTop,
  }));
  const beforeWheel = await scrollPositions();
  expect(await drawer.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop), 'the task still has content below the tag picker').toBeGreaterThan(1);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(150); // Allow the wheel event and compositor scroll to settle before comparing outer scroll positions.
  expect(await scrollPositions()).toEqual(beforeWheel);
  await expect(save).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await noOverflow(page, drawer);

  await search.fill(last.name);
  await expect(list.getByRole('checkbox')).toHaveCount(1);
  await list.getByRole('checkbox', { name: last.name, exact: true }).check();
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 49');
  await search.fill(first.name);
  await expect(list.getByRole('checkbox')).toHaveCount(1);
  await list.getByRole('checkbox', { name: first.name, exact: true }).check();
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 50');
  await section.getByRole('button', { name: 'Очистить поиск тегов', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(list.getByRole('checkbox')).toHaveCount(50);
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(50);
  for (const tag of [first, last]) await expect(list.getByRole('checkbox', { name: tag.name, exact: true })).toBeChecked();
  await save.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath('brigd-tags-picker-mobile.png') });
  await save.click();
  expect((await readDetail(request, task.id)).task.tagIds.sort()).toEqual(tags.map(tag => tag.id).sort());
  await expect(assigned.locator('.task-tag')).toHaveCount(50);

  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  await section.getByRole('button', { name: 'Изменить теги', exact: true }).click();
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 50');
  await expect(list.getByRole('checkbox', { checked: true })).toHaveCount(50);
  for (const tag of [first, last]) await expect(list.getByRole('checkbox', { name: tag.name, exact: true })).toBeChecked();
  const draft = tags[25];
  await search.fill(draft.name);
  await list.getByRole('checkbox', { name: draft.name, exact: true }).uncheck();
  await expect(section.locator('.tag-selection-count')).toHaveText('Выбрано: 49');
  await cancel.click();
  await expect(assigned.locator('.task-tag')).toHaveCount(50);
  expect((await readDetail(request, task.id)).task.tagIds.sort()).toEqual(tags.map(tag => tag.id).sort());
});
