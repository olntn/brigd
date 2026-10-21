import type { DocBlock, DocBlockType, DocCalloutColor, DocPageSummary } from './types';

export const DOC_TITLE_LIMIT = 140;
export const DOC_BLOCK_TEXT_LIMIT = 16_000;
export const DOC_BLOCK_LIMIT = 2_000;
export const DOC_PAGE_BYTES_LIMIT = 512 * 1024;
export const DOC_DEPTH_LIMIT = 8;
export const DOC_PAGE_LIMIT = 5_000;
export const DOC_INDENT_LIMIT = 4;
export const DOC_LANGUAGE_LIMIT = 40;
export const DOC_CALLOUT_ICON_LIMIT = 16;
export const DOC_TABLE_ROW_LIMIT = 100;
export const DOC_TABLE_COLUMN_LIMIT = 20;
export const DOC_TABLE_CELL_LIMIT = 2_000;
export const DOC_IMAGE_MAX_COUNT = 50;
export const DOC_IMAGES_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
/** An image nobody references for this long is removed on the next page save or upload. */
export const DOC_IMAGE_ORPHAN_TTL_MS = 60 * 60 * 1000;
export const DOC_MARKDOWN_LIMIT = 256 * 1024;
export const DOC_TASK_PAGE_LIMIT = 20;
export const DOC_SEARCH_LIMIT = 20;
export const DOC_UNTITLED = 'Без названия';
export const DOC_CALLOUT_COLORS: readonly DocCalloutColor[] = ['gray', 'blue', 'green', 'yellow', 'red'];
export const DOC_CALLOUT_COLOR_LABELS: Record<DocCalloutColor, string> = { gray: 'Серый', blue: 'Синий', green: 'Зелёный', yellow: 'Жёлтый', red: 'Красный' };
export const DOC_CALLOUT_ICONS = ['💡', '📌', '⚠️', '✅', '❗', '📝', '🔧', '🚀'];

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
  { type: 'todo', label: 'Чекбокс', hint: 'Пункт, который можно отметить', keywords: ['todo', 'task', 'check', 'чекбокс', 'галочка'], shortcut: '[] ' },
  { type: 'toggle', label: 'Раскрывающийся блок', hint: 'Скрывает вложенные блоки', keywords: ['toggle', 'details', 'раскрывающийся', 'свернуть', 'спойлер'], shortcut: null },
  { type: 'quote', label: 'Цитата', hint: 'Выделенный фрагмент', keywords: ['quote', 'цитата'], shortcut: '> ' },
  { type: 'callout', label: 'Выноска', hint: 'Заметка с иконкой и фоном', keywords: ['callout', 'note', 'выноска', 'заметка', 'важно'], shortcut: null },
  { type: 'code', label: 'Код', hint: 'Моноширинный блок без форматирования', keywords: ['code', 'код', 'pre'], shortcut: '```' },
  { type: 'table', label: 'Таблица', hint: 'Строки и столбцы с текстом', keywords: ['table', 'таблица'], shortcut: null },
  { type: 'image', label: 'Изображение', hint: 'PNG, JPEG, WebP или GIF из файла', keywords: ['image', 'picture', 'photo', 'изображение', 'картинка', 'фото'], shortcut: null },
  { type: 'task', label: 'Задача', hint: 'Карточка задачи brigd со статусом', keywords: ['task', 'card', 'задача', 'карточка'], shortcut: null },
  { type: 'toc', label: 'Оглавление', hint: 'Список заголовков этой страницы', keywords: ['toc', 'contents', 'оглавление', 'содержание'], shortcut: null },
  { type: 'divider', label: 'Разделитель', hint: 'Горизонтальная линия', keywords: ['divider', 'hr', 'line', 'разделитель', 'линия'], shortcut: '---' },
];
const kinds = new Map(DOC_BLOCK_KINDS.map(kind => [kind.type, kind]));
const LIST_TYPES = new Set<DocBlockType>(['bulleted', 'numbered', 'todo']);
const TEXT_TYPES = new Set<DocBlockType>(['paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered', 'todo', 'quote', 'code', 'callout', 'toggle']);

export const isDocBlockType = (value: unknown): value is DocBlockType => typeof value === 'string' && kinds.has(value as DocBlockType);
export const isDocListType = (type: DocBlockType): boolean => LIST_TYPES.has(type);
/** Types edited through the shared text field; the others carry structured content. */
export const isDocTextType = (type: DocBlockType): boolean => TEXT_TYPES.has(type);
export const isDocCalloutColor = (value: unknown): value is DocCalloutColor => typeof value === 'string' && (DOC_CALLOUT_COLORS as readonly string[]).includes(value);
export const docBlockKind = (type: DocBlockType): DocBlockKind => kinds.get(type)!;
export const docPageTitle = (page: { title: string }): string => page.title.trim() || DOC_UNTITLED;

function typeDefaults(block: DocBlock, source?: DocBlock) {
  switch (block.type) {
    case 'todo': block.checked = source?.checked ?? false; break;
    case 'code': block.language = source?.language ?? ''; break;
    case 'callout': block.icon = source?.icon ?? DOC_CALLOUT_ICONS[0]!; block.color = source?.color ?? 'gray'; break;
    case 'toggle': block.collapsed = source?.collapsed ?? false; break;
    case 'table': block.rows = source?.rows ?? [['', '', ''], ['', '', '']]; block.header = source?.header ?? true; break;
    case 'image': block.imageId = source?.imageId ?? null; break;
    case 'task': block.taskId = source?.taskId ?? null; break;
  }
}
export function createDocBlock(type: DocBlockType = 'paragraph', text = ''): DocBlock {
  const block: DocBlock = { id: crypto.randomUUID(), type, text: TEXT_TYPES.has(type) || type === 'image' ? text : '' };
  typeDefaults(block);
  return block;
}
/** Change a block's type in place, keeping only the properties the new type supports. */
export function retypeDocBlock(block: DocBlock, type: DocBlockType): DocBlock {
  const next: DocBlock = { id: block.id, type, text: TEXT_TYPES.has(type) || type === 'image' ? block.text : '' };
  if (block.indent) next.indent = block.indent;
  typeDefaults(next, block);
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
    const indent = block.indent ?? 0;
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

/** Blocks hidden under collapsed toggles: everything deeper that follows a collapsed toggle until the nesting returns. */
export function docHiddenBlockIds(blocks: DocBlock[]): Set<string> {
  const hidden = new Set<string>();
  let hideBelow: number | null = null;
  for (const block of blocks) {
    const indent = block.indent ?? 0;
    if (hideBelow !== null) {
      if (indent > hideBelow) { hidden.add(block.id); continue; }
      hideBelow = null;
    }
    if (block.type === 'toggle' && block.collapsed) hideBelow = indent;
  }
  return hidden;
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

/** Everything searchable on a page, one block per line. */
export function docSearchText(blocks: DocBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'table') return (block.rows ?? []).map(row => row.map(cell => stripInlineMarkdown(cell)).join(' ')).join('\n');
    if (block.type === 'code') return block.text;
    if (block.type === 'callout') return `${block.icon ?? ''} ${stripInlineMarkdown(block.text)}`.trim();
    return stripInlineMarkdown(block.text);
  }).filter(Boolean).join('\n');
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
