import type { DocBlock, DocBlockType, DocPageContentInput, DocPageCreateInput, DocPageMarkdownInput, DocPageMoveInput } from '../src/lib/types';
import { DOC_BLOCK_LIMIT, DOC_BLOCK_TEXT_LIMIT, DOC_CALLOUT_ICON_LIMIT, DOC_INDENT_LIMIT, DOC_LANGUAGE_LIMIT, DOC_MARKDOWN_LIMIT, DOC_PAGE_BYTES_LIMIT, DOC_PAGE_LIMIT, DOC_TABLE_CELL_LIMIT, DOC_TABLE_COLUMN_LIMIT, DOC_TABLE_ROW_LIMIT, DOC_TASK_PAGE_LIMIT, DOC_TITLE_LIMIT, isDocBlockType, isDocCalloutColor, isDocTextType } from '../src/lib/docs';
import { AppError } from './errors';

// JSON permits six-byte escapes for every UTF-16 code unit; the canonical page size is checked after parsing.
export const DOC_JSON_LIMIT = DOC_PAGE_BYTES_LIMIT * 6 + 4_096;
const ID = /^[a-zA-Z0-9-]{1,100}$/;
const UUID = /^[a-fA-F0-9-]{36}$/;
const LANGUAGE = /^[A-Za-z0-9+#._-]*$/;
const common = ['id', 'type', 'text', 'indent'];
const extra: Partial<Record<DocBlockType, string[]>> = {
  todo: ['checked'], code: ['language'], callout: ['icon', 'color'], toggle: ['collapsed'], table: ['rows', 'header'], image: ['imageId'], task: ['taskId'],
};

function object(value: unknown, allowed: string[], label = 'Ожидается JSON-объект'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(label);
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new AppError(`Допустимы только поля: ${allowed.join(', ')}`);
  return v;
}
const plain = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0');

export function validateDocTitle(value: unknown): string {
  if (!plain(value, DOC_TITLE_LIMIT)) throw new AppError(`Название страницы: не больше ${DOC_TITLE_LIMIT} символов без нулевых байтов`);
  return value.trim();
}
export function validateDocParentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw new AppError('Некорректная родительская страница');
  return value;
}
export function validateDocMarkdown(value: unknown): string {
  if (!plain(value, DOC_MARKDOWN_LIMIT)) throw new AppError(`markdown: до ${DOC_MARKDOWN_LIMIT} символов без нулевых байтов`);
  return value;
}
export function validateDocPageCreate(value: unknown): DocPageCreateInput {
  const v = object(value, ['title', 'parentId', 'markdown']);
  return { title: v.title === undefined ? '' : validateDocTitle(v.title), parentId: validateDocParentId(v.parentId), ...(v.markdown !== undefined ? { markdown: validateDocMarkdown(v.markdown) } : {}) };
}
export function validateDocPageMarkdown(value: unknown): DocPageMarkdownInput {
  const v = object(value, ['title', 'markdown']);
  if (!('title' in v) && !('markdown' in v)) throw new AppError('Укажите title или markdown');
  return { ...(v.title !== undefined ? { title: validateDocTitle(v.title) } : {}), ...(v.markdown !== undefined ? { markdown: validateDocMarkdown(v.markdown) } : {}) };
}
/** Pages a task points to as reference material. */
export function validateDocPageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > DOC_TASK_PAGE_LIMIT || value.some(id => typeof id !== 'string' || !ID.test(id))) {
    throw new AppError(`Документация: выберите не больше ${DOC_TASK_PAGE_LIMIT} страниц`);
  }
  if (new Set(value).size !== value.length) throw new AppError('Страницы документации не должны повторяться');
  return value as string[];
}

function validateDocBlock(value: unknown, index: number, ids: Set<string>): DocBlock {
  const label = `Блок ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(`${label}: ожидается объект`);
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID.test(v.id)) throw new AppError(`${label}: некорректный id`);
  if (ids.has(v.id)) throw new AppError(`${label}: id повторяется`);
  ids.add(v.id);
  if (!isDocBlockType(v.type)) throw new AppError(`${label}: неизвестный тип`);
  const type: DocBlockType = v.type;
  const allowed = [...common, ...(extra[type] ?? [])];
  const unknown = Object.keys(v).find(key => !allowed.includes(key));
  if (unknown) throw new AppError(`${label}: поле ${unknown} недопустимо для блока «${type}»`);
  if (!plain(v.text, DOC_BLOCK_TEXT_LIMIT)) throw new AppError(`${label}: текст до ${DOC_BLOCK_TEXT_LIMIT} символов без нулевых байтов`);
  if (!isDocTextType(type) && type !== 'image' && v.text !== '') throw new AppError(`${label}: у блока «${type}» нет текста`);
  const block: DocBlock = { id: v.id, type, text: v.text };
  if (v.indent !== undefined) {
    if (!Number.isInteger(v.indent) || (v.indent as number) < 0 || (v.indent as number) > DOC_INDENT_LIMIT) throw new AppError(`${label}: вложенность от 0 до ${DOC_INDENT_LIMIT}`);
    if ((v.indent as number) > 0) block.indent = v.indent as number;
  }
  const flag = (key: string, fallback: boolean) => {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new AppError(`${label}: ${key} должен быть boolean`);
    return v[key] === undefined ? fallback : v[key] as boolean;
  };
  if (type === 'todo') block.checked = flag('checked', false);
  if (type === 'toggle') block.collapsed = flag('collapsed', false);
  if (type === 'code') {
    if (v.language !== undefined && (typeof v.language !== 'string' || v.language.length > DOC_LANGUAGE_LIMIT || !LANGUAGE.test(v.language))) {
      throw new AppError(`${label}: язык до ${DOC_LANGUAGE_LIMIT} символов: буквы, цифры, +#._-`);
    }
    block.language = typeof v.language === 'string' ? v.language : '';
  }
  if (type === 'callout') {
    if (v.icon !== undefined && (!plain(v.icon, DOC_CALLOUT_ICON_LIMIT) || /[\n\r]/.test(v.icon))) throw new AppError(`${label}: иконка до ${DOC_CALLOUT_ICON_LIMIT} символов в одну строку`);
    if (v.color !== undefined && !isDocCalloutColor(v.color)) throw new AppError(`${label}: неизвестный цвет выноски`);
    block.icon = typeof v.icon === 'string' ? v.icon.trim() : '💡';
    block.color = isDocCalloutColor(v.color) ? v.color : 'gray';
  }
  if (type === 'table') {
    const rows = v.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > DOC_TABLE_ROW_LIMIT) throw new AppError(`${label}: таблица содержит от 1 до ${DOC_TABLE_ROW_LIMIT} строк`);
    const width = Array.isArray(rows[0]) ? rows[0].length : 0;
    if (width < 1 || width > DOC_TABLE_COLUMN_LIMIT) throw new AppError(`${label}: таблица содержит от 1 до ${DOC_TABLE_COLUMN_LIMIT} столбцов`);
    block.rows = rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== width) throw new AppError(`${label}: строка ${rowIndex + 1} должна содержать ${width} ячеек`);
      return row.map(value => {
        if (!plain(value, DOC_TABLE_CELL_LIMIT) || /[\n\r]/.test(value)) throw new AppError(`${label}: ячейка до ${DOC_TABLE_CELL_LIMIT} символов в одну строку`);
        return value;
      });
    });
    block.header = flag('header', true);
  }
  if (type === 'image') {
    if (v.imageId !== undefined && v.imageId !== null && (typeof v.imageId !== 'string' || !UUID.test(v.imageId))) throw new AppError(`${label}: некорректный идентификатор изображения`);
    block.imageId = typeof v.imageId === 'string' ? v.imageId : null;
  }
  if (type === 'task') {
    if (v.taskId !== undefined && v.taskId !== null && (typeof v.taskId !== 'string' || !UUID.test(v.taskId))) throw new AppError(`${label}: некорректный идентификатор задачи`);
    block.taskId = typeof v.taskId === 'string' ? v.taskId.toLowerCase() : null;
  }
  return block;
}

export function validateDocBlocks(value: unknown): DocBlock[] {
  if (!Array.isArray(value)) throw new AppError('blocks должен быть массивом');
  if (value.length > DOC_BLOCK_LIMIT) throw new AppError(`На одной странице допустимо не больше ${DOC_BLOCK_LIMIT} блоков. Разделите её на подстраницы.`);
  const ids = new Set<string>();
  return value.map((item, index) => validateDocBlock(item, index, ids));
}

export function docPageBytesOf(title: string, blocks: DocBlock[]): number {
  return Buffer.byteLength(JSON.stringify({ title, blocks }), 'utf8');
}
export function assertDocPageSize(title: string, blocks: DocBlock[]): void {
  if (docPageBytesOf(title, blocks) > DOC_PAGE_BYTES_LIMIT) throw new AppError(`Страница превышает ${Math.round(DOC_PAGE_BYTES_LIMIT / 1024)} КиБ. Вынесите часть содержимого на подстраницу.`);
}

export function validateDocPageContent(value: unknown): DocPageContentInput {
  const v = object(value, ['title', 'blocks', 'version']);
  if (!('title' in v) || !('blocks' in v) || !('version' in v)) throw new AppError('Укажите title, blocks и version страницы');
  const title = validateDocTitle(v.title);
  const blocks = validateDocBlocks(v.blocks);
  if (!Number.isInteger(v.version) || (v.version as number) < 1) throw new AppError('version должен быть целым числом от 1');
  assertDocPageSize(title, blocks);
  return { title, blocks, version: v.version as number };
}

export function validateDocPageMove(value: unknown): DocPageMoveInput {
  const v = object(value, ['parentId', 'position']);
  if (!('parentId' in v) && !('position' in v)) throw new AppError('Укажите parentId или position');
  const result: DocPageMoveInput = {};
  if ('parentId' in v) result.parentId = validateDocParentId(v.parentId);
  if ('position' in v) {
    if (!Number.isInteger(v.position) || (v.position as number) < 0 || (v.position as number) > DOC_PAGE_LIMIT) throw new AppError(`position: целое число от 0 до ${DOC_PAGE_LIMIT}`);
    result.position = v.position as number;
  }
  return result;
}

/** FTS5 query from free text: every word becomes a quoted prefix term, all required. */
export function docSearchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const terms = value.replace(/[^\p{L}\p{N}_\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
  return terms.length ? terms.map(term => `"${term}"*`).join(' ') : null;
}
