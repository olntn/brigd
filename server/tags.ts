import type { TagInput } from '../src/lib/types';
import { DEFAULT_TAG_COLOR, TAG_COUNT_LIMIT, TAG_NAME_LIMIT } from '../src/lib/tags';
import { AppError } from './errors';

export function validateTagPatch(value: unknown): Partial<TagInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => key !== 'name' && key !== 'color')) throw new AppError('Укажите только название или цвет тега');
  const patch: Partial<TagInput> = {};
  if ('name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > TAG_NAME_LIMIT || input.name.includes('\0')) {
      throw new AppError(`Название тега: введите от 1 до ${TAG_NAME_LIMIT} символов`);
    }
    patch.name = input.name.trim();
  }
  if ('color' in input) {
    if (typeof input.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(input.color)) throw new AppError('Цвет тега: укажите HEX в формате #RRGGBB');
    patch.color = input.color.toLowerCase();
  }
  return patch;
}

export function validateTag(value: unknown): Required<TagInput> {
  const input = validateTagPatch(value);
  if (input.name === undefined) throw new AppError('Укажите название тега');
  return { name: input.name, color: input.color ?? DEFAULT_TAG_COLOR };
}

/** SQLite NOCASE handles only ASCII; normalize Unicode names before comparing. */
export function tagNameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('ru-RU');
}

export function validateTagIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TAG_COUNT_LIMIT || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id))) {
    throw new AppError(`tagIds: укажите массив не больше чем из ${TAG_COUNT_LIMIT} идентификаторов тегов`);
  }
  return [...new Set(value as string[])];
}

export function validateTaskTags(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('tagIds' in value)) {
    throw new AppError('Укажите только tagIds задачи');
  }
  return validateTagIds((value as Record<string, unknown>).tagIds);
}
