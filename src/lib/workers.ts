import type { Effort, Provider } from './types';

/** Deliberately conservative, provider-specific choices; no cross-provider aliases. */
export const effortOptions: Record<Provider, readonly Effort[]> = {
  codex: ['default', 'low', 'medium', 'high', 'xhigh'],
  claude: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export const effortLabels: Record<Effort, string> = {
  default: 'По умолчанию CLI',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  xhigh: 'Очень высокий',
  max: 'Максимальный',
};

export function effortLabel(effort: Effort): string { return effortLabels[effort]; }
