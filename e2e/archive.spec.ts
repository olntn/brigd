import { expect, test, type Page } from '@playwright/test';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
async function createThroughUi(page: Page, title: string, instruction: string) {
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await form.locator('[name="title"]').fill(title);
  await form.locator('[name="instruction"]').fill(instruction);
  await form.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
// The browser database is shared across specs, so counts are compared relative to the start.
async function archiveCount(page: Page) {
  return Number(await page.getByRole('button', { name: 'Архив', exact: true }).locator('.nav-count').textContent());
}
async function expectNoHorizontalOverflow(page: Page) {
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Демонстрационный режим', { exact: true })).toBeVisible();
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-archive.png'), fullPage: true });
});

test('a task moves to the archive from its card, stays read-only there and returns to the board on restore', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const navigation = page.getByRole('complementary', { name: 'Основная навигация', exact: true });
  const archiveButton = navigation.getByRole('button', { name: 'Архив', exact: true });
  const settingsButton = navigation.getByRole('button', { name: 'Настройки', exact: true });
  const [archiveBox, settingsBox] = [await archiveButton.boundingBox(), await settingsButton.boundingBox()];
  expect(archiveBox!.y + archiveBox!.height, 'Archive sits above Settings').toBeLessThanOrEqual(settingsBox!.y + 1);
  const before = await archiveCount(page);

  const title = unique('Задача для архива');
  const drawer = await createThroughUi(page, title, 'Подготовь короткую сводку.');
  await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('Заметка до архива');
  await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  await expect(drawer.getByText('Заметка до архива', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'В архив', exact: true }).click();
  await expect(drawer.getByText('Задача перенесена в архив', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Восстановить', exact: true })).toBeVisible();
  await expect(drawer.getByText(/^В архиве с /)).toBeVisible();
  for (const name of ['Запустить', 'Изменить', 'В архив', 'Сохранить заметку']) {
    await expect(drawer.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(drawer.getByText('Задача в архиве. Восстановите её, чтобы оставить заметку или отправить агенту дополнительный запрос.', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Заметка до архива', { exact: true })).toBeVisible();
  await drawer.getByRole('tab', { name: /Логи/ }).click();
  await expect(drawer.locator('.archived-comment-note')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect.poll(() => archiveCount(page)).toBe(before + 1);

  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await expect(page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true })).toHaveCount(0);

  await archiveButton.click();
  await expect(page.getByRole('heading', { name: /^Архив/ })).toBeVisible();
  await page.getByLabel('Поиск в архиве', { exact: true }).fill(title);
  await expect(page.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();
  await page.getByLabel('Поиск в архиве', { exact: true }).fill(`${title} нет такой`);
  await expect(page.getByText('В архиве ничего не найдено', { exact: true })).toBeVisible();
  await page.getByLabel('Поиск в архиве', { exact: true }).fill(title);
  await page.screenshot({ path: testInfo.outputPath('brigd-archive-page.png'), fullPage: true });
  await page.getByRole('button', { name: `Открыть: ${title}`, exact: true }).click();
  const archivedDrawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(archivedDrawer.getByRole('button', { name: 'Восстановить', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: `Восстановить: ${title}`, exact: true }).click();
  await expect(page.getByText('Задача восстановлена и снова на доске', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toHaveCount(0);
  await expect.poll(() => archiveCount(page)).toBe(before);
  await navigation.getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  const restored = page.getByRole('dialog', { name: title, exact: true });
  await expect(restored.getByRole('button', { name: 'В архив', exact: true })).toBeVisible();
  await expect(restored.getByLabel('Заметка к задаче', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a task waiting for an answer cannot be archived', async ({ page, request }) => {
  const title = unique('Активная задача');
  const drawer = await createThroughUi(page, title, '[ask] Уточни детали перед работой.');
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'В архив', exact: true })).toHaveCount(0);
  const task = (await (await request.get('/api/tasks')).json()).find((row: { title: string }) => row.title === title);
  const response = await request.post(`/api/tasks/${task.id}/archive`, { headers: origin, data: {} });
  expect(response.status()).toBe(409);
  await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'В архив', exact: true })).toBeVisible();
});

for (const { width, height, fontSize } of [{ width: 390, height: 844, fontSize: 13 }, { width: 320, height: 640, fontSize: 26 }, { width: 768, height: 900, fontSize: 26 }]) {
  test(`archive navigation and page fit ${width}px with ${fontSize}px root text`, async ({ page, request }) => {
    const title = unique('Архивная задача с длинным названием-'.repeat(2));
    const created = await request.post('/api/tasks', { headers: origin, data: {
      title, instruction: 'Проверка вёрстки архива.', provider: 'codex', cwd: (await (await request.get('/api/info')).json()).cwd,
      schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false } });
    expect(created.status()).toBe(201);
    expect((await request.post(`/api/tasks/${(await created.json()).id}/archive`, { headers: origin, data: {} })).status()).toBe(200);
    await page.setViewportSize({ width, height });
    await page.reload();
    await page.addStyleTag({ content: `html { font-size: ${fontSize}px !important; }` });
    const navigation = page.getByRole('complementary', { name: 'Основная навигация', exact: true });
    await expect(navigation.getByRole('button', { name: 'Архив', exact: true })).toBeInViewport();
    await expect(navigation.getByRole('button', { name: 'Настройки', exact: true })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await navigation.getByRole('button', { name: 'Архив', exact: true }).click();
    await page.getByLabel('Поиск в архиве', { exact: true }).fill(title);
    await expect(page.getByRole('button', { name: `Восстановить: ${title}`, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}
