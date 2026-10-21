import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { validateDocBlocks } from '../server/docs';
import { AppError, Store } from '../server/store';
import { buildDocTree, createDocBlock, docHeadings, docListNumbers, docRawOffset, docShortcut, flattenDocTree, retypeDocBlock, stripInlineMarkdown, DOC_BLOCK_LIMIT, DOC_BLOCK_TEXT_LIMIT, DOC_DEPTH_LIMIT, DOC_PAGE_BYTES_LIMIT, DOC_PAGE_LIMIT, DOC_TITLE_LIMIT } from '../src/lib/docs';
import { renderInlineMarkdown } from '../src/lib/markdown';
import type { DocBlock, DocPage, DocPageSummary } from '../src/lib/types';

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
function expectError(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
async function reopen() {
  await engine.shutdown();
  await flush();
  store.close();
  store = new Store(join(folder, 'docs.sqlite'));
  engine = new Engine(store, true, factory);
  handler = createHandler(engine, { port: 4310, root: folder });
}
/** Roots first, then children grouped under their parent in tree order, so expectations read like the sidebar. */
function titles(pages: DocPageSummary[]): string[] {
  const walk = (parentId: string | null, depth: number): string[] => pages.filter(page => page.parentId === parentId).sort((a, b) => a.position - b.position)
    .flatMap(page => [`${'  '.repeat(depth)}${page.title}@${page.position}`, ...walk(page.id, depth + 1)]);
  return walk(null, 0);
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-docs-'));
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

describe('documentation pages', () => {
  test('creates, lists and persists a global tree ordered by position', async () => {
    expect(store.listDocPages()).toEqual([]);
    const root = store.createDocPage({ title: '  Guide  ' }, BASE);
    expect(root).toEqual({ id: root.id, parentId: null, position: 0, title: 'Guide', blocks: [], version: 1, createdAt: BASE, updatedAt: BASE, deletedAt: null });
    const second = store.createDocPage({}, BASE + 1);
    const child = store.createDocPage({ title: 'Child', parentId: root.id }, BASE + 2);
    const grandchild = store.createDocPage({ title: 'Grandchild', parentId: child.id }, BASE + 3);
    expect(second.title).toBe('');
    expect(child.position).toBe(0);
    expect(store.createDocPage({ title: 'Second child', parentId: root.id }, BASE + 4).position).toBe(1);
    await reopen();
    const pages = store.listDocPages();
    expect(pages.map(page => [page.title, page.parentId, page.position])).toEqual([
      ['Guide', null, 0], ['', null, 1], ['Child', root.id, 0], ['Grandchild', child.id, 0], ['Second child', root.id, 1],
    ]);
    expect(titles(pages)).toEqual(['Guide@0', '  Child@0', '    Grandchild@0', '  Second child@1', '@1']);
    expect(store.getDocPage(grandchild.id)).toMatchObject({ parentId: child.id, blocks: [], version: 1 });
    expectError(() => store.getDocPage('missing'), 404);
    expect((await request(`/api/docs/${grandchild.id}`)).status).toBe(200);
    expect((await request('/api/docs/missing')).status).toBe(404);
    expect(await (await request('/api/docs')).json()).toEqual(pages);
  });

  test.each([
    [], 'text', { title: 1 }, { title: 'x'.repeat(DOC_TITLE_LIMIT + 1) }, { title: 'a\0b' }, { parentId: 5 }, { parentId: 'bad id!' },
    { title: 'A', blocks: [] }, { id: 'caller-controlled' }, { position: 0 },
  ].map((value, index) => ({ value, index })))('rejects invalid create inputs without saving: case $index', async ({ value }) => {
    expectError(() => store.createDocPage(value as never), 400);
    expect((await request('/api/docs', 'POST', value)).status).toBe(400);
    expect(store.listDocPages()).toEqual([]);
    expectError(() => store.createDocPage(null as never), 400);
  });

  test('creation needs a live parent and respects the depth and count limits', async () => {
    expectError(() => store.createDocPage({ parentId: 'missing' }), 404);
    expect((await request('/api/docs', 'POST', { parentId: 'missing' })).status).toBe(404);
    let parent: string | null = null;
    for (let level = 1; level <= DOC_DEPTH_LIMIT; level++) parent = store.createDocPage({ title: `Level ${level}`, parentId: parent }, BASE + level).id;
    expectError(() => store.createDocPage({ title: 'Too deep', parentId: parent }), 400);
    const trashed = store.createDocPage({ title: 'Trashed' }, BASE);
    store.deleteDocPage(trashed.id, BASE + 20);
    expectError(() => store.createDocPage({ parentId: trashed.id }), 404);
    const insert = store.db.query('INSERT INTO doc_pages (id,parent_id,position,title,blocks,version,created_at,updated_at) VALUES (?,NULL,?,?,?,1,?,?)');
    const existing = store.db.query('SELECT count(*) AS n FROM doc_pages').get() as { n: number };
    store.db.transaction(() => { for (let i = existing.n; i < DOC_PAGE_LIMIT; i++) insert.run(`filler-${i}`, i, `Filler ${i}`, '[]', BASE, BASE); })();
    expectError(() => store.createDocPage({ title: 'One too many' }), 400);
    expect((await request('/api/docs', 'POST', { title: 'One too many' })).status).toBe(400);
    store.purgeDocPage(trashed.id);
    expect(store.createDocPage({ title: 'Fits again' }).title).toBe('Fits again');
  });

  test('saves content with canonical blocks and optimistic versions', async () => {
    const page = store.createDocPage({ title: 'Notes' }, BASE);
    const blocks: DocBlock[] = [
      block({ id: 'h', type: 'heading1', text: 'Title' }), block({ id: 'p', text: 'Body **bold**' }),
      block({ id: 't', type: 'todo', text: 'Task' }), block({ id: 'l', type: 'bulleted', text: 'Item', indent: 2 }),
      block({ id: 'c', type: 'code', text: 'bun test' }), block({ id: 'd', type: 'divider', text: '' }),
    ];
    const response = await request(`/api/docs/${page.id}`, 'PUT', { title: ' Renamed ', blocks, version: 1 });
    expect(response.status).toBe(200);
    const saved = await response.json() as DocPage;
    expect(saved).toMatchObject({ id: page.id, title: 'Renamed', version: 2, createdAt: BASE });
    expect(saved.blocks).toEqual([
      { id: 'h', type: 'heading1', text: 'Title' }, { id: 'p', type: 'paragraph', text: 'Body **bold**' },
      { id: 't', type: 'todo', text: 'Task', checked: false }, { id: 'l', type: 'bulleted', text: 'Item', indent: 2 },
      { id: 'c', type: 'code', text: 'bun test', language: '' }, { id: 'd', type: 'divider', text: '' },
    ]);
    const stale = await request(`/api/docs/${page.id}`, 'PUT', { title: 'Stale', blocks: [], version: 1 });
    expect(stale.status).toBe(409);
    expect(store.getDocPage(page.id)).toMatchObject({ title: 'Renamed', version: 2 });
    expect(store.saveDocPage(page.id, { title: '', blocks: [], version: 2 }, BASE + 5)).toMatchObject({ title: '', blocks: [], version: 3, updatedAt: BASE + 5 });
    await reopen();
    expect(store.getDocPage(page.id)).toMatchObject({ title: '', blocks: [], version: 3 });
    store.deleteDocPage(page.id, BASE + 6);
    expectError(() => store.saveDocPage(page.id, { title: 'Trashed', blocks: [], version: 3 }), 409);
    expectError(() => store.moveDocPage(page.id, { position: 0 }), 409);
    expectError(() => store.saveDocPage('missing', { title: '', blocks: [], version: 1 }), 404);
  });

  test.each([
    {}, { title: 'A' }, { title: 'A', blocks: [] }, { blocks: [], version: 1 }, { title: 'A', blocks: [], version: 0 }, { title: 'A', blocks: [], version: '1' },
    { title: 'A', blocks: {}, version: 1 }, { title: 'A', blocks: [null], version: 1 }, { title: 'A', blocks: [[]], version: 1 },
    { title: 'A', blocks: [block({ id: 'bad id' })], version: 1 }, { title: 'A', blocks: [block({ id: 'same' }), block({ id: 'same' })], version: 1 },
    { title: 'A', blocks: [block({ type: 'video' as never })], version: 1 }, { title: 'A', blocks: [block({ text: 42 as never })], version: 1 },
    { title: 'A', blocks: [block({ text: 'a\0b' })], version: 1 }, { title: 'A', blocks: [block({ text: 'x'.repeat(DOC_BLOCK_TEXT_LIMIT + 1) })], version: 1 },
    { title: 'A', blocks: [block({ type: 'divider', text: 'line' })], version: 1 }, { title: 'A', blocks: [block({ checked: true })], version: 1 },
    { title: 'A', blocks: [block({ type: 'todo', checked: 'yes' as never })], version: 1 }, { title: 'A', blocks: [block({ language: 'ts' })], version: 1 },
    { title: 'A', blocks: [block({ type: 'code', language: 'bad lang' })], version: 1 }, { title: 'A', blocks: [block({ type: 'code', language: 'x'.repeat(41) })], version: 1 },
    { title: 'A', blocks: [block({ indent: -1 })], version: 1 }, { title: 'A', blocks: [block({ type: 'bulleted', indent: 5 })], version: 1 },
    { title: 'A', blocks: [block({ type: 'bulleted', indent: 1.5 })], version: 1 }, { title: 'A', blocks: [{ ...block(), extra: true }], version: 1 },
    { title: 'A', blocks: [], version: 1, id: 'new' }, { title: 'x'.repeat(DOC_TITLE_LIMIT + 1), blocks: [], version: 1 },
    { title: 'A', blocks: Array.from({ length: DOC_BLOCK_LIMIT + 1 }, () => block()), version: 1 },
    { title: 'A', blocks: Array.from({ length: Math.ceil(DOC_PAGE_BYTES_LIMIT / DOC_BLOCK_TEXT_LIMIT) + 1 }, () => block({ text: 'x'.repeat(DOC_BLOCK_TEXT_LIMIT) })), version: 1 },
  ].map((value, index) => ({ value, index })))('invalid content is rejected atomically: case $index', async ({ value }) => {
    const page = store.createDocPage({ title: 'Keep' }, BASE);
    expectError(() => store.saveDocPage(page.id, value as never), 400);
    expect((await request(`/api/docs/${page.id}`, 'PUT', value)).status).toBe(400);
    expect(store.getDocPage(page.id)).toEqual(page);
  });

  test('accepts exact limits for text, blocks and page size', () => {
    const page = store.createDocPage({ title: 'x'.repeat(DOC_TITLE_LIMIT) }, BASE);
    const full = Array.from({ length: DOC_BLOCK_LIMIT }, () => block({ text: 'y' }));
    expect(store.saveDocPage(page.id, { title: page.title, blocks: full, version: 1 }).blocks).toHaveLength(DOC_BLOCK_LIMIT);
    expect(validateDocBlocks([block({ text: 'z'.repeat(DOC_BLOCK_TEXT_LIMIT) }), block({ type: 'code', language: 'c++' }), block({ type: 'bulleted', indent: 4 })])).toHaveLength(3);
  });

  test('moves pages among siblings and between parents without cycles or extra depth', async () => {
    const a = store.createDocPage({ title: 'A' }, BASE);
    const b = store.createDocPage({ title: 'B' }, BASE + 1);
    const c = store.createDocPage({ title: 'C' }, BASE + 2);
    const a1 = store.createDocPage({ title: 'A1', parentId: a.id }, BASE + 3);
    expect(store.moveDocPage(c.id, { position: 0 }, BASE + 4)).toMatchObject({ id: c.id, parentId: null, position: 0, updatedAt: BASE + 4 });
    expect(titles(store.listDocPages())).toEqual(['C@0', 'A@1', '  A1@0', 'B@2']);
    expect((await request(`/api/docs/${b.id}`, 'PATCH', { parentId: a.id })).status).toBe(200);
    expect(titles(store.listDocPages())).toEqual(['C@0', 'A@1', '  A1@0', '  B@1']);
    store.moveDocPage(b.id, { parentId: a.id, position: 0 });
    expect(titles(store.listDocPages())).toEqual(['C@0', 'A@1', '  B@0', '  A1@1']);
    store.moveDocPage(b.id, { parentId: null, position: 99 });
    expect(titles(store.listDocPages())).toEqual(['C@0', 'A@1', '  A1@0', 'B@2']);
    expectError(() => store.moveDocPage(a.id, { parentId: a.id }), 400);
    expectError(() => store.moveDocPage(a.id, { parentId: a1.id }), 400);
    expect((await request(`/api/docs/${a.id}`, 'PATCH', { parentId: a1.id })).status).toBe(400);
    expectError(() => store.moveDocPage(a.id, { parentId: 'missing' }), 404);
    expectError(() => store.moveDocPage('missing', { position: 0 }), 404);
    for (const value of [{}, { position: -1 }, { position: 1.5 }, { parentId: 7 }, { title: 'x' }]) {
      expectError(() => store.moveDocPage(a.id, value as never), 400);
      expect((await request(`/api/docs/${a.id}`, 'PATCH', value)).status).toBe(400);
    }
    let deepest = a1.id;
    for (let level = 3; level <= DOC_DEPTH_LIMIT; level++) deepest = store.createDocPage({ title: `L${level}`, parentId: deepest }).id;
    expectError(() => store.moveDocPage(c.id, { parentId: deepest }), 400);
    expectError(() => store.moveDocPage(a.id, { parentId: b.id }), 400);
    expect(store.moveDocPage(c.id, { parentId: a1.id }).parentId).toBe(a1.id);
    expect(titles(store.listDocPages()).filter(entry => !entry.startsWith(' '))).toEqual(['A@0', 'B@1']);
  });

  test('trash keeps subtrees together, restores separately deleted pages on their own and purges permanently', async () => {
    const root = store.createDocPage({ title: 'Root' }, BASE);
    const sibling = store.createDocPage({ title: 'Sibling' }, BASE + 1);
    const child = store.createDocPage({ title: 'Child', parentId: root.id }, BASE + 2);
    const grandchild = store.createDocPage({ title: 'Grandchild', parentId: child.id }, BASE + 3);
    const early = store.createDocPage({ title: 'Early', parentId: root.id }, BASE + 4);
    store.deleteDocPage(early.id, BASE + 10);
    expect(store.listDeletedDocPages().map(page => page.title)).toEqual(['Early']);
    expect(titles(store.listDocPages())).toEqual(['Root@0', '  Child@0', '    Grandchild@0', 'Sibling@1']);
    expect((await request(`/api/docs/${root.id}`, 'DELETE')).status).toBe(200);
    expect(store.listDeletedDocPages().map(page => page.title)).toEqual(['Root', 'Early']);
    expect(titles(store.listDocPages())).toEqual(['Sibling@0']);
    expect(store.getDocPage(grandchild.id).deletedAt).toBe(store.getDocPage(root.id).deletedAt);
    expect(store.getDocPage(early.id).deletedAt).toBe(BASE + 10);
    store.deleteDocPage(root.id, BASE + 11); // Idempotent: stamps stay as they were.
    expect(store.getDocPage(child.id).deletedAt).toBe(store.getDocPage(root.id).deletedAt);
    expect(await (await request('/api/docs/trash')).json()).toEqual(store.listDeletedDocPages());
    // A page whose parent is still trashed comes back at the root level, alone.
    expect((await request(`/api/docs/${child.id}/restore`, 'POST')).status).toBe(200);
    expect(titles(store.listDocPages())).toEqual(['Sibling@0', 'Child@1', '  Grandchild@0']);
    expect(store.getDocPage(child.id)).toMatchObject({ parentId: null, deletedAt: null });
    expect(store.getDocPage(grandchild.id)).toMatchObject({ parentId: child.id, deletedAt: null });
    expect(store.listDeletedDocPages().map(page => page.title)).toEqual(['Root', 'Early']);
    store.restoreDocPage(root.id, BASE + 12);
    expect(store.getDocPage(root.id)).toMatchObject({ parentId: null, position: 2, deletedAt: null });
    expect(store.listDeletedDocPages().map(page => page.title)).toEqual(['Early']);
    expect(store.restoreDocPage(root.id).deletedAt).toBeNull();
    expectError(() => store.purgeDocPage(root.id), 409);
    expect((await request(`/api/docs/${root.id}/purge`, 'POST')).status).toBe(409);
    expect(store.restoreDocPage(early.id)).toMatchObject({ parentId: root.id, position: 0, deletedAt: null });
    store.deleteDocPage(child.id, BASE + 20);
    await reopen();
    expect(store.listDeletedDocPages().map(page => page.title)).toEqual(['Child']);
    expect((await request(`/api/docs/${child.id}/purge`, 'POST')).status).toBe(200);
    expectError(() => store.getDocPage(child.id), 404);
    expectError(() => store.getDocPage(grandchild.id), 404);
    expectError(() => store.purgeDocPage(child.id), 404);
    expectError(() => store.restoreDocPage(child.id), 404);
    expectError(() => store.deleteDocPage(child.id), 404);
    expect((await request(`/api/docs/${child.id}`, 'DELETE')).status).toBe(404);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(titles(store.listDocPages())).toEqual(['Sibling@0', 'Root@1', '  Early@0']);
  });

  test('HTTP routes reject unsupported methods, content types and hosts like the rest of the API', async () => {
    const page = store.createDocPage({ title: 'Guarded' }, BASE);
    expect((await request('/api/docs', 'PUT', {})).status).toBe(404);
    expect((await request(`/api/docs/${page.id}/unknown`, 'POST')).status).toBe(404);
    expect((await request(`/api/docs/${page.id}`, 'PUT', { title: 'A', blocks: [], version: 1 }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await handler(new Request(`${ORIGIN}/api/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403);
    expect((await handler(new Request(`${ORIGIN}/api/docs/${page.id}`, { method: 'DELETE', headers: { origin: 'http://evil.example' } }))).status).toBe(403);
    expect(store.getDocPage(page.id)).toEqual(page);
  });
});

describe('documentation block helpers', () => {
  test('recognises Markdown shortcuts typed at the start of a block', () => {
    expect(docShortcut('# Title')).toEqual({ type: 'heading1', rest: 'Title' });
    expect(docShortcut('## ')).toEqual({ type: 'heading2', rest: '' });
    expect(docShortcut('### Deep')).toEqual({ type: 'heading3', rest: 'Deep' });
    expect(docShortcut('- item')).toEqual({ type: 'bulleted', rest: 'item' });
    expect(docShortcut('* item')).toEqual({ type: 'bulleted', rest: 'item' });
    expect(docShortcut('1. step')).toEqual({ type: 'numbered', rest: 'step' });
    expect(docShortcut('1) step')).toEqual({ type: 'numbered', rest: 'step' });
    expect(docShortcut('[] todo')).toEqual({ type: 'todo', rest: 'todo', checked: false });
    expect(docShortcut('[x] done')).toEqual({ type: 'todo', rest: 'done', checked: true });
    expect(docShortcut('> quote')).toEqual({ type: 'quote', rest: 'quote' });
    expect(docShortcut('```')).toEqual({ type: 'code', rest: '' });
    expect(docShortcut('---')).toEqual({ type: 'divider', rest: '' });
    for (const text of ['#Title', '2. step', '----', '```ts', 'plain - text', '[ ]', '']) expect(docShortcut(text)).toBeNull();
  });

  test('retypes blocks keeping only supported properties and numbers lists per level', () => {
    const todo = retypeDocBlock({ id: 'a', type: 'bulleted', text: 'x', indent: 2 }, 'todo');
    expect(todo).toEqual({ id: 'a', type: 'todo', text: 'x', checked: false, indent: 2 });
    expect(retypeDocBlock(todo, 'heading2')).toEqual({ id: 'a', type: 'heading2', text: 'x', indent: 2 });
    expect(retypeDocBlock({ id: 'b', type: 'paragraph', text: 'line' }, 'divider')).toEqual({ id: 'b', type: 'divider', text: '' });
    expect(retypeDocBlock({ id: 'c', type: 'quote', text: 'q' }, 'numbered')).toEqual({ id: 'c', type: 'numbered', text: 'q' });
    expect(createDocBlock('code', 'x')).toMatchObject({ type: 'code', text: 'x', language: '' });
    const blocks: DocBlock[] = [
      { id: '1', type: 'numbered', text: '', indent: 0 }, { id: '2', type: 'numbered', text: '', indent: 0 },
      { id: '2a', type: 'numbered', text: '', indent: 1 }, { id: '2b', type: 'bulleted', text: '', indent: 1 }, { id: '2c', type: 'numbered', text: '', indent: 1 },
      { id: '3', type: 'numbered', text: '', indent: 0 }, { id: 'p', type: 'paragraph', text: '' }, { id: '4', type: 'numbered', text: '', indent: 0 },
    ];
    expect([...docListNumbers(blocks)]).toEqual([['1', 1], ['2', 2], ['2a', 1], ['2c', 1], ['3', 3], ['4', 1]]);
  });

  test('builds outlines and trees and maps rendered carets back to raw Markdown', () => {
    expect(stripInlineMarkdown('**Bold** _em_ `code` [link](https://x.y) ~~gone~~ snake_case')).toBe('Bold em code link gone snake_case');
    expect(docHeadings([{ id: 'h', type: 'heading2', text: '**Setup**' }, { id: 'p', type: 'paragraph', text: 'text' }, { id: 'e', type: 'heading1', text: '  ' }]))
      .toEqual([{ id: 'h', level: 2, text: 'Setup' }, { id: 'e', level: 1, text: 'Без названия' }]);
    const raw = 'Say **hi** to [you](https://example.com)!';
    expect(docRawOffset(raw, 0)).toBe(0);
    expect(docRawOffset(raw, 4)).toBe(4); // before the markers that open "hi"
    expect(docRawOffset(raw, 5)).toBe(7); // between "h" and "i"
    expect(docRawOffset(raw, 6)).toBe(8); // after "hi", before the closing markers
    expect(docRawOffset(raw, 10)).toBe(14); // before the link text
    expect(docRawOffset(raw, 12)).toBe(17); // inside "you"
    expect(docRawOffset(raw, 13)).toBe(18); // after "you", still inside the link text
    expect(docRawOffset(raw, 14)).toBe(raw.length); // after "!"
    expect(docRawOffset(raw, 99)).toBe(raw.length);
    const summary = (id: string, parentId: string | null, position: number): DocPageSummary => ({ id, parentId, position, title: id, createdAt: 0, updatedAt: 0, deletedAt: null });
    const tree = buildDocTree([summary('b', null, 1), summary('a', null, 0), summary('a2', 'a', 1), summary('a1', 'a', 0), summary('orphan', 'gone', 0)]);
    // Position wins; the orphan shares position 0 with "a" and keeps its listing order behind it.
    expect(tree.map(node => [node.page.id, node.depth, node.children.map(child => child.page.id)])).toEqual([['a', 0, ['a1', 'a2']], ['orphan', 0, []], ['b', 0, []]]);
    expect(flattenDocTree(tree, id => id === 'a').map(node => node.page.id)).toEqual(['a', 'a1', 'a2', 'orphan', 'b']);
    expect(flattenDocTree(tree, () => false).map(node => node.page.id)).toEqual(['a', 'orphan', 'b']);
  });

  test('inline rendering keeps the comment hardening and never emits block elements', () => {
    const html = renderInlineMarkdown('**Жирный** `код` [x](https://e.com)\n<b>raw</b> [js](javascript:alert(1))');
    expect(html).toContain('<strong>Жирный</strong>');
    expect(html).toContain('<code>код</code>');
    expect(html).toContain('href="https://e.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('<br>\n');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('[js](javascript:alert(1))');
    expect(html).not.toMatch(/<(p|div|h\d|ul|ol|pre)[\s>]/);
  });
});
