import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { prepareAttachment } from '../server/attachments';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { validateDocBlocks } from '../server/docs';
import { AppError, Store } from '../server/store';
import { docBlocksToMarkdown, markdownToDocBlocks } from '../src/lib/docs-markdown';
import { createDocBlock, docHiddenBlockIds, docSearchText, retypeDocBlock, DOC_IMAGE_MAX_COUNT, DOC_IMAGE_ORPHAN_TTL_MS } from '../src/lib/docs';
import type { DocBlock, DocPage, DocPageExport, DocSearchHit, TaskInput } from '../src/lib/types';

const BASE = 1_700_000_000_000;
const ORIGIN = 'http://127.0.0.1:4310';
let folder: string;
let store: Store;
let engine: Engine;
let handler: ReturnType<typeof createHandler>;
const factory: AgentFactory = () => ({ result: new Promise(() => {}), cancel: () => {} });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const block = (patch: Partial<DocBlock> = {}): DocBlock => ({ id: crypto.randomUUID(), type: 'paragraph', text: 'Hello', ...patch });
const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => handler(new Request(ORIGIN + path, {
  method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
  body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value ?? {}),
}));
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Inspect project', instruction: 'Review this project.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
function expectError(action: () => unknown, status: number, message?: string | RegExp) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); if (message) expect((error as AppError).message).toMatch(message); }
}
async function pngImage(width = 32, height = 24, color = '#336699') {
  const png = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  return prepareAttachment(new Uint8Array(png), 'image/png', `pic-${width}x${height}.png`);
}
const strip = (blocks: DocBlock[]) => blocks.map(({ id: _id, ...rest }) => rest);
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-docs-content-'));
  store = new Store(join(folder, 'docs.sqlite'));
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: 4310, root: folder });
});
afterEach(async () => {
  await engine.shutdown();
  await flush();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('structured blocks', () => {
  test('validates and canonicalises the new block types', () => {
    const blocks = validateDocBlocks([
      block({ id: 'c', type: 'callout', text: 'Note', icon: ' ⚠️ ', color: 'yellow', indent: 1 }),
      block({ id: 't', type: 'toggle', text: 'More', collapsed: true }),
      block({ id: 'tb', type: 'table', text: '', rows: [['A', 'B'], ['1', '2']], header: false }),
      block({ id: 'i', type: 'image', text: 'Caption', imageId: null }),
      block({ id: 'k', type: 'task', text: '', taskId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' }),
      block({ id: 'o', type: 'toc', text: '' }),
      block({ id: 'p', text: 'Nested', indent: 0 }),
    ]);
    expect(blocks).toEqual([
      { id: 'c', type: 'callout', text: 'Note', indent: 1, icon: '⚠️', color: 'yellow' },
      { id: 't', type: 'toggle', text: 'More', collapsed: true },
      { id: 'tb', type: 'table', text: '', rows: [['A', 'B'], ['1', '2']], header: false },
      { id: 'i', type: 'image', text: 'Caption', imageId: null },
      { id: 'k', type: 'task', text: '', taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      { id: 'o', type: 'toc', text: '' },
      { id: 'p', type: 'paragraph', text: 'Nested' },
    ]);
    expect(validateDocBlocks([block({ type: 'callout', text: 'x' }), block({ type: 'toggle', text: 'x' })]).map(({ icon, color, collapsed }) => [icon, color, collapsed])).toEqual([['💡', 'gray', undefined], [undefined, undefined, false]]);
    for (const invalid of [
      block({ type: 'callout', text: 'x', color: 'pink' as never }), block({ type: 'callout', text: 'x', icon: 'x'.repeat(17) }), block({ type: 'callout', text: 'x', icon: 'a\nb' }),
      block({ type: 'toggle', text: 'x', collapsed: 'yes' as never }), block({ type: 'paragraph', text: 'x', collapsed: true }),
      block({ type: 'table', text: '' }), block({ type: 'table', text: '', rows: [] }), block({ type: 'table', text: '', rows: [['a'], ['b', 'c']] }), block({ type: 'table', text: '', rows: [['a\nb']] }),
      block({ type: 'table', text: '', rows: [Array.from({ length: 21 }, () => '')] }), block({ type: 'table', text: '', rows: Array.from({ length: 101 }, () => ['']) }), block({ type: 'table', text: 'text', rows: [['']] }),
      block({ type: 'image', text: '', imageId: 'short' }), block({ type: 'task', text: '', taskId: 'nope' }), block({ type: 'task', text: 'label' }), block({ type: 'toc', text: 'x' }),
      block({ type: 'paragraph', text: 'x', rows: [['']] }), block({ type: 'paragraph', text: 'x', indent: 5 }),
    ]) expectError(() => validateDocBlocks([invalid]), 400);
  });

  test('retype keeps indentation and structured defaults, and collapsed toggles hide deeper blocks', () => {
    const toggle = retypeDocBlock({ id: 'a', type: 'bulleted', text: 'x', indent: 2 }, 'toggle');
    expect(toggle).toEqual({ id: 'a', type: 'toggle', text: 'x', indent: 2, collapsed: false });
    expect(retypeDocBlock(toggle, 'table')).toEqual({ id: 'a', type: 'table', text: '', indent: 2, rows: [['', '', ''], ['', '', '']], header: true });
    expect(retypeDocBlock({ id: 'b', type: 'paragraph', text: 'cap' }, 'image')).toEqual({ id: 'b', type: 'image', text: 'cap', imageId: null });
    expect(createDocBlock('callout', 'hi')).toMatchObject({ type: 'callout', text: 'hi', icon: '💡', color: 'gray' });
    const blocks: DocBlock[] = [
      { id: 't1', type: 'toggle', text: 'Open', collapsed: false }, { id: 'c1', type: 'paragraph', text: '', indent: 1 },
      { id: 't2', type: 'toggle', text: 'Closed', collapsed: true }, { id: 'c2', type: 'paragraph', text: '', indent: 1 },
      { id: 't3', type: 'toggle', text: 'Nested closed', collapsed: true, indent: 1 }, { id: 'c3', type: 'paragraph', text: '', indent: 2 },
      { id: 'after', type: 'paragraph', text: '' }, { id: 't4', type: 'toggle', text: 'Deep closed', collapsed: true, indent: 1 }, { id: 'c4', type: 'paragraph', text: '', indent: 2 }, { id: 'sib', type: 'paragraph', text: '', indent: 1 },
    ];
    expect([...docHiddenBlockIds(blocks)]).toEqual(['c2', 't3', 'c3', 'c4']);
    expect(docSearchText([{ id: 'x', type: 'table', text: '', rows: [['**A**', 'B']] }, { id: 'y', type: 'callout', text: 'Note', icon: '💡' }, { id: 'z', type: 'code', text: 'raw **code**' }])).toBe('A B\n💡 Note\nraw **code**');
  });

  test('Markdown export and import round-trip every block type', () => {
    const markdown = [
      '# Title', '', 'Paragraph with **bold**.', 'Second line.', '', '- one', '  - nested', '- [x] done', '- [ ] open', '1. first', '2. second', '',
      '> quoted', '> twice', '', '```ts', 'const x = 1;', '```', '', '| A | B |', '| --- | --- |', '| 1 | pipe \\| inside |', '', '---', '',
      '<details>', '<summary>More</summary>', '', '  Hidden text.', '', '</details>', '', '[[toc]]', '', '@task()', '',
    ].join('\n');
    const blocks = markdownToDocBlocks(markdown, { pageId: 'page' });
    expect(blocks.map(item => `${item.type}${item.indent ? '@' + item.indent : ''}`)).toEqual([
      'heading1', 'paragraph', 'bulleted', 'bulleted@1', 'todo', 'todo', 'numbered', 'numbered', 'quote', 'code', 'table', 'divider', 'toggle', 'paragraph@1', 'toc', 'task',
    ]);
    expect(blocks[1]!.text).toBe('Paragraph with **bold**.\nSecond line.');
    expect(blocks[4]!.checked).toBe(true);
    expect(blocks[9]).toMatchObject({ language: 'ts', text: 'const x = 1;' });
    expect(blocks[10]).toMatchObject({ rows: [['A', 'B'], ['1', 'pipe | inside']], header: true });
    expect(blocks[15]).toMatchObject({ type: 'task', taskId: null });
    const exported = docBlocksToMarkdown(blocks, { pageId: 'page' });
    expect(strip(markdownToDocBlocks(exported, { pageId: 'page' }))).toEqual(strip(blocks));
    expect(exported).toContain('| 1 | pipe \\| inside |');
    expect(docBlocksToMarkdown([{ id: 'i', type: 'image', text: 'Cap', imageId: 'abcdefab-1234-1234-1234-abcdefabcdef' }, { id: 'c', type: 'callout', text: 'Hint', icon: '💡', color: 'blue' }], { pageId: 'page' }))
      .toBe('![Cap](/api/docs/page/images/abcdefab-1234-1234-1234-abcdefabcdef)\n\n> 💡 Hint\n');
    const own = markdownToDocBlocks('![Cap](/api/docs/page/images/abcdefab-1234-1234-1234-abcdefabcdef)\n\n![Other](/api/docs/other/images/abcdefab-1234-1234-1234-abcdefabcdef)', { pageId: 'page' });
    expect(strip(own)).toEqual([{ type: 'image', text: 'Cap', imageId: 'abcdefab-1234-1234-1234-abcdefabcdef' }, { type: 'paragraph', text: '![Other](/api/docs/other/images/abcdefab-1234-1234-1234-abcdefabcdef)' }]);
    expect(markdownToDocBlocks('', { pageId: 'page' })).toEqual([]);
    expect(strip(markdownToDocBlocks('```\nunterminated', { pageId: 'page' }))).toEqual([{ type: 'code', text: 'unterminated', language: '' }]);
  });
});

describe('pages with content, search and images', () => {
  test('creates and replaces pages from Markdown, exports them and bumps the version for open editors', async () => {
    const created = await request('/api/docs', 'POST', { title: 'Guide', markdown: '## Setup\n\nRun `bun install`.' });
    expect(created.status).toBe(201);
    const page = await created.json() as DocPage;
    expect(page.blocks.map(item => item.type)).toEqual(['heading2', 'paragraph']);
    const exported = await (await request(`/api/docs/${page.id}/export`)).json() as DocPageExport;
    expect(exported).toEqual({ id: page.id, parentId: null, title: 'Guide', childIds: [], updatedAt: page.updatedAt, markdown: '## Setup\n\nRun `bun install`.\n' });
    const replaced = await request(`/api/docs/${page.id}/markdown`, 'PUT', { markdown: '- item' });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ title: 'Guide', version: 2, blocks: [{ type: 'bulleted', text: 'item' }] });
    expect((await request(`/api/docs/${page.id}/markdown`, 'PUT', { title: 'Renamed' })).status).toBe(200);
    expect(store.getDocPage(page.id)).toMatchObject({ title: 'Renamed', version: 3, blocks: [{ type: 'bulleted', text: 'item' }] });
    expect((await request(`/api/docs/${page.id}`, 'PUT', { title: 'Stale editor', blocks: [], version: 1 })).status).toBe(409);
    for (const value of [{}, { markdown: 5 }, { title: 'x'.repeat(141) }, { markdown: 'a\0b' }, { other: 1 }]) expect((await request(`/api/docs/${page.id}/markdown`, 'PUT', value)).status).toBe(400);
    expect((await request('/api/docs', 'POST', { markdown: '@task(aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)' })).status).toBe(400);
    expect((await request('/api/docs', 'POST', { markdown: 'x'.repeat(256 * 1024 + 1) })).status).toBe(400);
    const child = store.createDocPage({ title: 'Child', parentId: page.id });
    expect(store.exportDocPage(page.id).childIds).toEqual([child.id]);
    store.deleteDocPage(page.id);
    expect((await request(`/api/docs/${page.id}/markdown`, 'PUT', { markdown: 'x' })).status).toBe(409);
  });

  test('full-text search covers titles and block text, ignores trashed pages and survives odd queries', async () => {
    const guide = store.createDocPage({ title: 'Deployment guide', markdown: 'Run **bun run start** on the server.\n\n| Host | Port |\n| --- | --- |\n| 127.0.0.1 | 4310 |' });
    const notes = store.createDocPage({ title: 'Meeting notes', markdown: 'Discussed deployment windows and ports.' });
    const hits = store.searchDocPages('deploy');
    expect(hits.map(hit => hit.id)).toEqual([guide.id, notes.id]);
    expect(hits[0]).toMatchObject({ title: 'Deployment guide', parentId: null });
    expect(store.searchDocPages('4310')[0]?.snippet).toContain('[4310]');
    expect(store.searchDocPages('bun start').map(hit => hit.id)).toEqual([guide.id]);
    expect(store.searchDocPages('   ')).toEqual([]);
    expect(store.searchDocPages('"quoted" AND (')).toEqual([]);
    expect(store.searchDocPages('nothing-matches-here')).toEqual([]);
    expect(await (await request('/api/docs/search?q=meeting')).json()).toEqual(store.searchDocPages('meeting'));
    store.saveDocPageMarkdown(notes.id, { title: 'Renamed notes', markdown: 'Nothing here.' });
    expect(store.searchDocPages('deployment').map(hit => hit.id)).toEqual([guide.id]);
    store.deleteDocPage(guide.id);
    expect(store.searchDocPages('deployment')).toEqual([]);
    store.restoreDocPage(guide.id);
    expect(store.searchDocPages('deployment').map(hit => hit.id)).toEqual([guide.id]);
    // Databases from before the index existed are filled on open.
    store.db.exec('DELETE FROM doc_search');
    store.close();
    store = new Store(join(folder, 'docs.sqlite'));
    engine = new Engine(store, true, factory);
    handler = createHandler(engine, { port: 4310, root: folder });
    expect(store.searchDocPages('deployment').map(hit => hit.id)).toEqual([guide.id]);
  });

  test('stores raster images per page, serves them and removes unreferenced ones after a grace period', async () => {
    const page = store.createDocPage({ title: 'Pictures' }, BASE);
    const image = store.addDocImage(page.id, await pngImage(), BASE);
    expect(image).toMatchObject({ pageId: page.id, name: 'pic-32x24.png', mime: 'image/png', createdAt: BASE });
    expectError(() => store.addDocImage(page.id, { name: 'x.txt', mime: 'text/plain', size: 1, sha256: 'a', previewable: false }, BASE), 415);
    const stray = await pngImage();
    expectError(() => store.addDocImage('missing', stray, BASE), 404);
    const served = await request(`/api/docs/${page.id}/images/${image.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-disposition')).toContain('inline');
    expect(new Uint8Array(await served.arrayBuffer())).toHaveLength(image.size);
    expect((await request(`/api/docs/${page.id}/images/${image.id}`, 'HEAD')).status).toBe(200);
    const other = store.createDocPage({ title: 'Other' }, BASE);
    expect((await request(`/api/docs/${other.id}/images/${image.id}`)).status).toBe(404);
    expectError(() => store.saveDocPage(other.id, { title: 'Other', version: 1, blocks: [block({ type: 'image', text: '', imageId: image.id })] }), 400, /не найдено на этой странице/);
    const saved = store.saveDocPage(page.id, { title: 'Pictures', version: 1, blocks: [block({ type: 'image', text: 'Cap', imageId: image.id })] }, BASE + 1);
    expect(store.exportDocPage(page.id).markdown).toBe(`![Cap](/api/docs/${page.id}/images/${image.id})\n`);
    expect(store.db.query('SELECT orphaned_at FROM doc_images WHERE id=?').get(image.id)).toEqual({ orphaned_at: null });
    const dropped = store.saveDocPage(page.id, { title: 'Pictures', version: saved.version, blocks: [] }, BASE + 2);
    expect(store.db.query('SELECT orphaned_at FROM doc_images WHERE id=?').get(image.id)).toEqual({ orphaned_at: BASE + 2 });
    store.saveDocPage(page.id, { title: 'Pictures', version: dropped.version, blocks: [block({ type: 'image', text: '', imageId: image.id })] }, BASE + 3);
    expect(store.db.query('SELECT orphaned_at FROM doc_images WHERE id=?').get(image.id)).toEqual({ orphaned_at: null });
    const final = store.saveDocPage(page.id, { title: 'Pictures', version: dropped.version + 1, blocks: [] }, BASE + 4);
    store.saveDocPage(page.id, { title: 'Pictures', version: final.version, blocks: [] }, BASE + 4 + DOC_IMAGE_ORPHAN_TTL_MS);
    expect(store.listDocImages(page.id)).toEqual([]);
    expect((await request(`/api/docs/${page.id}/images/${image.id}`)).status).toBe(404);
    const upload = await handler(new Request(`${ORIGIN}/api/docs/${page.id}/images?name=shot.png`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'image/png' }, body: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer() }));
    expect(upload.status).toBe(201);
    expect((await handler(new Request(`${ORIGIN}/api/docs/${page.id}/images?name=note.txt`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: 'hello' }))).status).toBe(415);
    for (let count = 1; count < DOC_IMAGE_MAX_COUNT; count++) store.addDocImage(page.id, await pngImage(4 + count % 3, 4), BASE + 10);
    expectError(() => store.addDocImage(page.id, { name: 'x.png', mime: 'image/png', size: 1, sha256: 'a', previewable: true }, BASE + 10), 400);
    store.deleteDocPage(page.id, BASE + 20);
    store.purgeDocPage(page.id);
    expect(store.db.query('SELECT count(*) AS n FROM doc_images').get()).toEqual({ n: 0 });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('saving a page validates task references', () => {
    const page = store.createDocPage({ title: 'Links' });
    const task = store.createTask(taskInput());
    const saved = store.saveDocPage(page.id, { title: 'Links', version: 1, blocks: [block({ type: 'task', text: '', taskId: task.id.toUpperCase() })] });
    expect(saved.blocks[0]!.taskId).toBe(task.id);
    expect(store.exportDocPage(page.id).markdown).toBe(`@task(${task.id})\n`);
    expectError(() => store.saveDocPage(page.id, { title: 'Links', version: 2, blocks: [block({ type: 'task', text: '', taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })] }), 400, /Задача из блока не найдена/);
  });
});
