import { existsSync, readFileSync, rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The test server points BRIGD_CLI_HOME at this scratch folder, so the buttons never touch a real home.
const cliHome = 'test-results/cli-home';
const origin = { Origin: 'http://127.0.0.1:4318' };
const accessName = 'Полный доступ Codex и Claude Code';

async function openPermissions(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Разрешения', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Разрешения', exact: true })).toBeVisible();
  return dialog;
}

async function toggleAccess(page: Page) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/permissions') && response.request().method() === 'PATCH');
  await page.getByRole('switch', { name: accessName, exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole('switch', { name: accessName, exact: true })).toBeEnabled();
}

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  expect((await request.patch('/api/settings/permissions', { headers: origin, data: { mode: 'full' } })).ok()).toBe(true);
  rmSync(cliHome, { recursive: true, force: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings/permissions', { headers: origin, data: { mode: 'full' } })).ok()).toBe(true);
});

test('full CLI access is enabled and both modes persist after reopening settings and reloading', async ({ page, request }) => {
  let dialog = await openPermissions(page);
  let access = dialog.getByRole('switch', { name: accessName, exact: true });
  await expect(access).toBeChecked();
  await expect(dialog.getByText('Команды и запись файлов без подтверждений и песочниц CLI, с правами пользователя сервиса.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('article', { name: 'Настройка Claude Code', exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/Уже запущенные процессы сохраняют прежний режим/)).toBeVisible();
  expect(existsSync(`${cliHome}/.claude/settings.json`)).toBe(false);
  expect(existsSync(`${cliHome}/.codex/config.toml`)).toBe(false);

  await toggleAccess(page);
  await expect(access).not.toBeChecked();
  expect(await (await request.get('/api/settings/permissions')).json()).toEqual({ mode: 'standard' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  dialog = await openPermissions(page);
  await expect(dialog.getByRole('switch', { name: accessName, exact: true })).not.toBeChecked();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  dialog = await openPermissions(page);
  access = dialog.getByRole('switch', { name: accessName, exact: true });
  await expect(access).not.toBeChecked();
  await toggleAccess(page);
  await expect(access).toBeChecked();
  expect(await (await request.get('/api/settings/permissions')).json()).toEqual({ mode: 'full' });
  await expect(dialog.getByRole('article', { name: 'Настройка Codex', exact: true })).toHaveCount(0);
  expect(existsSync(`${cliHome}/.claude/settings.json`)).toBe(false);
  expect(existsSync(`${cliHome}/.codex/config.toml`)).toBe(false);
});

test('a failed save restores the previous mode and allows retry', async ({ page, request }) => {
  const dialog = await openPermissions(page);
  const access = dialog.getByRole('switch', { name: accessName, exact: true });
  await expect(access).toBeChecked();
  await page.route('**/api/settings/permissions', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await route.fulfill({ status: 500, json: { error: 'Не удалось сохранить режим доступа.' } });
  });
  await access.click();
  await expect(dialog.getByRole('alert')).toContainText('Не удалось сохранить режим доступа.');
  await expect(access).toBeChecked();
  await expect(access).toBeEnabled();
  expect(await (await request.get('/api/settings/permissions')).json()).toEqual({ mode: 'full' });
  await expect(dialog.getByRole('article', { name: 'Настройка Claude Code', exact: true })).toHaveCount(0);

  await page.unroute('**/api/settings/permissions');
  await toggleAccess(page);
  await expect(access).not.toBeChecked();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await (await request.get('/api/settings/permissions')).json()).toEqual({ mode: 'standard' });
});

test('the permissions section waits for the saved mode and recovers from a loading error', async ({ page }) => {
  await page.route('**/api/settings/permissions', async route => {
    await route.fulfill({ status: 503, json: { error: 'Режим доступа временно недоступен.' } });
  });
  const dialog = await openPermissions(page);
  await expect(dialog.getByRole('alert')).toContainText('Режим доступа временно недоступен.');
  await expect(dialog.getByRole('switch', { name: accessName, exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('article')).toHaveCount(0);
  await page.unroute('**/api/settings/permissions');

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings/permissions', async route => { await gate; await route.continue(); });
  await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();
  try {
    await expect(dialog.getByRole('status')).toContainText('Загружаем режим доступа…');
    await expect(dialog.getByRole('switch', { name: accessName, exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(dialog.getByRole('switch', { name: accessName, exact: true })).toBeChecked();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('the permissions section shows both files, writes only the missing Claude rules and opens the guide popup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openPermissions(page);
  await toggleAccess(page);
  await expect(dialog.getByRole('switch', { name: accessName, exact: true })).not.toBeChecked();

  const claude = dialog.getByRole('article', { name: 'Настройка Claude Code', exact: true });
  await expect(claude.getByText('Разрешения не включены', { exact: true })).toBeVisible();
  await expect(claude.locator('.cli-setup-path')).toContainText('.claude/settings.json');
  await claude.getByRole('button', { name: 'Настроить разрешения Claude Code', exact: true }).click();
  await expect(claude.getByText('Файл обновлён', { exact: true })).toBeVisible();
  await expect(claude.getByText('Разрешения включены', { exact: true })).toBeVisible();
  const saved = JSON.parse(readFileSync(`${cliHome}/.claude/settings.json`, 'utf8'));
  expect(saved.permissions.allow).toContain('Bash(bun test:*)');
  await claude.getByRole('button', { name: 'Настроить разрешения Claude Code', exact: true }).click();
  await expect(claude.getByText('Без изменений', { exact: true })).toBeVisible();

  // Codex gets the same wording and the same kind of write: brigd's sandbox settings mirrored into config.toml.
  const codex = dialog.getByRole('article', { name: 'Настройка Codex', exact: true });
  await expect(codex.locator('.cli-setup-path')).toContainText('.codex/config.toml');
  await expect(codex.getByText('Разрешения не включены', { exact: true })).toBeVisible();
  await expect(codex.getByText(/Нет входа в Codex/)).toBeVisible();
  await codex.getByRole('button', { name: 'Настроить разрешения Codex', exact: true }).click();
  await expect(codex.getByText('Файл обновлён', { exact: true })).toBeVisible();
  await expect(codex.getByText('Разрешения включены', { exact: true })).toBeVisible();
  expect(existsSync(`${cliHome}/.codex/config.toml`)).toBe(true);
  expect(readFileSync(`${cliHome}/.codex/config.toml`, 'utf8')).toContain('sandbox_mode = "workspace-write"');
  await codex.getByRole('button', { name: 'Настроить разрешения Codex', exact: true }).click();
  await expect(codex.getByText('Без изменений', { exact: true })).toBeVisible();

  // The guide opens as its own popup above the settings and closes without touching them.
  await dialog.getByRole('button', { name: 'Инструкция', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'Инструкция по разрешениям', exact: true });
  await expect(guide.getByRole('heading', { name: 'Claude Code', exact: true, level: 2 })).toBeVisible();
  await expect(guide.getByLabel('Правила разрешений Claude Code', { exact: true })).toContainText('"Bash(bun test:*)"');
  await page.keyboard.press('Escape');
  await expect(guide).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(claude.getByText('Разрешения включены', { exact: true })).toBeVisible();

  // The autopilot checklist opens the same section.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Автопилот', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть раздел Разрешения', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'Разрешения', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});
