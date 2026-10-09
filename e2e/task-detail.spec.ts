import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Comment, Run, Task, TaskDetail } from '../src/lib/types';

// Read-only fixtures keep these UI checks independent of the shared database
// and prevent them from starting any real agent processes.
const timestamp = Date.UTC(2026, 9, 9, 12);
const legacyAction = 'Agent is working with local tools.';
const taskId = 'task-detail-fixture';
const runId = 'task-detail-run';

function fixtureDetail(waitingForAnswer = false): TaskDetail {
  const run: Run = {
    id: runId, taskId, workerId: null, worker: null, steps: [], currentStepIndex: null,
    instructions: [], provider: 'codex', cwd: '/workspace/project', instruction: 'Проверь карточку и объясни результат пользователю.',
    trigger: 'manual', scheduledFor: null, status: waitingForAnswer ? 'waiting_input' : 'completed',
    sessionId: 'task-detail-session', startedAt: timestamp, updatedAt: timestamp + 5_000,
    finishedAt: waitingForAnswer ? null : timestamp + 5_000, summary: waitingForAnswer ? null : 'Карточка проверена.',
    error: null, turn: 1, mock: true,
  };
  const task: Task = {
    id: taskId, title: 'Проверка карточки задачи', instruction: run.instruction, workerId: null,
    worker: null, steps: [], provider: 'codex', cwd: run.cwd, schedule: 'manual', intervalMinutes: null,
    firstRunAt: null, paused: false, createdAt: timestamp, updatedAt: timestamp + 5_000,
    nextRunAt: null, status: run.status, latestRun: run, runCount: 1,
  };
  const comment = (id: string, kind: Comment['kind'], body: string): Comment => ({
    id, taskId, runId: kind === 'user' ? null : runId, stepIndex: null, kind, body, createdAt: timestamp + 1_000,
  });
  return {
    task, runs: [run],
    comments: [
      comment('note', 'user', 'Сохрани понятное описание результата.'),
      comment('system-action', 'system', 'Работник начал проверку проекта.'),
      comment('legacy-action', 'agent', legacyAction),
      comment('user-quoted-action', 'user', legacyAction),
      comment('answer', 'agent', 'Я проверил карточку: все поля доступны.'),
      comment('question', 'question', 'Какой вариант оформления использовать?'),
      comment('result', 'result', 'Проверка завершена, результат готов.'),
    ],
    logs: [
      {
        id: 'log-inspection', taskId, runId, stepIndex: null, kind: 'tool',
        summary: 'Работник читает исходный код карточки',
        details: ['Команда: sed -n 1,80p src/App.svelte', 'Результат: найдены обработчики открытия карточки и формы ответа.'],
        createdAt: timestamp + 2_000,
      },
      {
        id: 'log-tests', taskId, runId, stepIndex: null, kind: 'tool',
        summary: 'Работник проверяет изменения',
        details: ['Команда: bun test tests', 'Результат: 12 тестов пройдено, ошибок нет.'],
        createdAt: timestamp + 3_000,
      },
    ],
  };
}

async function fixtureApi(page: Page, detail: TaskDetail) {
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: timestamp,
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') await route.fulfill({ status: 405, json: { error: 'Task detail fixtures are read-only' } });
    else if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/tasks') await route.fulfill({ json: [detail.task] });
    else if (path === `/api/tasks/${taskId}`) await route.fulfill({ json: detail });
    else if (path === '/api/workers' || path === '/api/instructions' || path === '/api/models') await route.fulfill({ json: [] });
    else await route.fulfill({ status: 404, json: { error: 'Unknown task detail fixture' } });
  });
}

async function openTask(page: Page, fixture: TaskDetail) {
  await fixtureApi(page, fixture);
  await page.goto('/');
  await page.getByRole('button', { name: `Открыть задачу: ${fixture.task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: fixture.task.title, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: /Комментарии/ })).toHaveAttribute('aria-selected', 'true');
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page, dialog: Locator) {
  const dimensions = await dialog.evaluate(node => ({
    left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
    width: node.clientWidth, contentWidth: node.scrollWidth, viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.left, 'dialog left edge remains visible').toBeGreaterThanOrEqual(-1);
  expect(dimensions.right, 'dialog right edge remains visible').toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.documentWidth, 'document has no horizontal overflow').toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.bodyWidth, 'body has no horizontal overflow').toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.contentWidth, 'dialog content has no horizontal overflow').toBeLessThanOrEqual(dimensions.width + 1);
}

test('task opens in a centered dialog with information on the left and comments on the right', async ({ page }, testInfo) => {
  const fixture = fixtureDetail();
  const dialog = await openTask(page, fixture);
  const information = dialog.locator('.task-information');
  const activity = dialog.locator('.task-activity');
  await expect(information.locator('.instruction-section p')).toHaveText(fixture.task.instruction);
  await expect(activity.getByRole('tabpanel', { name: /Комментарии/ })).toBeVisible();
  await expect(activity.getByLabel('Заметка к задаче', { exact: true })).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  const left = await information.boundingBox();
  const right = await activity.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(Math.abs(dialogBounds!.x + dialogBounds!.width / 2 - viewport.width / 2), 'dialog is horizontally centered').toBeLessThanOrEqual(2);
  expect(Math.abs(dialogBounds!.y + dialogBounds!.height / 2 - viewport.height / 2), 'dialog is vertically centered').toBeLessThanOrEqual(2);
  expect(left!.x + left!.width, 'information and activity use separate columns').toBeLessThanOrEqual(right!.x + 1);
  expect(Math.abs(left!.y - right!.y), 'columns start at the same height').toBeLessThanOrEqual(2);
  await expectNoHorizontalOverflow(page, dialog);
  await page.screenshot({ path: testInfo.outputPath('task-detail-desktop.png') });
});

test('comments contain conversation while worker actions have separate expandable logs', async ({ page }, testInfo) => {
  const fixture = fixtureDetail();
  const dialog = await openTask(page, fixture);
  const comments = dialog.getByRole('tabpanel', { name: /Комментарии/ });
  await expect(comments.locator('.comment-entry')).toHaveCount(5);
  await expect(comments.getByText('Я проверил карточку: все поля доступны.', { exact: true })).toBeVisible();
  await expect(comments.getByText('Какой вариант оформления использовать?', { exact: true })).toBeVisible();
  await expect(comments.getByText('Проверка завершена, результат готов.', { exact: true })).toBeVisible();
  await expect(comments.locator('.comment-user').getByText(legacyAction, { exact: true })).toBeVisible();
  await expect(comments.locator('.comment-agent').getByText(legacyAction, { exact: true })).toHaveCount(0);
  await expect(comments.getByText('Работник начал проверку проекта.', { exact: true })).toHaveCount(0);
  await expect(comments.getByText(fixture.logs![0].summary, { exact: true })).toHaveCount(0);

  await dialog.getByRole('tab', { name: /Логи/ }).click();
  const logs = dialog.getByRole('tabpanel', { name: /Логи/ });
  await expect(logs).toBeVisible();
  await expect(comments).not.toBeVisible();
  await expect(logs.locator('.task-log')).toHaveCount(4);
  const inspection = logs.locator('.task-log').filter({ hasText: fixture.logs![0].summary });
  const details = inspection.getByText(fixture.logs![0].details[0], { exact: true });
  await expect(details).not.toBeVisible();
  await inspection.locator('summary').click();
  await expect(details).toBeVisible();
  await expect(inspection.getByText(fixture.logs![0].details[1], { exact: true })).toBeVisible();
  await inspection.locator('summary').press('Enter');
  await expect(details).not.toBeVisible();
  const legacyLog = logs.locator('.task-log').filter({ hasText: legacyAction });
  await expect(legacyLog).toHaveCount(1);
  await legacyLog.locator('summary').click();
  await expect(legacyLog.getByText(legacyAction, { exact: true })).toBeVisible();
  await expect(logs.locator('.task-log > summary').filter({ hasText: 'Работник начал проверку проекта.' })).toBeVisible();
  await expect(logs.getByText('Я проверил карточку: все поля доступны.', { exact: true })).toHaveCount(0);
  await expect(logs.getByText('Какой вариант оформления использовать?', { exact: true })).toHaveCount(0);
  await inspection.locator('summary').click();
  await page.screenshot({ path: testInfo.outputPath('task-detail-desktop-logs.png') });
});

test('all three activity tabs support keyboard selection and wraparound', async ({ page }) => {
  const dialog = await openTask(page, fixtureDetail());
  const comments = dialog.getByRole('tab', { name: /Комментарии/ });
  const logs = dialog.getByRole('tab', { name: /Логи/ });
  const runs = dialog.getByRole('tab', { name: /Запуски/ });
  await comments.focus();
  for (const [key, tab, panelName] of [
    ['ArrowRight', logs, /Логи/], ['ArrowRight', runs, /Запуски/], ['ArrowRight', comments, /Комментарии/],
    ['ArrowLeft', runs, /Запуски/], ['Home', comments, /Комментарии/], ['End', runs, /Запуски/],
  ] as const) {
    await page.keyboard.press(key);
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tabpanel', { name: panelName })).toBeVisible();
    await expect(dialog.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
  }
});

test('agent questions and the answer composer appear in the activity column', async ({ page }) => {
  const dialog = await openTask(page, fixtureDetail(true));
  const activity = dialog.locator('.task-activity');
  await expect(activity.getByText('Какой вариант оформления использовать?', { exact: true })).toBeVisible();
  await expect(activity.getByLabel('Ответ агенту', { exact: true })).toBeVisible();
  await expect(dialog.locator('.task-information').getByLabel('Ответ агенту', { exact: true })).toHaveCount(0);
  await activity.getByLabel('Ответ агенту', { exact: true }).fill('Используй первый вариант.');
  await expect(activity.getByRole('button', { name: 'Продолжить работу', exact: true })).toBeEnabled();
});

for (const theme of ['light', 'dark'] as const) {
  test(`task details and expanded logs reflow at 320px in the ${theme} theme`, async ({ page }, testInfo) => {
    const fixture = fixtureDetail(true);
    const longText = 'ПодробностиБезПробелов'.repeat(40);
    fixture.logs![0].summary = `Работник проверяет ${longText}`;
    fixture.logs![0].details.push(longText);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
    const dialog = await openTask(page, fixture);
    await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expectNoHorizontalOverflow(page, dialog);
    const left = await dialog.locator('.task-information').boundingBox();
    const right = await dialog.locator('.task-activity').boundingBox();
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(right!.y, 'mobile activity is below the task information').toBeGreaterThanOrEqual(left!.y + left!.height - 1);
    const answer = dialog.getByLabel('Ответ агенту', { exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toBeInViewport();
    await dialog.getByRole('tab', { name: /Логи/ }).click();
    const log = dialog.locator('.task-log').filter({ hasText: fixture.logs![0].summary });
    await log.locator('summary').click();
    const detail = log.getByText(longText, { exact: true });
    await detail.scrollIntoViewIfNeeded();
    await expect(detail).toBeInViewport();
    await expectNoHorizontalOverflow(page, dialog);
    const widths = await log.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
    expect(widths.content, 'expanded log details wrap within their column').toBeLessThanOrEqual(widths.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`task-detail-320-${theme}.png`) });
  });
}
