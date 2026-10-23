import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, Task, TaskInput } from '../src/lib/types';

// The browser's zone is what the form saves into a new daily card.
test.use({ timezoneId: 'Europe/Moscow' });

// Monday 26 October 2026, 02:00 in Moscow.
const MONDAY_NIGHT = Date.UTC(2026, 9, 25, 23);

function fixtureTask(input: Partial<Task> = {}): Task {
  return {
    id: 'existing-task', title: 'Существующая задача', instruction: 'Проверь проект.', provider: 'codex',
    cwd: '/workspace/project', schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null,
    timeOfDay: null, weekdays: null, timeZone: null,
    paused: false, dependsOnTaskIds: [], dependencies: [], tagIds: [], tags: [], steps: [], workerId: null, worker: null,
    createdAt: Date.UTC(2026, 9, 24, 9), updatedAt: Date.UTC(2026, 9, 24, 9),
    archivedAt: null, nextRunAt: null, status: 'ready', latestRun: null, runCount: 0,
    ...input,
  };
}

async function fixtureApi(page: Page, tasks: Task[]) {
  const state = { tasks, writes: [] as TaskInput[] };
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: Date.UTC(2026, 9, 24, 9),
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if ((path === '/api/tasks' && method === 'POST') || (path.startsWith('/api/tasks/') && method === 'PATCH')) {
      const body = route.request().postDataJSON() as TaskInput;
      state.writes.push(body);
      const current = state.tasks.find(task => path === `/api/tasks/${task.id}`);
      const task = fixtureTask({ ...current, ...body, id: current?.id ?? `created-${state.writes.length}`, nextRunAt: MONDAY_NIGHT });
      state.tasks = current ? state.tasks.map(item => item.id === task.id ? task : item) : [task, ...state.tasks];
      await route.fulfill({ status: current ? 200 : 201, json: task });
    } else if (method !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Unsupported fixture mutation' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: state.tasks });
    } else if (path.startsWith('/api/tasks/')) {
      const task = state.tasks.find(item => path === `/api/tasks/${item.id}`);
      await route.fulfill(task ? { json: { task, runs: [], comments: [] } } : { status: 404, json: { error: 'Unknown fixture task' } });
    } else if (path === '/api/settings/general') {
      await route.fulfill({ json: { defaultCwd: '/workspace/project', defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null }, agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null } });
    } else if (path === '/api/workers' || path === '/api/models' || path === '/api/tags') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: null, source: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: 'Unknown daily schedule fixture' } });
    }
  });
  return state;
}

const nextRunText = (page: Page, timestamp: number) => page.evaluate(value => new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(value), timestamp).then(time => `Следующий запуск: ${time}`);

test('the board labels daily cards, shows their next run in local time and keeps them in the schedule filter', async ({ page }) => {
  await fixtureApi(page, [
    fixtureTask({ id: 'nightly', title: 'Ночной прогон', schedule: 'daily', timeOfDay: '02:00', weekdays: [1, 2, 3, 4, 5], timeZone: 'Europe/Moscow', nextRunAt: MONDAY_NIGHT }),
    fixtureTask({ id: 'tokyo', title: 'Отчёт для Токио', schedule: 'daily', timeOfDay: '09:30', weekdays: [1, 3], timeZone: 'Asia/Tokyo', nextRunAt: Date.UTC(2026, 9, 26, 0, 30) }),
    fixtureTask({ id: 'hourly', title: 'Ежечасная проверка', schedule: 'interval', intervalMinutes: 60, nextRunAt: MONDAY_NIGHT }),
    fixtureTask({ id: 'manual', title: 'Ручная задача' }),
  ]);
  await page.goto('/');
  const nightly = page.locator('.task-card').filter({ hasText: 'Ночной прогон' });
  await expect(nightly.locator('.card-schedule')).toHaveText('По будням в 02:00');
  await expect(nightly.locator('.card-next-run')).toHaveText(await nextRunText(page, MONDAY_NIGHT));
  await expect(page.locator('.task-card').filter({ hasText: 'Отчёт для Токио' }).locator('.card-schedule')).toHaveText('Пн, Ср в 09:30 (Asia/Tokyo)');
  await expect(page.locator('.task-card').filter({ hasText: 'Ручная задача' }).locator('.card-next-run')).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Фильтр задач', exact: true }).selectOption('scheduled');
  await expect(page.locator('.task-card h3')).toHaveText(['Ночной прогон', 'Отчёт для Токио', 'Ежечасная проверка'], { useInnerText: true });

  await page.getByRole('button', { name: 'Открыть задачу: Ночной прогон', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Ночной прогон', exact: true });
  await expect(drawer.locator('.detail-next-run')).toHaveText(await nextRunText(page, MONDAY_NIGHT));
});

test('a new card runs at a chosen time on chosen weekdays in the browser zone', async ({ page }) => {
  const state = await fixtureApi(page, []);
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.locator('[name="title"]').fill('Утренний отчёт');
  await editor.locator('[name="instruction"]').fill('Собери отчёт.');
  await editor.getByRole('button', { name: 'По времени', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'По времени', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('[name="intervalMinutes"]')).toHaveCount(0);
  await expect(editor.locator('[name="timeOfDay"]')).toHaveValue('09:00');
  await expect(editor.getByText('Часовой пояс: Europe/Moscow')).toBeVisible();
  const days = editor.getByRole('group', { name: 'Дни недели', exact: true });
  await expect(days.getByRole('button', { pressed: true })).toHaveCount(7);

  for (const day of ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']) await days.getByRole('button', { name: day, exact: true }).click();
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Выберите хотя бы один день недели.');
  expect(state.writes).toEqual([]);

  for (const day of ['Пятница', 'Понедельник', 'Среда']) await days.getByRole('button', { name: day, exact: true }).click();
  await editor.locator('[name="timeOfDay"]').fill('07:45');
  await editor.getByLabel('Сохранить расписание на паузе').check();
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ schedule: 'daily', timeOfDay: '07:45', weekdays: [1, 3, 5], timeZone: 'Europe/Moscow', intervalMinutes: null, firstRunAt: null, paused: true });
});

test('editing keeps the card zone and can switch it to the browser zone', async ({ page }) => {
  const state = await fixtureApi(page, [
    fixtureTask({ id: 'tokyo', title: 'Отчёт для Токио', schedule: 'daily', timeOfDay: '09:30', weekdays: [1, 3], timeZone: 'Asia/Tokyo', nextRunAt: Date.UTC(2026, 9, 26, 0, 30) }),
  ]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть задачу: Отчёт для Токио', exact: true }).click();
  await page.getByRole('dialog', { name: 'Отчёт для Токио', exact: true }).getByRole('button', { name: 'Изменить', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(edit.getByRole('button', { name: 'По времени', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(edit.locator('[name="timeOfDay"]')).toHaveValue('09:30');
  await expect(edit.getByRole('group', { name: 'Дни недели', exact: true }).getByRole('button', { pressed: true })).toHaveText(['Пн', 'Ср']);
  await expect(edit.getByText('Часовой пояс: Asia/Tokyo')).toBeVisible();

  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(edit).not.toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({ timeOfDay: '09:30', weekdays: [1, 3], timeZone: 'Asia/Tokyo' });

  await page.getByRole('dialog', { name: 'Отчёт для Токио', exact: true }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await edit.getByRole('button', { name: 'Использовать пояс браузера: Europe/Moscow', exact: true }).click();
  await expect(edit.getByText('Часовой пояс: Europe/Moscow')).toBeVisible();
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(edit).not.toBeVisible();
  expect(state.writes.at(-1)).toMatchObject({ timeOfDay: '09:30', weekdays: [1, 3], timeZone: 'Europe/Moscow' });
});
