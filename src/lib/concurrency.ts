import type { ConcurrencyLimits } from './types';

export const CONCURRENCY_LIMIT_MAX = 32;
/** Built-in values when neither the settings nor BRIGD_MAX_PARALLEL / BRIGD_MAX_PER_REPOSITORY say otherwise. */
export const DEFAULT_CONCURRENCY: ConcurrencyLimits = { maxParallel: 4, maxPerRepository: 1 };
export const CONCURRENCY_LABELS: Record<keyof ConcurrencyLimits, string> = {
  maxParallel: 'Всего процессов',
  maxPerRepository: 'Задач одновременно в одном репозитории',
};

export function isConcurrencyLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CONCURRENCY_LIMIT_MAX;
}
export function validateConcurrencyLimit(value: unknown, field: keyof ConcurrencyLimits): number {
  if (!isConcurrencyLimit(value)) throw new Error(`${CONCURRENCY_LABELS[field]}: целое число от 1 до ${CONCURRENCY_LIMIT_MAX}`);
  return value;
}
