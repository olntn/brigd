import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, GeneralSettings, Task, TaskInput } from '../src/lib/types';

const launchTypes = [
  { value: 'auto', label: 'Автопилот' },
  { value: 'manual', label: 'Вручную' },
  { value: 'interval', label: 'По расписанию' },
] as const;

function fixtureTask(input: Partial<Task> = {}): Task {
  return {
    id: 'existing-task', title: 'Существующая задача', instruction: 'Проверь проект.', provider: 'codex',
    cwd: '/workspace/existing-project', schedule: 'manual', intervalMinutes: null, firstRunAt: null,
    paused: false, tagIds: [], tags: [], steps: [], workerId: null, worker: null,
    createdAt: Date.UTC(2026, 0, 15, 12), updatedAt: Date.UTC(2026, 0, 15, 12),
    archivedAt: null, nextRunAt: null, status: 'ready', latestRun: null, runCount: 0,
    ...input,
  };
}

// Stateful API fixtures keep these UI checks independent from the shared demo
// database. Server tests cover directory validation and storage persistence.
async function fixtureApi(page: Page) {
  const state = {
    defaultCwd: '/workspace/project',
    defaultSchedule: 'manual' as GeneralSettings['defaultSchedule'],
    readError: '',
    saveFailure: null as { status: number; message: string } | null,
    pendingRead: null as Promise<void> | null,
    pendingSave: null as Promise<void> | null,
    writes: [] as GeneralSettings[],
    tasks: [] as Task[],
    taskWrites: [] as TaskInput[],
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
        await route.fulfill({ json: { defaultCwd: state.defaultCwd, defaultSchedule: state.defaultSchedule, fallbackWorkers: { codex: null, claude: null } } });
      }
    } else if (path === '/api/settings/general' && method === 'GET') {
      if (state.pendingRead) await state.pendingRead;
      await route.fulfill(state.readError
        ? { status: 503, json: { error: state.readError } }
        : { json: { defaultCwd: state.defaultCwd, defaultSchedule: state.defaultSchedule, fallbackWorkers: { codex: null, claude: null } } });
    } else if (path === '/api/tasks' && method === 'POST') {
      const body = route.request().postDataJSON() as TaskInput;
      state.taskWrites.push(body);
      const task = fixtureTask({ ...body, id: `created-${state.taskWrites.length}` });
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
    } else if (path === '/api/workers' || path === '/api/models' || path === '/api/tags') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: null, source: null } });
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
  expect(state.writes).toEqual([{ defaultCwd: '/workspace/saved-project', defaultSchedule: 'auto', fallbackWorkers: { codex: null, claude: null } }]);

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
    expect(state.writes).toEqual([{ defaultCwd: '/workspace/project', defaultSchedule: value, fallbackWorkers: { codex: null, claude: null } }]);

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
  expect(state.writes).toEqual([{ defaultCwd: '/workspace/project', defaultSchedule: 'auto', fallbackWorkers: { codex: null, claude: null } }]);
  expect(state.tasks.filter(task => task.id.startsWith('existing-')).map(task => task.schedule)).toEqual(launchTypes.map(type => type.value));
});
