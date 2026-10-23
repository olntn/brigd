/** A progress status is one short line on the card, e.g. «Сбор информации о проекте». */
export const RUN_PROGRESS_MAX_LENGTH = 120;

/** Collapses line breaks, control and bidi override characters into single spaces and trims the result. */
export const singleLine = (value: string): string => value.replace(/[\p{Cc}\p{Zl}\p{Zp}\s\u202A-\u202E\u2066-\u2069]+/gu, ' ').trim();

/** A single line (see singleLine); null when nothing printable is left or the line is too long. */
export function normalizeProgress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = singleLine(value);
  return text && text.length <= RUN_PROGRESS_MAX_LENGTH ? text : null;
}
