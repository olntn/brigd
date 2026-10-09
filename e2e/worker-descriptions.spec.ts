import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Run, RunStep, Task, TaskDetail, Worker } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const timestamp = Date.UTC(2026, 9, 9, 12);
const privateText = 'PRIVATE_DESCRIPTION_REGRESSION: Личные правила, видимые только в редакторе профиля.';
const publicText = 'Проверяет архитектуру и помогает готовить технические обзоры.';

async function noPrivateText(scope: Locator) {
  // textContent includes closed <details>; outerHTML also catches title/aria leaks.
  await expect(scope).not.toContainText(privateText);
  expect(await scope.evaluate(element => element.outerHTML)).not.toContain(privateText);
  await expect(scope.getByText('Стиль общения', { exact: true })).toHaveCount(0);
  await expect(scope.getByText('Личные инструкции', { exact: true })).toHaveCount(0);
}

async function noOverflow(page: Page, surface?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  if (surface) expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

function workerFixture(description: string | undefined): Worker {
  const worker: Worker = { id: 'description-worker', name: 'Хранитель описания', description: description ?? '', provider: 'codex', model: null, effort: 'high', communicationStyle: privateText, avatarUrl: null, archived: false, createdAt: timestamp, updatedAt: timestamp };
  // Deliberately emulate an old serialized record, before the description field existed.
  if (description === undefined) Reflect.deleteProperty(worker, 'description');
  return worker;
}

function taskFixture(worker: Worker, workflow = false): TaskDetail {
  const id = workflow ? 'description-workflow' : 'description-task';
  const steps: RunStep[] = workflow ? [0, 1].map(index => ({
    workerId: worker.id, worker: { ...worker }, title: `Этап ${index + 1}`, instruction: `Общедоступное задание ${index + 1}`,
    status: 'completed', sessionId: `mock-description-step-${index}`, startedAt: timestamp, updatedAt: timestamp + 1000,
    finishedAt: timestamp + 1000, summary: 'Готово.', error: null, attempts: [],
  })) : [];
  const run: Run = {
    id: `${id}-run`, taskId: id, workerId: worker.id, worker: { ...worker }, steps, currentStepIndex: workflow ? 1 : null,
    instructions: [], provider: worker.provider, cwd: '/workspace/project', instruction: 'Подготовить обзор проекта.',
    trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: `mock-${id}`, startedAt: timestamp,
    updatedAt: timestamp + 1000, finishedAt: timestamp + 1000, summary: 'Обзор готов.', error: null, turn: 1, mock: true,
  };
  const task: Task = {
    id, workerId: workflow ? null : worker.id, worker: workflow ? null : { ...worker },
    steps: steps.map(({ workerId, title, instruction }) => ({ workerId, title, instruction })),
    title: workflow ? 'Последовательность с описанием' : 'Задача с описанием', instruction: run.instruction,
    provider: worker.provider, cwd: run.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null,
    paused: false, createdAt: timestamp, updatedAt: timestamp, archivedAt: null, nextRunAt: null, status: run.status, latestRun: run, runCount: 1,
  };
  return { task, runs: [run], comments: [{ id: `${id}-comment`, taskId: id, runId: run.id, stepIndex: workflow ? 1 : null, kind: 'result', body: 'Результат проверки проекта.', createdAt: timestamp + 1000 }] };
}

async function fixtureApi(page: Page, description: string | undefined) {
  const worker = workerFixture(description);
  const details = [taskFixture(worker), taskFixture(worker, true)];
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }], scheduler: 'running', startedAt: timestamp };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only description fixture' } });
    if (path === '/api/info') return route.fulfill({ json: info });
    if (path === '/api/models' || path === '/api/instructions') return route.fulfill({ json: [] });
    if (path === '/api/workers') return route.fulfill({ json: [worker] });
    if (path === '/api/tasks') return route.fulfill({ json: details.map(detail => detail.task) });
    const detail = details.find(detail => path === `/api/tasks/${detail.task.id}`);
    return detail ? route.fulfill({ json: detail }) : route.fulfill({ status: 404, json: { error: 'Unknown description fixture' } });
  });
  return { worker, details };
}

async function openDrawer(page: Page, task: Task) {
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.comment-result')).toBeVisible();
  return drawer;
}

async function expandSnapshots(scope: Locator) {
  for (const details of await scope.locator('.run-instruction-snapshot, .workflow-step-snapshot, .workflow-template').all()) {
    if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
  }
}

test('an existing personal instruction survives independent description edits, clear and reload', async ({ page, request }) => {
  expect((await (await request.get('/api/info')).json()).mode).toBe('mock');
  const name = `Сохранённые личные правила ${crypto.randomUUID().slice(0, 8)}`;
  // Omitted description is how old clients create workers; private text is not a default description.
  const response = await request.post('/api/workers', { headers: origin, data: { name, provider: 'codex', effort: 'high', communicationStyle: privateText, avatarUrl: null } });
  expect(response.status()).toBe(201);
  const worker = await response.json() as Worker;
  expect(worker.description).toBe('');
  const readWorker = async () => (await (await request.get(`/api/workers/${worker.id}`)).json()) as Worker;
  const openEditor = async () => {
    await page.getByRole('button', { name: 'Работники', exact: true }).click();
    await page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true }).click();
    return page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
  };
  await page.goto('/');
  let editor = await openEditor();
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue(privateText);
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).not.toHaveAttribute('placeholder');
  await expect(editor.getByLabel('Описание', { exact: true })).toHaveValue('');
  await editor.getByLabel('Имя работника', { exact: true }).press('Tab');
  await expect(editor.getByLabel('Описание', { exact: true })).toBeFocused();
  await editor.getByLabel('Описание', { exact: true }).fill(publicText);
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await readWorker()).toMatchObject({ description: publicText, communicationStyle: privateText });
  await noPrivateText(page.locator('body'));
  await page.reload();
  editor = await openEditor();
  await expect(editor.getByLabel('Описание', { exact: true })).toHaveValue(publicText);
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue(privateText);
  await editor.getByLabel('Описание', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await readWorker()).toMatchObject({ description: '', communicationStyle: privateText });
  const card = page.getByRole('article', { name: `Работник: ${name}`, exact: true });
  await expect(card.locator('.worker-description')).toHaveText('Описание не задано');
  await noPrivateText(page.locator('body'));
  editor = await openEditor();
  await editor.getByLabel('Описание', { exact: true }).fill(publicText);
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  editor = await openEditor();
  await editor.getByLabel('Личные инструкции', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await readWorker()).toMatchObject({ description: publicText, communicationStyle: '' });
  await page.reload();
  editor = await openEditor();
  await expect(editor.getByLabel('Описание', { exact: true })).toHaveValue(publicText);
  await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true })).toBeFocused();
});

for (const description of [undefined, '']) {
  test(`${description === undefined ? 'legacy missing' : 'empty'} descriptions never reveal private instructions in any summary or expanded history`, async ({ page }, testInfo) => {
    const { worker, details } = await fixtureApi(page, description);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
    await noPrivateText(page.locator('body'));
    await expect(page.locator('.task-card .worker-description')).toHaveCount(0);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    await expect(page.locator('.task-row .worker-description')).toHaveCount(0);
    await noPrivateText(page.locator('body'));
    await page.getByRole('button', { name: 'Доска', exact: true }).click();
    for (const detail of details) {
      const drawer = await openDrawer(page, detail.task);
      await expandSnapshots(drawer);
      await expect(drawer.locator('.worker-description')).toHaveCount(0);
      await expect(drawer.locator('.comment-result .comment-meta strong')).toHaveText(worker.name);
      await noPrivateText(drawer);
      await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
      await expect(editor.locator('.worker-description')).toHaveCount(0);
      await noPrivateText(editor);
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await drawer.getByRole('tab', { name: /Запуски/ }).click();
      await expect(drawer.locator('.run-entry')).toBeVisible();
      await expandSnapshots(drawer);
      await expect(drawer.locator('.run-entry .worker-description')).toHaveCount(0);
      await noPrivateText(drawer);
      await drawer.screenshot({ path: testInfo.outputPath(`${description === undefined ? 'legacy' : 'empty'}-${detail.task.id}-expanded.png`) });
      await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Работники', exact: true }).click();
    const card = page.getByRole('article', { name: `Работник: ${worker.name}`, exact: true });
    await expect(card.locator('.worker-description')).toHaveText('Описание не задано');
    await noPrivateText(page.locator('body'));
    await page.getByRole('button', { name: `Изменить работника: ${worker.name}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
    await expect(editor.getByLabel('Описание', { exact: true })).toHaveValue('');
    await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue(privateText);
    await expect(editor.getByLabel('Личные инструкции', { exact: true })).not.toHaveAttribute('placeholder');
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();
    await noPrivateText(page.locator('body'));
  });
}

for (const theme of ['light', 'dark']) {
  for (const size of [{ width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} public descriptions fit cards, list, assignment, comments and expanded history at ${size.width}px and ${size.font}px text`, async ({ page }, testInfo) => {
      const description = 'ДлинноеОписаниеБезПробелов'.repeat(45).slice(0, 1000);
      const { details } = await fixtureApi(page, description);
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      const task = details[0].task;
      const card = page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true });
      await expect(card.locator('.worker-description')).toHaveText(description);
      const nameBox = await card.locator('.worker-identity-copy > span').boundingBox();
      const descriptionBox = await card.locator('.worker-description').boundingBox();
      expect(nameBox).not.toBeNull();
      expect(descriptionBox).not.toBeNull();
      expect(descriptionBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
      await noPrivateText(card);
      await noOverflow(page, card);
      await card.screenshot({ path: testInfo.outputPath(`description-${theme}-${size.width}-card.png`) });
      await page.getByRole('button', { name: 'Список', exact: true }).click();
      const row = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `Открыть: ${task.title}`, exact: true }) });
      await expect(row.locator('.worker-description')).toHaveText(description);
      await noPrivateText(row);
      await noOverflow(page, row);
      await row.screenshot({ path: testInfo.outputPath(`description-${theme}-${size.width}-list.png`) });
      await page.getByRole('button', { name: `Открыть: ${task.title}`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: task.title, exact: true });
      await expect(drawer.locator('.drawer-badges .worker-description')).toHaveText(description);
      await expect(drawer.locator('.comment-result .worker-description')).toHaveText(description);
      await expandSnapshots(drawer);
      await noPrivateText(drawer);
      await noOverflow(page, drawer);
      const comment = drawer.locator('.comment-result');
      await comment.scrollIntoViewIfNeeded();
      await expect(comment).toBeInViewport();
      await comment.screenshot({ path: testInfo.outputPath(`description-${theme}-${size.width}-comment.png`) });
      await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
      await expect(editor.locator('.worker-assignment .worker-description')).toHaveText(description);
      await noPrivateText(editor);
      await noOverflow(page, editor);
      await editor.locator('.worker-assignment').screenshot({ path: testInfo.outputPath(`description-${theme}-${size.width}-assignment.png`) });
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Изменить', exact: true })).toBeFocused();
      await drawer.getByRole('tab', { name: /Запуски/ }).click();
      await expect(drawer.locator('.run-entry')).toBeVisible();
      await expandSnapshots(drawer);
      await expect(drawer.locator('.run-entry .run-meta .worker-description')).toHaveText(description);
      await expect(drawer.locator('.run-entry .worker-run-settings .worker-description')).toHaveText(description);
      await noPrivateText(drawer);
      await noOverflow(page, drawer);
      await drawer.locator('.run-entry').screenshot({ path: testInfo.outputPath(`description-${theme}-${size.width}-history.png`) });
    });
  }
}
