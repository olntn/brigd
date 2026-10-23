import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, Run, RunProgress, Task, TaskDetail } from '../src/lib/types';

// Read-only fixtures: the progress status comes from the agent's set_progress calls, never from the UI.
const timestamp = Date.UTC(2026, 9, 9, 12);
const taskId = 'task-progress-fixture';

function fixture(progress: RunProgress | null, status: Run['status'] = 'running'): TaskDetail {
  const run: Run = {
    id: 'task-progress-run', taskId, workerId: null, worker: null, steps: [], currentStepIndex: null,
    instructions: [], provider: 'claude', cwd: '/workspace/project', instruction: 'Добавь статус выполнения в карточку задачи.',
    trigger: 'manual', scheduledFor: null, status, sessionId: 'task-progress-session', startedAt: timestamp,
    updatedAt: timestamp, finishedAt: status === 'running' ? null : timestamp + 60_000, summary: status === 'running' ? null : 'Статус добавлен.',
    error: null, turn: 1, mock: true, progress,
  };
  const task: Task = {
    tagIds: [], tags: [], id: taskId, title: 'Статус выполнения задачи', instruction: run.instruction, workerId: null, worker: null,
    steps: [], provider: 'claude', cwd: run.cwd, schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null,
    paused: false, createdAt: timestamp, updatedAt: timestamp, archivedAt: null, nextRunAt: null, status, latestRun: run, runCount: 1,
  };
  return { task, runs: [run], comments: [], logs: [] };
}

async function serve(page: Page, initial: TaskDetail) {
  const state = { detail: initial };
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: timestamp,
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') await route.fulfill({ status: 405, json: { error: 'Progress fixtures are read-only' } });
    else if (path === '/api/info') await route.fulfill({ json: info });
    else if (path === '/api/tasks') await route.fulfill({ json: [state.detail.task] });
    else if (path === `/api/tasks/${taskId}`) await route.fulfill({ json: state.detail });
    else if (path === '/api/workers' || path === '/api/instructions' || path === '/api/models' || path === '/api/tags') await route.fulfill({ json: [] });
    else await route.fulfill({ status: 404, json: { error: 'Unknown progress fixture' } });
  });
  return state;
}

test('the agent-reported progress status follows the running task on the board, in the list and in the card', async ({ page }, testInfo) => {
  const state = await serve(page, fixture({ text: 'Сбор информации о проекте', updatedAt: timestamp }));
  await page.goto('/');
  const card = page.locator('.task-card').filter({ hasText: 'Статус выполнения задачи' });
  await expect(page.locator('.board-column.column-running .task-card')).toHaveCount(1);
  await expect(card.locator('.card-progress')).toHaveText('Сбор информации о проекте');

  state.detail = fixture({ text: 'Написание кода', updatedAt: timestamp + 30_000 });
  await expect(card.locator('.card-progress')).toHaveText('Написание кода', { timeout: 6_000 });
  await page.screenshot({ path: testInfo.outputPath('task-progress-board.png') });

  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(page.locator('.task-row .list-progress')).toHaveText('Написание кода');
  await page.getByRole('button', { name: 'Доска', exact: true }).click();

  await page.getByRole('button', { name: 'Открыть задачу: Статус выполнения задачи', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Статус выполнения задачи', exact: true });
  const progress = dialog.getByRole('status').filter({ hasText: 'Статус выполнения:' });
  await expect(progress).toHaveText(/^Статус выполнения: Написание кода · с \d{2}:\d{2}$/);
  await expect(progress.locator('time')).toHaveAttribute('datetime', new Date(timestamp + 30_000).toISOString());
  await page.screenshot({ path: testInfo.outputPath('task-progress-detail.png') });

  // A finished run keeps only its lifecycle status.
  state.detail = fixture(null, 'completed');
  await expect(dialog.locator('.detail-progress')).toHaveCount(0, { timeout: 6_000 });
  await expect(dialog.locator('.drawer-badges .status-badge')).toHaveText('Завершено');
  await page.keyboard.press('Escape');
  await expect(card.locator('.card-progress')).toHaveCount(0);
});

test('a running task without a reported stage shows no progress line', async ({ page }) => {
  await serve(page, fixture(null));
  await page.goto('/');
  const card = page.locator('.task-card').filter({ hasText: 'Статус выполнения задачи' });
  await expect(page.locator('.board-column.column-running .task-card')).toHaveCount(1);
  await expect(card.locator('.card-progress')).toHaveCount(0);
});
