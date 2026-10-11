import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = () => `Кадрирование ${crypto.randomUUID().slice(0, 8)}`;

async function imageFile(page: Page, portrait = false) {
  const encoded = await page.evaluate(portrait => {
    const canvas = document.createElement('canvas');
    canvas.width = portrait ? 300 : 600;
    canvas.height = portrait ? 600 : 300;
    const context = canvas.getContext('2d')!;
    for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
      context.fillStyle = color;
      context.fillRect(portrait ? 0 : index * 200, portrait ? index * 200 : 0, portrait ? 300 : 200, portrait ? 200 : 300);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, portrait);
  return { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

async function slider(editor: Locator, label: string, value: string) {
  await editor.getByRole('slider', { name: label, exact: true }).evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function pixels(avatar: Locator) {
  return avatar.evaluate(async element => {
    const image = element as HTMLImageElement;
    try {
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return {
        width: image.naturalWidth, height: image.naturalHeight,
        samples: [[10, 10], [128, 128], [245, 245]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]),
      };
    } catch (error) {
      // Replacing a preview can interrupt decoding; poll the latest image again.
      if (error instanceof DOMException && error.name === 'EncodingError') return null;
      throw error;
    }
  });
}

async function expectColor(avatar: Locator, channel: number) {
  await expect.poll(async () => {
    const result = await pixels(avatar);
    if (!result) return false;
    return result.width === 256 && result.height === 256 && result.samples.every(pixel => pixel[channel] > 240 && pixel.filter((_, index) => index < 3 && index !== channel).every(value => value < 15));
  }).toBe(true);
}

test.beforeEach(async ({ page, request }) => {
  expect((await (await request.get('/api/info')).json()).mode).toBe('mock');
  await page.goto('/');
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
});

test('zoom, positioning and drag save the visible square instead of the uploaded image', async ({ page, request }) => {
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/avatars') uploads++; });
  const name = unique();
  await page.getByRole('button', { name: 'Новый работник', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
  await editor.getByLabel('Имя работника', { exact: true }).fill(name);
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page));
  await expect(editor.getByRole('slider', { name: 'Масштаб аватара', exact: true })).toHaveValue('1');
  await expect(editor.getByRole('slider', { name: 'Положение аватара по вертикали', exact: true })).toBeDisabled();
  await slider(editor, 'Масштаб аватара', '0.5');
  await expect.poll(async () => {
    const result = await pixels(editor.locator('.worker-avatar img'));
    if (!result) return false;
    const { samples } = result;
    return samples[0][3] === 0 && samples[2][3] === 0 && samples[1][1] > 240;
  }).toBe(true);
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по горизонтали', '1');
  await expectColor(editor.locator('.worker-avatar img'), 2);
  const canvas = editor.locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .9, bounds.y + bounds.height / 2);
  await page.mouse.up();
  expect(Number(await editor.getByRole('slider', { name: 'Положение аватара по горизонтали', exact: true }).inputValue())).toBeLessThan(1);
  await editor.getByRole('button', { name: 'Сбросить кадрирование', exact: true }).click();
  await expect(editor.getByRole('slider', { name: 'Масштаб аватара', exact: true })).toHaveValue('1');
  await expect(editor.getByRole('slider', { name: 'Положение аватара по горизонтали', exact: true })).toHaveValue('0.5');
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по горизонтали', '1');
  await expectColor(editor.locator('.worker-avatar img'), 2);
  expect(uploads).toBe(0);
  await editor.getByRole('button', { name: 'Создать работника', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(uploads).toBe(1);
  const worker = ((await (await request.get('/api/workers')).json()) as Worker[]).find(worker => worker.name === name)!;
  const profile = page.getByRole('article', { name: `Работник: ${name}`, exact: true });
  await expect(profile.locator('img')).toHaveAttribute('src', worker.avatarUrl!);
  await expectColor(profile.locator('img'), 2);
  await page.reload();
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  await expectColor(profile.locator('img'), 2);
});

test('an existing avatar can be edited, cancelled or removed without changing the old file', async ({ page, request }) => {
  const name = unique();
  const original = await imageFile(page);
  const { avatarUrl } = await (await request.post('/api/avatars', { headers: { ...origin, 'Content-Type': 'image/png' }, data: original.buffer })).json();
  const worker: Worker = await (await request.post('/api/workers', { headers: origin, data: { name, provider: 'codex', avatarUrl } })).json();
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/avatars') uploads++; });
  await page.reload();
  await page.getByRole('button', { name: 'Работники', exact: true }).click();
  const edit = page.getByRole('button', { name: `Изменить работника: ${name}`, exact: true });
  const editor = page.getByRole('dialog', { name: 'Редактировать работника', exact: true });
  await edit.click();
  await editor.getByLabel('Описание', { exact: true }).fill('Обычное изменение профиля');
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(uploads).toBe(0);
  await edit.click();
  await editor.getByRole('button', { name: 'Изменить размер аватара', exact: true }).click();
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по горизонтали', '0');
  await expectColor(editor.locator('.worker-avatar img'), 0);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(uploads).toBe(0);
  expect((await (await request.get(`/api/workers/${worker.id}`)).json()).avatarUrl).toBe(avatarUrl);
  await edit.click();
  await expect(editor.locator('.worker-avatar img')).toHaveAttribute('src', avatarUrl);
  await expect(editor.locator('canvas')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Изменить размер аватара', exact: true }).click();
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по горизонтали', '0');
  await expectColor(editor.locator('.worker-avatar img'), 0);
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const saved: Worker = await (await request.get(`/api/workers/${worker.id}`)).json();
  expect(saved.avatarUrl).not.toBe(avatarUrl);
  expect(uploads).toBe(1);
  expect(await (await request.get(avatarUrl)).body()).toEqual(original.buffer);
  await edit.click();
  await editor.getByRole('button', { name: 'Убрать аватар', exact: true }).click();
  await expect(editor.locator('canvas')).toHaveCount(0);
  await expect(editor.locator('.worker-avatar img')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await (await request.get(`/api/workers/${worker.id}`)).json()).avatarUrl).toBeNull();
  expect(uploads).toBe(1);
});

test('a failed profile save reuses its upload on retry', async ({ page }) => {
  let saves = 0;
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/avatars') uploads++; });
  await page.route('**/api/workers', async route => {
    if (route.request().method() === 'POST' && ++saves === 1) return route.fulfill({ status: 500, json: { error: 'Ошибка сохранения профиля' } });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Новый работник', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
  await editor.getByLabel('Имя работника', { exact: true }).fill(unique());
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page));
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по горизонтали', '1');
  await expectColor(editor.locator('.worker-avatar img'), 2);
  const save = editor.getByRole('button', { name: 'Создать работника', exact: true });
  await save.click();
  await expect(editor.getByRole('alert')).toHaveText('Ошибка сохранения профиля');
  expect(uploads).toBe(1);
  await save.click();
  await expect(editor).not.toBeVisible();
  expect(uploads).toBe(1);
  expect(saves).toBe(2);
});

test('a late preview from a replaced image cannot change the current draft', async ({ page }) => {
  const landscape = await imageFile(page);
  const portrait = await imageFile(page, true);
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    let first = true;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (!first) return original.call(this, callback, type, quality);
      first = false;
      original.call(this, blob => {
        (window as unknown as { releaseAvatarPreview: () => void }).releaseAvatarPreview = () => callback(blob);
      }, type, quality);
    };
  });
  await page.getByRole('button', { name: 'Новый работник', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(landscape);
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAvatarPreview: () => void }).releaseAvatarPreview)).toBe('function');
  await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(portrait);
  await slider(editor, 'Масштаб аватара', '2');
  await slider(editor, 'Положение аватара по вертикали', '1');
  await expectColor(editor.locator('.worker-avatar img'), 2);
  await page.evaluate(() => (window as unknown as { releaseAvatarPreview: () => void }).releaseAvatarPreview());
  await expectColor(editor.locator('.worker-avatar img'), 2);
  await expect(editor.getByRole('slider', { name: 'Положение аватара по вертикали', exact: true })).toHaveValue('1');
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
});

for (const theme of ['light', 'dark']) {
  test(`portrait editing fits a 320px screen with enlarged text in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.evaluate(theme => localStorage.setItem('brigd.theme', theme), theme);
    await page.reload();
    await page.getByRole('button', { name: 'Работники', exact: true }).click();
    await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
    await page.getByRole('button', { name: 'Новый работник', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Новый работник', exact: true });
    await editor.getByLabel('Загрузить аватар', { exact: true }).setInputFiles(await imageFile(page, true));
    await slider(editor, 'Масштаб аватара', '2');
    await slider(editor, 'Положение аватара по вертикали', '1');
    await expectColor(editor.locator('.worker-avatar img'), 2);
    expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await editor.locator('.avatar-editor').screenshot({ path: testInfo.outputPath('avatar-editor.png') });
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  });
}
