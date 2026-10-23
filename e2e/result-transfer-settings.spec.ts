import { expect, test, type Page } from '@playwright/test';
import type { ResultTransferSettings } from '../src/lib/types';

async function fixture(page: Page, english: boolean) {
  let settings: ResultTransferSettings = { mode: 'automatic', manualWait: 'continue' };
  const writes: ResultTransferSettings[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/settings/result-transfer') {
      if (route.request().method() === 'PATCH') {
        settings = route.request().postDataJSON(); writes.push(settings);
      }
      await route.fulfill({ json: settings });
    } else if (path === '/api/info') {
      await route.fulfill({ json: { mode: 'mock', cwd: '/project', scheduler: 'running', startedAt: 0, providers: [] } });
    } else if (path === '/api/settings/autopilot') {
      await route.fulfill({ json: { integrationChecks: [['bun', 'test']], source: 'settings' } });
    } else if (path === '/api/settings/check-triage') {
      await route.fulfill({ json: { enabled: true, saved: null, defaultEnabled: true, timeLimitMinutes: 30, handbackLimit: 3,
        counts: { flaky: 0, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 } } });
    } else if (path === '/api/settings/general') {
      await route.fulfill({ json: { defaultCwd: '/project', defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } } });
    } else await route.fulfill({ json: [] });
  });
  if (english) await page.addInitScript(() => localStorage.setItem('brigd.locale', 'en'));
  await page.goto('/');
  await page.getByRole('button', { name: english ? 'Settings' : 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: english ? 'Settings' : 'Настройки', exact: true });
  await dialog.getByRole('tab', { name: english ? 'Autopilot' : 'Автопилот', exact: true }).click();
  return { region: dialog.getByRole('region', { name: english ? 'Result transfer' : 'Перенос результата', exact: true }), writes };
}

for (const english of [false, true]) {
  test(`result transfer settings save both choices next to check commands (${english ? 'English' : 'Russian'})`, async ({ page }) => {
    const { region, writes } = await fixture(page, english);
    const mode = region.getByRole('combobox', { name: english ? 'Result transfer' : 'Перенос результата', exact: true });
    const wait = region.getByRole('combobox', { name: english ? 'While a result awaits manual transfer' : 'Пока результат ждёт ручного переноса', exact: true });
    await expect(mode).toHaveValue('automatic');
    await expect(wait).toHaveValue('continue'); await expect(wait).toBeDisabled();
    await mode.selectOption('manual'); await expect(wait).toBeEnabled();
    await wait.selectOption('wait');
    await region.getByRole('button', { name: english ? 'Save settings' : 'Сохранить настройки', exact: true }).click();
    await expect(region.getByRole('status')).toHaveText(english ? 'Transfer settings saved.' : 'Настройки переноса сохранены.');
    expect(writes).toEqual([{ mode: 'manual', manualWait: 'wait' }]);
    await mode.selectOption('automatic'); await expect(wait).toBeDisabled();
    await region.getByRole('button', { name: english ? 'Save settings' : 'Сохранить настройки', exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({ mode: 'automatic', manualWait: 'wait' });
  });
}
