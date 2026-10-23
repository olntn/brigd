import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, AutopilotOverview, GeneralSettings, Run, Task, TaskInput, Worker } from '../src/lib/types';

const launchTypes = [
  { value: 'auto', label: 'Автопилот' },
  { value: 'manual', label: 'Вручную' },
  { value: 'interval', label: 'По расписанию' },
] as const;

function fixtureTask(input: Partial<Task> = {}): Task {
  return {
    id: 'existing-task', title: 'Существующая задача', instruction: 'Проверь проект.', provider: 'codex',
    cwd: '/workspace/existing-project', schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null,
    paused: false, dependsOnTaskIds: [], dependencies: [], tagIds: [], tags: [], steps: [], workerId: null, worker: null,
    createdAt: Date.UTC(2026, 0, 15, 12), updatedAt: Date.UTC(2026, 0, 15, 12),
    archivedAt: null, nextRunAt: null, status: 'ready', latestRun: null, runCount: 0,
    ...input,
  };
}

function fixtureWorker(input: Partial<Worker> & Pick<Worker, 'id' | 'name' | 'provider'>): Worker {
  return {
    description: '', model: null, effort: 'default', ultracode: false, fallbackWorkerId: null, communicationStyle: '', avatarUrl: null,
    archived: false, createdAt: Date.UTC(2026, 0, 15, 12), updatedAt: Date.UTC(2026, 0, 15, 12), ...input,
  };
}

// Stateful API fixtures keep these UI checks independent from the shared demo
// database. Server tests cover directory validation and storage persistence.
async function fixtureApi(page: Page) {
  const state = {
    defaultCwd: '/workspace/project',
    defaultSchedule: 'manual' as GeneralSettings['defaultSchedule'],
    defaultWorkerId: null as string | null,
    webhookUrl: '', webhookSecret: '',
    workers: [] as Worker[],
    readError: '',
    saveFailure: null as { status: number; message: string } | null,
    pendingRead: null as Promise<void> | null,
    pendingSave: null as Promise<void> | null,
    writes: [] as GeneralSettings[],
    tasks: [] as Task[],
    taskWrites: [] as TaskInput[],
    autopilot: { enabled: false, until: null, startedAt: null, stoppedAt: null, stopReason: null, failures: 0, updatedAt: 0, pool: [], attempts: [] } as unknown as AutopilotOverview,
  };
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: Date.UTC(2026, 0, 15, 12),
    providers: [
      { id: 'codex', available: true, label: 'Codex' },
      { id: 'claude', available: true, label: 'Claude Code' },
    ],
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/settings/general' && method === 'PATCH') {
      const body = route.request().postDataJSON() as GeneralSettings;
      state.writes.push(body);
      if (state.saveFailure) {
        await route.fulfill({ status: state.saveFailure.status, json: { error: state.saveFailure.message } });
      } else {
        if (state.pendingSave) await state.pendingSave;
        state.defaultCwd = body.defaultCwd;
        state.defaultSchedule = body.defaultSchedule;
        state.defaultWorkerId = body.defaultWorkerId;
        state.webhookUrl = body.webhookUrl; state.webhookSecret = body.webhookSecret;
        await route.fulfill({ json: { defaultCwd: state.defaultCwd, defaultSchedule: state.defaultSchedule, defaultWorkerId: state.defaultWorkerId, webhookUrl: state.webhookUrl, webhookSecret: state.webhookSecret, fallbackWorkers: { codex: null, claude: null } } });
      }
    } else if (path === '/api/settings/general' && method === 'GET') {
      if (state.pendingRead) await state.pendingRead;
      await route.fulfill(state.readError
        ? { status: 503, json: { error: state.readError } }
        : { json: { defaultCwd: state.defaultCwd, defaultSchedule: state.defaultSchedule, defaultWorkerId: state.defaultWorkerId, webhookUrl: state.webhookUrl, webhookSecret: state.webhookSecret, fallbackWorkers: { codex: null, claude: null } } });
    } else if (path === '/api/tasks' && method === 'POST') {
      const body = route.request().postDataJSON() as TaskInput;
      state.taskWrites.push(body);
      const task = fixtureTask({ ...body, id: `created-${state.taskWrites.length}`, worker: state.workers.find(worker => worker.id === body.workerId) ?? null });
      state.tasks.unshift(task);
      await route.fulfill({ json: task });
    } else if (method !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Unsupported fixture mutation' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: state.tasks });
    } else if (path.startsWith('/api/tasks/')) {
      const task = state.tasks.find(task => path === `/api/tasks/${task.id}`);
      await route.fulfill(task
        ? { json: { task, runs: [], comments: [] } }
        : { status: 404, json: { error: 'Unknown fixture task' } });
    } else if (path === '/api/workers') {
      await route.fulfill({ json: state.workers });
    } else if (path === '/api/models' || path === '/api/tags') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: null, source: null } });
    } else if (path === '/api/autopilot') {
      await route.fulfill({ json: state.autopilot });
    } else {
      await route.fulfill({ status: 404, json: { error: 'Unknown general settings fixture' } });
    }
  });
  return state;
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await expect(dialog).toBeVisible();
  const panel = dialog.getByRole('tabpanel', { name: 'Общие', exact: true });
  return {
    dialog, panel,
    field: panel.getByLabel('Рабочая папка по умолчанию', { exact: true }),
    schedule: panel.getByRole('combobox', { name: 'Тип запуска по умолчанию', exact: true }),
    worker: panel.getByRole('combobox', { name: 'Работник по умолчанию', exact: true }),
  };
}

test('General comes first and saved working folders initialize new tasks after reload', async ({ page }) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  let settings = await openSettings(page);
  const sections = settings.dialog.getByRole('tablist', { name: 'Разделы настроек', exact: true });
  await expect(sections.getByRole('tab').first()).toHaveText('Общие');
  await expect(sections.getByRole('tab', { name: 'Общие', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.panel.getByRole('heading', { name: 'Общие', exact: true })).toBeVisible();
  await expect(settings.field).toHaveValue('/workspace/project');
  await expect(settings.schedule).toHaveValue('manual');
  await expect(settings.schedule.getByRole('option')).toHaveText(launchTypes.map(type => type.label));

  await settings.field.fill('/workspace/saved-project');
  await settings.schedule.selectOption('auto');
  await sections.getByRole('tab', { name: 'Внешний вид', exact: true }).click();
  await sections.getByRole('tab', { name: 'Общие', exact: true }).click();
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await expect(settings.schedule).toHaveValue('auto');
  await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
  expect(state.writes).toEqual([{ webhookUrl: '', webhookSecret: '', agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: '/workspace/saved-project', defaultSchedule: 'auto', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } }]);

  await settings.field.fill('/workspace/unsaved-project');
  await settings.schedule.selectOption('interval');
  await sections.getByRole('tab', { name: 'Внешний вид', exact: true }).click();
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  settings = await openSettings(page);
  await expect(settings.dialog.getByRole('tab', { name: 'Внешний вид', exact: true })).toHaveAttribute('aria-selected', 'true');
  await settings.dialog.getByRole('tab', { name: 'Общие', exact: true }).click();
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await expect(settings.schedule).toHaveValue('auto');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/saved-project');
  await expect(editor.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.locator('[name="cwd"]').fill('/workspace/manual-project');
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/manual-project');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();

  await page.reload();
  settings = await openSettings(page);
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await expect(settings.schedule).toHaveValue('auto');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/saved-project');
  await expect(editor.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a rejected directory keeps the error and draft for correction', async ({ page }) => {
  const state = await fixtureApi(page);
  state.saveFailure = { status: 400, message: 'Рабочая папка должна быть абсолютным путём к существующей папке.' };
  await page.goto('/');
  const { panel, field, schedule } = await openSettings(page);
  await expect(field).toBeEnabled();
  await field.fill('relative/project');
  await schedule.selectOption('interval');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.saveFailure.message);
  await expect(field).toHaveValue('relative/project');
  await expect(schedule).toHaveValue('interval');
  expect(state.defaultCwd).toBe('/workspace/project');
  expect(state.defaultSchedule).toBe('manual');

  state.saveFailure = null;
  await field.fill('/workspace/corrected-project');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(state.defaultCwd).toBe('/workspace/corrected-project');
  expect(state.defaultSchedule).toBe('interval');
});

test('failed loading and saving can retry, and pending saves protect the dialog', async ({ page }) => {
  const state = await fixtureApi(page);
  state.readError = 'Настройки временно недоступны';
  state.defaultSchedule = 'auto';
  await page.goto('/');
  const { dialog, panel, field, schedule } = await openSettings(page);
  await expect(panel.getByRole('alert')).toContainText(state.readError);
  await expect(field).toBeDisabled();
  await expect(schedule).toBeDisabled();
  state.readError = '';
  await panel.getByRole('button', { name: 'Повторить загрузку настроек', exact: true }).click();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('/workspace/project');
  await expect(schedule).toHaveValue('auto');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  state.saveFailure = { status: 503, message: 'Не удалось сохранить настройки' };
  await field.fill('/workspace/retry-project');
  await schedule.selectOption('interval');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.saveFailure.message);
  await expect(field).toHaveValue('/workspace/retry-project');
  await expect(schedule).toHaveValue('interval');
  expect(state.defaultSchedule).toBe('auto');

  let release!: () => void;
  state.pendingSave = new Promise<void>(resolve => { release = resolve; });
  state.saveFailure = null;
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  try {
    await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await expect(field).toBeDisabled();
    await expect(schedule).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeEnabled();
  expect(state.defaultCwd).toBe('/workspace/retry-project');
  expect(state.defaultSchedule).toBe('interval');
});

test('opening a new task waits for the saved launch type on initial load', async ({ page }) => {
  const state = await fixtureApi(page);
  state.defaultSchedule = 'interval';
  let release!: () => void;
  state.pendingRead = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).not.toBeVisible();
  } finally { release(); }
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'По расписанию', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('[name="intervalMinutes"]')).toHaveValue('60');
});

for (const { value, label } of launchTypes) {
  test(`saved ${label} launch type persists after reload and initializes new tasks`, async ({ page }) => {
    const state = await fixtureApi(page);
    await page.goto('/');
    let settings = await openSettings(page);
    await settings.schedule.selectOption(value);
    await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
    expect(state.writes).toEqual([{ webhookUrl: '', webhookSecret: '', agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: '/workspace/project', defaultSchedule: value, defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } }]);

    await page.reload();
    settings = await openSettings(page);
    await expect(settings.schedule).toHaveValue(value);
    await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
    await expect(editor.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (value === 'interval') {
      await expect(editor.locator('[name="intervalMinutes"]')).toHaveValue('60');
      await expect(editor.locator('[name="firstRunAt"]')).toBeVisible();
      await expect(editor.getByLabel('Сохранить расписание на паузе')).toBeVisible();
    } else {
      await expect(editor.locator('[name="intervalMinutes"]')).toHaveCount(0);
    }
    await editor.locator('[name="title"]').fill(`Новая задача: ${label}`);
    await editor.locator('[name="instruction"]').fill('Проверь проект.');
    await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(editor).not.toBeVisible();
    expect(state.taskWrites).toHaveLength(1);
    expect(state.taskWrites[0]).toMatchObject({ schedule: value, intervalMinutes: value === 'interval' ? 60 : null });
  });
}

test('a new task can override the launch type without changing the saved default or existing tasks', async ({ page }) => {
  const state = await fixtureApi(page);
  state.tasks = launchTypes.map(({ value, label }) => fixtureTask({
    id: `existing-${value}`, title: `Существующая: ${label}`, schedule: value,
    intervalMinutes: value === 'interval' ? 25 : null, paused: value === 'interval',
  }));
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.schedule.selectOption('auto');
  await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: 'Вручную', exact: true }).click();
  await editor.locator('[name="title"]').fill('Запустить вручную');
  await editor.locator('[name="instruction"]').fill('Проверь проект.');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(state.taskWrites[0]).toMatchObject({ schedule: 'manual', intervalMinutes: null });
  expect(state.defaultSchedule).toBe('auto');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Автопилот', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();

  for (const { value, label } of launchTypes) {
    const title = `Существующая: ${label}`;
    await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: title, exact: true });
    await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
    await expect(edit.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(edit.locator('[name="cwd"]')).toHaveValue('/workspace/existing-project');
    if (value === 'interval') {
      await expect(edit.locator('[name="intervalMinutes"]')).toHaveValue('25');
      await expect(edit.getByLabel('Сохранить расписание на паузе')).toBeChecked();
    }
    await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  }
  expect(state.writes).toEqual([{ webhookUrl: '', webhookSecret: '', agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: '/workspace/project', defaultSchedule: 'auto', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } }]);
  expect(state.tasks.filter(task => task.id.startsWith('existing-')).map(task => task.schedule)).toEqual(launchTypes.map(type => type.value));
});

test('the saved default worker is preselected in new single-worker tasks only', async ({ page }) => {
  const state = await fixtureApi(page);
  state.workers = [
    fixtureWorker({ id: 'worker-sol', name: 'Sol', provider: 'codex' }),
    fixtureWorker({ id: 'worker-opus', name: 'Opus', provider: 'claude' }),
    fixtureWorker({ id: 'worker-archived', name: 'Старый', provider: 'codex', archived: true }),
  ];
  state.tasks = [fixtureTask({ id: 'existing-unassigned', title: 'Существующая без работника' })];
  await page.goto('/');
  let settings = await openSettings(page);
  await expect(settings.worker).toHaveValue('');
  await expect(settings.worker.getByRole('option')).toHaveText(['Не выбирать', 'Sol · Codex', 'Opus · Claude Code']);
  await settings.worker.selectOption('worker-opus');
  await expect(settings.panel.getByText('Opus подставляется в поле «Работник» у новых простых задач.')).toBeVisible();
  await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
  expect(state.writes).toEqual([{ webhookUrl: '', webhookSecret: '', agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: '/workspace/project', defaultSchedule: 'manual', defaultWorkerId: 'worker-opus', fallbackWorkers: { codex: null, claude: null } }]);

  await page.reload();
  settings = await openSettings(page);
  await expect(settings.worker).toHaveValue('worker-opus');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.getByRole('combobox', { name: 'Работник', exact: true })).toHaveValue('worker-opus');
  await editor.locator('[name="title"]').fill('С работником по умолчанию');
  await editor.locator('[name="instruction"]').fill('Проверь проект.');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(state.taskWrites.at(-1)).toMatchObject({ workerId: 'worker-opus', provider: 'claude' });
  await page.keyboard.press('Escape');

  // The form can still clear the preselected worker for one task.
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.getByRole('combobox', { name: 'Работник', exact: true }).selectOption('');
  await editor.locator('[name="title"]').fill('Без работника');
  await editor.locator('[name="instruction"]').fill('Проверь проект.');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(state.taskWrites.at(-1)).toMatchObject({ workerId: null });
  expect(state.defaultWorkerId).toBe('worker-opus');
  await page.keyboard.press('Escape');

  // Editing keeps a card's own assignment.
  await page.getByRole('button', { name: 'Открыть задачу: Существующая без работника', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Существующая без работника', exact: true });
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(edit.getByRole('combobox', { name: 'Работник', exact: true })).toHaveValue('');
  await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();

  // An archived default stays saved but is not preselected.
  state.defaultWorkerId = 'worker-archived';
  await page.reload();
  settings = await openSettings(page);
  await expect(settings.worker).toHaveValue('worker-archived');
  await expect(settings.panel.getByText('Старый в архиве и не подставляется в новые задачи.', { exact: false })).toBeVisible();
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.getByRole('combobox', { name: 'Работник', exact: true })).toHaveValue('');
});

test('notification preferences stay in the browser; webhook fields save on the server', async ({ page }) => {
  const state = await fixtureApi(page);
  await mockNotifications(page);
  await page.goto('/');
  let settings = await openSettings(page);
  const browser = settings.panel.getByRole('checkbox', { name: 'Уведомления в браузере', exact: true });
  await expect(browser).not.toBeChecked();
  await expect(settings.panel.getByRole('checkbox', { name: 'Звук', exact: true })).not.toBeChecked();
  await expect(settings.panel.getByRole('checkbox', { name: 'Задача завершена и слита', exact: true })).not.toBeChecked();
  await browser.check();
  await expect(settings.panel.getByText('Разрешение: получено', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(1);
  await settings.panel.getByRole('checkbox', { name: 'Звук', exact: true }).check();
  await settings.panel.getByRole('checkbox', { name: 'Вопросы агента', exact: true }).uncheck();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('brigd.notifications')!))).toMatchObject({ browser: true, sound: true, events: { questions: false, completed: false } });
  expect(state.writes).toHaveLength(0);
  await settings.panel.getByLabel('URL webhook', { exact: true }).fill('https://example.com/events');
  await settings.panel.getByLabel('Секрет', { exact: true }).fill('test-secret');
  await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
  expect(state.writes.at(-1)).toMatchObject({ webhookUrl: 'https://example.com/events', webhookSecret: 'test-secret' });
  expect(state.writes.at(-1)).not.toHaveProperty('browser');
  await page.reload();
  settings = await openSettings(page);
  await expect(settings.panel.getByRole('checkbox', { name: 'Уведомления в браузере', exact: true })).toBeChecked();
  await expect(settings.panel.getByRole('checkbox', { name: 'Звук', exact: true })).toBeChecked();
  await expect(settings.panel.getByRole('checkbox', { name: 'Вопросы агента', exact: true })).not.toBeChecked();
  await expect(settings.panel.getByLabel('URL webhook', { exact: true })).toHaveValue('https://example.com/events');
});

async function mockNotifications(page: Page) {
  await page.addInitScript(() => {
    const state = window as any;
    state.__notifications = [];
    state.__permissionRequests = 0;
    state.Notification = class {
      static permission = 'default';
      static async requestPermission() { state.__permissionRequests++; this.permission = 'granted'; return 'granted'; }
      onclick: (() => void) | null = null;
      constructor(public title: string, public options: unknown) { state.__notifications.push(this); }
      close() {}
    };
    state.__streams = [];
    state.EventSource = class extends EventTarget {
      constructor() { super(); state.__streams.push(this); }
      close() {}
    };
  });
}
function notificationTask(status: Run['status'], turn = 1): Task {
  const timestamp = Date.UTC(2026, 0, 15, 12);
  const run: Run = {
    id: 'notification-run', taskId: 'notification-task', steps: [], currentStepIndex: null, workerId: null, worker: null, instructions: [],
    provider: 'codex', cwd: '/workspace/project', instruction: 'Private instructions', trigger: 'manual', scheduledFor: null, status,
    sessionId: 'session', startedAt: timestamp, updatedAt: timestamp + turn * 1000, finishedAt: null, summary: null, error: null, turn, mock: true,
  };
  return fixtureTask({ id: run.taskId, title: 'Задача с вопросом', status, latestRun: run, runCount: 1 });
}
async function notifyChange(page: Page) {
  await page.evaluate(() => {
    for (const stream of (window as any).__streams) stream.dispatchEvent(new MessageEvent('change', { data: JSON.stringify({ scopes: ['tasks'], revision: Date.now() }) }));
  });
}
async function notificationCount(page: Page): Promise<number> { return page.evaluate(() => (window as any).__notifications.length); }

for (const fallback of [false, true]) test(`a transition notifies once across tabs, click opens the card and reload ignores old questions (${fallback ? 'localStorage' : 'Web Locks'})`, async ({ page, context }) => {
  if (fallback) await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
  const first = await fixtureApi(page);
  first.tasks = [notificationTask('running')];
  await mockNotifications(page);
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.panel.getByRole('checkbox', { name: 'Уведомления в браузере', exact: true }).check();
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  const secondPage = await context.newPage();
  const second = await fixtureApi(secondPage);
  second.tasks = [notificationTask('running')];
  await mockNotifications(secondPage);
  await secondPage.goto('/');
  await secondPage.evaluate(() => { (window as any).Notification.permission = 'granted'; });
  await expect(secondPage.getByRole('button', { name: 'Открыть задачу: Задача с вопросом', exact: true })).toBeVisible();
  first.tasks = [notificationTask('waiting_input')];
  second.tasks = [notificationTask('waiting_input')];
  await Promise.all([notifyChange(page), notifyChange(secondPage)]);
  await expect.poll(async () => await notificationCount(page) + await notificationCount(secondPage)).toBe(1);
  const owner = await notificationCount(page) ? page : secondPage;
  await owner.evaluate(() => (window as any).__notifications[0].onclick());
  await expect(owner.getByRole('dialog', { name: 'Задача с вопросом', exact: true })).toBeVisible();
  await Promise.all([notifyChange(page), notifyChange(secondPage)]);
  await expect.poll(async () => await notificationCount(page) + await notificationCount(secondPage)).toBe(1);
  await page.reload();
  await page.evaluate(() => { (window as any).Notification.permission = 'granted'; });
  await expect(page.getByRole('button', { name: 'Открыть задачу: Задача с вопросом', exact: true })).toBeVisible();
  expect(await notificationCount(page)).toBe(0);
  // A later question in the same native session is a distinct event.
  first.tasks = [notificationTask('waiting_input', 2)];
  await notifyChange(page);
  await expect.poll(() => notificationCount(page)).toBe(1);
});

test('autopilot notifications follow transitions and completed merges respect the separate toggle', async ({ page }) => {
  const state = await fixtureApi(page);
  state.tasks = [notificationTask('running')];
  state.autopilot = { ...state.autopilot, enabled: true, startedAt: 10, attempts: [state.tasks[0]!.latestRun!] };
  await mockNotifications(page);
  await page.goto('/');
  const settings = await openSettings(page);
  await settings.panel.getByRole('checkbox', { name: 'Уведомления в браузере', exact: true }).check();
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  state.tasks = [notificationTask('completed')];
  state.autopilot.attempts = [state.tasks[0]!.latestRun!];
  await notifyChange(page);
  await expect.poll(() => notificationCount(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).__notifications[0].title)).toBe('Очередь автопилота закончилась');
  state.autopilot = { ...state.autopilot, enabled: false, stoppedAt: 20, stopReason: 'until' };
  await notifyChange(page);
  await expect.poll(() => notificationCount(page)).toBe(2);
  const completed = state.tasks[0]!;
  completed.title = 'Проверенный результат';
  completed.latestRun!.integration = { id: 'merge-1', attempt: 1, status: 'merged', updatedAt: 25 } as NonNullable<Run['integration']>;
  await notifyChange(page);
  await expect(page.getByRole('button', { name: 'Открыть задачу: Проверенный результат', exact: true })).toBeVisible();
  const reopened = await openSettings(page);
  await reopened.panel.getByRole('checkbox', { name: 'Задача завершена и слита', exact: true }).check();
  await reopened.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  expect(await notificationCount(page)).toBe(2);
  // A later run's merge is a new completion event.
  completed.latestRun!.id = 'next-run';
  completed.latestRun!.integration!.id = 'merge-2';
  await notifyChange(page);
  await expect.poll(() => notificationCount(page)).toBe(3);
  expect(await page.evaluate(() => (window as any).__notifications.at(-1).title)).toBe('Задача завершена и слита');
});
