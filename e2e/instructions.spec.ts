import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Instruction, InstructionInput, Task, TaskDetail } from '../src/lib/types';
import { INSTRUCTION_BODY_LIMIT, INSTRUCTION_TITLE_LIMIT } from '../src/lib/instructions';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

async function openInstructions(page: Page) {
  await page.getByRole('button', { name: 'Инструкции', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Инструкции/ })).toBeVisible();
}

async function newInstruction(page: Page) {
  await openInstructions(page);
  const trigger = page.getByRole('button', { name: 'Новая инструкция', exact: true });
  await trigger.click();
  const editor = page.getByRole('dialog', { name: 'Новая инструкция', exact: true });
  await expect(editor.getByLabel('Название инструкции', { exact: true })).toBeFocused();
  return { editor, trigger };
}

async function createInstruction(request: APIRequestContext, input: Partial<InstructionInput> = {}) {
  const response = await request.post('/api/instructions', {
    headers: origin,
    data: { title: unique('Правило'), body: 'Сначала вывод, затем детали.', enabled: true, ...input },
  });
  expect(response.status()).toBe(201);
  return await response.json() as Instruction;
}

async function noOverflow(page: Page, dialog?: Locator) {
  const pageWidth = await page.evaluate(() => ({ width: document.documentElement.clientWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(pageWidth.html).toBeLessThanOrEqual(pageWidth.width + 1);
  expect(pageWidth.body).toBeLessThanOrEqual(pageWidth.width + 1);
  if (!dialog) return;
  const size = await dialog.evaluate(node => {
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
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  const instructions = await (await request.get('/api/instructions')).json() as Instruction[];
  for (const instruction of instructions) expect((await request.delete(`/api/instructions/${instruction.id}`, { headers: origin })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, request }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-instructions-state.png'), fullPage: true });
  // This is the dedicated mock browser database, shared serially with other specs.
  const instructions = await (await request.get('/api/instructions')).json() as Instruction[];
  for (const instruction of instructions) await request.delete(`/api/instructions/${instruction.id}`, { headers: origin });
});

test('create, edit, toggle, reload and confirm deletion with keyboard focus', async ({ page, request }, testInfo) => {
  const title = unique('Проверка изменений');
  const changed = unique('Проверка тестов');
  const text = 'После правок запусти тесты.\nСообщи, если что-то не удалось проверить.';
  const { editor, trigger } = await newInstruction(page);
  await editor.getByLabel('Название инструкции', { exact: true }).fill(title);
  await editor.getByLabel('Текст инструкции', { exact: true }).fill(text);
  await editor.getByLabel('Включить для новых запусков', { exact: true }).uncheck();
  await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
  const card = page.getByRole('article', { name: `Инструкция: ${title}`, exact: true });
  await expect(editor).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(card).toContainText(text);
  await expect(card.getByRole('switch')).not.toBeChecked();
  await card.getByRole('button', { name: `Изменить инструкцию: ${title}`, exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать инструкцию', exact: true });
  await expect(edit.getByLabel('Текст инструкции', { exact: true })).toHaveValue(text);
  await edit.getByLabel('Название инструкции', { exact: true }).fill(changed);
  await edit.getByLabel('Текст инструкции', { exact: true }).fill('Новая версия правила.');
  await edit.getByRole('button', { name: 'Сохранить инструкцию', exact: true }).click();
  const changedCard = page.getByRole('article', { name: `Инструкция: ${changed}`, exact: true });
  await expect(changedCard.getByRole('button', { name: `Изменить инструкцию: ${changed}`, exact: true })).toBeFocused();
  await changedCard.getByRole('switch').click();
  await expect(changedCard.getByRole('switch')).toBeChecked();
  await expect(changedCard.getByRole('switch')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(changedCard.getByRole('switch')).not.toBeChecked();
  await expect(changedCard.getByRole('switch')).toBeFocused();
  await page.reload();
  await openInstructions(page);
  await expect(changedCard).toContainText('Новая версия правила.');
  await expect(changedCard.getByRole('switch')).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('brigd-instructions-created-and-edited.png'), fullPage: true });

  let deletes = 0;
  page.on('request', req => { if (req.method() === 'DELETE' && new URL(req.url()).pathname.startsWith('/api/instructions/')) deletes++; });
  const deleteButton = changedCard.getByRole('button', { name: `Удалить инструкцию: ${changed}`, exact: true });
  await deleteButton.click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить инструкцию?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Отмена', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(deleteButton).toBeFocused();
  expect(deletes).toBe(0);
  await deleteButton.click();
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(deletes).toBe(0);
  await deleteButton.click();
  await confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true }).click();
  await expect(changedCard).toHaveCount(0);
  await expect(page.getByText('Ваши правила, в каждой задаче', { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  expect(deletes).toBe(1);
  expect(await (await request.get('/api/instructions')).json()).toEqual([]);
});

test('cancel and Escape reset only the unsaved draft and restore the opener', async ({ page, request }) => {
  const { editor, trigger } = await newInstruction(page);
  await editor.getByLabel('Название инструкции', { exact: true }).fill('Не сохранять');
  await editor.getByLabel('Текст инструкции', { exact: true }).fill('Черновик');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(editor.getByLabel('Название инструкции', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Текст инструкции', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Название инструкции', { exact: true })).toHaveAttribute('maxlength', String(INSTRUCTION_TITLE_LIMIT));
  await expect(editor.getByLabel('Текст инструкции', { exact: true })).toHaveAttribute('maxlength', String(INSTRUCTION_BODY_LIMIT));
  await expect(editor.getByLabel('Включить для новых запусков', { exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await (await request.get('/api/instructions')).json()).toEqual([]);
});

test('frozen instructions survive edit, disable, delete and resuming the same run', async ({ page, request }, testInfo) => {
  const first = await createInstruction(request, { title: 'Прежнее правило', body: 'Старая версия для текущего запуска.' });
  const second = await createInstruction(request, { title: 'Выключенное правило', body: 'Сначала выключено.', enabled: false });
  const title = unique('Запуск с общими правилами');
  const info = await (await request.get('/api/info')).json();
  const task = await (await request.post('/api/tasks', { headers: origin, data: {
    title, instruction: '[ask] Подготовь краткий обзор проекта.', provider: 'codex', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } })).json() as Task;
  await page.reload();
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const before = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(before.runs[0].instructions).toEqual([{ id: first.id, title: first.title, body: first.body }]);
  const snapshot = drawer.locator('.current-run-instructions .run-instruction-snapshot');
  await snapshot.locator('summary').click();
  await expect(snapshot).toContainText(first.body);
  await expect(snapshot).not.toContainText(second.body);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();

  await openInstructions(page);
  await page.getByRole('button', { name: `Изменить инструкцию: ${first.title}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать инструкцию', exact: true });
  await editor.getByLabel('Текст инструкции', { exact: true }).fill('Обновлённая версия для следующего запуска.');
  await editor.getByRole('button', { name: 'Сохранить инструкцию', exact: true }).click();
  await page.getByRole('article', { name: `Инструкция: ${first.title}`, exact: true }).getByRole('switch').click();
  await expect(page.getByRole('article', { name: `Инструкция: ${first.title}`, exact: true }).getByRole('switch')).not.toBeChecked();
  await page.getByRole('button', { name: `Удалить инструкцию: ${first.title}`, exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить инструкцию?', exact: true }).getByRole('button', { name: 'Удалить инструкцию', exact: true }).click();
  await page.getByRole('article', { name: `Инструкция: ${second.title}`, exact: true }).getByRole('switch').click();
  await expect(page.getByRole('article', { name: `Инструкция: ${second.title}`, exact: true }).getByRole('switch')).toBeChecked();

  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Начни с архитектуры.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  const resumed = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(resumed.runs[0].id).toBe(before.runs[0].id);
  expect(resumed.runs[0].sessionId).toBe(before.runs[0].sessionId);
  expect(resumed.runs[0].turn).toBe(2);
  expect(resumed.runs[0].instructions).toEqual(before.runs[0].instructions);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await drawer.locator('.run-entry .run-instruction-snapshot summary').click();
  await expect(drawer.locator('.run-entry')).toContainText(first.body);
  await expect(drawer.locator('.run-entry')).not.toContainText('Обновлённая версия');
  await drawer.locator('.run-entry').screenshot({ path: testInfo.outputPath('brigd-instructions-frozen-run-after-resume.png') });

  await expect(drawer.getByRole('button', { name: 'Запустить снова', exact: true })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  // Changed global guidance applies to a separate new task; the completed task cannot restart.
  const freshResponse = await request.post('/api/tasks', { headers: origin, data: {
    title: unique('Новая задача с обновлёнными правилами'), instruction: '[ask] Подготовь новый обзор проекта.',
    provider: 'codex', cwd: info.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(freshResponse.status()).toBe(201);
  const freshTask = await freshResponse.json() as Task;
  await page.reload();
  await page.getByRole('button', { name: `Открыть задачу: ${freshTask.title}`, exact: true }).click();
  const freshDrawer = page.getByRole('dialog', { name: freshTask.title, exact: true });
  await freshDrawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(freshDrawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const freshDetail = await (await request.get(`/api/tasks/${freshTask.id}`)).json() as TaskDetail;
  expect(freshDetail.runs[0].instructions).toEqual([{ id: second.id, title: second.title, body: second.body }]);
  expect((await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail).runs).toEqual(resumed.runs);
  await freshDrawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(freshDrawer.locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
});

test('loading, failed read and retry do not masquerade as an empty collection', async ({ page }) => {
  const readGate = gate();
  let fail = true;
  await page.route('**/api/instructions', async route => {
    await readGate.promise;
    if (fail) await route.abort('failed');
    else await route.continue();
  });
  await openInstructions(page);
  await expect(page.getByRole('status')).toContainText('Загружаем инструкции');
  await expect(page.getByText('Ваши правила, в каждой задаче', { exact: true })).toHaveCount(0);
  readGate.release();
  await expect(page.getByRole('alert')).toContainText('Нет связи с сервером');
  await expect(page.getByText('Ваши правила, в каждой задаче', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByText('Ваши правила, в каждой задаче', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('network and size errors retain editable drafts; toggles and delete errors preserve saved data', async ({ page, request }) => {
  const title = unique('Сохранить черновик');
  let failCreate = true;
  await page.route('**/api/instructions', async route => {
    if (route.request().method() === 'POST' && failCreate) { failCreate = false; await route.abort('failed'); }
    else await route.continue();
  });
  const { editor } = await newInstruction(page);
  await editor.getByLabel('Название инструкции', { exact: true }).fill(title);
  const longBody = 'Д'.repeat(15000); // Valid field length, over the encoded enabled-library budget.
  await editor.getByLabel('Текст инструкции', { exact: true }).fill(longBody);
  await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Нет связи с сервером');
  await expect(editor.getByLabel('Название инструкции', { exact: true })).toHaveValue(title);
  await expect(editor.getByLabel('Текст инструкции', { exact: true })).toHaveValue(longBody);
  await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('24000');
  await expect(editor.getByLabel('Текст инструкции', { exact: true })).toHaveValue(longBody);
  await editor.getByLabel('Включить для новых запусков', { exact: true }).uncheck();
  await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page.getByRole('article', { name: `Инструкция: ${title}`, exact: true });
  await card.getByRole('switch').click();
  await expect(page.getByRole('alert')).toContainText('24000');
  await expect(card.getByRole('switch')).not.toBeChecked();
  await expect(card.getByRole('switch')).toBeFocused();
  const instruction = (await (await request.get('/api/instructions')).json() as Instruction[])[0];
  expect(instruction).toMatchObject({ title, body: longBody, enabled: false });
  let failDelete = true;
  await page.route(`**/api/instructions/${instruction.id}`, async route => {
    if (route.request().method() === 'DELETE' && failDelete) { failDelete = false; await route.fulfill({ status: 503, json: { error: 'Удаление временно недоступно' } }); }
    else await route.continue();
  });
  await card.getByRole('button', { name: `Удалить инструкцию: ${title}`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить инструкцию?', exact: true });
  await confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('Удаление временно недоступно');
  expect(await (await request.get('/api/instructions')).json()).toHaveLength(1);
  await confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(card).toHaveCount(0);
});

test('pending save is single-submit and an old read cannot erase the new instruction', async ({ page, request }) => {
  const title = unique('Одна отправка');
  const readGate = gate();
  const saveGate = gate();
  let reads = 0;
  let saves = 0;
  await page.route('**/api/instructions', async route => {
    if (route.request().method() === 'GET' && ++reads === 1) { await readGate.promise; await route.fulfill({ json: [] }); }
    else if (route.request().method() === 'POST') { saves++; await saveGate.promise; await route.continue(); }
    else await route.continue();
  });
  try {
    const { editor } = await newInstruction(page);
    await editor.getByLabel('Название инструкции', { exact: true }).fill(title);
    await editor.getByLabel('Текст инструкции', { exact: true }).fill('Один сохранённый экземпляр.');
    await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
    await expect(editor.getByLabel('Текст инструкции', { exact: true })).toBeDisabled();
    await editor.locator('form').evaluate(form => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    saveGate.release();
    await expect(editor).not.toBeVisible();
    const card = page.getByRole('article', { name: `Инструкция: ${title}`, exact: true });
    await expect(card).toBeVisible();
    const oldRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/instructions');
    readGate.release();
    await oldRead;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(card).toBeVisible();
    expect(saves).toBe(1);
    expect((await (await request.get('/api/instructions')).json() as Instruction[]).filter(item => item.title === title)).toHaveLength(1);
  } finally { readGate.release(); saveGate.release(); }
});

test('pending toggle and delete are single-submit; stale reads cannot resurrect deletion', async ({ page, request }) => {
  const item = await createInstruction(request);
  await openInstructions(page);
  const card = page.getByRole('article', { name: `Инструкция: ${item.title}`, exact: true });
  await expect(card).toBeVisible();
  const toggleGate = gate();
  const deleteGate = gate();
  let toggles = 0;
  let deletes = 0;
  await page.route(`**/api/instructions/${item.id}`, async route => {
    if (route.request().method() === 'PATCH') { toggles++; await toggleGate.promise; }
    if (route.request().method() === 'DELETE') { deletes++; await deleteGate.promise; }
    await route.continue();
  });
  const readGate = gate();
  let staleReadStarted = false;
  try {
    await card.getByRole('switch').click();
    await expect(card.getByRole('switch')).toBeDisabled();
    await expect(card.getByRole('switch')).toBeChecked();
    await card.getByRole('switch').evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    toggleGate.release();
    await expect(card.getByRole('switch')).not.toBeChecked();
    await expect(card.getByRole('switch')).toBeFocused();
    expect(toggles).toBe(1);
    const disabledItem = { ...item, enabled: false };
    await page.route('**/api/instructions', async route => {
      if (route.request().method() === 'GET' && !staleReadStarted) {
        staleReadStarted = true;
        await readGate.promise;
        await route.fulfill({ json: [disabledItem] });
      } else await route.continue();
    });
    await expect.poll(() => staleReadStarted).toBe(true);
    await card.getByRole('button', { name: `Удалить инструкцию: ${item.title}`, exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Удалить инструкцию?', exact: true });
    await confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true }).click();
    await expect(confirmation.getByRole('button', { name: 'Удаляем…', exact: true })).toBeDisabled();
    await confirmation.locator('form').evaluate(form => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeVisible();
    deleteGate.release();
    await expect(confirmation).not.toBeVisible();
    await expect(card).toHaveCount(0);
    const oldRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/instructions');
    readGate.release();
    await oldRead;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(card).toHaveCount(0);
    expect(deletes).toBe(1);
  } finally { toggleGate.release(); deleteGate.release(); readGate.release(); }
});

test('saving the hundredth instruction restores focus to its edit button when create becomes unavailable', async ({ page }) => {
  const timestamp = Date.now();
  const rows: Instruction[] = Array.from({ length: 99 }, (_, index) => ({
    id: `limit-${index}`, title: `Сохранённое правило ${index + 1}`, body: 'Краткий текст.',
    enabled: false, createdAt: timestamp + index, updatedAt: timestamp + index,
  }));
  await page.route('**/api/instructions', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: rows });
    else {
      const input = route.request().postDataJSON() as InstructionInput;
      const saved: Instruction = { ...input, id: 'limit-100', createdAt: timestamp + 100, updatedAt: timestamp + 100 };
      rows.push(saved);
      await route.fulfill({ status: 201, json: saved });
    }
  });
  await openInstructions(page);
  await expect(page.getByRole('article')).toHaveCount(99);
  const { editor, trigger } = await newInstruction(page);
  await editor.getByLabel('Название инструкции', { exact: true }).fill('Сотая инструкция');
  await editor.getByLabel('Текст инструкции', { exact: true }).fill('Фокус остаётся на доступном действии.');
  await editor.getByRole('button', { name: 'Создать инструкцию', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Изменить инструкцию: Сотая инструкция', exact: true })).toBeFocused();
  await expect(page.getByText('Достигнут лимит: 100 инструкций.', { exact: false })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  for (const size of [{ width: 1440, height: 1000, font: 13 }, { width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} instructions and dialogs reflow at ${size.width}px with ${size.font}px text`, async ({ page, request }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(value => localStorage.setItem('brigd.theme', value), theme);
      const title = 'ДлинноеНазваниеБезПробелов'.repeat(5);
      const item = await createInstruction(request, { title, body: 'ДлинноеПравилоБезПробелов'.repeat(150) });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      await expect(page.locator('.brand .brig-logo')).toBeVisible();
      await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/brig.svg');
      await openInstructions(page);
      const card = page.getByRole('article', { name: `Инструкция: ${item.title}`, exact: true });
      await expect(card).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`brigd-instructions-${theme}-${size.width}-${size.font}-list.png`), fullPage: true });
      await card.getByRole('button', { name: `Изменить инструкцию: ${item.title}`, exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Редактировать инструкцию', exact: true });
      await noOverflow(page, editor);
      await editor.evaluate(node => { node.scrollTop = 0; });
      await editor.screenshot({ path: testInfo.outputPath(`brigd-instructions-${theme}-${size.width}-${size.font}-editor-top.png`) });
      const save = editor.getByRole('button', { name: 'Сохранить инструкцию', exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await noOverflow(page, editor);
      await editor.screenshot({ path: testInfo.outputPath(`brigd-instructions-${theme}-${size.width}-${size.font}-editor-actions.png`) });
      await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
      await card.getByRole('button', { name: `Удалить инструкцию: ${item.title}`, exact: true }).click();
      const confirmation = page.getByRole('dialog', { name: 'Удалить инструкцию?', exact: true });
      await noOverflow(page, confirmation);
      await confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true }).scrollIntoViewIfNeeded();
      await expect(confirmation.getByRole('button', { name: 'Удалить инструкцию', exact: true })).toBeInViewport();
      await confirmation.screenshot({ path: testInfo.outputPath(`brigd-instructions-${theme}-${size.width}-${size.font}-delete-confirmation.png`) });
      await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
      await noOverflow(page);
    });
  }
}
