import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Comment, Run, Task, TaskDetail } from '../src/lib/types';

// Appearance checks use fixed, read-only API fixtures so they neither depend on
// the shared browser database nor accidentally run a real CLI in CLI mode.
const timestamp = Date.UTC(2026, 0, 15, 12);
const token = (label: string) => `${label}-${'ДлинноеСловоБезПробелов'.repeat(45)}`;
const instruction = token('Инструкция');
const note = token('Комментарий');
const summary = token('Результат');
const failure = token('Ошибка');
const taskId = 'appearance-task';
const run: Run = {
  id: 'appearance-run', taskId, workerId: null, worker: null, provider: 'codex', cwd: '/workspace/project', instruction,
  trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: 'appearance-session',
  startedAt: timestamp, updatedAt: timestamp + 1_000, finishedAt: timestamp + 1_000,
  summary, error: null, turn: 1, mock: false,
};
const task: Task = {
  id: taskId, workerId: null, worker: null, title: `Адаптивная-${'Задача'.repeat(18)}`, instruction, provider: 'codex',
  cwd: `/workspace/${'длинный-путь-'.repeat(35)}`, schedule: 'manual', intervalMinutes: null,
  firstRunAt: null, paused: false, createdAt: timestamp, updatedAt: timestamp,
  nextRunAt: null, status: 'completed', latestRun: run, runCount: 2,
};
const comment: Comment = {
  id: 'appearance-comment', taskId, runId: null, kind: 'user', body: note, createdAt: timestamp,
};
const detail: TaskDetail = {
  task,
  runs: [run, { ...run, id: 'appearance-failed-run', status: 'failed', summary: null, error: failure }],
  comments: [comment],
};

async function fixtureApi(page: Page, mode: AppInfo['mode'] = 'mock', populated = false) {
  const info: AppInfo = {
    mode, cwd: '/workspace/project', scheduler: 'running', startedAt: timestamp,
    providers: [
      { id: 'codex', available: true, label: 'Codex' },
      { id: 'claude', available: true, label: 'Claude Code' },
    ],
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Appearance fixtures are read-only' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/workers') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/tasks') {
      await route.fulfill({ json: populated ? [task] : [] });
    } else if (path === `/api/tasks/${taskId}`) {
      await route.fulfill({ json: detail });
    } else {
      await route.fulfill({ status: 404, json: { error: 'Unknown appearance fixture' } });
    }
  });
}

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: /^Все задачи/ })).toBeVisible();
}

async function openSettings(page: Page) {
  const trigger = page.getByRole('button', { name: 'Настройки', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await expect(dialog).toBeVisible();
  return { trigger, dialog, toggle: dialog.getByLabel('Тёмная тема', { exact: true }) };
}

async function expectNoHorizontalOverflow(page: Page, dialog?: Locator) {
  const documentSize = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(documentSize.document, 'document must not scroll horizontally').toBeLessThanOrEqual(documentSize.viewport + 1);
  expect(documentSize.body, 'body must not scroll horizontally').toBeLessThanOrEqual(documentSize.viewport + 1);
  if (!dialog) return;
  const dimensions = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: element.clientWidth, contentWidth: element.scrollWidth,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    };
  });
  expect(dimensions.left, 'dialog left edge').toBeGreaterThanOrEqual(-1);
  expect(dimensions.right, 'dialog right edge').toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.top, 'dialog top edge').toBeGreaterThanOrEqual(-1);
  expect(dimensions.bottom, 'dialog bottom edge').toBeLessThanOrEqual(dimensions.viewportHeight + 1);
  expect(dimensions.contentWidth, 'dialog contents must not be horizontally clipped').toBeLessThanOrEqual(dimensions.width + 1);
}

async function expectReachable(control: Locator, dialog: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
  const controlBounds = await control.boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(controlBounds).not.toBeNull();
  expect(dialogBounds).not.toBeNull();
  expect(controlBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x - 1);
  expect(controlBounds!.x + controlBounds!.width).toBeLessThanOrEqual(dialogBounds!.x + dialogBounds!.width + 1);
  expect(controlBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y - 1);
  expect(controlBounds!.y + controlBounds!.height).toBeLessThanOrEqual(dialogBounds!.y + dialogBounds!.height + 1);
}

async function expectWrapped(element: Locator) {
  await expect(element).toBeVisible();
  const dimensions = await element.evaluate(node => ({
    contentWidth: node.scrollWidth,
    width: node.clientWidth,
    height: node.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
  }));
  expect(dimensions.contentWidth, 'long unbroken text must wrap within its container').toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.height, 'fixture token should occupy multiple lines').toBeGreaterThan(dimensions.lineHeight * 2);
}

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) {
    await page.screenshot({ path: testInfo.outputPath('brigd-appearance.png'), fullPage: true });
  }
});

test('brigd branding appears in the title, navigation and workspace', async ({ page }) => {
  await fixtureApi(page, 'cli');
  await openApp(page);
  await expect(page).toHaveTitle('brigd · Задачи для ваших агентов');
  await expect(page.getByRole('link', { name: 'brigd — главная', exact: true })).toHaveText('brigd.');
  await expect(page.getByText('brigd · MVP', { exact: true })).toBeVisible();
  await expect(page.getByText(/Trackt|trackt/)).toHaveCount(0);
});

for (const legacy of ['light', 'dark'] as const) {
  test(`legacy ${legacy} theme survives the rename and reload`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('trackt.theme', theme), legacy);
    await fixtureApi(page);
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', legacy);
    expect(await page.evaluate(() => localStorage.getItem('brigd.theme'))).toBe(legacy);
    expect(await page.evaluate(() => localStorage.getItem('trackt.theme'))).toBe(legacy);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', legacy);
    const { toggle } = await openSettings(page);
    await toggle.setChecked(legacy !== 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', legacy === 'dark' ? 'light' : 'dark');
  });
}

test('readable legacy dark theme survives a blocked migration write', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('trackt.theme', 'dark');
    Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await fixtureApi(page);
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('brigd.theme'))).toBeNull();
  const { toggle } = await openSettings(page);
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('new theme preference synchronizes across tabs', async ({ page, context }) => {
  await fixtureApi(page);
  await openApp(page);
  const other = await context.newPage();
  await fixtureApi(other);
  await openApp(other);
  const { toggle } = await openSettings(page);
  await toggle.check();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle.uncheck();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await other.close();
});

test('CLI workspace is uncluttered and demo safety warning is preserved', async ({ page }) => {
  await fixtureApi(page, 'cli');
  await openApp(page);
  for (const removedText of [
    'Workspace', 'Локально · синхронизировано', 'Данные хранятся локально',
    'Bun + Svelte 5 · Codex и Claude Code', 'Ваш фокус — на важном.',
    'Агенты позаботятся об остальном',
  ]) {
    await expect(page.getByText(removedText, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText(/CLI-режим: агенты работают с файлами/)).toHaveCount(0);
  await expect(page.getByText('Демонстрационный режим', { exact: true })).toHaveCount(0);

  await page.unroute('**/api/**');
  await fixtureApi(page, 'mock');
  await page.reload();
  await expect(page.getByText('Демонстрационный режим', { exact: true })).toBeVisible();
  await expect(page.getByText('Запуски симулируются. Codex и Claude CLI не вызываются, файлы не изменяются.', { exact: true })).toBeVisible();
  await expect(page.getByText('Демо-запуски · без вызовов CLI', { exact: true })).toHaveCount(0);
});

test('theme settings persist both choices and return focus after Escape or Close', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await fixtureApi(page);
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightBackground = await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.screenshot({ path: testInfo.outputPath('brigd-light-board.png'), fullPage: true });
  let settings = await openSettings(page);
  await expect(settings.toggle).not.toBeChecked();
  await settings.toggle.check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('brigd.theme'))).toBe('dark');
  const darkBackground = await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  await page.screenshot({ path: testInfo.outputPath('brigd-dark-settings.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(settings.dialog).not.toBeVisible();
  await expect(settings.trigger).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('brigd-dark-board.png'), fullPage: true });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  settings = await openSettings(page);
  await expect(settings.toggle).toBeChecked();
  await settings.toggle.uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('brigd.theme'))).toBe('light');
  await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await expect(settings.dialog).not.toBeVisible();
  await expect(settings.trigger).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('an invalid saved theme does not prevent startup', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('brigd.theme', 'unexpected-theme'));
  await fixtureApi(page);
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const { toggle } = await openSettings(page);
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

for (const storageFailure of ['read', 'write'] as const) {
  test(`theme remains usable when localStorage ${storageFailure} is unavailable`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(failure => {
      if (failure === 'read') {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() { throw new DOMException('Storage blocked', 'SecurityError'); },
        });
      } else {
        Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
      }
    }, storageFailure);
    await fixtureApi(page);
    await openApp(page);
    const { dialog, toggle } = await openSettings(page);
    await toggle.check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await toggle.uncheck();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

const layouts: Array<{ width: number; height: number; fontSize: number; emulatedLayout?: string }> = [
  { width: 1440, height: 1000, fontSize: 26 },
  { width: 1024, height: 768, fontSize: 26 },
  { width: 768, height: 900, fontSize: 26 },
  { width: 390, height: 844, fontSize: 13 },
  { width: 390, height: 844, fontSize: 26 },
  { width: 320, height: 640, fontSize: 13 },
  { width: 320, height: 640, fontSize: 26 },
  // Reduced CSS layout viewports model browser zoom reflow, not native zoom.
  { width: 640, height: 360, fontSize: 13, emulatedLayout: '200% browser layout from 1280×720' },
  { width: 720, height: 500, fontSize: 13, emulatedLayout: '200% browser layout from 1440×1000' },
  { width: 360, height: 250, fontSize: 13, emulatedLayout: '400% browser layout from 1440×1000' },
];

for (const { width, height, fontSize, emulatedLayout } of layouts) {
  const description = emulatedLayout ? ` (emulated ${emulatedLayout})` : '';
  test(`layout and complete editor remain reachable at ${width}×${height}px / ${fontSize}px root text${description}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixtureApi(page, 'mock', true);
    await openApp(page);
    await page.addStyleTag({ content: `html { font-size: ${fontSize}px !important; }` });
    await expectNoHorizontalOverflow(page);

    const settings = await openSettings(page);
    await expectNoHorizontalOverflow(page, settings.dialog);
    await expectReachable(settings.toggle, settings.dialog);
    await settings.toggle.check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await settings.dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();

    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
    await expect(editor).toBeVisible();
    await expectNoHorizontalOverflow(page, editor);
    await expectReachable(editor.getByRole('heading', { name: 'Новая задача', exact: true }), editor);
    await expectReachable(editor.locator('[name="title"]'), editor);
    await editor.locator('[name="title"]').fill('Проверка всех полей');
    await expectReachable(editor.locator('[name="instruction"]'), editor);
    await editor.locator('[name="instruction"]').fill(instruction);
    const claudeOption = editor.locator('.provider-options label').filter({ has: page.getByRole('radio', { name: /Claude Code/ }) });
    await expectReachable(claudeOption, editor);
    await claudeOption.click();
    await expect(editor.getByRole('radio', { name: /Claude Code/ })).toBeChecked();
    await expectReachable(editor.locator('[name="cwd"]'), editor);
    await editor.getByRole('button', { name: 'По расписанию', exact: true }).click();
    await expectReachable(editor.locator('[name="intervalMinutes"]'), editor);
    await editor.locator('[name="intervalMinutes"]').fill('30');
    await expectReachable(editor.locator('[name="firstRunAt"]'), editor);
    await expectReachable(editor.getByLabel('Сохранить расписание на паузе'), editor);
    await editor.getByLabel('Сохранить расписание на паузе').check();
    await expectNoHorizontalOverflow(page, editor);
    await expectReachable(editor.getByRole('button', { name: 'Создать задачу', exact: true }), editor);
    await expectReachable(editor.getByRole('button', { name: 'Отмена', exact: true }), editor);
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(editor).not.toBeVisible();

    await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: task.title, exact: true });
    await expect(drawer).toBeVisible();
    await expectWrapped(drawer.locator('.instruction-section p'));
    await expectWrapped(drawer.locator('.comment-main p'));
    await expectNoHorizontalOverflow(page, drawer);
    await drawer.getByRole('tab', { name: /Запуски/ }).click();
    await expectWrapped(drawer.locator('.run-entry > p').filter({ hasText: summary }));
    await expectWrapped(drawer.locator('.run-history-error'));
    await expectNoHorizontalOverflow(page, drawer);
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();

    await page.getByRole('button', { name: 'Список', exact: true }).click();
    await expect(page.getByRole('button', { name: `Открыть: ${task.title}`, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

for (const fontSize of [13, 26]) {
  test(`empty workspace fits a 320px screen with ${fontSize}px root text`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await fixtureApi(page);
    await openApp(page);
    await page.addStyleTag({ content: `html { font-size: ${fontSize}px !important; }` });
    await expect(page.getByRole('button', { name: /Создать первую задачу/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}
