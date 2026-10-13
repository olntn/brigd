import { expect, test, type Page } from '@playwright/test';
import type { AppInfo } from '../src/lib/types';

// Stateful API fixtures keep these UI checks independent from the shared demo
// database. Server tests cover directory validation and storage persistence.
async function fixtureApi(page: Page) {
  const state = {
    defaultCwd: '/workspace/project',
    readError: '',
    saveFailure: null as { status: number; message: string } | null,
    pendingSave: null as Promise<void> | null,
    writes: [] as Array<{ defaultCwd: string }>,
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
      const body = route.request().postDataJSON() as { defaultCwd: string };
      state.writes.push(body);
      if (state.saveFailure) {
        await route.fulfill({ status: state.saveFailure.status, json: { error: state.saveFailure.message } });
      } else {
        if (state.pendingSave) await state.pendingSave;
        state.defaultCwd = body.defaultCwd;
        await route.fulfill({ json: { defaultCwd: state.defaultCwd } });
      }
    } else if (path === '/api/settings/general' && method === 'GET') {
      await route.fulfill(state.readError
        ? { status: 503, json: { error: state.readError } }
        : { json: { defaultCwd: state.defaultCwd } });
    } else if (method !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Unsupported fixture mutation' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/tasks' || path === '/api/workers' || path === '/api/models') {
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
  return { dialog, panel, field: panel.getByLabel('Рабочая папка по умолчанию', { exact: true }) };
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

  await settings.field.fill('/workspace/saved-project');
  await sections.getByRole('tab', { name: 'Внешний вид', exact: true }).click();
  await sections.getByRole('tab', { name: 'Общие', exact: true }).click();
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await settings.panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(settings.panel.getByRole('status')).toContainText('Настройки сохранены');
  expect(state.writes).toEqual([{ defaultCwd: '/workspace/saved-project' }]);

  await settings.field.fill('/workspace/unsaved-project');
  await sections.getByRole('tab', { name: 'Внешний вид', exact: true }).click();
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  settings = await openSettings(page);
  await expect(settings.dialog.getByRole('tab', { name: 'Внешний вид', exact: true })).toHaveAttribute('aria-selected', 'true');
  await settings.dialog.getByRole('tab', { name: 'Общие', exact: true }).click();
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/saved-project');
  await editor.locator('[name="cwd"]').fill('/workspace/manual-project');
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/manual-project');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();

  await page.reload();
  settings = await openSettings(page);
  await expect(settings.field).toHaveValue('/workspace/saved-project');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await expect(editor.locator('[name="cwd"]')).toHaveValue('/workspace/saved-project');
});

test('a rejected directory keeps the error and draft for correction', async ({ page }) => {
  const state = await fixtureApi(page);
  state.saveFailure = { status: 400, message: 'Рабочая папка должна быть абсолютным путём к существующей папке.' };
  await page.goto('/');
  const { panel, field } = await openSettings(page);
  await expect(field).toBeEnabled();
  await field.fill('relative/project');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.saveFailure.message);
  await expect(field).toHaveValue('relative/project');
  expect(state.defaultCwd).toBe('/workspace/project');

  state.saveFailure = null;
  await field.fill('/workspace/corrected-project');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(state.defaultCwd).toBe('/workspace/corrected-project');
});

test('failed loading and saving can retry, and pending saves protect the dialog', async ({ page }) => {
  const state = await fixtureApi(page);
  state.readError = 'Настройки временно недоступны';
  await page.goto('/');
  const { dialog, panel, field } = await openSettings(page);
  await expect(panel.getByRole('alert')).toContainText(state.readError);
  await expect(field).toBeDisabled();
  state.readError = '';
  await panel.getByRole('button', { name: 'Повторить загрузку настроек', exact: true }).click();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('/workspace/project');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  state.saveFailure = { status: 503, message: 'Не удалось сохранить настройки' };
  await field.fill('/workspace/retry-project');
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.saveFailure.message);
  await expect(field).toHaveValue('/workspace/retry-project');

  let release!: () => void;
  state.pendingSave = new Promise<void>(resolve => { release = resolve; });
  state.saveFailure = null;
  await panel.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  try {
    await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await expect(field).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeEnabled();
  expect(state.defaultCwd).toBe('/workspace/retry-project');
});
