/** Shared fetch wrapper for the documentation section: keeps the HTTP status so a 409 can be told from other failures. */
export class DocsRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function docsRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.method && options.method !== 'GET' ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  });
  let result: { error?: string } & T;
  try { result = await response.json(); } catch { throw new DocsRequestError('Сервер вернул неожиданный ответ. Попробуйте ещё раз.', response.status); }
  if (!response.ok) throw new DocsRequestError(result.error || `Ошибка запроса (${response.status})`, response.status);
  return result;
}

export const docsFailureMessage = (failure: unknown): string => failure instanceof TypeError
  ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
  : failure instanceof Error ? failure.message : 'Не удалось сохранить изменения. Попробуйте ещё раз.';
