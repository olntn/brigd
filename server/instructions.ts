import type { InstructionInput, InstructionSnapshot } from '../src/lib/types';
import { INSTRUCTION_BODY_LIMIT, INSTRUCTION_COUNT_LIMIT, INSTRUCTION_ENABLED_BYTES_LIMIT, INSTRUCTION_ENABLED_TEXT_LIMIT, INSTRUCTION_TITLE_LIMIT } from '../src/lib/instructions';
import { AppError } from './errors';

// JSON permits six-byte escapes for every UTF-16 code unit. Keep this larger
// body limit specific to instruction writes; ordinary API routes stay unchanged.
export const INSTRUCTION_JSON_LIMIT = (INSTRUCTION_TITLE_LIMIT + INSTRUCTION_BODY_LIMIT) * 6 + 1_024;
const fields = new Set(['title', 'body', 'enabled']);

function instructionText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new AppError(`${label}: введите от 1 до ${limit} символов без нулевых байтов`);
  }
  return value.trim();
}

export function validateInstructionPatch(value: unknown): Partial<InstructionInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (!keys.length || keys.some(key => !fields.has(key))) throw new AppError('Укажите только название, текст или enabled инструкции');
  const result: Partial<InstructionInput> = {};
  if ('title' in v) result.title = instructionText(v.title, 'Название инструкции', INSTRUCTION_TITLE_LIMIT);
  if ('body' in v) result.body = instructionText(v.body, 'Текст инструкции', INSTRUCTION_BODY_LIMIT);
  if ('enabled' in v) {
    if (typeof v.enabled !== 'boolean') throw new AppError('enabled должен быть boolean');
    result.enabled = v.enabled;
  }
  return result;
}

export function validateInstruction(value: unknown): InstructionInput {
  const input = validateInstructionPatch(value);
  if (input.title === undefined || input.body === undefined || input.enabled === undefined) {
    throw new AppError('Укажите название, текст и enabled инструкции');
  }
  return input as InstructionInput;
}

/** Validate both stored aggregates and direct adapter inputs without truncation. */
export function validateInstructionSnapshots(value: unknown): asserts value is InstructionSnapshot[] {
  if (!Array.isArray(value) || value.length > INSTRUCTION_COUNT_LIMIT) throw new AppError(`Допустимо не больше ${INSTRUCTION_COUNT_LIMIT} инструкций`);
  let characters = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'title', 'body'].includes(key)) ||
        typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.id)) throw new AppError('Некорректный снимок инструкции');
    instructionText(item.title, 'Название инструкции', INSTRUCTION_TITLE_LIMIT);
    instructionText(item.body, 'Текст инструкции', INSTRUCTION_BODY_LIMIT);
    characters += item.title.length + item.body.length;
  }
  if (characters > INSTRUCTION_ENABLED_TEXT_LIMIT) throw new AppError(`Во включённых инструкциях допускается не больше ${INSTRUCTION_ENABLED_TEXT_LIMIT} символов вместе с названиями. Сократите текст или выключите часть инструкций.`);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > INSTRUCTION_ENABLED_BYTES_LIMIT) {
    throw new AppError(`Включённые инструкции превышают ${INSTRUCTION_ENABLED_BYTES_LIMIT} байт с учётом JSON-кодирования. Сократите текст или сохраните инструкцию выключенной.`);
  }
}
