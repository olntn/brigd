import { expect, test, type Page } from '@playwright/test';
import type { AutopilotSettings, Task } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const settingsRoute = /\/api\/settings\/autopilot(?:\?.*)?$/;
const checks = [['bun', 'install', '--frozen-lockfile'], ['bun', 'run', 'verify']];

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Автопилот', exact: true }).click();
  await expect(dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true })).toBeEnabled();
  return dialog;
}

test.beforeEach(async ({ request }) => {
  expect((await (await request.get('/api/info')).json()).mode).toBe('mock');
  expect((await request.patch('/api/autopilot', { headers: origin, data: { enabled: false, until: null } })).ok()).toBe(true);
  const reset = await request.patch('/api/settings/autopilot', { headers: origin, data: { integrationChecks: null } });
  expect(reset.ok()).toBe(true);
  expect(await reset.json()).toEqual({ integrationChecks: null, source: null });
});

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings/autopilot', { headers: origin, data: { integrationChecks: null } })).ok()).toBe(true);
  expect((await request.patch('/api/settings/check-triage', { headers: origin, data: { enabled: null } })).ok()).toBe(true);
});

test('failed check triage is on by default, stays off once switched off and returns to the default', async ({ page, request }) => {
  expect((await request.patch('/api/settings/check-triage', { headers: origin, data: { enabled: null } })).ok()).toBe(true);
  await page.goto('/');
  let dialog = await openSettings(page);
  let section = dialog.getByRole('region', { name: 'Разбор упавших проверок', exact: true });
  let toggle = section.getByRole('checkbox', { name: 'Разбирать упавшие проверки автоматически', exact: true });
  await expect(toggle).toBeChecked();
  await expect(section).toContainText('Используется значение по умолчанию: включено.');
  await expect(section).toContainText('не больше 3 раз на один результат');
  await expect(section).toContainText('не дольше 30 мин');
  await expect(section).toContainText('Всего: прошли со второй попытки — 0');
  await expect(section.getByRole('button', { name: 'Вернуть значение по умолчанию', exact: true })).toBeDisabled();
  await toggle.uncheck();
  await expect(section.getByRole('status')).toContainText('Разбор выключен');
  expect(await (await request.get('/api/settings/check-triage')).json()).toMatchObject({ enabled: false, saved: false, defaultEnabled: true });

  await page.reload();
  dialog = await openSettings(page);
  section = dialog.getByRole('region', { name: 'Разбор упавших проверок', exact: true });
  toggle = section.getByRole('checkbox', { name: 'Разбирать упавшие проверки автоматически', exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(section).toContainText('Сохранено в настройках.');
  await section.getByRole('button', { name: 'Вернуть значение по умолчанию', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(section.getByRole('status')).toContainText('Восстановлено значение по умолчанию.');
  expect(await (await request.get('/api/settings/check-triage')).json()).toMatchObject({ enabled: true, saved: null });
});

test('missing checks block autopilot; valid settings persist and reset blocks it again', async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  await page.route('**/api/info', route => route.fulfill({ json: { ...info, mode: 'cli' } }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  const status = page.getByRole('region', { name: 'Состояние автопилота' });
  await expect(status.getByRole('button', { name: 'Включить автопилот', exact: true })).toBeDisabled();
  await status.getByRole('button', { name: 'открыть настройки автопилота', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await expect(dialog.getByRole('tab', { name: 'Автопилот', exact: true })).toHaveAttribute('aria-selected', 'true');
  const field = dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true });
  await expect(field).toBeEnabled();
  await field.fill('[]');
  await dialog.getByRole('button', { name: 'Сохранить проверки', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('укажите 1–10 непустых команд');
  expect(await (await request.get('/api/settings/autopilot')).json()).toEqual({ integrationChecks: null, source: null });

  await field.fill(JSON.stringify(checks));
  await dialog.getByRole('tab', { name: 'Модели', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Автопилот', exact: true }).click();
  await expect(field).toHaveValue(JSON.stringify(checks));
  await dialog.getByRole('button', { name: 'Сохранить проверки', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Проверки сохранены');
  expect(await (await request.get('/api/settings/autopilot')).json()).toEqual({ integrationChecks: checks, source: 'settings' });
  await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await expect(status.getByRole('button', { name: 'Включить автопилот', exact: true })).toBeEnabled();

  await page.reload();
  dialog = await openSettings(page);
  await expect(dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true })).toHaveValue(JSON.stringify(checks, null, 2));
  await dialog.getByRole('button', { name: 'Сбросить настройку', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Настройка сброшена');
  await expect(dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await expect(status.getByRole('button', { name: 'Включить автопилот', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('loading and save errors allow retry; pending writes protect the dialog', async ({ page, request }) => {
  let failRead = true;
  let failSave = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(settingsRoute, async route => {
    if (route.request().method() === 'GET' && failRead) {
      await route.fulfill({ status: 503, json: { error: 'Настройки временно недоступны' } });
    } else if (route.request().method() === 'PATCH') {
      if (failSave) await route.fulfill({ status: 503, json: { error: 'Не удалось сохранить проверки' } });
      else { await gate; await route.continue(); }
    } else await route.continue();
  });
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog.getByRole('alert')).toContainText('Настройки временно недоступны');
  const field = dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true });
  await field.fill(JSON.stringify(checks));
  failRead = false;
  await dialog.getByRole('button', { name: 'Повторить загрузку настроек', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(field).toHaveValue(JSON.stringify(checks));
  await dialog.getByRole('button', { name: 'Сохранить проверки', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Не удалось сохранить проверки');
  await expect(field).toHaveValue(JSON.stringify(checks));

  failSave = false;
  await dialog.getByRole('button', { name: 'Сохранить проверки', exact: true }).click();
  try {
    await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await expect(field).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(dialog.getByRole('status')).toContainText('Проверки сохранены');
  await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeEnabled();
  expect(await (await request.get('/api/settings/autopilot')).json() as AutopilotSettings).toEqual({ integrationChecks: checks, source: 'settings' });
});

test('real mode disables task launch until checks are configured', async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  // The server stays in mock mode; only the UI sees CLI mode, so no real process can start.
  await page.route('**/api/info', route => route.fulfill({ json: { ...info, mode: 'cli' } }));
  const created = await request.post('/api/tasks', { headers: origin, data: {
    title: `Проверки перед запуском ${crypto.randomUUID()}`, instruction: 'Опиши проект.', provider: 'codex', cwd: info.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
  } });
  expect(created.status()).toBe(201);
  const task = await created.json() as Task;
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: `Запустить: ${task.title}`, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Настройки автопилота', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
    await dialog.getByLabel('BRIGD_INTEGRATION_CHECKS', { exact: true }).fill(JSON.stringify(checks));
    await dialog.getByRole('button', { name: 'Сохранить проверки', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Проверки сохранены');
    await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await expect(page.getByRole('button', { name: `Запустить: ${task.title}`, exact: true })).toBeEnabled();
  } finally {
    expect((await request.post(`/api/tasks/${task.id}/archive`, { headers: origin, data: {} })).ok()).toBe(true);
  }
});
