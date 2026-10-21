import type { DocBlock, DocBlockType, DocPageSummary } from './types';

export const DOC_TITLE_LIMIT = 140;
export const DOC_BLOCK_TEXT_LIMIT = 16_000;
export const DOC_BLOCK_LIMIT = 2_000;
export const DOC_PAGE_BYTES_LIMIT = 512 * 1024;
export const DOC_DEPTH_LIMIT = 8;
export const DOC_PAGE_LIMIT = 5_000;
export const DOC_INDENT_LIMIT = 4;
export const DOC_LANGUAGE_LIMIT = 40;
export const DOC_UNTITLED = 'Без названия';

export interface DocBlockKind {
  type: DocBlockType;
  label: string;
  hint: string;
  /** Lowercase search terms for the block menu, Latin and Cyrillic. */
  keywords: string[];
  /** What to type at the start of a block to get this type, shown as a hint. */
  shortcut: string | null;
}
export const DOC_BLOCK_KINDS: readonly DocBlockKind[] = [
  { type: 'paragraph', label: 'Текст', hint: 'Обычный абзац', keywords: ['text', 'paragraph', 'текст', 'абзац'], shortcut: null },
  { type: 'heading1', label: 'Заголовок 1', hint: 'Крупный заголовок раздела', keywords: ['h1', 'heading', 'заголовок'], shortcut: '# ' },
  { type: 'heading2', label: 'Заголовок 2', hint: 'Заголовок подраздела', keywords: ['h2', 'heading', 'заголовок'], shortcut: '## ' },
  { type: 'heading3', label: 'Заголовок 3', hint: 'Небольшой заголовок', keywords: ['h3', 'heading', 'заголовок'], shortcut: '### ' },
  { type: 'bulleted', label: 'Маркированный список', hint: 'Список с точками', keywords: ['list', 'bullet', 'список', 'маркированный'], shortcut: '- ' },
  { type: 'numbered', label: 'Нумерованный список', hint: 'Список с номерами', keywords: ['list', 'numbered', 'ordered', 'список', 'нумерованный'], shortcut: '1. ' },
  { type: 'todo', label: 'Чекбокс', hint: 'Пункт, который можно отметить', keywords: ['todo', 'task', 'check', 'чекбокс', 'задача', 'галочка'], shortcut: '[] ' },
  { type: 'quote', label: 'Цитата', hint: 'Выделенный фрагмент', keywords: ['quote', 'цитата'], shortcut: '> ' },
  { type: 'code', label: 'Код', hint: 'Моноширинный блок без форматирования', keywords: ['code', 'код', 'pre'], shortcut: '```' },
  { type: 'divider', label: 'Разделитель', hint: 'Горизонтальная линия', keywords: ['divider', 'hr', 'line', 'разделитель', 'линия'], shortcut: '---' },
];
const kinds = new Map(DOC_BLOCK_KINDS.map(kind => [kind.type, kind]));
const LIST_TYPES = new Set<DocBlockType>(['bulleted', 'numbered', 'todo']);

export const isDocBlockType = (value: unknown): value is DocBlockType => typeof value === 'string' && kinds.has(value as DocBlockType);
export const isDocListType = (type: DocBlockType): boolean => LIST_TYPES.has(type);
export const docBlockKind = (type: DocBlockType): DocBlockKind => kinds.get(type)!;
export const docPageTitle = (page: { title: string }): string => page.title.trim() || DOC_UNTITLED;

export function createDocBlock(type: DocBlockType = 'paragraph', text = ''): DocBlock {
  const block: DocBlock = { id: crypto.randomUUID(), type, text: type === 'divider' ? '' : text };
  if (type === 'todo') block.checked = false;
  if (type === 'code') block.language = '';
  if (LIST_TYPES.has(type)) block.indent = 0;
  return block;
}

/** Change a block's type in place, keeping only the properties the new type supports. */
export function retypeDocBlock(block: DocBlock, type: DocBlockType): DocBlock {
  const next: DocBlock = { id: block.id, type, text: type === 'divider' ? '' : block.text };
  if (type === 'todo') next.checked = block.checked ?? false;
  if (type === 'code') next.language = block.language ?? '';
  if (LIST_TYPES.has(type)) next.indent = LIST_TYPES.has(block.type) ? block.indent ?? 0 : 0;
  return next;
}

export interface DocShortcut { type: DocBlockType; rest: string; checked?: boolean; }
/** A Markdown prefix typed at the start of a block converts it, Notion-style. */
export function docShortcut(text: string): DocShortcut | null {
  if (text === '```') return { type: 'code', rest: '' };
  if (text === '---') return { type: 'divider', rest: '' };
  const patterns: [RegExp, DocBlockType][] = [
    [/^# /, 'heading1'], [/^## /, 'heading2'], [/^### /, 'heading3'],
    [/^[-*] /, 'bulleted'], [/^1[.)] /, 'numbered'], [/^> /, 'quote'],
  ];
  for (const [pattern, type] of patterns) {
    const match = text.match(pattern);
    if (match) return { type, rest: text.slice(match[0].length) };
  }
  const todo = text.match(/^\[( |x|X)?\] /);
  if (todo) return { type: 'todo', rest: text.slice(todo[0].length), checked: /x/i.test(todo[1] ?? '') };
  return null;
}

/** Numbers for numbered items: consecutive items at one level count up; anything else at that level or above restarts. */
export function docListNumbers(blocks: DocBlock[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const counters: number[] = [];
  for (const block of blocks) {
    const indent = LIST_TYPES.has(block.type) ? block.indent ?? 0 : 0;
    if (block.type === 'numbered') {
      counters[indent] = (counters[indent] ?? 0) + 1;
      numbers.set(block.id, counters[indent]!);
      counters.length = indent + 1;
    } else {
      counters.length = Math.min(counters.length, indent);
    }
  }
  return numbers;
}

/** Plain text of inline Markdown for outlines and labels; a display heuristic, not a parser. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DocHeading { id: string; level: 1 | 2 | 3; text: string; }
export function docHeadings(blocks: DocBlock[]): DocHeading[] {
  const headings: DocHeading[] = [];
  for (const block of blocks) {
    const level = block.type === 'heading1' ? 1 : block.type === 'heading2' ? 2 : block.type === 'heading3' ? 3 : null;
    if (level) headings.push({ id: block.id, level, text: stripInlineMarkdown(block.text) || DOC_UNTITLED });
  }
  return headings;
}

/** Map a caret offset in rendered text back to the raw Markdown: emphasis markers and link targets are invisible. */
export function docRawOffset(raw: string, visible: number): number {
  let seen = 0;
  for (let index = 0; index < raw.length; index++) {
    if (seen >= visible) return index;
    const char = raw[index]!;
    if (char === '*' || char === '~' || char === '`') continue;
    if (char === '_' && (index === 0 || index === raw.length - 1 || !/\w/.test(raw[index - 1]!) || !/\w/.test(raw[index + 1]!))) continue;
    if (char === '[' && raw.indexOf('](', index) !== -1) continue;
    if (char === ']' && raw[index + 1] === '(') {
      const close = raw.indexOf(')', index);
      if (close === -1) return raw.length;
      index = close;
      continue;
    }
    seen++;
  }
  return raw.length;
}

export interface DocTreeNode { page: DocPageSummary; children: DocTreeNode[]; depth: number; }
/** Sibling order follows position; pages whose parent is missing from the list appear at the root. */
export function buildDocTree(pages: DocPageSummary[]): DocTreeNode[] {
  const ids = new Set(pages.map(page => page.id));
  const byParent = new Map<string | null, DocPageSummary[]>();
  for (const page of pages) {
    const key = page.parentId !== null && ids.has(page.parentId) ? page.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), page]);
  }
  const build = (parent: string | null, depth: number, seen: Set<string>): DocTreeNode[] =>
    (byParent.get(parent) ?? []).filter(page => !seen.has(page.id)).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt).map(page => {
      const next = new Set(seen).add(page.id);
      return { page, depth, children: build(page.id, depth + 1, next) };
    });
  return build(null, 0, new Set());
}

/** Depth-first order of the tree as the sidebar shows it, honouring collapsed nodes. */
export function flattenDocTree(nodes: DocTreeNode[], expanded: (id: string) => boolean): DocTreeNode[] {
  const result: DocTreeNode[] = [];
  const walk = (items: DocTreeNode[]) => { for (const node of items) { result.push(node); if (node.children.length && expanded(node.page.id)) walk(node.children); } };
  walk(nodes);
  return result;
}

export const docPageBytes = (title: string, blocks: DocBlock[]): number => new TextEncoder().encode(JSON.stringify({ title, blocks })).byteLength;
