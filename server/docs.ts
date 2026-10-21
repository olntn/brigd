import type { DocBlock, DocBlockType, DocPageContentInput, DocPageCreateInput, DocPageMoveInput } from '../src/lib/types';
import { DOC_BLOCK_LIMIT, DOC_BLOCK_TEXT_LIMIT, DOC_INDENT_LIMIT, DOC_LANGUAGE_LIMIT, DOC_PAGE_BYTES_LIMIT, DOC_PAGE_LIMIT, DOC_TITLE_LIMIT, isDocBlockType, isDocListType } from '../src/lib/docs';
import { AppError } from './errors';

// JSON permits six-byte escapes for every UTF-16 code unit; the canonical page size is checked after parsing.
export const DOC_JSON_LIMIT = DOC_PAGE_BYTES_LIMIT * 6 + 4_096;
const ID = /^[a-zA-Z0-9-]{1,100}$/;
const LANGUAGE = /^[A-Za-z0-9+#._-]*$/;
const blockFields = new Set(['id', 'type', 'text', 'checked', 'language', 'indent']);

function object(value: unknown, allowed: string[], label = 'Ожидается JSON-объект'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(label);
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new AppError(`Допустимы только поля: ${allowed.join(', ')}`);
  return v;
}

export function validateDocTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length > DOC_TITLE_LIMIT || value.includes('\0')) {
    throw new AppError(`Название страницы: не больше ${DOC_TITLE_LIMIT} символов без нулевых байтов`);
  }
  return value.trim();
}

export function validateDocParentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw new AppError('Некорректная родительская страница');
  return value;
}

export function validateDocPageCreate(value: unknown): DocPageCreateInput {
  const v = object(value, ['title', 'parentId']);
  return { title: v.title === undefined ? '' : validateDocTitle(v.title), parentId: validateDocParentId(v.parentId) };
}

function validateDocBlock(value: unknown, index: number, ids: Set<string>): DocBlock {
  const label = `Блок ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(`${label}: ожидается объект`);
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !blockFields.has(key))) throw new AppError(`${label}: неизвестное поле`);
  if (typeof v.id !== 'string' || !ID.test(v.id)) throw new AppError(`${label}: некорректный id`);
  if (ids.has(v.id)) throw new AppError(`${label}: id повторяется`);
  ids.add(v.id);
  if (!isDocBlockType(v.type)) throw new AppError(`${label}: неизвестный тип`);
  const type: DocBlockType = v.type;
  if (typeof v.text !== 'string' || v.text.length > DOC_BLOCK_TEXT_LIMIT || v.text.includes('\0')) {
    throw new AppError(`${label}: текст до ${DOC_BLOCK_TEXT_LIMIT} символов без нулевых байтов`);
  }
  if (type === 'divider' && v.text !== '') throw new AppError(`${label}: у разделителя нет текста`);
  const block: DocBlock = { id: v.id, type, text: v.text };
  if (type === 'todo') {
    if (v.checked !== undefined && typeof v.checked !== 'boolean') throw new AppError(`${label}: checked должен быть boolean`);
    block.checked = v.checked === true;
  } else if (v.checked !== undefined) throw new AppError(`${label}: checked допустим только у чекбокса`);
  if (type === 'code') {
    if (v.language !== undefined && (typeof v.language !== 'string' || v.language.length > DOC_LANGUAGE_LIMIT || !LANGUAGE.test(v.language))) {
      throw new AppError(`${label}: язык до ${DOC_LANGUAGE_LIMIT} символов: буквы, цифры, +#._-`);
    }
    block.language = typeof v.language === 'string' ? v.language : '';
  } else if (v.language !== undefined) throw new AppError(`${label}: language допустим только у кода`);
  if (isDocListType(type)) {
    if (v.indent !== undefined && (!Number.isInteger(v.indent) || (v.indent as number) < 0 || (v.indent as number) > DOC_INDENT_LIMIT)) {
      throw new AppError(`${label}: вложенность от 0 до ${DOC_INDENT_LIMIT}`);
    }
    block.indent = typeof v.indent === 'number' ? v.indent : 0;
  } else if (v.indent !== undefined) throw new AppError(`${label}: вложенность допустима только у списков`);
  return block;
}

export function validateDocBlocks(value: unknown): DocBlock[] {
  if (!Array.isArray(value)) throw new AppError('blocks должен быть массивом');
  if (value.length > DOC_BLOCK_LIMIT) throw new AppError(`На одной странице допустимо не больше ${DOC_BLOCK_LIMIT} блоков. Разделите её на подстраницы.`);
  const ids = new Set<string>();
  return value.map((item, index) => validateDocBlock(item, index, ids));
}

export function validateDocPageContent(value: unknown): DocPageContentInput {
  const v = object(value, ['title', 'blocks', 'version']);
  if (!('title' in v) || !('blocks' in v) || !('version' in v)) throw new AppError('Укажите title, blocks и version страницы');
  const title = validateDocTitle(v.title);
  const blocks = validateDocBlocks(v.blocks);
  if (!Number.isInteger(v.version) || (v.version as number) < 1) throw new AppError('version должен быть целым числом от 1');
  const bytes = Buffer.byteLength(JSON.stringify({ title, blocks }), 'utf8');
  if (bytes > DOC_PAGE_BYTES_LIMIT) throw new AppError(`Страница превышает ${Math.round(DOC_PAGE_BYTES_LIMIT / 1024)} КиБ. Вынесите часть содержимого на подстраницу.`);
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
