import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, BackupEntry, Task } from '../src/lib/types';

const date = Date.UTC(2026, 9, 14, 12);
function task(title: string): Task {
  return {
    id: 'backup-task', title, instruction: 'Проверь проект.', provider: 'codex', cwd: '/workspace/project',
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, tagIds: [], tags: [],
    steps: [], workerId: null, worker: null, createdAt: date, updatedAt: date, archivedAt: null,
    nextRunAt: null, status: 'ready', latestRun: null, runCount: 0,
  };
}

// Backup files and restore state are isolated from the shared demo database.
// Server tests exercise real SQLite snapshots, restore, upload validation and deletion protection.
async function fixtureApi(page: Page, initial: BackupEntry[] = [
  { id: 'current', name: 'Текущий.sqlite', source: 'manual', createdAt: date, size: 8192, selected: true },
  { id: 'update', name: 'before-update.sqlite', source: 'update', createdAt: date - 60_000, size: 16384, selected: false },
]) {
  const state = {
    backups: initial.map(entry => ({ ...entry })),
    selectedId: initial.find(entry => entry.selected)?.id ?? null,
    readError: '', mutationError: '', pendingMutation: null as Promise<void> | null,
    tasks: [task('Задача после бэкапа')],
    uploads: [] as { name: string; contentType: string; body: Buffer }[],
    deleted: [] as string[], restored: [] as string[], reads: 0, sequence: 0,
  };
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: date,
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/backups' && method === 'GET') {
      state.reads++;
      await route.fulfill(state.readError ? { status: 503, json: { error: state.readError } } : {
        json: { backups: state.backups.map(entry => ({ ...entry, selected: entry.id === state.selectedId })), selectedId: state.selectedId },
      });
    } else if (path.startsWith('/api/backups') && method !== 'GET') {
      if (state.pendingMutation) await state.pendingMutation;
      if (state.mutationError) { await route.fulfill({ status: 409, json: { error: state.mutationError } }); return; }
      if (path === '/api/backups' && method === 'POST') {
        const sequence = ++state.sequence;
        const entry: BackupEntry = { id: `manual-${sequence}`, name: `manual-${sequence}.sqlite`, source: 'manual', createdAt: date + sequence, size: 12288, selected: false };
        state.backups.unshift(entry);
        await route.fulfill({ status: 201, json: entry });
      } else if (path === '/api/backups/upload' && method === 'POST') {
        const name = decodeURIComponent(request.headers()['x-backup-name']);
        const body = request.postDataBuffer()!;
        state.uploads.push({ name, contentType: request.headers()['content-type'], body });
        const sequence = ++state.sequence;
        const entry: BackupEntry = { id: `upload-${sequence}`, name, source: 'upload', createdAt: date + sequence, size: body.byteLength, selected: false };
        state.backups.unshift(entry);
        await route.fulfill({ status: 201, json: entry });
      } else {
        const [, id, operation] = /^\/api\/backups\/([^/]+)(?:\/(select))?$/.exec(path) ?? [];
        const entry = state.backups.find(entry => entry.id === id);
        if (!entry) { await route.fulfill({ status: 404, json: { error: 'Бэкап не найден' } }); return; }
        if (operation === 'select' && method === 'POST') {
          state.selectedId = id;
          state.restored.push(id);
          state.tasks = [task('Задача из бэкапа')];
          await route.fulfill({ json: { ...entry, selected: true } });
        } else if (method === 'DELETE') {
          if (id === state.selectedId) { await route.fulfill({ status: 409, json: { error: 'Текущий выбранный бэкап нельзя удалить' } }); return; }
          state.deleted.push(id);
          state.backups = state.backups.filter(entry => entry.id !== id);
          await route.fulfill({ json: { ok: true } });
        } else await route.fulfill({ status: 405, json: { error: 'Unsupported backup fixture mutation' } });
      }
    } else if (/^\/api\/backups\/[^/]+\/download$/.test(path)) {
      await route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="before-update.sqlite"' }, body: Buffer.from('SQLite format 3\0backup fixture') });
    } else if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/tasks') await route.fulfill({ json: state.tasks });
    else if (path === '/api/workers' || path === '/api/models' || path === '/api/tags') await route.fulfill({ json: [] });
    else if (path === '/api/settings/general') await route.fulfill({ json: { defaultCwd: '/workspace/project', defaultSchedule: 'manual' } });
    else if (path === '/api/settings/autopilot') await route.fulfill({ json: { integrationChecks: null, source: null } });
    else await route.fulfill({ status: 404, json: { error: 'Unknown backup fixture' } });
  });
  return state;
}

async function openBackups(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Бэкапы', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Бэкапы', exact: true });
  await expect(panel).toBeVisible();
  return { dialog, panel };
}

test('backups support create, download, upload, confirmed restore and deletion while protecting the selected backup', async ({ page }, testInfo) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  let { dialog, panel } = await openBackups(page);
  const current = panel.getByRole('listitem', { name: 'Текущий.sqlite', exact: true });
  await expect(current.getByText('Выбран', { exact: true })).toBeVisible();
  await expect(current.getByRole('button', { name: 'Удалить бэкап: Текущий.sqlite', exact: true })).toBeDisabled();
  await expect(current.getByText('Текущий выбранный бэкап нельзя удалить.', { exact: true })).toBeVisible();
  const update = panel.getByRole('listitem', { name: 'before-update.sqlite', exact: true });
  await expect(update.getByText('Перед обновлением', { exact: true })).toBeVisible();
  await expect(update.getByText('16 КБ', { exact: true })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), update.getByRole('link', { name: 'Скачать бэкап: before-update.sqlite', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('before-update.sqlite');
  expect(new URL(download.url()).pathname).toBe('/api/backups/update/download');

  await panel.getByRole('button', { name: 'Создать бэкап', exact: true }).click();
  const manual = panel.getByRole('listitem', { name: 'manual-1.sqlite', exact: true });
  await expect(manual.getByText('Создан вручную', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('Бэкап создан');
  const uploadedName = 'Копия проекта.sqlite';
  await panel.getByLabel('Файл бэкапа', { exact: true }).setInputFiles({ name: uploadedName, mimeType: 'application/vnd.sqlite3', buffer: Buffer.from('SQLite format 3\0uploaded fixture') });
  const uploaded = panel.getByRole('listitem', { name: uploadedName, exact: true });
  await expect(uploaded.getByText('Загружен', { exact: true })).toBeVisible();
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].name).toBe(uploadedName);
  expect(state.uploads[0].contentType).toBe('application/octet-stream');
  expect(state.uploads[0].body.toString()).toBe('SQLite format 3\0uploaded fixture');
  await page.screenshot({ path: testInfo.outputPath('backups-desktop.png'), fullPage: true });

  await manual.getByRole('button', { name: 'Удалить бэкап: manual-1.sqlite', exact: true }).click();
  await expect(manual.getByRole('button', { name: 'Удалить навсегда', exact: true })).toBeFocused();
  await manual.getByRole('button', { name: 'Отмена удаления', exact: true }).click();
  expect(state.deleted).toEqual([]);
  await manual.getByRole('button', { name: 'Удалить бэкап: manual-1.sqlite', exact: true }).click();
  await manual.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(manual).toHaveCount(0);
  expect(state.deleted).toEqual(['manual-1']);

  await uploaded.getByRole('button', { name: `Выбрать бэкап: ${uploadedName}`, exact: true }).click();
  await expect(uploaded).toContainText('Данные приложения будут заменены. Активные запуски остановятся. Перед восстановлением сохраним текущие данные');
  await expect(uploaded.getByRole('button', { name: 'Восстановить данные', exact: true })).toBeFocused();
  expect(state.restored).toEqual([]);
  await uploaded.getByRole('button', { name: 'Отмена восстановления', exact: true }).click();
  await uploaded.getByRole('button', { name: `Выбрать бэкап: ${uploadedName}`, exact: true }).click();
  await Promise.all([page.waitForEvent('load'), uploaded.getByRole('button', { name: 'Восстановить данные', exact: true }).click()]);
  await expect(page.getByRole('button', { name: 'Открыть задачу: Задача из бэкапа', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть задачу: Задача после бэкапа', exact: true })).toHaveCount(0);
  expect(state.restored).toEqual(['upload-2']);
  ({ dialog, panel } = await openBackups(page));
  const selected = panel.getByRole('listitem', { name: uploadedName, exact: true });
  await expect(selected.getByText('Выбран', { exact: true })).toBeVisible();
  await expect(selected.getByRole('button', { name: `Удалить бэкап: ${uploadedName}`, exact: true })).toBeDisabled();
  await expect(panel.getByRole('listitem', { name: 'Текущий.sqlite', exact: true }).getByRole('button', { name: 'Удалить бэкап: Текущий.sqlite', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
});

test('backup loading can be retried and mutations retain their state across tabs and prevent closing settings', async ({ page }) => {
  const state = await fixtureApi(page, []);
  state.readError = 'Не удалось прочитать папку бэкапов';
  await page.goto('/');
  const { dialog, panel } = await openBackups(page);
  await expect(panel.getByRole('alert')).toContainText(state.readError);
  state.readError = '';
  await panel.getByRole('button', { name: 'Повторить загрузку бэкапов', exact: true }).click();
  await expect(panel.getByText('Бэкапов пока нет. Создайте первый бэкап или загрузите сохранённый файл.', { exact: true })).toBeVisible();
  await panel.getByLabel('Файл бэкапа', { exact: true }).setInputFiles({ name: 'empty.sqlite', mimeType: 'application/vnd.sqlite3', buffer: Buffer.alloc(0) });
  await expect(panel.getByRole('alert')).toContainText('Файл бэкапа пуст');
  expect(state.uploads).toHaveLength(0);
  state.mutationError = 'Недостаточно места на диске';
  await panel.getByRole('button', { name: 'Создать бэкап', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.mutationError);
  state.mutationError = '';
  let release!: () => void;
  state.pendingMutation = new Promise<void>(resolve => { release = resolve; });
  await panel.getByRole('button', { name: 'Создать бэкап', exact: true }).click();
  try {
    await expect(panel.getByRole('status')).toContainText('Создаём бэкап');
    await expect(panel.getByRole('button', { name: 'Создать бэкап', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Общие', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeDisabled();
    await dialog.getByRole('tab', { name: 'Бэкапы', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Создаём бэкап');
  } finally { release(); }
  await expect(panel.getByRole('status')).toContainText('Бэкап создан');
  await expect(dialog.getByRole('button', { name: 'Закрыть настройки', exact: true })).toBeEnabled();
  const reads = state.reads;
  await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await openBackups(page);
  await expect.poll(() => state.reads).toBe(reads + 1);
  await expect(panel.getByRole('listitem', { name: 'manual-1.sqlite', exact: true })).toBeVisible();
});

test('backup restoration errors keep confirmation open and deletion failures can be retried', async ({ page }) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  const { panel } = await openBackups(page);
  const update = panel.getByRole('listitem', { name: 'before-update.sqlite', exact: true });
  await update.getByRole('button', { name: 'Выбрать бэкап: before-update.sqlite', exact: true }).click();
  state.mutationError = 'Бэкап повреждён';
  await update.getByRole('button', { name: 'Восстановить данные', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(state.mutationError);
  await expect(update.getByRole('button', { name: 'Отмена восстановления', exact: true })).toBeEnabled();
  expect(state.restored).toEqual([]);
  await update.getByRole('button', { name: 'Отмена восстановления', exact: true }).click();
  await update.getByRole('button', { name: 'Удалить бэкап: before-update.sqlite', exact: true }).click();
  state.mutationError = 'Не удалось удалить файл';
  await update.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(update.getByRole('alert')).toContainText(state.mutationError);
  state.mutationError = '';
  await update.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
  await expect(update).toHaveCount(0);
  expect(state.deleted).toEqual(['update']);
});

test('the selected backup can be restored again and stays protected from deletion', async ({ page }) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  let { panel } = await openBackups(page);
  const selected = panel.getByRole('listitem', { name: 'Текущий.sqlite', exact: true });
  const restore = selected.getByRole('button', { name: 'Восстановить бэкап: Текущий.sqlite', exact: true });
  await expect(restore).toHaveText('Восстановить снова');
  await restore.click();
  await expect(selected.getByRole('button', { name: 'Восстановить данные', exact: true })).toBeEnabled();
  await expect(selected.getByRole('button', { name: 'Удалить бэкап: Текущий.sqlite', exact: true })).toBeDisabled();
  expect(state.restored).toEqual([]);
  await Promise.all([page.waitForEvent('load'), selected.getByRole('button', { name: 'Восстановить данные', exact: true }).click()]);
  await expect(page.getByRole('button', { name: 'Открыть задачу: Задача из бэкапа', exact: true })).toBeVisible();
  expect(state.restored).toEqual(['current']);
  ({ panel } = await openBackups(page));
  const restored = panel.getByRole('listitem', { name: 'Текущий.sqlite', exact: true });
  await expect(restored.getByText('Выбран', { exact: true })).toBeVisible();
  await expect(restored.getByRole('button', { name: 'Восстановить бэкап: Текущий.sqlite', exact: true })).toBeEnabled();
  await expect(restored.getByRole('button', { name: 'Удалить бэкап: Текущий.sqlite', exact: true })).toBeDisabled();
});

test('backup tab works with keyboard navigation and fits narrow screens with large text in a dark theme', async ({ page }, testInfo) => {
  await fixtureApi(page, [{ id: 'long', name: 'Очень длинное имя бэкапа проекта-'.repeat(7) + '.sqlite', source: 'update', createdAt: date, size: 16384, selected: true }]);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
  await page.evaluate(() => { document.documentElement.dataset.colorScheme = 'dark'; });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Общие', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: 'Бэкапы', exact: true })).toBeFocused();
  const panel = dialog.getByRole('tabpanel', { name: 'Бэкапы', exact: true });
  await expect(panel.getByText('Перед обновлением', { exact: true })).toBeVisible();
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, dialog: document.querySelector('.settings-dialog')!.clientWidth, content: document.querySelector('.settings-dialog')!.scrollWidth }));
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  expect(size.content).toBeLessThanOrEqual(size.dialog + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: 'html { font-size: 13px !important; }' });
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('backups-narrow-dark.png'), fullPage: true });
});
