import { t } from './i18n';
import { isBuiltinWorker } from './workers';

/** Built-in workers keep their Russian name and description in data; show them in the interface language. */
export function localWorker<W extends { id: string; name: string; description?: string | null }>(worker: W): W {
  if (!isBuiltinWorker(worker.id)) return worker;
  return { ...worker, name: t(worker.name), ...(worker.description ? { description: t(worker.description) } : {}) };
}
