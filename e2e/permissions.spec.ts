import { existsSync, readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The test server points BRIGD_CLI_HOME at this scratch folder, so the buttons never touch a real home.
const cliHome = 'test-results/cli-home';

test.beforeEach(async ({ page, request }) => {
  const info = await (await request.get('/api/info')).json();
  expect(info.mode).toBe('mock'); // Never launch a real model or edit a real workspace.
  rmSync(cliHome, { recursive: true, force: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

test('the permissions section shows both files, writes only the missing Claude rules and opens the guide popup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Разрешения', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Разрешения', exact: true })).toBeVisible();

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
