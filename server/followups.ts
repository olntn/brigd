import type { FollowupInput, RunCheckFailure } from '../src/lib/types';
import { CHECK_HANDBACK_OUTPUT_LIMIT } from '../src/lib/check-triage';
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

/** Colours, cursor movement and other terminal control sequences in a check's output; tabs and line breaks stay. */
const CONTROL = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/**
 * The end of a failed command's output, as handed back to the worker: readable text within the follow-up request's limit,
 * so the prompt stays bounded however the project's tools print. The beginning is cut, as in the merge record.
 */
export function handbackOutput(output: string, truncated: boolean): Pick<RunCheckFailure, 'output' | 'outputTruncated'> {
  let text = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(CONTROL, '');
  if (text.length <= CHECK_HANDBACK_OUTPUT_LIMIT) return { output: text, outputTruncated: truncated };
  text = text.slice(-CHECK_HANDBACK_OUTPUT_LIMIT);
  // A cut between the halves of a surrogate pair would leave half a character.
  if (/^[\udc00-\udfff]/.test(text)) text = text.slice(1);
  return { output: text, outputTruncated: true };
}
