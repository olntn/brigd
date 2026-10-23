import { expect, test, type Page } from '@playwright/test';
import type { AppInfo, Comment, Run, Task, TaskDetail } from '../src/lib/types';

// Read-only API fixtures exercise saved comments without starting a real agent
// or changing the database shared by the rest of the browser suite.
const timestamp = Date.UTC(2026, 9, 13, 12);
const taskId = 'comment-formatting-task';
const runId = 'comment-formatting-run';
type Message = Pick<Comment, 'kind' | 'body'>;

function fixtureDetail(messages: Message[]): TaskDetail {
  const run: Run = {
    id: runId, taskId, workerId: null, worker: null, steps: [], currentStepIndex: null,
    instructions: [], provider: 'codex', cwd: '/workspace/project', instruction: 'Показать форматирование комментариев.',
    trigger: 'manual', scheduledFor: null, status: 'completed', sessionId: 'comment-formatting-session',
    startedAt: timestamp, updatedAt: timestamp + 5_000, finishedAt: timestamp + 5_000,
    summary: 'Комментарии готовы.', error: null, turn: 1, mock: true,
  };
  const task: Task = {
    id: taskId, title: 'Форматирование комментариев', instruction: run.instruction,
    tagIds: [], tags: [], workerId: null, worker: null, steps: [], provider: 'codex', cwd: run.cwd,
    schedule: 'manual', priority: 'normal', intervalMinutes: null, firstRunAt: null, paused: false,
    createdAt: timestamp, updatedAt: timestamp + 5_000, archivedAt: null, nextRunAt: null,
    status: run.status, latestRun: run, runCount: 1,
  };
  return {
    task, runs: [run], logs: [],
    comments: messages.map((message, index) => ({
      ...message, id: `comment-formatting-${index}`, taskId,
      runId: message.kind === 'user' ? null : runId, stepIndex: null, createdAt: timestamp + index * 1_000,
    })),
  };
}

async function openComments(page: Page, messages: Message[]) {
  const detail = fixtureDetail(messages);
  const info: AppInfo = {
    mode: 'mock', cwd: '/workspace/project', scheduler: 'running', startedAt: timestamp,
    providers: [{ id: 'codex', available: true, label: 'Codex' }, { id: 'claude', available: true, label: 'Claude Code' }],
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only comment formatting fixture' } });
    if (path === '/api/info') return route.fulfill({ json: info });
    if (path === '/api/tasks') return route.fulfill({ json: [detail.task] });
    if (path === `/api/tasks/${taskId}`) return route.fulfill({ json: detail });
    if (['/api/workers', '/api/instructions', '/api/models', '/api/tags'].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: 'Unknown comment formatting fixture' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Открыть задачу: ${detail.task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: detail.task.title, exact: true });
  const comments = dialog.getByRole('tabpanel', { name: /Комментарии/ });
  await expect(dialog).toBeVisible();
  await expect(comments).toBeVisible();
  return { dialog, comments };
}

test('user notes, agent messages, questions and results render inline Markdown', async ({ page }) => {
  const kinds = ['user', 'agent', 'question', 'result'] as const;
  const { comments } = await openComments(page, kinds.map(kind => ({
    kind,
    body: `## Сообщение ${kind}\n\n**Жирный текст**, *курсив*, ~~удалённый текст~~ и \`const ready = true\`.\n\n[Документация](https://example.com/docs?q=1&mode=view)`,
  })));
  await expect(comments.locator('.comment-entry')).toHaveCount(kinds.length);
  for (const kind of kinds) {
    const body = comments.locator(`.comment-${kind} .comment-body`);
    await expect(body.getByRole('heading', { name: `Сообщение ${kind}`, level: 2 })).toBeVisible();
    await expect(body.locator('strong')).toHaveText('Жирный текст');
    await expect(body.locator('em')).toHaveText('курсив');
    await expect(body.locator('s, del')).toHaveText('удалённый текст');
    await expect(body.locator('code')).toHaveText('const ready = true');
    const link = body.getByRole('link', { name: 'Документация', exact: true });
    await expect(link).toHaveAttribute('href', 'https://example.com/docs?q=1&mode=view');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    await expect(link).toHaveAttribute('rel', /\bnoreferrer\b/);
  }
});

test('comments render headings, lists, quotes, fenced code and tables', async ({ page }) => {
  const code = 'function greet() {\n  return "<b>Привет</b>";\n}';
  const markdown = [
    '# Результат проверки', '',
    '- Первый пункт', '- Второй пункт', '',
    '1. Прочитать результат', '2. Подтвердить изменения', '',
    '> Цитата с **важным** замечанием.', '',
    '```typescript', code, '```', '',
    '| Проверка | Статус |', '| :--- | ---: |', '| Типы | Готово |', '| Тесты | Пройдены |',
  ].join('\n');
  const { comments } = await openComments(page, [{ kind: 'agent', body: markdown }]);
  const body = comments.locator('.comment-body');
  await expect(body.getByRole('heading', { name: 'Результат проверки', level: 1 })).toBeVisible();
  await expect(body.locator('ul > li')).toHaveText(['Первый пункт', 'Второй пункт']);
  await expect(body.locator('ol > li')).toHaveText(['Прочитать результат', 'Подтвердить изменения']);
  await expect(body.locator('blockquote')).toContainText('Цитата с важным замечанием.');
  await expect(body.locator('blockquote strong')).toHaveText('важным');
  expect(await body.locator('pre > code').textContent()).toBe(`${code}\n`);
  await expect(body.locator('pre b')).toHaveCount(0);
  const table = body.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Проверка', 'Статус']);
  await expect(table.getByRole('columnheader').nth(1)).toHaveCSS('text-align', 'right');
  await expect(table.getByRole('cell')).toHaveText(['Типы', 'Готово', 'Тесты', 'Пройдены']);
  await expect(table.getByRole('cell').nth(1)).toHaveCSS('text-align', 'right');
});

test('plain comments preserve readable line breaks and paragraphs', async ({ page }) => {
  const lines = ['Первая строка: 2 < 3 & 5 > 4.', 'Вторая строка без разметки.', 'Отдельный абзац.'];
  const { comments } = await openComments(page, [{ kind: 'user', body: `${lines[0]}\n${lines[1]}\n\n${lines[2]}` }]);
  const body = comments.locator('.comment-body');
  await expect(body.locator('p')).toHaveCount(2);
  await expect(body.locator('br')).toHaveCount(1);
  expect((await body.innerText()).split('\n').filter(line => line.length > 0)).toEqual(lines);
});

test('comment Markdown escapes raw HTML and does not create unsafe links', async ({ page }) => {
  const script = '<script>window.commentMarkdownExecuted = true</script>';
  const image = '<img src=x onerror="window.commentMarkdownExecuted = true">';
  const { comments } = await openComments(page, [{ kind: 'agent', body: [
    script, '', image, '', '<b>HTML остаётся текстом</b>', '',
    '[Опасная ссылка](javascript:alert(1))', '',
    '[Смешанный регистр](JaVaScRiPt:alert(1))', '',
    '[Данные](data:text/html,hello)', '',
    '[Безопасная ссылка](https://example.com/docs)',
  ].join('\n') }]);
  const body = comments.locator('.comment-body');
  await expect(body).toContainText(script);
  await expect(body).toContainText(image);
  await expect(body).toContainText('<b>HTML остаётся текстом</b>');
  await expect(body.locator('script, img, iframe, object, embed, b')).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'Опасная ссылка', exact: true })).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'Смешанный регистр', exact: true })).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'Данные', exact: true })).toHaveCount(0);
  await expect(body.getByRole('link', { name: 'Безопасная ссылка', exact: true })).toHaveAttribute('href', 'https://example.com/docs');
  expect(await page.evaluate(() => (window as typeof window & { commentMarkdownExecuted?: boolean }).commentMarkdownExecuted)).toBeUndefined();
});

for (const theme of ['light', 'dark'] as const) {
  test(`long code and tables scroll inside comments at 320px in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(value => localStorage.setItem('brigd.theme', value), theme);
    const longCode = `const value = "${'ДлинноеЗначение'.repeat(40)}";`;
    const longCell = 'ДлинноеЗначение'.repeat(20);
    const tableColumns = Array.from({ length: 8 }, (_, index) => `Столбец ${index + 1}`);
    const { dialog, comments } = await openComments(page, [{ kind: 'result', body: [
      '```typescript', longCode, '```', '',
      `| ${tableColumns.join(' | ')} |`,
      `| ${tableColumns.map(() => '---').join(' | ')} |`,
      `| ${tableColumns.map(() => longCell).join(' | ')} |`,
    ].join('\n') }]);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const dimensions = await dialog.evaluate(node => ({
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      width: node.clientWidth, contentWidth: node.scrollWidth, viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    }));
    expect(dimensions.left, 'dialog left edge remains visible').toBeGreaterThanOrEqual(-1);
    expect(dimensions.right, 'dialog right edge remains visible').toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.documentWidth, 'document has no horizontal overflow').toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.bodyWidth, 'page body has no horizontal overflow').toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.contentWidth, 'dialog has no horizontal overflow').toBeLessThanOrEqual(dimensions.width + 1);

    const body = comments.locator('.comment-body');
    const pre = body.locator('pre');
    expect(await pre.locator('code').textContent()).toBe(`${longCode}\n`);
    const codeDimensions = await pre.evaluate(node => ({
      width: node.clientWidth, contentWidth: node.scrollWidth, overflow: getComputedStyle(node).overflowX,
    }));
    expect(codeDimensions.contentWidth, 'long code can be scrolled without wrapping').toBeGreaterThan(codeDimensions.width);
    expect(['auto', 'scroll']).toContain(codeDimensions.overflow);

    const tableScrollsLocally = await body.getByRole('table').evaluate(table => {
      for (let node: Element | null = table; node && node.closest('.comment-body'); node = node.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    });
    expect(tableScrollsLocally, 'wide table has its own horizontal scroll container').toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`comment-formatting-mobile-${theme}.png`) });
  });
}
