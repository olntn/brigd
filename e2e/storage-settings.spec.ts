import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, StorageCleanupResult, StorageEntry, StorageOverview } from '../src/lib/types';

const root = '/var/lib/trackt/workspaces';
const bucket = `${root}/5c3282c576b05feb1066`;
function entry(patch: Partial<StorageEntry> & Pick<StorageEntry, 'path' | 'reason' | 'retained' | 'bytes'>): StorageEntry {
  return { kind: 'worktree', files: 12, runId: 'run-1', taskId: 'task-1', taskTitle: 'Обновить зависимости', startedAt: Date.UTC(2026, 9, 21, 11, 5), ...patch };
}
const entries: StorageEntry[] = [
  entry({ path: `${bucket}/run-cancelled`, reason: 'cancelled', retained: false, bytes: 120 * 1024 * 1024, taskTitle: 'Отменённая задача' }),
  entry({ path: `${bucket}/integration-job-1`, kind: 'candidate', reason: 'stale', retained: false, bytes: 300 * 1024 * 1024 }),
  entry({ path: `${bucket}/leftover-run`, reason: 'unknown', retained: false, bytes: 1024, runId: null, taskId: null, taskTitle: null, startedAt: null }),
  entry({ path: `${bucket}/run-conflict`, reason: 'conflict', retained: true, bytes: 80 * 1024 * 1024, runId: 'run-2', taskTitle: 'Починить тесты' }),
  entry({ path: `${bucket}/run-active`, reason: 'active', retained: true, bytes: 40 * 1024 * 1024, runId: 'run-3' }),
  entry({ path: `${bucket}/integration-job-2`, kind: 'candidate', reason: 'failed', retained: true, optional: true, bytes: 200 * 1024 * 1024, runId: 'run-4', taskTitle: 'Проверка не прошла' }),
  entry({ path: `${root}/notes.txt`, kind: 'unknown', reason: 'foreign', retained: true, bytes: 0, files: 0, runId: null, taskId: null, taskTitle: null, startedAt: null }),
];
const sum = (selected: StorageEntry[]) => selected.reduce((total, item) => total + item.bytes, 0);
function overviewOf(selected: StorageEntry[], reclaimableBranches: string[] = []): StorageOverview {
  return { available: true, note: null, root, totalBytes: sum(selected), reclaimableBytes: sum(selected.filter(item => !item.retained)),
    retainedBytes: sum(selected.filter(item => item.retained)), entries: selected, reclaimableBranches, scannedAt: Date.UTC(2026, 9, 22, 9, 30, 15) };
}

async function fixtureApi(page: Page, options: { available?: boolean; readError?: string; cleanupError?: string } = {}) {
  const state = { entries: [...entries], branches: [] as string[], reads: 0, cleanups: 0, available: options.available ?? true, readError: options.readError ?? '', cleanupError: options.cleanupError ?? '' };
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: Date.UTC(2026, 0, 15, 12),
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }] };
  const overview = (): StorageOverview => state.available ? overviewOf(state.entries, state.branches) : { available: false, note: null, root: null, totalBytes: 0, reclaimableBytes: 0, retainedBytes: 0, entries: [], reclaimableBranches: [], scannedAt: Date.UTC(2026, 9, 22, 9, 30, 15) };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/settings/storage' && method === 'GET') {
      state.reads++;
      if (state.readError) { await route.fulfill({ status: 503, json: { error: state.readError } }); return; }
      await route.fulfill({ json: overview() });
    } else if (path === '/api/settings/storage/cleanup' && method === 'POST') {
      state.cleanups++;
      if (state.cleanupError) { await route.fulfill({ status: 409, json: { error: state.cleanupError } }); return; }
      const body = (route.request().postDataJSON() ?? {}) as { includeCandidates?: boolean };
      const taken = (item: StorageEntry) => !item.retained || !!body.includeCandidates && !!item.optional;
      const removed = state.entries.filter(taken);
      state.entries = state.entries.filter(item => !taken(item));
      const removedBranches = state.branches.length;
      state.branches = [];
      const result: StorageCleanupResult = { removed: removed.length, removedBranches, freedBytes: sum(removed), failures: [], overview: overview() };
      await route.fulfill({ json: result });
    } else if (method !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Unsupported fixture mutation' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/tasks' || path === '/api/workers' || path === '/api/models' || path === '/api/tags') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/settings/general') {
      await route.fulfill({ json: { defaultCwd: '/workspace/project', defaultSchedule: 'manual', fallbackWorkers: { codex: null, claude: null } } });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: null, source: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: 'Unknown storage fixture' } });
    }
  });
  return state;
}

async function openStorage(page: Page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await expect(dialog).toBeVisible();
  const tabs = dialog.getByRole('tablist', { name: 'Разделы настроек', exact: true });
  await expect(tabs.getByRole('tab')).toHaveText(['Общие', 'Внешний вид', 'Модели', 'Разрешения', 'Автопилот', 'Хранилище', 'Бэкапы']);
  await tabs.getByRole('tab', { name: 'Хранилище', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Хранилище', exact: true });
  await expect(panel.getByRole('heading', { name: 'Хранилище', exact: true })).toBeVisible();
  return { dialog, panel };
}

test('the storage section counts space by reason and the clean-up button reclaims only what is no longer needed', async ({ page }) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  const { panel } = await openStorage(page);
  await expect(panel.getByRole('status')).toBeHidden();
  const summary = panel.getByRole('group', { name: 'Занятое место', exact: true }).or(panel.locator('.storage-summary'));
  await expect(summary).toContainText('Занято');
  await expect(summary).toContainText('740 МБ');
  await expect(summary).toContainText('Можно освободить');
  await expect(summary).toContainText('420 МБ');
  await expect(summary).toContainText('Ещё нужно');
  await expect(summary).toContainText('320 МБ');
  await expect(panel.getByText(root, { exact: true })).toBeVisible();
  const groups = panel.getByRole('list', { name: 'Папки по состоянию', exact: true });
  const group = (name: string) => groups.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 4, name, exact: true }) });
  await expect(group('Конфликт слияния')).toContainText('сохраняется');
  await expect(group('Конфликт слияния')).toContainText('Починить тесты · Запуск run-2 · 21 октября 2026 г.');
  await expect(group('Конфликт слияния')).toContainText('Поручите конфликт Интегратору или повторите слияние в карточке задачи.');
  await expect(group('Запуск отменён')).toContainText('будет удалена');
  await expect(group('Кандидат слияния устарел')).toContainText('300 МБ');
  await expect(group('Нет записи в базе brigd')).toContainText('1 КБ');
  await expect(group('Ошибка запуска или проверки')).toContainText('сохраняется, кандидаты — по галочке');
  await expect(group('Создано не brigd')).toContainText('объём не учитывается');
  await expect(group('Создано не brigd')).toContainText('notes.txt');
  // Reclaimable groups are listed before retained ones.
  await expect(groups.getByRole('heading', { level: 4 }).first()).toHaveText('Кандидат слияния устарел');
  const clean = panel.getByRole('button', { name: 'Очистить', exact: true });
  await expect(clean).toBeEnabled();
  await clean.click();
  const confirm = panel.getByRole('button', { name: 'Удалить папки', exact: true });
  await expect(confirm).toBeFocused();
  await expect(panel.getByText('Удалить 3 папки и освободить 420 МБ?')).toBeVisible();
  await expect(panel.getByText('Папки активных, прерванных, конфликтных, завершившихся ошибкой или блокировкой и ещё не перенесённых запусков не трогаются.')).toBeVisible();
  const option = panel.getByRole('checkbox', { name: /Также удалить кандидаты неудачных проверок/ });
  await expect(option).not.toBeChecked();
  await expect(panel.getByText('(1 папка, 200 МБ)')).toBeVisible();
  await panel.getByRole('button', { name: 'Отмена очистки', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(clean).toBeFocused();
  await clean.click();
  await panel.getByRole('button', { name: 'Удалить папки', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Удалены 3 папки. Освобождено 420 МБ.');
  expect(state.cleanups).toBe(1);
  await expect(summary).toContainText('320 МБ');
  await expect(group('Запуск отменён')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Удалить папки', exact: true })).toBeHidden();
  // Candidates of failed checks are taken only when asked for.
  await expect(clean).toBeEnabled();
  await clean.click();
  await expect(panel.getByText('Удалить 0 папок и освободить 0 Б?')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Удалить папки', exact: true })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /Также удалить кандидаты неудачных проверок/ }).check();
  await expect(panel.getByText('Удалить 1 папку и освободить 200 МБ?')).toBeVisible();
  await panel.getByRole('button', { name: 'Удалить папки', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Удалена 1 папка. Освобождено 200 МБ.');
  expect(state.cleanups).toBe(2);
  await expect(summary).toContainText('120 МБ');
  await expect(clean).toBeDisabled();
  const reads = state.reads;
  await panel.getByRole('button', { name: 'Пересчитать', exact: true }).click();
  await expect.poll(() => state.reads).toBe(reads + 1);
  await expect(panel.getByRole('status')).toBeHidden();
});

test('demo mode explains that there are no worktrees and the clean-up request errors stay in the section', async ({ page }) => {
  const state = await fixtureApi(page, { available: false });
  await page.goto('/');
  const { panel, dialog } = await openStorage(page);
  await expect(panel.getByText('В этом режиме отдельные worktree не создаются, поэтому очищать нечего.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Очистить', exact: true })).toHaveCount(0);
  state.available = true;
  state.cleanupError = 'Очистка уже выполняется. Дождитесь её завершения.';
  await dialog.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await openStorage(page);
  await panel.getByRole('button', { name: 'Пересчитать', exact: true }).click();
  await panel.getByRole('button', { name: 'Очистить', exact: true }).click();
  await panel.getByRole('button', { name: 'Удалить папки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Очистка уже выполняется. Дождитесь её завершения.');
  await expect(panel.getByRole('button', { name: 'Удалить папки', exact: true })).toBeVisible();
});

test('a failed count offers a retry and keeps the section usable at narrow widths', async ({ page }) => {
  const state = await fixtureApi(page, { readError: 'Каталог рабочих папок недоступен.' });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  const { panel } = await openStorage(page);
  await expect(panel.getByRole('alert')).toContainText('Каталог рабочих папок недоступен.');
  state.readError = '';
  await panel.getByRole('button', { name: 'Повторить подсчёт', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Очистить', exact: true })).toBeEnabled();
  const width = await panel.evaluate(element => element.scrollWidth <= element.clientWidth);
  expect(width).toBe(true);
});

test('failed folder removals remain reclaimable and do not report that all folders are needed', async ({ page }) => {
  const state = await fixtureApi(page);
  state.entries = entries.filter(item => item.retained || item.path.endsWith('/run-cancelled'));
  await page.route('**/api/settings/storage/cleanup', async route => {
    const result: StorageCleanupResult = {
      removed: 0, removedBranches: 0, freedBytes: 0,
      failures: [{ path: `${bucket}/run-cancelled`, error: 'Нет доступа к папке.' }],
      overview: overviewOf(state.entries),
    };
    await route.fulfill({ json: result });
  });
  await page.goto('/');
  const { panel } = await openStorage(page);
  await panel.getByRole('button', { name: 'Очистить', exact: true }).click();
  await panel.getByRole('button', { name: 'Удалить папки', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Не удалось удалить:');
  await expect(panel.getByRole('alert')).toContainText('Нет доступа к папке.');
  await expect(panel.getByRole('status')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Очистить', exact: true })).toBeEnabled();
  await expect(panel.locator('.storage-summary')).toContainText('120 МБ');
});

test('cleanup removes merged branches even after their working folders have already been removed', async ({ page }) => {
  const state = await fixtureApi(page);
  state.entries = [];
  state.branches = ['brigd/run-old-merged'];
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  const { panel } = await openStorage(page);
  await expect(panel.getByRole('heading', { name: 'Ветки после слияния', exact: true })).toBeVisible();
  await expect(panel.getByText('brigd/run-old-merged', { exact: true })).toBeVisible();
  const clean = panel.getByRole('button', { name: 'Очистить', exact: true });
  await expect(clean).toBeEnabled();
  await clean.click();
  await expect(panel.getByText('Удалить 1 ветку и освободить 0 Б?')).toBeVisible();
  await expect(panel.getByText('Остальные ветки и история задач останутся.')).toBeVisible();
  const confirm = panel.getByRole('button', { name: 'Удалить ветки', exact: true });
  await expect(confirm).toBeFocused();
  await expect(confirm).toBeEnabled();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await confirm.click();
  await expect(panel.getByRole('status')).toContainText('Удалена 1 ветка. Освобождено 0 Б.');
  expect(state.cleanups).toBe(1);
  await expect(panel.getByText('brigd/run-old-merged', { exact: true })).toBeHidden();
  await expect(clean).toBeDisabled();
});
