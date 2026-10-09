import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Attachment, Comment, Run, Task, TaskDetail } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const timestamp = Date.UTC(2026, 9, 9, 9);
// A real, decodable PNG: browser previews must work, rather than merely render an <img>.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
type TestFile = { name: string; mimeType: string; buffer: Buffer };
const imageFile = (name = 'screenshot.png'): TestFile => ({ name, mimeType: 'image/png', buffer: png });
const textFile = (name = 'context.txt'): TestFile => ({ name, mimeType: 'text/plain', buffer: Buffer.from('Контекст задачи\nВторая строка.\n', 'utf8') });
const pathOf = (url: string) => new URL(url).pathname;
const composer = (within: Locator, name: 'Файлы задачи' | 'Файлы заметки' | 'Файлы ответа') => within.getByRole('region', { name, exact: true });
const attachmentName = (within: Locator, name: string) => within.locator('.attachment-name').filter({ hasText: name });

function expectAttachmentIntegrity(attachment: Attachment | undefined, file: TestFile) {
  expect(attachment, `persisted metadata for ${file.name}`).toMatchObject({
    name: file.name, mime: file.mimeType, size: file.buffer.byteLength,
    sha256: createHash('sha256').update(file.buffer).digest('hex'), source: 'user',
  });
}

async function expectBoundOriginal(request: APIRequestContext, taskId: string, attachment: Attachment | undefined, file: TestFile) {
  expectAttachmentIntegrity(attachment, file);
  expect(attachment?.taskId, `bound owner of ${file.name}`).toBe(taskId);
  const response = await request.get(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment!.id)}?download=1`);
  expect(response.status(), `download persisted original ${file.name}`).toBe(200);
  expect(response.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(response.headers()['content-length']).toBe(String(file.buffer.byteLength));
  const persisted = await response.body();
  expect(persisted, `byte-for-byte original ${file.name}`).toEqual(file.buffer);
  expect(createHash('sha256').update(persisted).digest('hex'), `download agrees with persisted metadata for ${file.name}`).toBe(attachment!.sha256);
}

async function openEditor(page: Page, title = unique('Задача с файлами'), instruction = 'Проверь приложенные материалы.') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.locator('[name="title"]').fill(title);
  await editor.locator('[name="instruction"]').fill(instruction);
  return { editor, title };
}

async function createTask(request: APIRequestContext, options: { title?: string; instruction?: string; attachmentIds?: string[] } = {}) {
  const infoResponse = await request.get('/api/info');
  expect(infoResponse.ok()).toBe(true);
  const info = await infoResponse.json() as AppInfo;
  const response = await request.post('/api/tasks', { headers: origin, data: {
    title: options.title ?? unique('Проверка вложений'), instruction: options.instruction ?? 'Проверь приложенные материалы.',
    provider: 'codex', cwd: info.cwd, schedule: 'manual', intervalMinutes: null,
    firstRunAt: null, paused: false, attachmentIds: options.attachmentIds ?? [],
  } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Task>;
}

async function openTask(page: Page, task: Task) {
  await page.goto('/');
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Заметка к задаче', { exact: true })).toBeVisible();
  return drawer;
}

async function upload(request: APIRequestContext, file: TestFile) {
  const response = await request.post(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
    headers: { ...origin, 'Content-Type': file.mimeType }, data: file.buffer,
  });
  expect(response.ok()).toBe(true);
  const attachment = await response.json() as Attachment;
  expectAttachmentIntegrity(attachment, file);
  expect(attachment.taskId).toBeNull();
  return attachment;
}

async function selectFiles(page: Page, region: Locator, files: TestFile[]) {
  const responses = files.map(file => page.waitForResponse(response => response.request().method() === 'POST'
    && pathOf(response.url()) === '/api/uploads' && new URL(response.url()).searchParams.get('name') === file.name));
  await region.locator('input[type="file"]').setInputFiles(files);
  const attachments: Attachment[] = [];
  for (let index = 0; index < files.length; index++) {
    const response = await responses[index];
    expect(response.ok(), `upload ${files[index].name}`).toBe(true);
    expect(response.request().headers()['content-type']).toBe(files[index].mimeType);
    // Chromium's DevTools may omit File-backed fetch bodies. Assert the server's
    // persisted bytes through their independently computed digest and byte length.
    const attachment = await response.json() as Attachment;
    expectAttachmentIntegrity(attachment, files[index]);
    expect(attachment.taskId).toBeNull();
    attachments.push(attachment);
    await expect(attachmentName(region, files[index].name)).toBeVisible();
  }
  return attachments;
}

async function transferFiles(target: Locator, kind: 'paste' | 'drop', files: TestFile[]) {
  await target.evaluate((element, input) => {
    const transfer = new DataTransfer();
    for (const file of input.files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }));
    const event = input.kind === 'paste'
      ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(event);
  }, { kind, files: files.map(file => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })) });
}

async function detail(request: APIRequestContext, taskId: string) {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<TaskDetail>;
}

async function saveNewTask(page: Page, editor: Locator, title: string) {
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === '/api/tasks');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const task = await response.json() as Task;
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(editor).not.toBeVisible();
  await expect(drawer).toBeVisible();
  return { task, drawer, payload: response.request().postDataJSON() as { attachmentIds: string[] } };
}

async function noOverflow(page: Page, dialog: Locator) {
  const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(viewport.content, 'page must not scroll sideways').toBeLessThanOrEqual(viewport.width + 1);
  const bounds = await dialog.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: node.clientWidth, content: node.scrollWidth, viewport: innerWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.content, 'attachment cards must fit their dialog').toBeLessThanOrEqual(bounds.width + 1);
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/info');
  expect(response.ok()).toBe(true);
  expect((await response.json() as AppInfo).mode, 'Attachment browser tests must not invoke paid CLI adapters').toBe('mock');
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-attachments.png'), fullPage: true });
});

test('select multiple files and create one task with atomically bound uploads, then reload', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const taskWrites: string[] = [];
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && /^\/api\/tasks(?:\/[^/]+)?$/.test(pathOf(request.url()))) taskWrites.push(request.method());
  });
  const { editor, title } = await openEditor(page);
  const region = composer(editor, 'Файлы задачи');
  await expect(region.locator('input[type="file"]')).toHaveAttribute('multiple', '');
  const files = [imageFile('reference #1.png'), textFile('notes & plan.txt')];
  const staged = await selectFiles(page, region, files);
  expect(taskWrites, 'uploading a draft must not create a partial task').toEqual([]);
  expect(staged.every(file => file.taskId === null && file.source === 'user')).toBe(true);
  const { task, drawer, payload } = await saveNewTask(page, editor, title);
  expect(payload.attachmentIds).toEqual(staged.map(file => file.id));
  expect(taskWrites, 'creation and binding must use one task write').toEqual(['POST']);
  const saved = await detail(request, task.id);
  expect(saved.task.attachments?.map(file => file.id)).toEqual(staged.map(file => file.id));
  for (let index = 0; index < files.length; index++) {
    await expect(attachmentName(drawer, files[index].name)).toBeVisible();
    const response = await request.get(`/api/tasks/${task.id}/attachments/${staged[index].id}`);
    expect(response.ok()).toBe(true);
    expect(await response.body()).toEqual(files[index].buffer);
    await expectBoundOriginal(request, task.id, saved.task.attachments?.find(file => file.id === staged[index].id), files[index]);
  }
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(title);
  await page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true }).click();
  for (const file of files) await expect(attachmentName(page.getByRole('dialog', { name: title, exact: true }), file.name)).toBeVisible();
  expect(errors).toEqual([]);
});

test('paste from the task textarea and drop multiple files into the composer', async ({ page, request }) => {
  const { editor, title } = await openEditor(page);
  const region = composer(editor, 'Файлы задачи');
  const pasted = imageFile('from clipboard.png');
  await transferFiles(editor.locator('[name="instruction"]'), 'paste', [pasted]);
  await expect(attachmentName(region, pasted.name)).toBeVisible();
  const dropped = [textFile('dropped note.txt'), imageFile('dropped screenshot.png')];
  await transferFiles(region, 'drop', dropped);
  for (const file of dropped) await expect(attachmentName(region, file.name)).toBeVisible();
  await expect(editor.locator('[name="instruction"]')).toHaveValue('Проверь приложенные материалы.');
  const { task } = await saveNewTask(page, editor, title);
  const saved = await detail(request, task.id);
  expect(saved.task.attachments?.map(file => file.name).sort()).toEqual([pasted, ...dropped].map(file => file.name).sort());
  for (const file of [pasted, ...dropped]) await expectBoundOriginal(request, task.id, saved.task.attachments?.find(attachment => attachment.name === file.name), file);
});

test('an image opens by keyboard, Escape restores the task, and download returns the bound file', async ({ page, request }, testInfo) => {
  // Exercise a real screenshot's dimensions as well as the small PNG fixtures.
  // This captures the running app, not a synthetic claim of agent-produced output.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeVisible();
  const file: TestFile = { name: 'preview.png', mimeType: 'image/png', buffer: await page.screenshot({ fullPage: false }) };
  const staged = await upload(request, file);
  const task = await createTask(request, { attachmentIds: [staged.id] });
  const drawer = await openTask(page, task);
  const thumbnail = drawer.getByRole('button', { name: `Открыть изображение: ${file.name}`, exact: true });
  await thumbnail.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: file.name, exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(320);
  await expect.poll(() => preview.locator('img').evaluate(image => (image as HTMLImageElement).naturalHeight)).toBeGreaterThan(200);
  await noOverflow(page, preview);
  await page.screenshot({ path: testInfo.outputPath('attachments-image-preview.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(thumbnail).toBeFocused();
  const link = drawer.getByRole('link', { name: `Скачать: ${file.name}`, exact: true });
  await expect(link).toHaveAttribute('href', `/api/tasks/${task.id}/attachments/${staged.id}?download=1`);
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe(file.name);
  expect(await downloaded.failure()).toBeNull();
  await expectBoundOriginal(request, task.id, (await detail(request, task.id)).task.attachments?.find(attachment => attachment.id === staged.id), file);
  await thumbnail.click();
  await preview.getByRole('button', { name: 'Закрыть просмотр', exact: true }).click();
  await expect(drawer).toBeVisible();
});

test('attachment-only note survives a failed save, binds once, and is visible after reload', async ({ page, request }) => {
  const task = await createTask(request);
  const drawer = await openTask(page, task);
  const region = composer(drawer, 'Файлы заметки');
  const file = textFile('attachment only.txt');
  const [staged] = await selectFiles(page, region, [file]);
  await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('Черновик для переключения вкладок.');
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await drawer.getByRole('tab', { name: /Комментарии/ }).click();
  await expect(attachmentName(region, staged.name)).toBeVisible();
  await expect(drawer.getByLabel('Заметка к задаче', { exact: true })).toHaveValue('Черновик для переключения вкладок.');
  await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('');
  let attempts = 0;
  const bodies: { body: string; attachmentIds: string[] }[] = [];
  await page.route(`**/api/tasks/${task.id}/comments`, async route => {
    bodies.push(route.request().postDataJSON());
    if (++attempts === 1) await route.fulfill({ status: 503, json: { error: 'Заметка временно не сохраняется.' } });
    else await route.continue();
  });
  const save = drawer.getByRole('button', { name: 'Сохранить заметку', exact: true });
  await expect(drawer.getByLabel('Заметка к задаче', { exact: true })).toHaveValue('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Заметка временно не сохраняется.' })).toBeVisible();
  await expect(attachmentName(region, staged.name)).toBeVisible();
  expect((await detail(request, task.id)).comments.some(entry => entry.attachments?.some(file => file.id === staged.id))).toBe(false);
  await save.click();
  const article = drawer.locator('article.comment-user').filter({ hasText: staged.name });
  await expect(attachmentName(article, staged.name)).toBeVisible();
  await expect(region.locator('.attachment-name')).toHaveCount(0);
  expect(bodies).toEqual([{ body: '', attachmentIds: [staged.id] }, { body: '', attachmentIds: [staged.id] }]);
  const saved = await detail(request, task.id);
  const comments = saved.comments.filter(entry => entry.attachments?.some(file => file.id === staged.id));
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toBe('');
  expect(comments[0].attachments?.[0]).toMatchObject({ taskId: task.id, commentId: comments[0].id, source: 'user' });
  await expectBoundOriginal(request, task.id, comments[0].attachments?.[0], file);
  await page.reload();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  await expect(page.locator('article.comment-user').filter({ hasText: staged.name })).toBeVisible();
});

for (const withText of [true, false]) {
test(`${withText ? 'pasted clarification with text' : 'attachment-only clarification'} survives a failed resume and resumes the same session`, async ({ page, request }) => {
  const task = await createTask(request, { instruction: '[ask] Уточни референс перед продолжением.' });
  const drawer = await openTask(page, task);
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const before = await detail(request, task.id);
  const run = before.runs[0];
  expect(run.sessionId).toBeTruthy();
  const answer = drawer.getByLabel('Ответ агенту', { exact: true });
  const answerText = withText ? 'Используй приложенный снимок.' : '';
  await answer.fill(answerText);
  const file = imageFile('clarification.png');
  const uploaded = page.waitForResponse(response => pathOf(response.url()) === '/api/uploads' && response.request().method() === 'POST');
  await transferFiles(answer, 'paste', [file]);
  const uploadedResponse = await uploaded;
  expect(uploadedResponse.status()).toBe(201);
  const staged = await uploadedResponse.json() as Attachment;
  expectAttachmentIntegrity(staged, file);
  const region = composer(drawer, 'Файлы ответа');
  await expect(attachmentName(region, file.name)).toBeVisible();
  const bodies: { answer: string; attachmentIds: string[] }[] = [];
  await page.route(`**/api/runs/${run.id}/resume`, async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.fulfill({ status: 503, json: { error: 'Ответ временно не отправляется.' } });
    else await route.continue();
  });
  const resume = drawer.getByRole('button', { name: 'Продолжить работу', exact: true });
  await resume.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Ответ временно не отправляется.' })).toBeVisible();
  await expect(answer).toHaveValue(answerText);
  await expect(attachmentName(region, file.name)).toBeVisible();
  await resume.click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ answer: answerText, attachmentIds: [staged.id] });
  expect(bodies[1]).toEqual(bodies[0]);
  const after = await detail(request, task.id);
  expect(after.runs).toHaveLength(1);
  expect(after.runs[0]).toMatchObject({ id: run.id, sessionId: run.sessionId, turn: 2 });
  const replies = after.comments.filter(entry => entry.attachments?.some(file => file.id === staged.id));
  expect(replies).toHaveLength(1);
  await expectBoundOriginal(request, task.id, replies[0].attachments?.find(attachment => attachment.id === staged.id), file);
  await expect(drawer.locator('article.comment-user').filter({ hasText: file.name })).toBeVisible();
});
}

test('partial upload failure keeps successful files and the note draft for retry', async ({ page, request }) => {
  const task = await createTask(request);
  const drawer = await openTask(page, task);
  const region = composer(drawer, 'Файлы заметки');
  const field = drawer.getByLabel('Заметка к задаче', { exact: true });
  const good = textFile('successful.txt');
  const rejected = imageFile('retry.png');
  let rejectedAttempts = 0;
  const uploadedIds: string[] = [];
  await page.route('**/api/uploads?*', async route => {
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name === rejected.name && ++rejectedAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: 'Не удалось загрузить снимок. Попробуйте ещё раз.' } });
      return;
    }
    const response = await route.fetch();
    if (response.ok()) {
      const attachment = await response.json() as Attachment;
      expectAttachmentIntegrity(attachment, name === good.name ? good : rejected);
      uploadedIds.push(attachment.id);
    }
    await route.fulfill({ response });
  });
  await field.fill('Этот текст нельзя потерять после ошибки.');
  await region.locator('input[type="file"]').setInputFiles([good, rejected]);
  await expect(attachmentName(region, good.name)).toBeVisible();
  await expect(region.getByRole('alert')).toContainText('Не удалось загрузить снимок.');
  await expect(field).toHaveValue('Этот текст нельзя потерять после ошибки.');
  const retried = page.waitForResponse(response => pathOf(response.url()) === '/api/uploads' && new URL(response.url()).searchParams.get('name') === rejected.name);
  await region.getByRole('button', { name: `Повторить загрузку: ${rejected.name}`, exact: true }).click();
  expect((await retried).ok()).toBe(true);
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expect(attachmentName(region, good.name)).toHaveCount(1);
  await expect(attachmentName(region, rejected.name)).toHaveCount(1);
  await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  const article = drawer.locator('article.comment-user').filter({ hasText: 'Этот текст нельзя потерять после ошибки.' });
  await expect(attachmentName(article, good.name)).toBeVisible();
  await expect(attachmentName(article, rejected.name)).toBeVisible();
  const saved = await detail(request, task.id);
  const note = saved.comments.find(entry => entry.body === 'Этот текст нельзя потерять после ошибки.')!;
  expect(note.attachments?.map(file => file.id).sort()).toEqual(uploadedIds.sort());
  expect(uploadedIds).toHaveLength(2);
  for (const file of [good, rejected]) await expectBoundOriginal(request, task.id, note.attachments?.find(attachment => attachment.name === file.name), file);
});

test('failed task creation preserves staged uploads and retries without reupload or a partial task', async ({ page, request }) => {
  const { editor, title } = await openEditor(page);
  const region = composer(editor, 'Файлы задачи');
  const file = textFile('saved draft.txt');
  const [staged] = await selectFiles(page, region, [file]);
  const bodies: { title: string; attachmentIds: string[] }[] = [];
  let duplicateUploads = 0;
  page.on('request', request => { if (pathOf(request.url()) === '/api/uploads' && request.method() === 'POST') duplicateUploads++; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.fulfill({ status: 503, json: { error: 'Не удалось создать задачу. Повторите сохранение.' } });
    else await route.continue();
  });
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Не удалось создать задачу.');
  await expect(editor.locator('[name="title"]')).toHaveValue(title);
  await expect(attachmentName(region, staged.name)).toBeVisible();
  expect((await (await request.get('/api/tasks')).json() as Task[]).some(task => task.title === title)).toBe(false);
  const { task } = await saveNewTask(page, editor, title);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[1].attachmentIds).toEqual([staged.id]);
  expect(duplicateUploads).toBe(0);
  const saved = await detail(request, task.id);
  expect(saved.task.attachments?.map(file => file.id)).toEqual([staged.id]);
  await expectBoundOriginal(request, task.id, saved.task.attachments?.[0], file);
});

test('removing a staged file and cancelling the editor delete abandoned uploads', async ({ page, request }) => {
  const { editor, title } = await openEditor(page);
  const region = composer(editor, 'Файлы задачи');
  const staged = await selectFiles(page, region, [textFile('remove.txt'), imageFile('cancel.png')]);
  const removed = page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${staged[0].id}`);
  await region.getByRole('button', { name: `Убрать файл: ${staged[0].name}`, exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await expect(attachmentName(region, staged[0].name)).toHaveCount(0);
  const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${staged[1].id}`);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await cancelled).ok()).toBe(true);
  await expect(editor).not.toBeVisible();
  expect((await (await request.get('/api/tasks')).json() as Task[]).some(task => task.title === title)).toBe(false);
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(composer(page.getByRole('dialog', { name: 'Новая задача', exact: true }), 'Файлы задачи').locator('.attachment-name')).toHaveCount(0);
});

test('a late upload response after cancellation is cleaned up and cannot leak into a new editor', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploaded!: (attachment: Attachment) => void;
  const accepted = new Promise<Attachment>(resolve => { uploaded = resolve; });
  await page.route('**/api/uploads?*', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const attachment = await response.json() as Attachment;
    expectAttachmentIntegrity(attachment, imageFile('late screenshot.png'));
    uploaded(attachment);
    await gate;
    await route.fulfill({ response });
  });
  try {
    const { editor } = await openEditor(page);
    await composer(editor, 'Файлы задачи').locator('input[type="file"]').setInputFiles(imageFile('late screenshot.png'));
    const staged = await accepted;
    await expect(editor.getByRole('button', { name: 'Создать задачу', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    const fresh = page.getByRole('dialog', { name: 'Новая задача', exact: true });
    await fresh.locator('[name="title"]').fill('Новый независимый черновик');
    const cleanup = page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${staged.id}`);
    release();
    expect((await cleanup).ok()).toBe(true);
    await expect(composer(fresh, 'Файлы задачи').locator('.attachment-name')).toHaveCount(0);
    await expect(fresh.locator('[name="title"]')).toHaveValue('Новый независимый черновик');
    await expect(fresh.getByRole('alert')).toHaveCount(0);
  } finally { release(); }
});

test('closing a task discards note uploads without deleting its bound files', async ({ page, request }) => {
  const existingFile = textFile('persistent context.txt');
  const existing = await upload(request, existingFile);
  const task = await createTask(request, { attachmentIds: [existing.id] });
  const drawer = await openTask(page, task);
  const [staged] = await selectFiles(page, composer(drawer, 'Файлы заметки'), [textFile('unsaved note.txt')]);
  const cleanup = page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${staged.id}`);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  expect((await cleanup).ok()).toBe(true);
  const bound = await request.get(`/api/tasks/${task.id}/attachments/${existing.id}`);
  expect(bound.ok()).toBe(true);
  const saved = await detail(request, task.id);
  expect(saved.task.attachments?.map(file => file.id)).toEqual([existing.id]);
  await expectBoundOriginal(request, task.id, saved.task.attachments?.[0], existingFile);
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  await expect(composer(drawer, 'Файлы заметки').locator('.attachment-name')).toHaveCount(0);
  await expect(attachmentName(drawer, existing.name)).toBeVisible();
});


test('editing task files changes the next run but preserves the current run input snapshot', async ({ page, request }) => {
  const initialFile = textFile('initial context.txt');
  const initial = await upload(request, initialFile);
  const task = await createTask(request, { instruction: '[ask] Уточни вариант и используй исходный контекст.', attachmentIds: [initial.id] });
  const drawer = await openTask(page, task);
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const before = await detail(request, task.id);
  expect(before.runs[0].inputAttachments?.map(file => file.id)).toEqual([initial.id]);
  const deletedIds: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') deletedIds.push(pathOf(request.url()).split('/').at(-1)!); });
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  const region = composer(editor, 'Файлы задачи');
  await region.getByRole('button', { name: `Убрать файл: ${initial.name}`, exact: true }).click();
  const replacementFile = textFile('next run context.txt');
  const [replacement] = await selectFiles(page, region, [replacementFile]);
  const updated = page.waitForResponse(response => response.request().method() === 'PATCH' && pathOf(response.url()) === `/api/tasks/${task.id}`);
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  expect((await updated).ok()).toBe(true);
  await expect(editor).not.toBeVisible();
  const saved = await detail(request, task.id);
  expect(saved.task.attachments?.map(file => file.id)).toEqual([replacement.id]);
  expect(saved.runs[0].inputAttachments?.map(file => file.id)).toEqual([initial.id]);
  expect(deletedIds).not.toContain(initial.id);
  expect((await request.get(`/api/tasks/${task.id}/attachments/${initial.id}`)).ok()).toBe(true);
  await expectBoundOriginal(request, task.id, saved.task.attachments?.[0], replacementFile);
  await expectBoundOriginal(request, task.id, saved.runs[0].inputAttachments?.[0], initialFile);
  await expect(attachmentName(drawer.getByRole('region', { name: 'Файлы задачи', exact: true }), replacement.name)).toBeVisible();
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await drawer.locator('.run-entry .run-instruction-snapshot > summary').click();
  await expect(attachmentName(drawer.locator('.run-entry'), initial.name)).toBeVisible();
  await expect(attachmentName(drawer.locator('.run-entry'), replacement.name)).toHaveCount(0);
});

for (const succeeded of [true, false]) {
test(`a late ${succeeded ? 'successful' : 'failed'} note response preserves the new draft and ${succeeded ? 'keeps the bound file' : 'cleans up abandoned staging'}`, async ({ page, request }) => {
  const firstTask = await createTask(request);
  const secondTask = await createTask(request);
  const drawer = await openTask(page, firstTask);
  const sourceFile = textFile('keep on navigation.txt');
  const [savedFile] = await selectFiles(page, composer(drawer, 'Файлы заметки'), [sourceFile]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let accepted!: () => void;
  const persisted = new Promise<void>(resolve => { accepted = resolve; });
  const deletedIds: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') deletedIds.push(pathOf(request.url()).split('/').at(-1)!); });
  await page.route(`**/api/tasks/${firstTask.id}/comments`, async route => {
    const response = succeeded ? await route.fetch() : null;
    if (response) expect(response.ok()).toBe(true);
    accepted();
    await gate;
    if (response) await route.fulfill({ response });
    else await route.fulfill({ status: 503, json: { error: 'Первая заметка не сохранилась.' } });
  });
  try {
    await drawer.getByLabel('Заметка к задаче', { exact: true }).fill('Сохранённая заметка первой задачи.');
    await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
    await persisted;
    await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    await page.getByLabel('Поиск задач', { exact: true }).fill(secondTask.title);
    await page.getByRole('button', { name: `Открыть задачу: ${secondTask.title}`, exact: true }).click();
    const other = page.getByRole('dialog', { name: secondTask.title, exact: true });
    const field = other.getByLabel('Заметка к задаче', { exact: true });
    await field.fill('Новый черновик второй задачи.');
    const [draftFile] = await selectFiles(page, composer(other, 'Файлы заметки'), [textFile('other task draft.txt')]);
    const finished = page.waitForResponse(response => pathOf(response.url()) === `/api/tasks/${firstTask.id}/comments` && response.request().method() === 'POST');
    const abandoned = succeeded ? null : page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${savedFile.id}`);
    release();
    expect((await finished).ok()).toBe(succeeded);
    if (abandoned) expect((await abandoned).ok()).toBe(true);
    await expect(field).toHaveValue('Новый черновик второй задачи.');
    await expect(attachmentName(composer(other, 'Файлы заметки'), draftFile.name)).toBeVisible();
    if (succeeded) expect(deletedIds).not.toContain(savedFile.id);
    else expect(deletedIds).toContain(savedFile.id);
    expect((await request.get(`/api/tasks/${firstTask.id}/attachments/${savedFile.id}`)).ok()).toBe(succeeded);
    const savedComments = (await detail(request, firstTask.id)).comments.filter(entry => entry.attachments?.some(file => file.id === savedFile.id));
    expect(savedComments).toHaveLength(succeeded ? 1 : 0);
    if (succeeded) await expectBoundOriginal(request, firstTask.id, savedComments[0].attachments?.find(attachment => attachment.id === savedFile.id), sourceFile);
    expect((await detail(request, secondTask.id)).comments.some(entry => entry.attachments?.some(file => file.id === savedFile.id))).toBe(false);
    const cleanup = page.waitForResponse(response => response.request().method() === 'DELETE' && pathOf(response.url()) === `/api/uploads/${draftFile.id}`);
    await other.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    expect((await cleanup).ok()).toBe(true);
  } finally { release(); }
});
}

// Agent output is a read-only fixture: these checks must never need a real CLI.
function attachmentFixture(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'fixture-input', taskId: 'attachment-fixture-task', commentId: null, runId: null,
    stepIndex: null, attemptId: null, source: 'user', name: 'source reference.png', mime: 'image/png',
    size: png.byteLength, sha256: 'a'.repeat(64), previewable: true, createdAt: timestamp, ...overrides,
  };
}

function fixtureDetail(): TaskDetail {
  const input = attachmentFixture();
  const run: Run = {
    id: 'attachment-fixture-run', taskId: input.taskId!, workerId: null, worker: null,
    instructions: [], steps: [], currentStepIndex: null, inputAttachments: [input], provider: 'codex', cwd: '/workspace/project',
    instruction: 'Подготовь и приложи результат.', trigger: 'manual', scheduledFor: null, status: 'completed',
    sessionId: 'attachment-fixture-session', startedAt: timestamp, updatedAt: timestamp + 1000,
    finishedAt: timestamp + 1000, summary: 'Результат готов и приложен.', error: null, turn: 1, mock: true,
  };
  const outputs = [
    attachmentFixture({ id: 'fixture-result-image', name: 'final mockup.png', source: 'agent', runId: run.id, commentId: 'fixture-result', stepIndex: 1, attemptId: 'fixture-attempt' }),
    attachmentFixture({ id: 'fixture-result-pdf', name: `${'ОченьДлинноеИмяРезультата'.repeat(7)}.pdf`, mime: 'application/pdf', previewable: false, source: 'agent', runId: run.id, commentId: 'fixture-result', stepIndex: 1, attemptId: 'fixture-attempt', size: 1024 }),
    attachmentFixture({ id: 'fixture-result-svg', name: 'diagram.svg', mime: 'image/svg+xml', previewable: false, source: 'agent', runId: run.id, commentId: 'fixture-result', size: 200 }),
    attachmentFixture({ id: 'fixture-result-html', name: '<b>отчёт</b>.html', mime: 'text/html', previewable: false, source: 'agent', runId: run.id, commentId: 'fixture-result', size: 100 }),
  ];
  // add_attachment without a caption creates a direct task file, not a comment.
  const directOutput = attachmentFixture({
    id: 'fixture-direct-agent-output', name: 'uncaptioned result.txt', mime: 'text/plain',
    previewable: false, source: 'agent', runId: run.id, commentId: null, size: 64,
  });
  const task: Task = {
    id: input.taskId!, title: 'Файлы пользователя и результат агента', instruction: run.instruction,
    workerId: null, worker: null, steps: [], provider: 'codex', cwd: run.cwd,
    schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
    createdAt: timestamp, updatedAt: timestamp, archivedAt: null, nextRunAt: null, status: 'completed', latestRun: run, runCount: 1,
    attachments: [input, directOutput],
  };
  const result: Comment = { id: 'fixture-result', taskId: task.id, runId: run.id, stepIndex: 1, kind: 'result', body: 'Прикладываю готовый макет и документы.', createdAt: timestamp + 1000, attachments: outputs };
  return { task, runs: [run], comments: [result], attachments: [input, directOutput, ...outputs] };
}

async function fixtureApi(page: Page, fixture: TaskDetail) {
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', providers: [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude Code', available: true }], scheduler: 'running', startedAt: timestamp };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') { await route.fulfill({ status: 405, json: { error: 'Attachment appearance fixtures are read-only' } }); return; }
    if (url.pathname === '/api/info') await route.fulfill({ json: info });
    else if (url.pathname === '/api/workers' || url.pathname === '/api/instructions') await route.fulfill({ json: [] });
    else if (url.pathname === '/api/tasks') await route.fulfill({ json: [fixture.task] });
    else if (url.pathname === `/api/tasks/${fixture.task.id}`) await route.fulfill({ json: fixture });
    else {
      const attachment = fixture.attachments?.find(file => url.pathname === `/api/tasks/${fixture.task.id}/attachments/${file.id}`);
      if (attachment) await route.fulfill({ contentType: attachment.mime, body: attachment.previewable ? png : Buffer.from('Download-only fixture'), headers: { 'X-Content-Type-Options': 'nosniff', ...(!attachment.previewable || url.searchParams.has('download') ? { 'Content-Disposition': 'attachment' } : {}) } });
      else await route.fulfill({ status: 404, json: { error: 'Unknown attachment fixture' } });
    }
  });
}

test('agent outputs belong to their result, unsafe image types only download, and run input snapshots are shown', async ({ page }) => {
  const fixture = fixtureDetail();
  await fixtureApi(page, fixture);
  const drawer = await openTask(page, fixture.task);
  const directOutput = fixture.task.attachments!.find(file => file.source === 'agent' && file.commentId === null)!;
  const agentFiles = drawer.getByRole('region', { name: 'Файлы агента', exact: true });
  await expect(attachmentName(drawer, directOutput.name)).toHaveCount(1);
  await expect(attachmentName(agentFiles, directOutput.name)).toBeVisible();
  await expect(attachmentName(drawer.getByRole('region', { name: 'Файлы задачи', exact: true }), directOutput.name)).toHaveCount(0);
  const directCard = agentFiles.getByRole('listitem').filter({ hasText: directOutput.name });
  await expect(directCard.locator('.attachment-meta')).toContainText(`Codex · запуск ${directOutput.runId!.slice(0, 6)}`);
  await expect(directCard.locator('.attachment-meta')).not.toContainText('Вы');
  await expect(directCard.getByRole('link', { name: `Скачать: ${directOutput.name}`, exact: true })).toHaveAttribute('href', `/api/tasks/${fixture.task.id}/attachments/${directOutput.id}?download=1`);
  const result = drawer.locator('article.comment-result');
  const outputs = fixture.comments[0].attachments!;
  for (const attachment of outputs) {
    await expect(attachmentName(result, attachment.name)).toBeVisible();
    await expect(result.getByRole('link', { name: `Скачать: ${attachment.name}`, exact: true })).toHaveAttribute('href', `/api/tasks/${fixture.task.id}/attachments/${attachment.id}?download=1`);
  }
  await expect(result.getByRole('button', { name: 'Открыть изображение: final mockup.png', exact: true })).toBeVisible();
  for (const attachment of outputs.filter(file => !file.previewable)) {
    await expect(result.getByRole('button', { name: `Открыть изображение: ${attachment.name}`, exact: true })).toHaveCount(0);
  }
  await expect(result.locator('.attachment-name b')).toHaveCount(0);
  await expect(result.locator('iframe, object, embed, script')).toHaveCount(0);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await drawer.locator('.run-entry .run-instruction-snapshot > summary').click();
  await expect(attachmentName(drawer.locator('.run-entry'), fixture.task.attachments!.find(file => file.source === 'user')!.name)).toBeVisible();
  await expect(drawer.locator('.run-entry')).toContainText('Ход 1');
});

const layouts = [
  { label: 'desktop', width: 1440, height: 1000, fontSize: 13 },
  { label: 'mobile', width: 390, height: 844, fontSize: 13 },
  // 26px is 200% text scaling; this is not a claim of native browser zoom.
  { label: '320px-200-percent-text', width: 320, height: 640, fontSize: 26 },
];
for (const theme of ['light', 'dark'] as const) {
  for (const layout of layouts) {
    test(`attachment layout, preview and editor at ${layout.label} in ${theme} theme`, async ({ page }, testInfo) => {
      const fixture = fixtureDetail();
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
      await fixtureApi(page, fixture);
      const drawer = await openTask(page, fixture.task);
      await page.addStyleTag({ content: `html { font-size: ${layout.fontSize}px !important; }` });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await noOverflow(page, drawer);
      const result = drawer.locator('article.comment-result');
      const longName = attachmentName(result, fixture.comments[0].attachments![1].name);
      await longName.scrollIntoViewIfNeeded();
      await expect(longName).toBeInViewport();
      const dimensions = await longName.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
      expect(dimensions.content, 'long file names must wrap inside the card').toBeLessThanOrEqual(dimensions.width + 1);
      await page.screenshot({ path: testInfo.outputPath(`attachments-${layout.label}-${theme}-result.png`), fullPage: false });
      await result.getByRole('button', { name: 'Открыть изображение: final mockup.png', exact: true }).click();
      const preview = page.getByRole('dialog', { name: 'final mockup.png', exact: true });
      await expect(preview).toBeVisible();
      await noOverflow(page, preview);
      const close = preview.getByRole('button', { name: 'Закрыть просмотр', exact: true });
      await close.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`attachments-${layout.label}-${theme}-preview.png`), fullPage: false });
      await close.click();
      await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
      const region = composer(editor, 'Файлы задачи');
      await expect(attachmentName(region, fixture.task.attachments!.find(file => file.source === 'user')!.name)).toBeVisible();
      await region.getByRole('button', { name: 'Прикрепить файлы', exact: true }).scrollIntoViewIfNeeded();
      await noOverflow(page, editor);
      await page.screenshot({ path: testInfo.outputPath(`attachments-${layout.label}-${theme}-editor.png`), fullPage: false });
      await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
      await expect(drawer).toBeVisible();
    });
  }
}
