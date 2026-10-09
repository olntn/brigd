import { resolve, sep } from 'node:path';
import type { AppInfo } from '../src/lib/types';
import { Engine } from './engine';
import { AppError } from './store';
import { textField, validateTask } from './validation';

export interface HttpOptions { port: number; dev?: boolean; root?: string; startedAt?: number; allowedHosts?: string[]; allowedOrigins?: string[]; defaultCwd?: string; }
const JSON_LIMIT = 32_768;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: securityHeaders }); }
async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('Нужен Content-Type: application/json', 415);
  if (Number(req.headers.get('content-length')) > JSON_LIMIT) throw new AppError('Слишком большой запрос', 413);
  const reader = req.body?.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  if (reader) while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > JSON_LIMIT) { await reader.cancel(); throw new AppError('Слишком большой запрос', 413); }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Некорректный JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('Ожидается JSON-объект');
  return parsed as Record<string, unknown>;
}

export function createHandler(engine: Engine, options: HttpOptions) {
  const hostnames = new Set(options.allowedHosts ?? [`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set(options.allowedOrigins ?? [...hostnames].map(host => `http://${host}`));
  if (options.dev) { origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:5173'); }
  const dist = resolve(options.root ?? process.cwd(), 'dist');
  const startedAt = options.startedAt ?? Date.now();
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      if (!hostnames.has(req.headers.get('host') ?? url.host)) throw new AppError('Недопустимый Host', 403);
      const origin = req.headers.get('origin');
      if (origin && !origins.has(origin)) throw new AppError('Недопустимый Origin', 403);
      if (req.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('Межсайтовые запросы запрещены', 403);
      if (!['GET', 'HEAD'].includes(req.method) && (!origin || !origins.has(origin))) throw new AppError('Изменения разрешены только из локального интерфейса (Origin обязателен)', 403);
      const path = url.pathname;
      const method = req.method;
      if (path === '/api/info' && method === 'GET') {
        const info: AppInfo = { mode: engine.mock ? 'mock' : 'cli', cwd: options.defaultCwd ?? process.cwd(), scheduler: 'running', startedAt,
          providers: [{ id: 'codex', available: engine.mock || !!Bun.which('codex'), label: 'Codex' }, { id: 'claude', available: engine.mock || !!Bun.which('claude'), label: 'Claude Code' }] };
        return json(info);
      }
      if (path === '/api/tasks' && method === 'GET') return json(engine.store.listTasks());
      if (path === '/api/tasks' && method === 'POST') return json(engine.store.createTask(await validateTask(await body(req))), 201);
      const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(run|comments))?$/);
      if (taskMatch) {
        const [, id, action] = taskMatch;
        if (!action && method === 'GET') return json(engine.store.detail(id));
        if (!action && method === 'PATCH') {
          const current = engine.store.getTask(id);
          const patch = await body(req);
          // Stopping a schedule must remain possible after its project mount disappears.
          if (Object.keys(patch).length === 1 && 'paused' in patch) {
            if (typeof patch.paused !== 'boolean') throw new AppError('paused должен быть boolean');
            return json(engine.store.updateTask(id, { ...current, paused: patch.paused }));
          }
          return json(engine.store.updateTask(id, await validateTask({ ...current, ...patch })));
        }
        if (action === 'run' && method === 'POST') { await body(req); return json(engine.start(id), 201); }
        if (action === 'comments' && method === 'POST') return json(engine.store.comment(id, null, 'user', textField((await body(req)).body, 'Комментарий', 8_000)), 201);
      }
      const runMatch = path.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/(resume|cancel)$/);
      if (runMatch && method === 'POST') {
        const [, id, action] = runMatch;
        const value = await body(req);
        return json(action === 'cancel' ? engine.cancel(id) : engine.resume(id, textField(value.answer, 'Ответ', 8_000), value.acknowledgeInterruption === true));
      }
      if (path.startsWith('/api/')) throw new AppError('Маршрут не найден', 404);
      if (method !== 'GET' && method !== 'HEAD') throw new AppError('Метод не поддерживается', 405);
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { throw new AppError('Некорректный URL'); }
      const filePath = resolve(dist, `.${decoded}`);
      if (filePath !== dist && !filePath.startsWith(dist + sep)) throw new AppError('Недопустимый путь', 403);
      const file = Bun.file(filePath);
      const candidate = await file.exists() && (await file.stat()).isFile() ? file : Bun.file(resolve(dist, 'index.html'));
      if (!(await candidate.exists())) return new Response('brigd: выполните bun run build или запустите bun run dev (http://127.0.0.1:5173).', { status: 503, headers: securityHeaders });
      return new Response(method === 'HEAD' ? null : candidate, { headers: { ...securityHeaders, 'Content-Type': candidate.type } });
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Внутренняя ошибка. Подробности в терминале сервиса.' }, 500);
    }
  };
}
