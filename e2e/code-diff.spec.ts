import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { RunCodeDiff } from '../src/lib/code-diff';
import type { AppInfo, Run, Task, TaskDetail } from '../src/lib/types';

// These fixtures are read-only: opening a diff must never start an agent or
// write a file in the project shown by the task.
const timestamp = Date.UTC(2026, 9, 13, 12);
const taskId = 'code-diff-task';
const latestRunId = 'code-diff-latest';
const previousRunId = 'code-diff-previous';

function fixtureDetail(runIds = [latestRunId, previousRunId]): TaskDetail {
  const runs: Run[] = runIds.map((id, index) => ({
    id, taskId, workerId: null, worker: null, steps: [], currentStepIndex: null,
    instructions: [], provider: 'codex', cwd: '/workspace/project', instruction: 'Добавить отображение изменений кода.',
    trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: `${id}-session`,
    startedAt: timestamp - index * 60_000, updatedAt: timestamp - index * 60_000 + 5_000,
    finishedAt: timestamp - index * 60_000 + 5_000, summary: 'Изменения готовы.',
    error: null, turn: 1, mock: true,
  }));
  const task: Task = {
    id: taskId, title: 'Просмотр изменений кода', instruction: 'Добавить отображение изменений кода.',
    tagIds: [], tags: [], workerId: null, worker: null, steps: [], provider: 'codex',
    cwd: '/workspace/project', schedule: 'manual', intervalMinutes: null, firstRunAt: null,
    paused: false, createdAt: timestamp - 60_000, updatedAt: timestamp + 5_000,
    archivedAt: null, nextRunAt: null, status: runs[0]?.status ?? 'ready',
    latestRun: runs[0] ?? null, runCount: runs.length,
  };
  return { task, runs, comments: [], logs: [] };
}

function emptyDiff(runId = latestRunId): RunCodeDiff {
  return {
    runId, state: 'available', reason: null, files: [], additions: 0, deletions: 0,
    truncated: false, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    capturedAt: timestamp + 5_000, live: false,
  };
}

function changedDiff(): RunCodeDiff {
  return {
    ...emptyDiff(), additions: 2, deletions: 1,
    files: [{
      path: 'src/greeting.ts', oldPath: null, status: 'modified', additions: 2, deletions: 1,
      binary: false, truncated: false,
      patch: [
        'diff --git a/src/greeting.ts b/src/greeting.ts',
        'index 1111111..2222222 100644',
        '--- a/src/greeting.ts', '+++ b/src/greeting.ts',
        '@@ -1,2 +1,3 @@', '-export const greeting = "Old";',
        '+export const greeting = "Привет";', '+export const ready = true;',
        ' export const version = 1;', '',
      ].join('\n'),
    }],
  };
}

type DiffHandler = (route: Route, runId: string) => Promise<void>;

async function fixtureApi(page: Page, detail: TaskDetail, handler: DiffHandler) {
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: timestamp,
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only code diff fixture' } });
    if (path === '/api/info') return route.fulfill({ json: info });
    if (path === '/api/tasks') return route.fulfill({ json: [detail.task] });
    if (path === `/api/tasks/${taskId}`) return route.fulfill({ json: detail });
    if (path === '/api/workers' || path === '/api/instructions' || path === '/api/models' || path === '/api/tags') return route.fulfill({ json: [] });
    const match = /^\/api\/runs\/([^/]+)\/diff$/.exec(path);
    if (match) return handler(route, decodeURIComponent(match[1]));
    return route.fulfill({ status: 404, json: { error: 'Unknown code diff fixture' } });
  });
}

async function openChanges(page: Page, detail: TaskDetail, handler: DiffHandler) {
  await fixtureApi(page, detail, handler);
  await page.goto('/');
  await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: detail.task.title, exact: true });
  await dialog.getByRole('tab', { name: /Изменения/ }).click();
  const panel = dialog.getByRole('tabpanel', { name: /Изменения/ });
  await expect(panel).toBeVisible();
  return { dialog, panel };
}

async function expectNoHorizontalOverflow(page: Page, dialog: Locator) {
  const dimensions = await dialog.evaluate(node => ({
    left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
    width: node.clientWidth, content: node.scrollWidth, viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.left).toBeGreaterThanOrEqual(-1);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
}

test('a run diff shows file paths and distinct added, removed and context code', async ({ page }, testInfo) => {
  const requests: string[] = [];
  const { dialog, panel } = await openChanges(page, fixtureDetail(), async (route, runId) => {
    requests.push(runId);
    await route.fulfill({ json: changedDiff() });
  });
  await expect(panel.getByRole('combobox', { name: 'Запуск для просмотра изменений', exact: true })).toHaveValue(latestRunId);
  const file = panel.locator('.diff-file');
  await expect(file).toHaveCount(1);
  await expect(file.locator('summary')).toContainText('src/greeting.ts');
  await expect(file.locator('summary')).toContainText('+2');
  await expect(file.locator('summary')).toContainText('−1');
  await expect(file.locator('.diff-line.addition .diff-code')).toHaveText([
    'export const greeting = "Привет";', 'export const ready = true;',
  ]);
  await expect(file.locator('.diff-line.deletion .diff-code')).toHaveText('export const greeting = "Old";');
  await expect(file.getByText('export const version = 1;', { exact: true })).toBeVisible();
  const addedColor = await file.locator('.diff-line.addition .diff-code').first().evaluate(node => getComputedStyle(node).color);
  const removedColor = await file.locator('.diff-line.deletion .diff-code').evaluate(node => getComputedStyle(node).color);
  expect(addedColor, 'additions and deletions use different text colors').not.toBe(removedColor);
  expect(requests).toEqual([latestRunId]);
  await expectNoHorizontalOverflow(page, dialog);
  await panel.screenshot({ path: testInfo.outputPath('code-diff-desktop.png') });
  await file.locator('summary').press('Enter');
  await expect(file.locator('.diff-line.addition').first()).not.toBeVisible();
  await file.locator('summary').press('Enter');
  await expect(file.locator('.diff-line.addition').first()).toBeVisible();
});

test('the selected run has its own empty or unavailable diff and switching clears old code', async ({ page }) => {
  const reason = 'Для этого запуска снимок изменений не сохранён.';
  const requests: string[] = [];
  const { panel } = await openChanges(page, fixtureDetail(), async (route, runId) => {
    requests.push(runId);
    await route.fulfill({ json: runId === latestRunId ? changedDiff() : { ...emptyDiff(runId), state: 'unavailable', reason } });
  });
  const selector = panel.getByRole('combobox', { name: 'Запуск для просмотра изменений', exact: true });
  await expect(panel.locator('.diff-file')).toHaveCount(1);
  await selector.selectOption(previousRunId);
  await expect(panel.getByText('Diff недоступен', { exact: true })).toBeVisible();
  await expect(panel.getByText(reason, { exact: true })).toBeVisible();
  await expect(panel.locator('.diff-file')).toHaveCount(0);
  await expect(panel.getByText('Изменений кода нет', { exact: true })).toHaveCount(0);
  await selector.selectOption(latestRunId);
  await expect(panel.locator('.diff-file')).toHaveCount(1);
  expect(requests).toEqual([latestRunId, previousRunId, latestRunId]);
});

test('an available empty diff is explained without showing stale file content', async ({ page }) => {
  const { panel } = await openChanges(page, fixtureDetail(), async route => {
    await route.fulfill({ json: emptyDiff() });
  });
  await expect(panel.getByText('Изменений кода нет', { exact: true })).toBeVisible();
  await expect(panel.locator('.diff-file')).toHaveCount(0);
  await expect(panel.getByText('Diff недоступен', { exact: true })).toHaveCount(0);
});

test('a task without runs explains why there is no diff without sending a diff request', async ({ page }) => {
  let requests = 0;
  const { panel } = await openChanges(page, fixtureDetail([]), async route => {
    requests++;
    await route.fulfill({ json: emptyDiff() });
  });
  await expect(panel.getByText('Запусков пока нет', { exact: true })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Запуск для просмотра изменений', exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});

test('loading and failed diff requests are visible and a retry recovers the selected run', async ({ page }) => {
  let release!: () => void;
  const heldRequest = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const { panel } = await openChanges(page, fixtureDetail(), async route => {
    attempts++;
    if (attempts === 1) {
      await heldRequest;
      await route.fulfill({ status: 503, json: { error: 'Временная ошибка чтения diff' } });
    } else await route.fulfill({ json: changedDiff() });
  });
  await expect(panel.getByText('Загружаем изменения…', { exact: true })).toBeVisible();
  release();
  await expect(panel.getByRole('alert')).toContainText('Временная ошибка чтения diff');
  await panel.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await expect(panel.locator('.diff-file')).toHaveCount(1);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('a delayed response from a previous run cannot overwrite the selected run', async ({ page }) => {
  let release!: () => void;
  const heldRequest = new Promise<void>(resolve => { release = resolve; });
  let latestRequested!: () => void;
  const started = new Promise<void>(resolve => { latestRequested = resolve; });
  let latestFinished!: () => void;
  const finished = new Promise<void>(resolve => { latestFinished = resolve; });
  const { panel } = await openChanges(page, fixtureDetail(), async (route, runId) => {
    if (runId === latestRunId) {
      latestRequested();
      await heldRequest;
      // Aborting the first fetch when selection changes is also valid behavior.
      await route.fulfill({ json: changedDiff() }).catch(() => {});
      latestFinished();
    } else await route.fulfill({ json: emptyDiff(runId) });
  });
  await started;
  const selector = panel.getByRole('combobox', { name: 'Запуск для просмотра изменений', exact: true });
  await selector.selectOption(previousRunId);
  await expect(panel.getByText('Изменений кода нет', { exact: true })).toBeVisible();
  release();
  await finished;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(selector).toHaveValue(previousRunId);
  await expect(panel.getByText('Изменений кода нет', { exact: true })).toBeVisible();
  await expect(panel.locator('.diff-file')).toHaveCount(0);
});

test('binary, renamed and truncated files retain their paths and explain missing code', async ({ page }) => {
  const diff: RunCodeDiff = {
    ...emptyDiff(), truncated: true, additions: 1,
    files: [
      { path: 'assets/mascot.png', oldPath: null, status: 'added', additions: 0, deletions: 0, binary: true, truncated: false, patch: '' },
      { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0, binary: false, truncated: false, patch: '' },
      { path: 'src/large.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, truncated: true, patch: '@@ -0,0 +1 @@\n+export const visible = true;\n' },
    ],
  };
  const { panel } = await openChanges(page, fixtureDetail(), async route => { await route.fulfill({ json: diff }); });
  await expect(panel.locator('.diff-file')).toHaveCount(3);
  const binary = panel.locator('.diff-file').filter({ hasText: 'assets/mascot.png' });
  await expect(binary).toContainText('Двоичный файл изменён. Текстовый diff недоступен.');
  await expect(binary.locator('.diff-line')).toHaveCount(0);
  const renamed = panel.locator('.diff-file').filter({ hasText: 'src/new-name.ts' });
  await expect(renamed).toContainText('src/old-name.ts');
  await expect(panel).toContainText(/Показана только часть изменений/);
  await expect(panel.locator('.diff-file').filter({ hasText: 'src/large.ts' }).locator('.diff-line.addition .diff-code')).toHaveText('export const visible = true;');
});

for (const theme of ['light', 'dark'] as const) {
  test(`long paths and code stay inside the mobile dialog in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
    const diff = changedDiff();
    const longPath = `src/${'ОченьДлинныйПутьБезПробелов'.repeat(12)}.ts`;
    const longCode = `export const text = "${'ДлиннаяСтрокаКодаБезПробелов'.repeat(24)}";`;
    diff.files[0].path = longPath;
    diff.files[0].patch = `@@ -0,0 +1 @@\n+${longCode}\n`;
    const { dialog, panel } = await openChanges(page, fixtureDetail(), async route => { await route.fulfill({ json: diff }); });
    await page.addStyleTag({ content: 'html { font-size: 26px !important; }' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(panel.locator('.diff-file > summary')).toContainText(longPath);
    const code = panel.locator('.diff-line.addition .diff-code');
    await expect(code).toHaveText(longCode);
    await code.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, dialog);
    const file = panel.locator('.diff-file');
    expect(await file.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`code-diff-320-${theme}.png`) });
  });
}
