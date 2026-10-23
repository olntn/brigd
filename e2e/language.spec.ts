import { expect, test, type Page } from '@playwright/test';

// Lists come from empty fixtures so data created by other specs (Russian titles,
// names) cannot appear; settings and server-generated text come from the mock server.
async function emptyLists(page: Page) {
  await page.route(/\/api\/(tasks|workers|models|tags|backups|instructions|docs|docs\/trash)(\?.*)?$/, async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [] });
    else await route.fallback();
  });
}

async function openApp(page: Page, newTask: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: newTask, exact: true })).toBeEnabled();
}

async function chooseLanguage(page: Page, settingsName: string, languageTab: string, option: string) {
  await page.getByRole('button', { name: settingsName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: settingsName, exact: true });
  await dialog.getByRole('tab', { name: languageTab, exact: true }).click();
  await dialog.getByRole('radio', { name: option, exact: true }).check();
}

/** Visible text in Russian; the Russian language option keeps its own name. */
async function russianText(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  return text.split('\n').map(line => line.trim()).filter(line => /[А-Яа-яЁё]/.test(line) && line !== 'Русский');
}

test('interface language switches to English, persists and synchronizes across tabs', async ({ page, context }) => {
  await emptyLists(page);
  await openApp(page, 'Новая задача');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const other = await context.newPage();
  await emptyLists(other);
  await openApp(other, 'Новая задача');

  await chooseLanguage(page, 'Настройки', 'Язык', 'English');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(dialog.getByRole('radio', { name: 'English', exact: true })).toBeChecked();
  await expect(dialog.getByRole('tablist', { name: 'Settings sections', exact: true }).getByRole('tab'))
    .toHaveText(['General', 'Language', 'Appearance', 'Models', 'Permissions', 'Autopilot', 'Concurrency', 'Storage', 'Backups']);
  expect(await page.evaluate(() => localStorage.getItem('brigd.locale'))).toBe('en');
  await expect(other.locator('html')).toHaveAttribute('lang', 'en');
  await expect(other.getByRole('button', { name: 'New task', exact: true })).toBeEnabled();

  await page.reload();
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await chooseLanguage(page, 'Settings', 'Language', 'Русский');
  await expect(page.getByRole('dialog', { name: 'Настройки', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(other.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await other.close();
});

test('English interface shows no Russian on pages and settings sections', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brigd.locale', 'en'));
  await emptyLists(page);
  await openApp(page, 'New task');
  for (const name of ['Tasks', 'Autopilot', 'Workers', 'Instructions', 'Docs', 'Tags', 'Archive']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForLoadState('networkidle');
    expect(await russianText(page), `${name} page`).toEqual([]);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  for (const tab of await dialog.getByRole('tab').allInnerTexts()) {
    await dialog.getByRole('tab', { name: tab, exact: true }).click();
    await expect(dialog.getByRole('tabpanel', { name: tab, exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await russianText(page), `${tab} settings`).toEqual([]);
  }
});

test('server errors appear in English', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('brigd.locale', 'en'));
  await emptyLists(page);
  await openApp(page, 'New task');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New task', exact: true });
  await editor.getByRole('textbox', { name: 'Task title' }).fill('Language check');
  await editor.locator('[name="instruction"]').fill('Do nothing.');
  await editor.locator('[name="cwd"]').fill('/brigd-language-check/missing-folder');
  await page.route('**/api/tasks', route => route.request().method() === 'POST' ? route.fallback() : route.fulfill({ json: [] }));
  await editor.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('The working folder does not exist or the service cannot access it');
});
