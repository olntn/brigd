import type { ModelCatalogInput } from '../src/lib/types';
import { MODEL_LABEL_LIMIT, normalizeModel } from '../src/lib/workers';
import { AppError } from './errors';

const fields = new Set(['provider', 'modelId', 'label']);

/** The catalog stores suggestions, never references from workers or snapshots. */
export function validateModelPatch(value: unknown): Partial<ModelCatalogInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Ожидается JSON-объект');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (!keys.length || keys.some(key => !fields.has(key))) throw new AppError('Укажите только provider, modelId или label модели');
  const result: Partial<ModelCatalogInput> = {};
  if (Object.hasOwn(v, 'provider')) {
    if (v.provider !== 'codex' && v.provider !== 'claude') throw new AppError('Неизвестный провайдер модели');
    result.provider = v.provider;
  }
  if (Object.hasOwn(v, 'modelId')) {
    let modelId: string | null;
    try { modelId = normalizeModel(v.modelId); }
    catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректный ID модели'); }
    if (!modelId) throw new AppError('Укажите непустой ID модели');
    result.modelId = modelId;
  }
  if (Object.hasOwn(v, 'label')) {
    if (typeof v.label !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(v.label)) {
      throw new AppError('Название модели должно быть текстом без управляющих символов');
    }
    const label = v.label.trim();
    if (!label || label.length > MODEL_LABEL_LIMIT) throw new AppError(`Название модели: от 1 до ${MODEL_LABEL_LIMIT} символов`);
    result.label = label;
  }
  return result;
}

export function validateModel(value: unknown): ModelCatalogInput {
  const input = validateModelPatch(value);
  if (input.provider === undefined || input.modelId === undefined || input.label === undefined) {
    throw new AppError('Укажите provider, modelId и label модели');
  }
  return input as ModelCatalogInput;
}
