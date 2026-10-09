import type { FollowupInput } from '../src/lib/types';
import { attachmentIds } from './attachments';
import { AppError } from './errors';

export const followupRequestText = (body: string): string => body.trim() || 'Запрос на продолжение приложен во вложениях.';

/** Shared by the HTTP boundary and Store: callers cannot bypass validation. */
export function validateFollowup(value: unknown): FollowupInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается запрос на продолжение');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'attachmentIds,body,requestId,sourceRunId,sourceStepIndex') throw new AppError('Укажите исходный запуск, этап, текст, вложения и ID запроса');
  if (typeof input.sourceRunId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.sourceRunId)) throw new AppError('Некорректный исходный запуск');
  if (input.sourceStepIndex !== null && (!Number.isSafeInteger(input.sourceStepIndex) || (input.sourceStepIndex as number) < 0)) throw new AppError('Укажите номер исходного этапа или null');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) throw new AppError('Некорректный ID запроса');
  if (!Array.isArray(input.attachmentIds)) throw new AppError('Вложения должны быть массивом');
  const ids = attachmentIds(input.attachmentIds);
  if (typeof input.body !== 'string' || (!input.body.trim() && !ids.length) || input.body.length > 8_000 || input.body.includes('\0')) throw new AppError('Продолжение: введите от 1 до 8000 символов или приложите файлы');
  return { sourceRunId: input.sourceRunId, sourceStepIndex: input.sourceStepIndex as number | null,
    // Preserve the submitted bytes for idempotency; presentation is normalized
    // only when committing the request comment and historical metadata.
    body: input.body, attachmentIds: ids, requestId: input.requestId };
}
