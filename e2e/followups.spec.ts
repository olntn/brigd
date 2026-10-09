import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Attachment, FollowupInput, Run, RunStatus, Task, TaskDetail, Worker } from '../src/lib/types';

const origin = { Origin: 'http://127.0.0.1:4318' };
const timestamp = Date.UTC(2026, 9, 9, 12);
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
const privateText = 'PRIVATE_FOLLOWUP_INSTRUCTIONS: Эти личные правила не должны появляться в истории.';
const pathOf = (url: string) => new URL(url).pathname;
const composer = (drawer: Locator) => drawer.locator('#task-comment');
const sendRequest = (drawer: Locator) => drawer.getByRole('button', { name: 'Отправить агенту', exact: true });
const recipient = (drawer: Locator) => drawer.getByRole('combobox', { name: 'Получатель дополнительного запроса', exact: true });

async function readDetail(request: APIRequestContext, taskId: string) {
  const response = await request.get(`/api/tasks/${taskId}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<TaskDetail>;
}
async function waitForStatus(request: APIRequestContext, taskId: string, status: RunStatus) {
  await expect.poll(async () => (await readDetail(request, taskId)).task.latestRun?.status, { timeout: 12_000 }).toBe(status);
  return readDetail(request, taskId);
}
async function createWorker(request: APIRequestContext, index = 0) {
  const response = await request.post('/api/workers', { headers: origin, data: {
    name: unique(`Автор ${index + 1}`), provider: index === 1 ? 'claude' : 'codex', model: null, effort: 'high',
    description: `Публичная роль автора ${index + 1}.`, communicationStyle: privateText, avatarUrl: null,
  } });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Worker>;
}
async function completedTask(request: APIRequestContext, workflow = false) {
  const workers = await Promise.all(Array.from({ length: workflow ? 3 : 1 }, (_, index) => createWorker(request, index)));
  const info = await (await request.get('/api/info')).json() as AppInfo;
  const response = await request.post('/api/tasks', { headers: origin, data: {
    title: unique(workflow ? 'Готовая последовательность' : 'Готовая задача'), instruction: 'Подготовь исходный результат.',
    workerId: workflow ? null : workers[0].id, provider: 'codex', cwd: info.cwd, schedule: 'manual', intervalMinutes: null,
    firstRunAt: null, paused: false, steps: workflow ? workers.map((worker, index) => ({ workerId: worker.id, title: `Этап ${index + 1}`, instruction: `Выполни исходный этап ${index + 1}.` })) : [],
  } });
  expect(response.status()).toBe(201);
  const task = await response.json() as Task;
  expect((await request.post(`/api/tasks/${task.id}/run`, { headers: origin, data: {} })).status()).toBe(201);
  const detail = await waitForStatus(request, task.id, 'completed');
  return { task: detail.task, original: detail.runs[0], workers, detail };
}
async function openTask(page: Page, task: Task, navigate = true) {
  if (navigate) await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await page.getByLabel('Поиск задач', { exact: true }).fill(task.title);
  if (['failed', 'blocked', 'interrupted', 'cancelled'].includes(task.status)) await page.getByRole('button', { name: /Другие статусы/ }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true });
  await expect(composer(drawer)).toBeVisible();
  return drawer;
}
async function postFromComposer(page: Page, drawer: Locator, taskId: string, body: string) {
  await composer(drawer).fill(body);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === `/api/tasks/${taskId}/followups`);
  await sendRequest(drawer).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  return { run: await response.json() as Run, payload: response.request().postDataJSON() as FollowupInput };
}
async function noFreshStart(drawer: Locator) {
  await expect(drawer.getByRole('button', { name: /^(Запустить|Запустить снова|Повторить запуск|Начать всю задачу заново)$/ })).toHaveCount(0);
}
async function noPrivateText(drawer: Locator) {
  await expect(drawer).not.toContainText('PRIVATE_FOLLOWUP_INSTRUCTIONS');
  expect(await drawer.evaluate(node => node.outerHTML)).not.toContain('PRIVATE_FOLLOWUP_INSTRUCTIONS');
  await expect(drawer.getByText('Личные инструкции', { exact: true })).toHaveCount(0);
}

function fixtureDetail(status: RunStatus = 'completed', session = true, followup = false): TaskDetail {
  const worker: Worker = { id: 'followup-worker', name: 'Сохранённый автор', description: 'Проверяет готовые результаты.', provider: 'codex', model: null, effort: 'high', communicationStyle: privateText, avatarUrl: null, archived: false, createdAt: timestamp, updatedAt: timestamp };
  const original: Run = {
    id: 'followup-original-run', taskId: 'followup-fixture-task', workerId: worker.id, worker: { ...worker }, steps: [], currentStepIndex: null,
    instructions: [], provider: worker.provider, cwd: '/workspace/project', instruction: 'Исходная цель.', trigger: 'manual', scheduledFor: null,
    status: 'completed', sessionId: session ? 'mock-codex-followup-session' : null, startedAt: timestamp, updatedAt: timestamp + 1000,
    finishedAt: timestamp + 1000, summary: 'Исходный результат сохранён.', error: null, turn: 1, mock: true,
  };
  const latest: Run = followup ? { ...original, id: 'followup-current-run', trigger: 'followup', status,
    startedAt: timestamp + 2000, updatedAt: timestamp + 3000, finishedAt: ['running', 'waiting_input', 'interrupted'].includes(status) ? null : timestamp + 3000,
    followup: { sourceRunId: original.id, sourceStepIndex: null, request: 'Уточни результат.', workflow: null },
    summary: status === 'completed' ? 'Дополнение готово.' : null, error: ['failed', 'blocked', 'interrupted'].includes(status) ? 'Причина остановки дополнительного запроса.' : null,
  } : { ...original, status };
  const task: Task = {
    id: original.taskId, title: 'Дополнительные запросы в сохранённую сессию', instruction: original.instruction, workerId: worker.id, worker,
    provider: worker.provider, steps: [], cwd: original.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false,
    createdAt: timestamp, updatedAt: latest.updatedAt, nextRunAt: null, status, latestRun: latest, runCount: followup ? 2 : 1,
  };
  return { task, runs: followup ? [latest, original] : [latest], comments: [{ id: 'original-result', taskId: task.id, runId: original.id, stepIndex: null, kind: 'result', body: original.summary!, createdAt: timestamp + 1000 }] };
}
async function fixtureApi(page: Page, details: TaskDetail[], action?: (path: string, body: unknown) => Promise<{ status?: number; json: unknown }>) {
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }], scheduler: 'running', startedAt: timestamp };
  await page.route('**/api/**', async route => {
    const request = route.request(); const path = pathOf(request.url());
    if (request.method() !== 'GET') return route.fulfill(action ? await action(path, request.postDataJSON()) : { status: 405, json: { error: 'Read-only followup fixture' } });
    if (path === '/api/info') return route.fulfill({ json: info });
    if (path === '/api/models' || path === '/api/instructions') return route.fulfill({ json: [] });
    if (path === '/api/workers') return route.fulfill({ json: details.flatMap(detail => detail.task.worker ? [detail.task.worker] : []) });
    if (path === '/api/tasks') return route.fulfill({ json: details.map(detail => detail.task) });
    const detail = details.find(detail => path === `/api/tasks/${detail.task.id}`);
    return route.fulfill(detail ? { json: detail } : { status: 404, json: { error: 'Unknown followup fixture' } });
  });
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/info');
  expect(response.ok()).toBe(true);
  expect((await response.json() as AppInfo).mode, 'Followup browser tests must never invoke paid CLI adapters').toBe('mock');
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-followups.png'), fullPage: true });
});

test('notes remain inert while an explicit request and its answer retain the original session and frozen worker', async ({ page, request }) => {
  const { task, original, workers } = await completedTask(request);
  const drawer = await openTask(page, task);
  await noFreshStart(drawer);
  expect((await request.post(`/api/tasks/${task.id}/run`, { headers: origin, data: {} })).status()).toBe(409);
  const note = 'Просто заметка: не запускать агента.';
  await composer(drawer).fill(note);
  await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
  await expect(drawer.locator('.comment-user').filter({ hasText: note })).toBeVisible();
  let detail = await readDetail(request, task.id);
  expect(detail.runs).toEqual([original]);
  expect(detail.comments.find(comment => comment.body === note)?.runId).toBeNull();
  const edited = await request.patch(`/api/workers/${workers[0].id}`, { headers: origin, data: { name: 'Новый профиль', provider: 'claude', model: 'changed-future-model', effort: 'max', description: 'Новая публичная роль.', communicationStyle: 'PRIVATE_FOLLOWUP_INSTRUCTIONS_EDITED' } });
  expect(edited.ok()).toBe(true);
  expect((await request.patch(`/api/tasks/${task.id}`, { headers: origin, data: { instruction: 'Совершенно новое будущее задание.' } })).ok()).toBe(true);
  const body = '[ask] Уточни исходный результат перед дополнительной работой.';
  const { run, payload } = await postFromComposer(page, drawer, task.id, body);
  expect(payload).toMatchObject({ sourceRunId: original.id, sourceStepIndex: null, body, attachmentIds: [] });
  expect(payload.requestId).toBeTruthy();
  expect(run).toMatchObject({ trigger: 'followup', sessionId: original.sessionId, worker: original.worker, cwd: original.cwd, instruction: original.instruction, steps: [], currentStepIndex: null });
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  await expect(drawer.locator('.comment-question .comment-meta strong')).toHaveText(workers[0].name);
  await expect(sendRequest(drawer)).toBeDisabled();
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Приоритет: точность исходного результата.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  detail = await waitForStatus(request, task.id, 'completed');
  expect(detail.runs).toHaveLength(2);
  expect(detail.runs[1]).toEqual(original);
  expect(detail.runs[0]).toMatchObject({ id: run.id, sessionId: original.sessionId, worker: original.worker, trigger: 'followup', turn: run.turn + 1 });
  expect(detail.runs[0].followup).toMatchObject({ sourceRunId: original.id, sourceStepIndex: null, request: body });
  await noPrivateText(drawer);
  await expect(recipient(drawer).locator('option')).toHaveCount(1);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry')).toHaveCount(2);
  await expect(drawer.locator('.run-entry').first()).toContainText('Дополнительный запрос');
  await expect(drawer.locator('.run-entry').first()).toContainText(body);
  await noPrivateText(drawer);
});

test('an attachment-only request binds the original bytes to the new run without changing the original result', async ({ page, request }) => {
  const { task, original } = await completedTask(request);
  const drawer = await openTask(page, task);
  const file = { name: 'дополнение.txt', mimeType: 'text/plain', buffer: Buffer.from('Дополнительные исходные данные.\n', 'utf8') };
  const uploadPromise = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === '/api/uploads');
  const files = drawer.getByRole('region', { name: 'Файлы заметки', exact: true });
  await files.locator('input[type="file"]').setInputFiles(file);
  const uploadResponse = await uploadPromise;
  expect(uploadResponse.status()).toBe(201);
  const attachment = await uploadResponse.json() as Attachment;
  await expect(files.locator('.attachment-name')).toHaveText(file.name);
  await expect(composer(drawer)).toHaveValue('');
  await expect(sendRequest(drawer)).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && pathOf(response.url()) === `/api/tasks/${task.id}/followups`);
  await sendRequest(drawer).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ sourceRunId: original.id, sourceStepIndex: null, attachmentIds: [attachment.id] });
  const run = await response.json() as Run;
  const detail = await waitForStatus(request, task.id, 'completed');
  expect(detail.runs).toHaveLength(2);
  expect(detail.runs[1]).toEqual(original);
  expect(detail.runs[0].inputAttachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: attachment.id, taskId: task.id, runId: run.id, name: file.name, size: file.buffer.byteLength })]));
  const originalBytes = await request.get(`/api/tasks/${task.id}/attachments/${attachment.id}?download=1`);
  expect(originalBytes.ok()).toBe(true);
  expect(await originalBytes.body()).toEqual(file.buffer);
  await expect(files.locator('.attachment-name')).toHaveCount(0);
  await expect(drawer.locator('.comment-user .attachment-name').filter({ hasText: file.name })).toBeVisible();
});

test('retrying a lost accepted response uses the same request identity and never starts a second turn', async ({ page, request }) => {
  const { task, original } = await completedTask(request);
  const drawer = await openTask(page, task);
  const writes: FollowupInput[] = [];
  let acceptedId = '';
  await page.route(`**/api/tasks/${task.id}/followups`, async route => {
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      acceptedId = (await response.json() as Run).id;
      await route.fulfill({ status: 503, json: { error: 'Ответ потерян после сохранения запроса.' } });
    } else await route.continue();
  });
  const body = 'Добавь краткий вывод к готовому результату.';
  await composer(drawer).fill(body);
  await sendRequest(drawer).click();
  await expect(drawer.getByRole('alert').filter({ hasText: 'Ответ потерян после сохранения запроса.' })).toBeVisible();
  await expect(composer(drawer)).toHaveValue(body);
  await waitForStatus(request, task.id, 'completed');
  await expect(sendRequest(drawer)).toBeEnabled();
  await sendRequest(drawer).click();
  await expect(composer(drawer)).toHaveValue('');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  const detail = await readDetail(request, task.id);
  expect(detail.runs.map(run => run.id)).toEqual([acceptedId, original.id]);
  expect(detail.comments.filter(comment => comment.kind === 'user' && comment.body === body)).toHaveLength(1);
});

test('a delayed request locks duplicate submission and dismissal until it is safe to navigate', async ({ page }) => {
  const first = fixtureDetail();
  const second = fixtureDetail();
  second.task = { ...second.task, id: 'other-followup-task', title: 'Другая задача', latestRun: { ...second.runs[0], id: 'other-followup-run', taskId: 'other-followup-task' } };
  second.runs = [second.task.latestRun!]; second.comments = [];
  const calls: FollowupInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  await fixtureApi(page, [first, second], async (path, body) => {
    expect(path).toBe(`/api/tasks/${first.task.id}/followups`);
    calls.push(body as FollowupInput); await gate;
    return { status: 201, json: { ...first.runs[0], id: 'delayed-followup-run', trigger: 'followup', followup: { sourceRunId: first.runs[0].id, sourceStepIndex: null, request: (body as FollowupInput).body, workflow: null } } };
  });
  const drawer = await openTask(page, first.task);
  await composer(drawer).fill('Дополнение первой задаче.');
  await sendRequest(drawer).click();
  await expect.poll(() => calls.length).toBe(1);
  const sending = drawer.getByRole('button', { name: 'Отправляем…', exact: true });
  const close = drawer.getByRole('button', { name: 'Закрыть задачу', exact: true });
  await expect(sending).toBeDisabled();
  await expect(close).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Сохранить заметку', exact: true })).toBeDisabled();
  await sending.evaluate(button => (button as HTMLButtonElement).click());
  await page.keyboard.press('Escape');
  await expect(drawer).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(drawer).toBeVisible();
  const responsePromise = page.waitForResponse(response => pathOf(response.url()) === `/api/tasks/${first.task.id}/followups`);
  release(); await responsePromise;
  await expect(close).toBeEnabled();
  await close.click();
  const other = await openTask(page, second.task, false);
  await composer(other).fill('Черновик другой задачи должен остаться.');
  await expect(other).toBeVisible();
  await expect(composer(other)).toHaveValue('Черновик другой задачи должен остаться.');
  expect(calls).toHaveLength(1);
  await expect(other).not.toContainText('Дополнение первой задаче.');
});

for (const state of ['no-run', 'missing-session'] as const) {
  test(`${state} disables agent requests but allows an ordinary note`, async ({ page }) => {
    const detail = fixtureDetail('completed', false);
    if (state === 'no-run') { detail.task = { ...detail.task, status: 'ready', latestRun: null, runCount: 0 }; detail.runs = []; detail.comments = []; }
    const calls: { path: string; body: unknown }[] = [];
    await fixtureApi(page, [detail], async (path, body) => { calls.push({ path, body }); return { status: 503, json: { error: 'Заметка доступна независимо от сессии.' } }; });
    const drawer = await openTask(page, detail.task);
    await composer(drawer).fill('Это только заметка.');
    if (state === 'no-run') await expect(sendRequest(drawer)).toHaveCount(0);
    else { await expect(sendRequest(drawer)).toBeDisabled(); await noFreshStart(drawer); }
    await expect(drawer.getByRole('button', { name: 'Сохранить заметку', exact: true })).toBeEnabled();
    await drawer.getByRole('button', { name: 'Сохранить заметку', exact: true }).click();
    await expect(drawer.getByRole('alert').filter({ hasText: 'Заметка доступна независимо от сессии.' })).toBeVisible();
    expect(calls).toEqual([{ path: `/api/tasks/${detail.task.id}/comments`, body: { body: 'Это только заметка.', attachmentIds: [] } }]);
  });
}

test('last and earlier workflow recipients preserve every original completed stage and attempt', async ({ page, request }, testInfo) => {
  const { task, original, workers } = await completedTask(request, true);
  const drawer = await openTask(page, task);
  await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(3);
  await expect(recipient(drawer).locator('option')).toHaveCount(3);
  await expect(recipient(drawer).locator('option:checked')).toContainText(workers[2].name);
  const last = await postFromComposer(page, drawer, task.id, 'Добавь вывод от последнего работника.');
  expect(last.payload).toMatchObject({ sourceRunId: original.id, sourceStepIndex: 2 });
  await waitForStatus(request, task.id, 'completed');
  await expect(sendRequest(drawer)).toBeDisabled(); // Empty composer, regardless of the next poll.
  await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(3);
  await expect(recipient(drawer).locator('option')).toHaveCount(3); // Same sessions are deduplicated after a followup.
  const prior = recipient(drawer).locator('option').filter({ hasText: workers[0].name });
  const priorValue = await prior.getAttribute('value');
  expect(priorValue).toBeTruthy();
  await recipient(drawer).selectOption(priorValue!);
  const first = await postFromComposer(page, drawer, task.id, 'Уточни данные первого этапа.');
  expect(first.payload).toMatchObject({ sourceRunId: original.id, sourceStepIndex: 0 });
  const detail = await waitForStatus(request, task.id, 'completed');
  expect(detail.runs).toHaveLength(3);
  expect(detail.runs[2]).toEqual(original);
  for (const [index, stage] of [[1, 2], [0, 0]] as const) {
    expect(detail.runs[index]).toMatchObject({ trigger: 'followup', sessionId: original.steps[stage].sessionId, worker: original.steps[stage].worker, steps: [], currentStepIndex: null });
    expect(detail.runs[index].followup?.workflow?.steps).toEqual(original.steps);
  }
  await expect(drawer.locator('.current-followup .followup-request')).toHaveText('Уточни данные первого этапа.');
  await expect(recipient(drawer).locator('option:checked')).toContainText(workers[0].name);
  // A request after that completed followup is scalar, even though it displays frozen workflow context.
  const further = await postFromComposer(page, drawer, task.id, 'Ещё одно уточнение первому работнику.');
  expect(further.payload).toMatchObject({ sourceRunId: first.run.id, sourceStepIndex: null });
  const final = await waitForStatus(request, task.id, 'completed');
  expect(final.runs).toHaveLength(4);
  expect(final.runs[3]).toEqual(original);
  expect(final.runs[0]).toMatchObject({ sessionId: original.steps[0].sessionId, worker: original.steps[0].worker, steps: [], currentStepIndex: null });
  expect(final.runs[0].followup?.workflow?.steps).toEqual(original.steps);
  await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(3);
  await noPrivateText(drawer);
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  const oldHistory = drawer.locator('.run-entry').last();
  await expect(oldHistory.locator('[data-status="completed"]')).toHaveCount(3);
  await expect(oldHistory).toContainText('3 из 3 этапов завершено');
  await oldHistory.screenshot({ path: testInfo.outputPath('followup-original-workflow-unchanged.png') });
});

for (const status of ['failed', 'blocked'] as const) {
  test(`a ${status} followup is terminal and never restores a fresh manual start`, async ({ page, request }) => {
    const { task, original } = await completedTask(request);
    let drawer = await openTask(page, task);
    const sent = await postFromComposer(page, drawer, task.id, `${status === 'failed' ? '[fail]' : '[blocked]'} Проверь дополнительный результат.`);
    const detail = await waitForStatus(request, task.id, status);
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[1]).toEqual(original);
    expect(detail.runs[0]).toMatchObject({ id: sent.run.id, sessionId: original.sessionId, trigger: 'followup' });
    await expect(drawer.locator('.run-error')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Повторить текущий этап', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Продолжить работу', exact: true })).toHaveCount(0);
    await expect(drawer.locator('.workflow-retry-panel')).toHaveCount(0);
    await noFreshStart(drawer);
    expect((await request.post(`/api/tasks/${task.id}/run`, { headers: origin, data: {} })).status()).toBe(409);
    await noPrivateText(drawer);
    // Reload must use the persisted completed-run flag even though the latest run failed.
    drawer = await openTask(page, detail.task);
    await noFreshStart(drawer);
    await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    const card = page.locator('.task-card').filter({ has: page.getByRole('button', { name: `Открыть задачу: ${task.title}`, exact: true }) });
    await expect(card.locator('.card-run')).toHaveCount(0);
  });
}

test('cancelling a later question preserves completion history and cannot restart the task', async ({ page, request }) => {
  const { task, original } = await completedTask(request);
  const drawer = await openTask(page, task);
  await postFromComposer(page, drawer, task.id, '[ask] Уточни вариант для дополнения.');
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Отменено', { exact: true })).toBeVisible();
  const detail = await waitForStatus(request, task.id, 'cancelled');
  expect(detail.runs[1]).toEqual(original);
  await noFreshStart(drawer);
  expect((await request.post(`/api/tasks/${task.id}/run`, { headers: origin, data: {} })).status()).toBe(409);
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  const row = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `Открыть: ${task.title}`, exact: true }) });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /^(Запустить|Начать заново):/ })).toHaveCount(0);
});

for (const action of ['resume', 'cancel'] as const) {
  test(`interrupted followup requires stopped-process acknowledgement before ${action}`, async ({ page }) => {
    const detail = fixtureDetail('interrupted', true, true);
    const calls: { path: string; body: unknown }[] = [];
    await fixtureApi(page, [detail], async (path, body) => { calls.push({ path, body }); return { status: 503, json: { error: 'Тестовая остановка после подтверждения.' } }; });
    const drawer = await openTask(page, detail.task);
    const resume = drawer.getByRole('button', { name: 'Продолжить работу', exact: true });
    const cancel = drawer.getByRole('button', { name: 'Отменить запуск', exact: true });
    await expect(resume).toBeDisabled(); await expect(cancel).toBeDisabled();
    await drawer.getByLabel('Я проверил(а), что предыдущий процесс CLI остановлен', { exact: true }).check();
    await expect(resume).toBeEnabled(); await expect(cancel).toBeEnabled();
    await (action === 'resume' ? resume : cancel).click();
    await expect(drawer.getByRole('alert').filter({ hasText: 'Тестовая остановка после подтверждения.' })).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: `/api/runs/${detail.runs[0].id}/${action}`, body: { acknowledgeInterruption: true } });
    await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
    await expect(resume).toBeDisabled(); await expect(cancel).toBeDisabled();
  });
}


test('an interrupted followup without a session can only be cancelled after acknowledging the stopped process', async ({ page }) => {
  const detail = fixtureDetail('interrupted', false, true);
  const calls: { path: string; body: unknown }[] = [];
  await fixtureApi(page, [detail], async (path, body) => { calls.push({ path, body }); return { status: 503, json: { error: 'Подтверждение отмены получено.' } }; });
  const drawer = await openTask(page, detail.task);
  await expect(drawer.locator('.resume-warning')).toContainText('Идентификатор сессии не сохранён.');
  await expect(drawer.getByRole('button', { name: 'Продолжить работу', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Повторить текущий этап', exact: true })).toHaveCount(0);
  const cancel = drawer.getByRole('button', { name: 'Отменить запуск', exact: true });
  await expect(cancel).toBeDisabled();
  await drawer.getByLabel('Я проверил(а), что предыдущий процесс CLI остановлен', { exact: true }).check();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(drawer.getByRole('alert').filter({ hasText: 'Подтверждение отмены получено.' })).toBeVisible();
  expect(calls).toEqual([{ path: `/api/runs/${detail.runs[0].id}/cancel`, body: { acknowledgeInterruption: true } }]);
});
