import { expect, test } from '@playwright/test';
import type { AutopilotOverview, Task, TaskDetail } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  expect((await request.patch('/api/settings/autopilot', { headers: origin, data: { integrationChecks: null } })).ok()).toBe(true);
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
  // Leftover pool tasks from earlier runs stay out of this session's queue.
  const tasks = await (await request.get('/api/tasks')).json() as Task[];
  for (const task of tasks) {
    if (task.schedule !== 'auto' || task.archivedAt !== null || task.paused) continue;
    expect((await request.patch(`/api/tasks/${task.id}`, { headers: origin, data: { paused: true } })).ok()).toBe(true);
  }
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test('dependency picker, waiting reasons, manual warning and archived prerequisite problem', async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  const prerequisiteTitle = unique('Зависимость');
  const title = unique('После зависимости');
  const created = await request.post('/api/tasks', { headers: origin, data: {
    title: prerequisiteTitle, instruction: 'Проверь проект.', provider: 'codex', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(created.status()).toBe(201);
  const prerequisite = await created.json() as Task;
  await page.reload();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.getByLabel('Название задачи').fill(title);
  await editor.getByLabel('Что нужно сделать?').fill('Проверь результат после первой задачи.');
  const picker = editor.getByRole('group', { name: 'После задач…' });
  await picker.getByRole('searchbox').fill(prerequisiteTitle);
  await picker.getByRole('checkbox', { name: prerequisiteTitle, exact: true }).check();
  await expect(editor.getByText('Ручной запуск разрешён и может начаться до выполнения зависимостей.')).toBeVisible();
  await editor.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.getByText('Ручной запуск начнётся без ожидания зависимостей.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
  await drawer.getByRole('link', { name: prerequisiteTitle, exact: true }).click();
  const prerequisiteDrawer = page.getByRole('dialog', { name: prerequisiteTitle, exact: true });
  await expect(prerequisiteDrawer).toBeVisible();
  await prerequisiteDrawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  const queue = page.getByRole('region', { name: 'Очередь автопилота' });
  await expect(queue.getByText(`ждёт задачу ${prerequisiteTitle}`, { exact: true })).toBeVisible();
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: true, until: null } })).ok()).toBe(true);
  await expect(page.getByText('Ждут зависимости: 1.', { exact: true })).toBeVisible();
  expect((await request.post(`/api/tasks/${prerequisite.id}/archive`, { headers: origin, data: {} })).ok()).toBe(true);
  await expect(queue.locator('.dependency-problem').filter({ hasText: title }).first()).toBeVisible();
  await expect(queue.getByText('Зависимость в архиве без успешного результата. Восстановите её или уберите зависимость.', { exact: false })).toBeVisible();
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  const problems = page.getByRole('region', { name: 'Проблемные задачи' });
  await expect(problems).toBeVisible();
  if (await problems.getByRole('button', { expanded: false }).count()) await problems.getByRole('button', { expanded: false }).click();
  await expect(problems.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true })).toBeVisible();
});

test('navigation shows autopilot changes on other pages and after reloading', async ({ page, request }) => {
  const navigation = page.getByRole('button', { name: 'Автопилот', exact: true });
  const badge = navigation.locator('.autopilot-nav-status');
  await expect(badge).toBeVisible();
  await expect(badge).toBeEmpty();
  await expect(badge).not.toHaveClass(/is-enabled|is-unknown/);
  await expect(navigation).toHaveAccessibleDescription('Выключен');
  await expect(navigation).not.toHaveClass(/active/);

  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: true, until: null } })).ok()).toBe(true);
  await expect(badge).toHaveClass(/is-enabled/);
  await expect(navigation).toHaveAccessibleDescription('Включён');

  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
  await expect(navigation).toHaveAccessibleDescription('Выключен');
  await expect(badge).not.toHaveClass(/is-enabled/);

  // Opening the application while already enabled must show the saved state.
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: true, until: null } })).ok()).toBe(true);
  await page.reload();
  await expect(navigation).toHaveAccessibleDescription('Включён');
  await expect(badge).toHaveClass(/is-enabled/);
  await expect(navigation).not.toHaveClass(/active/);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(badge).toBeVisible();
  const buttonBox = await navigation.boundingBox();
  const badgeBox = await badge.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(badgeBox!.x).toBeGreaterThanOrEqual(buttonBox!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(buttonBox!.x + buttonBox!.width);

  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
});

test('navigation distinguishes loading and unavailable status and recovers', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let unavailable = true;
  await page.route('**/api/autopilot', async route => {
    await held;
    if (unavailable) await route.fulfill({ status: 503, json: { error: 'Нет связи' } });
    else await route.continue();
  });
  await page.reload();
  const navigation = page.getByRole('button', { name: 'Автопилот', exact: true });
  const badge = navigation.locator('.autopilot-nav-status');
  // The status is read again on change events, reconnects and on returning to the tab; the last one is easy to trigger here.
  const reread = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(navigation).toHaveAccessibleDescription('Загрузка…');
  release();
  await expect(navigation).toHaveAccessibleDescription('Неизвестно');
  await expect(badge).toHaveClass(/is-unknown/);

  unavailable = false;
  await reread();
  await expect(navigation).toHaveAccessibleDescription('Выключен');
  await expect(badge).not.toHaveClass(/is-unknown/);
  await navigation.click();
  await expect(page.getByRole('region', { name: 'Состояние автопилота' })).toBeVisible();
  unavailable = true;
  await reread();
  await expect(navigation).toHaveAccessibleDescription('Неизвестно');
  unavailable = false;
  await reread();
  await expect(navigation).toHaveAccessibleDescription('Выключен');
});

test('autopilot tab shows the queue, starts pool tasks once enabled and reports the session', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const info = await (await request.get('/api/info')).json();
  const title = unique('Ночная задача');
  const created = await request.post('/api/tasks', { headers: origin, data: {
    title, instruction: 'Проверь проект и опиши структуру.', provider: 'codex', cwd: info.cwd, schedule: 'auto', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(created.status()).toBe(201);
  const task = await created.json() as Task;

  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Автопилот', exact: true })).toBeVisible();
  const status = page.getByRole('region', { name: 'Состояние автопилота' });
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  const queue = page.getByRole('region', { name: 'Очередь автопилота' });
  await expect(queue.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();

  // Deferring keeps the task in autopilot mode but out of the queue; returning it restores the order.
  await queue.getByRole('button', { name: `Отложить: ${title}`, exact: true }).click();
  await expect(queue.getByRole('button', { name: `Вернуть в очередь: ${title}`, exact: true })).toBeVisible();
  await queue.getByRole('button', { name: `Вернуть в очередь: ${title}`, exact: true }).click();
  await expect(queue.getByRole('button', { name: `Отложить: ${title}`, exact: true })).toBeVisible();

  await status.getByLabel('Остановить в').uncheck();
  await status.getByRole('button', { name: 'Включить автопилот', exact: true }).click();
  await expect(status.getByText('Включён', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAccessibleDescription('Включён');
  await expect(queue.getByText('Очередь пуста', { exact: true })).toBeVisible();
  const report = page.getByRole('region', { name: 'Итоги сессии автопилота' });
  await expect(report.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();
  await expect(report.getByText('Завершено', { exact: true })).toBeVisible();
  await expect(report.getByLabel('Разбор упавших проверок за сессию', { exact: true })).toHaveText('Разбор упавших проверок: прошли со второй попытки — 0 · целевая ветка не проходит — 0 · возвращено работникам — 0 · исчерпан лимит возвратов — 0 · без возврата — 0 · остановлено — 0.');

  const overview = await (await request.get('/api/autopilot')).json() as AutopilotOverview;
  expect(overview.enabled).toBe(true);
  expect(overview.triage).toEqual({ flaky: 0, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 });
  expect(overview.attempts.map(run => run.taskId)).toEqual([task.id]);
  const detail = await (await request.get(`/api/tasks/${task.id}`)).json() as TaskDetail;
  expect(detail.runs[0]).toMatchObject({ trigger: 'autopilot', status: 'completed', mock: true });

  await status.getByRole('button', { name: 'Выключить автопилот', exact: true }).click();
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAccessibleDescription('Выключен');
  await expect(status.getByText(/выключен вручную/)).toBeVisible();

  // The run history names the trigger.
  await report.getByRole('button', { name: `Открыть: ${title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-meta').getByText('Автопилот', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the queue is reordered by dragging or with arrow keys, the autopilot follows it and archived tasks leave the report', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const info = await (await request.get('/api/info')).json();
  const titles = [unique('Первая в очереди'), unique('Вторая в очереди'), unique('Третья в очереди')];
  const ids: string[] = [];
  for (const title of titles) {
    const created = await request.post('/api/tasks', { headers: origin, data: {
      title, instruction: 'Проверь проект и опиши структуру.', provider: 'codex', cwd: info.cwd, schedule: 'auto', intervalMinutes: null, firstRunAt: null, paused: false,
    } });
    expect(created.status()).toBe(201);
    ids.push((await created.json() as Task).id);
  }
  const pool = async () => (await (await request.get('/api/autopilot')).json() as AutopilotOverview).pool.map(task => task.id);

  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  const queue = page.getByRole('region', { name: 'Очередь автопилота' });
  const order = queue.locator('.autopilot-queue-row .autopilot-task strong');
  const row = (title: string) => queue.locator('.autopilot-queue-row', { hasText: title });
  await expect(order).toHaveText(titles);

  // Dropping onto the upper half of a row puts the task above it.
  await row(titles[2]!).dragTo(row(titles[0]!), { targetPosition: { x: 300, y: 3 } });
  await expect(order).toHaveText([titles[2]!, titles[0]!, titles[1]!]);
  await expect.poll(pool).toEqual([ids[2], ids[0], ids[1]]);

  // The handle moves a task one place per arrow key and keeps the focus.
  const handle = queue.getByRole('button', { name: new RegExp(`^Переместить: ${titles[2]}`) });
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect(order).toHaveText([titles[0]!, titles[2]!, titles[1]!]);
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAccessibleName(`Переместить: ${titles[2]}, место 2 из 3`);
  await expect.poll(pool).toEqual([ids[0], ids[2], ids[1]]);
  await page.reload();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await expect(order).toHaveText([titles[0]!, titles[2]!, titles[1]!]);

  // One repository takes one task at a time, so the attempts follow the arranged order.
  const status = page.getByRole('region', { name: 'Состояние автопилота' });
  await status.getByLabel('Остановить в').uncheck();
  await status.getByRole('button', { name: 'Включить автопилот', exact: true }).click();
  await expect(status.getByText('Включён', { exact: true })).toBeVisible();
  const attempts = async () => (await (await request.get('/api/autopilot')).json() as AutopilotOverview).attempts.map(run => run.taskId);
  await expect.poll(attempts).toEqual([ids[0], ids[2], ids[1]]);
  const report = page.getByRole('region', { name: 'Итоги сессии автопилота' });
  for (const title of titles) await expect(report.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();

  // An archived task leaves the session report, as it leaves the board.
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids[2]}`)).json()) as TaskDetail).task.status).toBe('completed');
  expect((await request.post(`/api/tasks/${ids[2]}/archive`, { headers: origin, data: {} })).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await expect(report.getByRole('button', { name: `Открыть: ${titles[0]}`, exact: true })).toBeVisible();
  await expect(report.getByRole('button', { name: `Открыть: ${titles[2]}`, exact: true })).toHaveCount(0);
  await expect(report.getByText(/Задачи из архива не показаны: 1\./)).toBeVisible();

  await status.getByRole('button', { name: 'Выключить автопилот', exact: true }).click();
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the task form sets a priority, the queue puts more urgent tasks first and moves stay within one priority', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const info = await (await request.get('/api/info')).json();
  const create = async (title: string, priority?: string) => {
    const created = await request.post('/api/tasks', { headers: origin, data: {
      title, instruction: 'Проверь проект и опиши структуру.', provider: 'codex', cwd: info.cwd, schedule: 'auto', intervalMinutes: null, firstRunAt: null, paused: false,
      ...(priority ? { priority } : {}),
    } });
    expect(created.status()).toBe(201);
    return (await created.json() as Task).id;
  };
  const low = unique('Низкий приоритет'), first = unique('Обычная первая'), second = unique('Обычная вторая'), urgent = unique('Критическая задача');
  const ids = [await create(low, 'low'), await create(first), await create(second)];

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  const priority = editor.getByLabel('Приоритет', { exact: true });
  await expect(priority).toHaveValue('normal');
  await expect(priority.locator('option')).toHaveText(['Критический', 'Высокий', 'Обычный', 'Низкий']);
  await priority.selectOption({ label: 'Критический' });
  await editor.locator('[name="title"]').fill(urgent);
  await editor.locator('[name="instruction"]').fill('Срочно проверь проект.');
  await editor.locator('[name="cwd"]').fill(info.cwd);
  await editor.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor).toBeHidden();
  const drawer = page.getByRole('dialog', { name: urgent, exact: true });
  await expect(drawer.locator('.drawer-badges .priority-badge')).toHaveText('Приоритет: Критический');
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  const tasks = await (await request.get('/api/tasks')).json() as Task[];
  const urgentId = tasks.find(task => task.title === urgent)!.id;
  expect(tasks.find(task => task.id === urgentId)).toMatchObject({ priority: 'critical', schedule: 'auto' });
  const card = page.locator('article.task-card').filter({ has: page.getByRole('button', { name: `Открыть задачу: ${urgent}`, exact: true }) });
  await expect(card.locator('.priority-badge')).toHaveText('Приоритет: Критический');

  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  const queue = page.getByRole('region', { name: 'Очередь автопилота' });
  const order = queue.locator('.autopilot-queue-row .autopilot-task strong');
  const row = (title: string) => queue.locator('.autopilot-queue-row', { hasText: title });
  await expect(order).toHaveText([urgent, first, second, low]);
  await expect(row(urgent).locator('.priority-badge')).toHaveText('Критический');
  await expect(row(first).locator('.priority-badge')).toHaveCount(0);
  await expect(queue.getByRole('button', { name: `Открыть: ${low}, приоритет низкий`, exact: true })).toBeVisible();
  const pool = async () => (await (await request.get('/api/autopilot')).json() as AutopilotOverview).pool.map(task => task.id);

  // A task cannot be dropped among tasks of another priority, nor moved past them with the arrow keys.
  await row(low).dragTo(row(urgent), { targetPosition: { x: 300, y: 3 } });
  const lowHandle = queue.getByRole('button', { name: new RegExp(`^Переместить: ${low}`) });
  await lowHandle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(order).toHaveText([urgent, first, second, low]);
  await expect.poll(pool).toEqual([urgentId, ids[1], ids[2], ids[0]]);
  // Within one priority the order is still arranged by hand.
  const secondHandle = queue.getByRole('button', { name: new RegExp(`^Переместить: ${second}`) });
  await secondHandle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(order).toHaveText([urgent, second, first, low]);
  await page.keyboard.press('ArrowUp');
  await expect(order).toHaveText([urgent, second, first, low]);
  await expect.poll(pool).toEqual([urgentId, ids[2], ids[1], ids[0]]);

  // The autopilot follows the priorities: one repository takes one task at a time.
  const status = page.getByRole('region', { name: 'Состояние автопилота' });
  await status.getByLabel('Остановить в').uncheck();
  await status.getByRole('button', { name: 'Включить автопилот', exact: true }).click();
  await expect(status.getByText('Включён', { exact: true })).toBeVisible();
  const attempts = async () => (await (await request.get('/api/autopilot')).json() as AutopilotOverview).attempts.map(run => run.taskId);
  await expect.poll(attempts).toEqual([urgentId, ids[2], ids[1], ids[0]]);
  await status.getByRole('button', { name: 'Выключить автопилот', exact: true }).click();
  await expect(status.getByText('Выключен', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
