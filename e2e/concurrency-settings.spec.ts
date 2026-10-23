import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, ConcurrencyLimits, ConcurrencySettings } from '../src/lib/types';

async function fixtureApi(page: Page) {
  const defaults: ConcurrencyLimits = { maxParallel: 4, maxPerRepository: 1 };
  const state = { saved: { maxParallel: null, maxPerRepository: null } as ConcurrencySettings['saved'], writes: [] as unknown[] };
  const settings = (): ConcurrencySettings => ({ maxParallel: state.saved.maxParallel ?? defaults.maxParallel, maxPerRepository: state.saved.maxPerRepository ?? defaults.maxPerRepository,
    saved: { ...state.saved }, defaults });
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: Date.UTC(2026, 0, 15, 12),
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/settings/concurrency' && method === 'GET') {
      await route.fulfill({ json: settings() });
    } else if (path === '/api/settings/concurrency' && method === 'PATCH') {
      const body = route.request().postDataJSON() as ConcurrencySettings['saved'];
      state.writes.push(body);
      state.saved = { ...state.saved, ...body };
      await route.fulfill({ json: settings() });
    } else if (method !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Unsupported fixture mutation' } });
    } else if (path === '/api/info') {
      await route.fulfill({ json: info });
    } else if (path === '/api/tasks' || path === '/api/workers' || path === '/api/models' || path === '/api/tags') {
      await route.fulfill({ json: [] });
    } else if (path === '/api/settings/general') {
      await route.fulfill({ json: { defaultCwd: '/workspace/project', defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } } });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: null, source: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: 'Unknown concurrency fixture' } });
    }
  });
  return state;
}

test('the parallelism section saves both limits, warns when the total caps a repository and resets to the start-up values', async ({ page }) => {
  const state = await fixtureApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: 'Параллельность', exact: true }).click();
  const panel = dialog.getByRole('tabpanel', { name: 'Параллельность', exact: true });
  await expect(panel.getByRole('heading', { name: 'Параллельность', exact: true })).toBeVisible();
  const perRepository = panel.getByRole('spinbutton', { name: 'Задач одновременно в одном репозитории', exact: true });
  const parallel = panel.getByRole('spinbutton', { name: 'Всего процессов', exact: true });
  await expect(perRepository).toHaveValue('1');
  await expect(parallel).toHaveValue('4');
  await expect(panel.getByText('Значение запуска сервиса: 1.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Сбросить', exact: true })).toBeDisabled();
  await expect(panel.getByText('Проверка и слияние результатов одного репозитория идут строго по одному', { exact: false })).toBeVisible();

  await perRepository.fill('6');
  await expect(panel.getByText('в одном репозитории одновременно будет работать не больше 4', { exact: false })).toBeVisible();
  await perRepository.fill('0');
  await panel.getByRole('button', { name: 'Сохранить лимиты', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('целое число от 1 до 32');
  expect(state.writes).toEqual([]);

  await perRepository.fill('3');
  await parallel.fill('5');
  await panel.getByRole('button', { name: 'Сохранить лимиты', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Лимиты сохранены');
  expect(state.writes).toEqual([{ maxPerRepository: 3, maxParallel: 5 }]);
  await expect(panel.getByText('Сохранено в настройках.', { exact: false })).toHaveCount(2);

  await panel.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Лимиты сброшены');
  expect(state.writes[1]).toEqual({ maxParallel: null, maxPerRepository: null });
  await expect(perRepository).toHaveValue('1');
  await expect(parallel).toHaveValue('4');
});
