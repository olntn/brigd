import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Run, RunStep, Task, TaskDetail, Worker } from '../src/lib/types';

// Read-only fixtures keep visual size/reflow checks independent of native CLI accounts.
const timestamp = Date.UTC(2026, 9, 9, 12);
const privateText = 'PRIVATE_AVATAR_INSTRUCTIONS: Доступны только в редакторе профиля.';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const workers: Worker[] = [
  { id: 'avatar-photo-worker', name: 'Александра Проверяющая', description: 'Проверяет результат и помогает подготовить следующий шаг.', provider: 'codex', model: null, effort: 'high', communicationStyle: privateText, avatarUrl: '/api/avatars/avatar-sizing-photo', archived: false, createdAt: timestamp, updatedAt: timestamp },
  { id: 'avatar-initials-worker', name: 'Михаил Исследователь', description: 'Разбирается в исходных данных и сохраняет важные детали.', provider: 'claude', model: null, effort: 'high', communicationStyle: privateText, avatarUrl: null, archived: false, createdAt: timestamp, updatedAt: timestamp },
];
function detailFixture(workflow: boolean): TaskDetail {
  const id = workflow ? 'avatar-workflow-task' : 'avatar-simple-task';
  const worker = workers[0];
  const steps: RunStep[] = workflow ? workers.map((profile, index) => ({
    workerId: profile.id, worker: { ...profile }, title: `Этап ${index + 1}: ${index ? 'Проверка' : 'Исследование'}`, instruction: 'Подготовь сохранённый результат этапа.',
    status: 'completed', sessionId: `mock-${profile.provider}-avatar-${index}`, startedAt: timestamp, updatedAt: timestamp + 1000,
    finishedAt: timestamp + 1000, summary: 'Сохранённый результат готов.', error: null, attempts: [],
  })) : [];
  const run: Run = {
    id: `${id}-run`, taskId: id, workerId: worker.id, worker: { ...worker }, steps, currentStepIndex: workflow ? 1 : null,
    instructions: [], provider: worker.provider, cwd: '/workspace/project', instruction: 'Подготовить итог по результатам работы.',
    trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: `mock-codex-${id}`, startedAt: timestamp,
    updatedAt: timestamp + 1000, finishedAt: timestamp + 1000, summary: 'Результат готов.', error: null, turn: 1, mock: true,
  };
  const task: Task = {
    id, title: workflow ? 'Проверка аватаров этапов' : 'Проверка читаемых аватаров', instruction: run.instruction,
    workerId: workflow ? null : worker.id, worker: workflow ? null : worker, steps: steps.map(({ workerId, title, instruction }) => ({ workerId, title, instruction })),
    provider: worker.provider, cwd: run.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
    createdAt: timestamp, updatedAt: timestamp + 1000, nextRunAt: null, status: 'completed', latestRun: run, runCount: 1,
  };
  return { task, runs: [run], comments: [{ id: `${id}-result`, taskId: id, runId: run.id, stepIndex: workflow ? 0 : null, kind: 'result', body: 'Результат с хорошо различимым автором.', createdAt: timestamp + 1000 }, { id: `${id}-note`, taskId: id, runId: null, stepIndex: null, kind: 'user', body: 'Обычная заметка пользователя.', createdAt: timestamp + 2000 }] };
}
async function fixtureApi(page: Page) {
  const details = [detailFixture(false), detailFixture(true)];
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }], scheduler: 'running', startedAt: timestamp };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only avatar fixture' } });
    if (path === '/api/info') return route.fulfill({ json: info });
    if (path === '/api/avatars/avatar-sizing-photo') return route.fulfill({ contentType: 'image/png', body: png });
    if (path === '/api/workers') return route.fulfill({ json: workers });
    if (path === '/api/models' || path === '/api/instructions') return route.fulfill({ json: [] });
    if (path === '/api/tasks') return route.fulfill({ json: details.map(detail => detail.task) });
    const detail = details.find(detail => path === `/api/tasks/${detail.task.id}`);
    return route.fulfill(detail ? { json: detail } : { status: 404, json: { error: 'Unknown avatar fixture' } });
  });
  return details;
}
async function expectSize(avatar: Locator, size: number) {
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveCSS('width', `${size}px`);
  await expect(avatar).toHaveCSS('height', `${size}px`);
  const bounds = await avatar.boundingBox();
  expect(bounds?.width, 'avatar must not shrink in a narrow flex row').toBeCloseTo(size, 0);
  expect(bounds?.height).toBeCloseTo(size, 0);
}
async function noOverflow(page: Page, surface?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'page has no horizontal overflow').toBe(true);
  if (surface) expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'surface has no horizontal clipping').toBe(true);
}
async function noPrivateText(surface: Locator) {
  await expect(surface).not.toContainText(privateText);
  expect(await surface.evaluate(element => element.outerHTML)).not.toContain(privateText);
}
async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await control.page().evaluate(() => innerWidth) + 1);
}

for (const layout of [
  { theme: 'light', width: 1440, height: 1000, font: 13 },
  { theme: 'dark', width: 390, height: 844, font: 13 },
  { theme: 'dark', width: 320, height: 640, font: 26 },
]) {
  test(`larger avatar hierarchy stays readable in ${layout.theme} at ${layout.width}px with ${layout.font}px text`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const details = await fixtureApi(page);
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.addInitScript(theme => localStorage.setItem('brigd.theme', theme), layout.theme);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
    await page.addStyleTag({ content: `html { font-size: ${layout.font}px !important; }` });
    await expect(page.locator('html')).toHaveAttribute('data-theme', layout.theme);
    const card = page.getByRole('button', { name: `Открыть задачу: ${details[0].task.title}`, exact: true });
    await expectSize(card.locator('.worker-avatar'), 32);
    await noOverflow(page, card);
    await noPrivateText(card);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const row = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `Открыть: ${details[0].task.title}`, exact: true }) });
    await expectSize(row.locator('.worker-avatar'), 32);
    await noOverflow(page, row);
    await page.getByRole('button', { name: 'Доска', exact: true }).click();
    await page.getByRole('button', { name: 'Работники', exact: true }).click();
    for (const worker of workers) {
      const profile = page.getByRole('article', { name: `Работник: ${worker.name}`, exact: true });
      await expectSize(profile.locator('.worker-avatar'), 64);
      await expect(profile.locator('.worker-description')).toHaveText(worker.description);
      await noOverflow(page, profile);
      await noPrivateText(profile);
    }
    const photo = page.getByRole('article', { name: `Работник: ${workers[0].name}`, exact: true }).locator('.worker-avatar img');
    await expect.poll(() => photo.evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(page.getByRole('article', { name: `Работник: ${workers[1].name}`, exact: true }).locator('.worker-avatar')).toHaveText('МИ');
    await page.screenshot({ path: testInfo.outputPath('avatar-directory.png'), fullPage: true });
    await page.getByRole('button', { name: `Изменить работника: ${workers[0].name}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
    await expectSize(editor.locator('.worker-avatar-picker .worker-avatar'), 88);
    await expect(editor.getByLabel('Личные инструкции', { exact: true })).toHaveValue(privateText);
    await noOverflow(page, editor);
    await editor.locator('.worker-avatar-picker').screenshot({ path: testInfo.outputPath('avatar-profile-editor.png') });
    await reachable(editor.getByRole('button', { name: 'Отмена', exact: true }));
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.getByRole('button', { name: 'Задачи', exact: true }).click();
    for (const detail of details) {
      await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: detail.task.title, exact: true });
      await expectSize(drawer.locator('.drawer-badges .worker-avatar'), 40);
      await expectSize(drawer.locator('.comment-result .worker-avatar'), 40);
      await expectSize(drawer.locator('.comment-user .comment-avatar'), 40);
      await drawer.locator('.comment-result').screenshot({ path: testInfo.outputPath(`${detail.task.id}-comment-avatar.png`) });
      if (detail.task.steps.length) {
        for (const avatar of await drawer.locator('.current-workflow .worker-avatar').all()) await expectSize(avatar, 36);
        await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(2);
        await drawer.locator('.current-workflow').screenshot({ path: testInfo.outputPath('avatar-completed-workflow.png') });
      }
      await noOverflow(page, drawer);
      await noPrivateText(drawer);
      const message = drawer.locator('#task-comment');
      await message.fill('Уточни результат в той же сессии.');
      await reachable(drawer.getByRole('combobox', { name: 'Получатель дополнительного запроса', exact: true }));
      await reachable(drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }));
      await reachable(drawer.getByRole('button', { name: 'Отправить агенту', exact: true }));
      await expect(drawer.getByRole('button', { name: 'Отправить агенту', exact: true })).toBeEnabled();
      await drawer.locator('.comment-form').screenshot({ path: testInfo.outputPath(`${detail.task.id}-composer.png`) });
      await noOverflow(page, drawer);
      await drawer.getByRole('tab', { name: /Запуски/ }).click();
      await expectSize(drawer.locator('.run-entry .run-meta .worker-avatar'), 32);
      await noPrivateText(drawer);
      await noOverflow(page, drawer);
      await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    }
    expect(errors).toEqual([]);
  });
}
