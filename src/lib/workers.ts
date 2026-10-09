import type { Effort, ModelCatalogEntry, Provider } from './types';

export const MODEL_ID_LIMIT = 128;
export const MODEL_LABEL_LIMIT = 80;
export const MODEL_CATALOG_PROVIDER_LIMIT = 100;

/** Documented IDs, not an account-specific availability list. Custom IDs stay supported.
 * Verified with Codex 0.162.0 / Claude Code 2.1.295 and their model documentation:
 * https://learn.chatgpt.com/docs/models
 * https://code.claude.com/docs/en/model-config
 */
export const modelPresets: Record<Provider, readonly { id: string; label: string }[]> = {
  codex: [
    { id: 'gpt-6.1-sol', label: 'Sol 6.1' },
    { id: 'gpt-6-astra', label: 'Astra' },
    { id: 'gpt-6-luna', label: 'Luna' },
  ],
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  ],
};

/** A single bounded argv value. Permit native aliases, dated IDs, and cloud-provider IDs. */
export function normalizeModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('ID модели должен быть текстом без управляющих символов.');
  const model = value.replace(/^ +| +$/g, '');
  if (!model) return null;
  if (model.length > MODEL_ID_LIMIT || !/^[A-Za-z0-9][A-Za-z0-9._:/+@\[\]-]*$/.test(model)) {
    throw new Error(`ID модели: до ${MODEL_ID_LIMIT} символов, без пробелов; начните с буквы или цифры. Допустимы буквы, цифры и . _ : / + @ [ ] -`);
  }
  return model;
}

export function modelLabel(model?: string | null, catalog?: readonly ModelCatalogEntry[], provider?: Provider): string {
  if (!model) return 'По умолчанию CLI';
  if (catalog) return catalog.find(option => option.modelId === model && (!provider || option.provider === provider))?.label ?? model;
  return [...modelPresets.codex, ...modelPresets.claude].find(option => option.id === model)?.label ?? model;
}

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
