import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { AppInfo, Run, RunStatus, RunStep, Task, TaskDetail, Worker } from '../src/lib/types';
import { modelPresets, modelLabel } from '../src/lib/workers';

const origin = { Origin: 'http://127.0.0.1:4318' };
const unique = (title: string) => `${title} ${crypto.randomUUID().slice(0, 8)}`;
const timestamp = Date.UTC(2026, 8, 4, 12);
function worker(id: string, provider: 'codex' | 'claude' = 'codex'): Worker {
  return { id, name: `Работник ${id}`, provider, model: modelPresets[provider][0].id, effort: 'high', communicationStyle: `Стиль ${id}`, avatarUrl: null, archived: false, createdAt: timestamp, updatedAt: timestamp };
}
const fixtureWorkers = [worker('аналитик'), worker('редактор', 'claude'), worker('проверяющий')];
function fixtureDetail(status: RunStatus = 'waiting_input', session = true): TaskDetail {
  const steps: RunStep[] = fixtureWorkers.map((profile, index) => {
    const stepStatus = index === 0 ? 'completed' : index === 1 ? status : 'pending';
    const startedAt = index < 2 ? timestamp : null;
    const sessionId = index === 0 || (index === 1 && session) ? `mock-${profile.provider}-step-${index}` : null;
    return {
      workerId: profile.id, worker: { ...profile }, title: `Этап ${index + 1}`, instruction: `Сохранённое задание ${index + 1}`, status: stepStatus,
      sessionId, startedAt, updatedAt: timestamp, finishedAt: index === 0 ? timestamp : null,
      summary: index === 0 ? 'Первый этап действительно завершён.' : null,
      error: index === 1 && ['failed', 'blocked', 'interrupted'].includes(status) ? 'Проверьте причину остановки.' : null,
      attempts: startedAt ? [{ id: `attempt-${index}`, number: 1, status: stepStatus as RunStatus, sessionId, turn: 1, startedAt, updatedAt: timestamp, finishedAt: index === 0 ? timestamp : null, summary: null, error: null }] : [],
    };
  });
  const run: Run = { id: 'workflow-run', taskId: 'workflow-task', steps, currentStepIndex: 1, instructions: [{ id: 'guide', title: 'Правило запуска', body: 'Только сохранённые правила.' }], workerId: steps[1].workerId, worker: steps[1].worker, provider: 'claude', cwd: '/workspace/project', instruction: 'Общая сохранённая цель', trigger: 'manual', scheduledFor: null, status, sessionId: steps[1].sessionId, startedAt: timestamp, updatedAt: timestamp, finishedAt: null, summary: null, error: steps[1].error, turn: 1, mock: true };
  const task: Task = { id: run.taskId, workerId: null, worker: null, steps: steps.map(({ workerId, title, instruction }) => ({ workerId, title, instruction })), title: 'Сложная задача для проверки', instruction: run.instruction, provider: 'codex', cwd: run.cwd, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, createdAt: timestamp, updatedAt: timestamp, nextRunAt: null, status, latestRun: run, runCount: 1 };
  return { task, runs: [run], comments: [{ id: 'old-result', taskId: task.id, runId: run.id, stepIndex: 0, kind: 'result', body: 'Первый работник уже закончил.', createdAt: timestamp }, { id: 'question', taskId: task.id, runId: run.id, stepIndex: 1, kind: 'question', body: 'Какой вариант выбрать?', createdAt: timestamp }] };
}
async function fixtures(page: Page, detail: TaskDetail, options: { workers?: Worker[]; others?: TaskDetail[]; action?: (path: string, body: unknown) => Promise<{ status?: number; json: unknown }> } = {}) {
  const info: AppInfo = { mode: 'mock', cwd: '/workspace/project', providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }], scheduler: 'running', startedAt: timestamp };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      const result = options.action ? await options.action(path, request.postDataJSON()) : { status: 405, json: { error: 'Read-only workflow fixture' } };
      await route.fulfill(result); return;
    }
    if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/workers') await route.fulfill({ json: options.workers ?? fixtureWorkers });
    else if (path === '/api/tasks') await route.fulfill({ json: [detail.task, ...(options.others ?? []).map(item => item.task)] });
    else if (path === `/api/tasks/${detail.task.id}`) await route.fulfill({ json: detail });
    else if (options.others?.some(item => path === `/api/tasks/${item.task.id}`)) await route.fulfill({ json: options.others.find(item => path === `/api/tasks/${item.task.id}`) });
    else await route.fulfill({ status: 404, json: { error: 'Unknown workflow fixture' } });
  });
}
async function openFixture(page: Page, detail: TaskDetail) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  if (['failed', 'blocked', 'cancelled', 'interrupted'].includes(detail.task.status)) await page.getByRole('button', { name: /Другие статусы/ }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: detail.task.title, exact: true });
  await expect(drawer.locator('.current-workflow .workflow-run-step')).toHaveCount(3);
  return drawer;
}
async function createWorkers(request: APIRequestContext) {
  return Promise.all(['Исследователь', 'Исполнитель', 'Проверяющий'].map(async (name, index) => {
    const response = await request.post('/api/workers', { headers: origin, data: { name: unique(name), provider: index === 1 ? 'claude' : 'codex', model: modelPresets[index === 1 ? 'claude' : 'codex'][0].id, effort: 'high', communicationStyle: 'Сначала результат.', avatarUrl: null } });
    expect(response.ok()).toBe(true); return response.json() as Promise<Worker>;
  }));
}
async function noOverflow(page: Page, dialog: Locator) {
  const documentSize = await page.evaluate(() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
  expect(documentSize.contentWidth, 'document content must fit the viewport').toBeLessThanOrEqual(documentSize.width + 1);
  const size = await dialog.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const overflow = [...node.querySelectorAll<HTMLElement>('*')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1);
    }).slice(0, 8).map(element => `${element.tagName.toLowerCase()}.${element.className}`);
    return { width: node.clientWidth, contentWidth: node.scrollWidth, overflow };
  });
  expect(size.contentWidth, `dialog contents must fit; overflowing descendants: ${size.overflow.join(', ')}`).toBeLessThanOrEqual(size.width + 1);
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/info');
  expect(response.ok()).toBe(true);
  expect((await response.json()).mode, 'Workflow browser tests must never invoke paid CLI adapters').toBe('mock');
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await page.screenshot({ path: testInfo.outputPath('brigd-workflow.png'), fullPage: true });
});

test('complex editor orders named workers, resumes exact middle session and freezes the run', async ({ page, request }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const workers = await createWorkers(request);
  const title = unique('Последовательная работа');
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.locator('[name="title"]').fill(title);
  await editor.locator('[name="instruction"]').fill('Подготовь результат по шагам.');
  await editor.getByRole('button', { name: 'Сложная задача', exact: true }).click();
  await expect(editor.locator('.provider-options')).toHaveCount(0);
  await editor.locator('[name="step-title-0"]').fill('Исследование');
  await editor.locator('[name="step-worker-0"]').selectOption(workers[0].id);
  await editor.locator('[name="step-instruction-0"]').fill('Проверь исходные данные.');
  await editor.locator('[name="step-title-1"]').fill('Исполнение');
  await editor.locator('[name="step-worker-1"]').selectOption(workers[1].id);
  await expect(editor.locator('.workflow-assignment').nth(1)).toContainText(modelLabel(workers[1].model));
  await editor.locator('[name="step-instruction-1"]').fill('[ask] Уточни нужный вариант.');
  await editor.getByRole('button', { name: 'Добавить этап', exact: true }).click();
  await editor.locator('[name="step-title-2"]').fill('Проверка');
  await editor.locator('[name="step-worker-2"]').selectOption(workers[2].id);
  await editor.locator('[name="step-instruction-2"]').fill('Проверь итоговый результат.');
  await editor.getByRole('button', { name: 'Поднять этап 3', exact: true }).click();
  await expect(editor.locator('[name="step-title-1"]')).toHaveValue('Проверка');
  await expect(editor.locator('[name="step-title-1"]')).toBeFocused();
  await editor.getByRole('button', { name: 'Опустить этап 2', exact: true }).click();
  await expect(editor.locator('[name="step-title-2"]')).toHaveValue('Проверка');
  await editor.getByRole('button', { name: 'Добавить этап', exact: true }).click();
  await editor.getByRole('button', { name: 'Удалить этап 4', exact: true }).click();
  await expect(editor.locator('.workflow-draft-step')).toHaveCount(3);
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await expect(drawer.locator('.workflow-template')).toContainText(workers[2].name);
  await drawer.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(drawer.getByText('Агенту нужен ваш ответ', { exact: true })).toBeVisible();
  const checklist = drawer.locator('.current-workflow');
  await expect(checklist.locator('[data-status="completed"]')).toHaveCount(1);
  await expect(checklist.locator('[data-status="waiting_input"]')).toHaveCount(1);
  await expect(checklist.locator('[data-status="pending"]')).toHaveCount(1);
  await expect(checklist.getByRole('checkbox')).toHaveCount(0);
  await expect(drawer.locator('.resume-panel')).toContainText(workers[1].name);
  await expect(drawer.locator('.comment-question .comment-meta strong')).toHaveText(workers[1].name);
  const saved = (await (await request.get('/api/tasks')).json() as Task[]).find(task => task.title === title)!;
  const original = saved.latestRun!;
  expect(original.steps[0].status).toBe('completed');
  const originalSession = original.steps[1].sessionId;
  expect(originalSession).toBeTruthy();
  const renamed = unique('Обновлённый работник');
  await request.patch(`/api/workers/${workers[1].id}`, { headers: origin, data: { name: renamed, model: 'custom-model-after-edit', communicationStyle: 'Новый стиль.' } });
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await expect(edit.getByText(/Изменения применятся к следующему запуску/)).toBeVisible();
  await edit.locator('[name="step-instruction-2"]').fill('Изменённое задание для будущего запуска.');
  await edit.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  // The underlying drawer is visible while the nested editor is still modal.
  // Wait for successful dismissal before typing into its otherwise inert textarea.
  await expect(edit).not.toBeVisible();
  await expect(drawer.locator('.resume-panel')).toContainText(workers[1].name);
  await expect(checklist.locator('.workflow-step-worker').nth(1)).toContainText(modelLabel(workers[1].model));
  await expect(checklist).not.toContainText('custom-model-after-edit');
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Выбираю первый вариант.');
  await expect(drawer.getByLabel('Ответ агенту', { exact: true })).toHaveValue('Выбираю первый вариант.');
  await expect(drawer.getByRole('button', { name: 'Продолжить работу', exact: true })).toBeEnabled();
  let attempts = 0;
  await page.route(`**/api/runs/${original.id}/resume`, async route => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { error: 'Временная ошибка отправки ответа.' } });
    else await route.continue();
  });
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Временная ошибка отправки ответа.');
  await expect(drawer.getByLabel('Ответ агенту', { exact: true })).toHaveValue('Выбираю первый вариант.');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await expect(drawer.locator('.drawer-badges').getByText('Завершено', { exact: true })).toBeVisible();
  await expect(checklist.locator('[data-status="completed"]')).toHaveCount(3);
  await expect(drawer.getByRole('button', { name: 'Начать всю задачу заново', exact: true })).toBeEnabled();
  const final = await (await request.get(`/api/tasks/${saved.id}`)).json() as TaskDetail;
  expect(final.runs[0].id).toBe(original.id);
  expect(final.runs[0].steps[1].sessionId).toBe(originalSession);
  expect(final.runs[0].steps[1].worker.name).toBe(workers[1].name);
  expect(final.runs[0].steps[1].worker.model).toBe(workers[1].model);
  expect(final.runs[0].steps[2].instruction).toBe('Проверь итоговый результат.');
  await drawer.getByRole('tab', { name: /Запуски/ }).click();
  await expect(drawer.locator('.run-entry .workflow-checklist')).toContainText('3 из 3 этапов завершено');
  await expect(drawer.locator('.run-entry .workflow-step-worker').nth(1)).toContainText(modelLabel(workers[1].model));
  await drawer.locator('.run-entry .workflow-step-snapshot').nth(1).locator('summary').click();
  await expect(drawer.locator('.run-entry .workflow-step-snapshot').nth(1)).toContainText(workers[1].model!);
  await drawer.locator('.run-entry .workflow-step-snapshot').nth(2).locator('summary').click();
  await expect(drawer.locator('.run-entry .workflow-step-instruction').nth(2)).toHaveText('Проверь итоговый результат.');
  await drawer.screenshot({ path: testInfo.outputPath('workflow-frozen-history.png') });
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByLabel('Поиск задач', { exact: true }).fill(workers[0].name);
  await page.getByLabel('Фильтр по агенту', { exact: true }).selectOption('claude');
  await expect(page.getByRole('button', { name: `Открыть задачу: ${title}`, exact: true })).toContainText('3 из 3 этапов завершено');
  expect(errors).toEqual([]);
});

for (const status of ['failed', 'blocked'] as const) {
  test(`${status} preserves completed steps and offers an explicit retry, then cancellation before a fresh run`, async ({ page }) => {
    const detail = fixtureDetail(status); const calls: { path: string; body: unknown }[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    await fixtures(page, detail, { action: async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith('/retry')) { await gate; return { status: 503, json: { error: 'Повтор пока недоступен.' } }; }
      if (path.endsWith('/cancel')) {
        const run = detail.task.latestRun!; run.status = 'cancelled'; detail.task.status = 'cancelled';
        run.steps[1].status = 'cancelled'; run.steps[2].status = 'cancelled';
        return { json: run };
      }
      return { status: 409, json: { error: 'Unexpected action' } };
    } });
    const drawer = await openFixture(page, detail);
    await expect(drawer.getByRole('button', { name: 'Начать всю задачу заново', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Запустить снова', exact: true })).toHaveCount(0);
    await expect(drawer.locator('.workflow-retry-panel')).toContainText('могут повториться');
    if (status === 'blocked') await expect(drawer.locator('.workflow-retry-panel')).toContainText('не предоставляет агенту дополнительных разрешений');
    const retry = drawer.getByRole('button', { name: 'Повторить текущий этап', exact: true });
    await retry.click();
    await expect(drawer.getByRole('button', { name: 'Запускаем…', exact: true })).toBeDisabled();
    await drawer.locator('.workflow-retry-panel button').evaluate(button => { (button as HTMLButtonElement).click(); });
    release();
    await expect(drawer.getByRole('alert').filter({ hasText: 'Повтор пока недоступен.' })).toBeVisible();
    expect(calls).toEqual([{ path: '/api/runs/workflow-run/retry', body: {} }]);
    await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(1);
    await expect(drawer.locator('.current-workflow [data-status="pending"]')).toHaveCount(1);
    await drawer.getByRole('button', { name: 'Отменить запуск', exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'Начать всю задачу заново', exact: true })).toBeEnabled();
    await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(1);
    await expect(drawer.locator('.current-workflow [data-status="cancelled"]')).toHaveCount(2);
  });
}

for (const session of [true, false]) {
  test(`interrupted workflow ${session ? 'resumes saved session' : 'retries missing session'} only after acknowledgement`, async ({ page }) => {
    const detail = fixtureDetail('interrupted', session); const calls: { path: string; body: unknown }[] = [];
    await fixtures(page, detail, { action: async (path, body) => { calls.push({ path, body }); return { status: 503, json: { error: 'Ожидаем повторного подключения.' } }; } });
    const drawer = await openFixture(page, detail);
    const action = drawer.getByRole('button', { name: session ? 'Продолжить работу' : 'Повторить текущий этап', exact: true });
    await expect(action).toBeDisabled();
    await expect(drawer.getByRole('button', { name: 'Отменить запуск', exact: true })).toBeDisabled();
    await drawer.getByLabel('Я проверил(а), что предыдущий процесс CLI остановлен', { exact: true }).check();
    await expect(action).toBeEnabled();
    await expect(drawer.getByRole('button', { name: 'Отменить запуск', exact: true })).toBeEnabled();
    await action.click();
    await expect(drawer.getByRole('alert').filter({ hasText: 'Ожидаем повторного подключения.' })).toBeVisible();
    expect(calls[0].path).toBe(`/api/runs/workflow-run/${session ? 'resume' : 'retry'}`);
    expect(calls[0].body).toMatchObject({ acknowledgeInterruption: true });
    await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
    await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
    await expect(action).toBeDisabled();
    await expect(drawer.getByLabel('Я проверил(а), что предыдущий процесс CLI остановлен', { exact: true })).not.toBeChecked();
  });
}

test('interrupted cancellation requires acknowledgement and does not imply later steps will resume', async ({ page }) => {
  const detail = fixtureDetail('interrupted'); detail.runs[0].steps[2].status = 'cancelled';
  const calls: { path: string; body: unknown }[] = [];
  await fixtures(page, detail, { action: async (path, body) => {
    calls.push({ path, body }); detail.task.status = 'cancelled'; detail.runs[0].status = 'cancelled'; detail.runs[0].steps[1].status = 'cancelled';
    return { json: detail.runs[0] };
  } });
  const drawer = await openFixture(page, detail);
  await expect(drawer.getByText('Отмена уже запрошена. Продолжение касается только текущего этапа; остальные этапы отменены.', { exact: true })).toBeVisible();
  const cancel = drawer.getByRole('button', { name: 'Отменить запуск', exact: true });
  await expect(cancel).toBeDisabled();
  await drawer.getByLabel('Я проверил(а), что предыдущий процесс CLI остановлен', { exact: true }).check();
  await cancel.click();
  await expect(drawer.getByRole('button', { name: 'Начать всю задачу заново', exact: true })).toBeEnabled();
  expect(calls).toEqual([{ path: '/api/runs/workflow-run/cancel', body: { acknowledgeInterruption: true } }]);
  await expect(drawer.locator('.current-workflow [data-status="completed"]')).toHaveCount(1);
});

test('late response does not clear another task’s newer answer draft', async ({ page }) => {
  const detail = fixtureDetail(); let release!: () => void;
  const other = fixtureDetail(); other.task.id = 'second-task'; other.task.title = 'Другая сложная задача';
  other.runs[0].id = 'second-run'; other.runs[0].taskId = other.task.id;
  const gate = new Promise<void>(resolve => release = resolve); let requests = 0;
  await fixtures(page, detail, { others: [other], action: async () => { requests++; await gate; return { json: detail.task.latestRun }; } });
  const drawer = await openFixture(page, detail);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Старый ответ');
  await drawer.getByRole('button', { name: 'Продолжить работу', exact: true }).click();
  await drawer.getByRole('button', { name: 'Закрыть задачу', exact: true }).click();
  await page.getByRole('button', { name: `Открыть задачу: ${other.task.title}`, exact: true }).click();
  const newer = page.getByRole('dialog', { name: other.task.title, exact: true });
  await expect(newer.getByLabel('Ответ агенту', { exact: true })).toBeEnabled();
  await newer.getByLabel('Ответ агенту', { exact: true }).fill('Новый черновик');
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/tasks/second-task') && response.request().method() === 'GET');
  release();
  await refreshed;
  await expect(newer.getByText('Ответ отправлен, агент продолжает работу', { exact: true })).toHaveCount(0);
  await expect(newer.getByLabel('Ответ агенту', { exact: true })).toHaveValue('Новый черновик');
  expect(requests).toBe(1);
});

test('empty workers guidance, editor cancellation and save errors preserve the draft', async ({ page }) => {
  const detail = fixtureDetail(); let saves = 0;
  await fixtures(page, detail, { workers: [], action: async () => { saves++; return { status: 400, json: { error: 'Не удалось сохранить план.' } }; } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Новая задача', exact: true });
  await editor.getByRole('button', { name: 'Сложная задача', exact: true }).click();
  await expect(editor.getByText(/Создайте хотя бы одного работника/)).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Создать задачу', exact: true })).toBeEnabled();
  await editor.locator('[name="title"]').fill('Несохранённая задача');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(saves).toBe(0);
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(editor.locator('[name="title"]')).toHaveValue('');
  await expect(editor.getByRole('button', { name: 'Простая задача', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.locator('[name="title"]').fill('Сохранить черновик');
  await editor.locator('[name="instruction"]').fill('Данные останутся при ошибке.');
  await editor.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Не удалось сохранить план.');
  await expect(editor.locator('[name="title"]')).toHaveValue('Сохранить черновик');
  expect(saves).toBe(1);
});

test('complex save is single-flight, retains draft on errors and prevents dismissal in flight', async ({ page }) => {
  const detail = fixtureDetail(); let saves = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  await fixtures(page, detail, { action: async () => { saves++; await gate; return { status: 503, json: { error: 'План не сохранён. Попробуйте ещё раз.' } }; } });
  const drawer = await openFixture(page, detail);
  await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
  await editor.locator('[name="step-title-1"]').fill('Исправленный второй этап');
  await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
  await editor.locator('form').evaluate(form => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  release();
  await expect(editor.getByRole('alert')).toContainText('План не сохранён. Попробуйте ещё раз.');
  await expect(editor.locator('[name="step-title-1"]')).toHaveValue('Исправленный второй этап');
  await expect(editor.locator('.workflow-draft-step')).toHaveCount(3);
  expect(saves).toBe(1);
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Изменить', exact: true })).toBeFocused();
});

test('task navigation stays available without removed slogans, heading or agent promotion blocks', async ({ page }) => {
  await fixtures(page, fixtureDetail()); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Задачи', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Все задачи', exact: true })).toHaveCount(0);
  for (const text of ['ВАШИ АГЕНТЫ', 'Всё на вашем компьютере', 'Локальная база и агенты.', 'МЕНЬШЕ РУТИНЫ. БОЛЬШЕ СДЕЛАННОГО.', 'Дайте агентам задачу. Остальное держите в поле зрения.']) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  await expect(page.locator('.agent-nav')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
});

for (const theme of ['light', 'dark']) {
  for (const size of [{ width: 390, height: 844, font: 13 }, { width: 320, height: 640, font: 26 }]) {
    test(`${theme} workflow checklist and editor fit ${size.width}px at ${size.font}px`, async ({ page }, testInfo) => {
      const detail = fixtureDetail('blocked');
      detail.runs[0].steps[1].title = 'ДлинноеНазваниеЭтапа'.repeat(20);
      detail.runs[0].steps[1].worker.name = 'ДлинноеИмяРаботника'.repeat(20);
      detail.runs[0].steps[1].worker.model = 'm'.repeat(128);
      detail.task.steps[1].title = detail.runs[0].steps[1].title;
      await fixtures(page, detail, { workers: fixtureWorkers.map(profile => profile.id === detail.runs[0].steps[1].workerId ? { ...profile, model: 'm'.repeat(128) } : profile) }); await page.setViewportSize(size);
      await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
      const drawer = await openFixture(page, detail);
      await page.addStyleTag({ content: `html { font-size: ${size.font}px !important; }` });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(drawer.locator('.current-workflow .worker-model-label').nth(1)).toContainText('m'.repeat(128));
      await noOverflow(page, drawer);
      // Frozen worker names also appear below the checklist in comment authors.
      // Verify that area directly rather than only the top of the drawer.
      const author = drawer.locator('.comment-question .comment-meta strong');
      await author.scrollIntoViewIfNeeded();
      await expect(author).toBeInViewport();
      await noOverflow(page, drawer);
      await drawer.locator('.current-workflow .workflow-step-snapshot').nth(1).locator('summary').click();
      await noOverflow(page, drawer);
      await drawer.getByRole('button', { name: 'Повторить текущий этап', exact: true }).scrollIntoViewIfNeeded();
      await expect(drawer.getByRole('button', { name: 'Повторить текущий этап', exact: true })).toBeInViewport();
      await drawer.screenshot({ path: testInfo.outputPath(`workflow-${theme}-${size.width}-checklist.png`) });
      await drawer.getByRole('button', { name: 'Изменить', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Редактировать задачу', exact: true });
      await expect(editor.locator('.workflow-assignment .worker-model-label').nth(1)).toContainText('m'.repeat(128));
      for (const avatar of await editor.locator('.workflow-assignment .worker-avatar').all()) {
        const box = await avatar.boundingBox();
        expect(box?.width).toBe(24);
        expect(box?.height).toBe(24);
      }
      await noOverflow(page, editor);
      await editor.getByRole('button', { name: 'Поднять этап 2', exact: true }).scrollIntoViewIfNeeded();
      await expect(editor.getByRole('button', { name: 'Поднять этап 2', exact: true })).toBeInViewport();
      await editor.getByRole('button', { name: 'Сохранить изменения', exact: true }).scrollIntoViewIfNeeded();
      await noOverflow(page, editor);
      await editor.screenshot({ path: testInfo.outputPath(`workflow-${theme}-${size.width}-editor.png`) });
      await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await expect(drawer).toBeVisible();
    });
  }
}


test('waiting workflow wraps valid unbroken step and worker names on narrow mobile at 200% text', async ({ page }, testInfo) => {
  const detail = fixtureDetail('waiting_input');
  const longTitle = 'Э'.repeat(140);
  const longName = 'Р'.repeat(80);
  detail.runs[0].steps[1].title = longTitle;
  detail.runs[0].steps[1].worker.name = longName;
  detail.task.steps[1].title = longTitle;
  await fixtures(page, detail);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => localStorage.setItem('brigd.theme', 'dark'));
  const drawer = await openFixture(page, detail);
  await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await noOverflow(page, drawer);
  const context = drawer.locator('.resume-panel .current-step-context');
  await expect(context).toContainText(longTitle);
  await expect(context).toContainText(longName);
  await context.scrollIntoViewIfNeeded();
  await expect(context).toBeInViewport();
  await noOverflow(page, drawer);
  await drawer.getByLabel('Ответ агенту', { exact: true }).fill('Продолжай с первым вариантом.');
  const resume = drawer.getByRole('button', { name: 'Продолжить работу', exact: true });
  await expect(resume).toBeEnabled();
  await resume.scrollIntoViewIfNeeded();
  await expect(resume).toBeInViewport();
  await noOverflow(page, drawer);
  await drawer.screenshot({ path: testInfo.outputPath('workflow-waiting-dark-320-26.png') });
});
