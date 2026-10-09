import { resolve, sep } from 'node:path';
import type { AppInfo } from '../src/lib/types';
import { Engine } from './engine';
import { AppError } from './store';
import { MAX_AVATAR_BYTES, validateAvatar } from './avatars';
import { textField, validateTask, validateWorker } from './validation';
import { TASK_JSON_LIMIT } from './workflows';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';
import { attachmentIds, attachmentDisposition, prepareAttachment } from './attachments';
import { INSTRUCTION_JSON_LIMIT, validateInstruction, validateInstructionPatch } from './instructions';
import { validateModel, validateModelPatch } from './models';

export interface HttpOptions { port: number; dev?: boolean; root?: string; startedAt?: number; allowedHosts?: string[]; allowedOrigins?: string[]; defaultCwd?: string; }
const JSON_LIMIT = 32_768;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: securityHeaders }); }
async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > limit) throw new AppError('Слишком большой запрос', 413);
  const reader = req.body?.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  if (reader) while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > limit) { await reader.cancel(); throw new AppError('Слишком большой запрос', 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function body(req: Request, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('Нужен Content-Type: application/json', 415);
  const bytes = await readBody(req, limit);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new AppError('Некорректный JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('Ожидается JSON-объект');
  return parsed as Record<string, unknown>;
}

export function createHandler(engine: Engine, options: HttpOptions) {
  const hostnames = new Set(options.allowedHosts ?? [`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set(options.allowedOrigins ?? [...hostnames].map(host => `http://${host}`));
  if (options.dev) { origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:5173'); }
  const dist = resolve(options.root ?? process.cwd(), 'dist');
  const startedAt = options.startedAt ?? Date.now();
  let uploading = 0;
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
      if (path === '/api/uploads' && method === 'POST') {
        if (uploading >= 4) throw new AppError('Слишком много одновременных загрузок. Повторите через несколько секунд.', 429);
        uploading++;
        try {
          const name = url.searchParams.get('name') ?? '';
          const data = await readBody(req, ATTACHMENT_MAX_BYTES);
          const prepared = await prepareAttachment(data, req.headers.get('content-type') ?? 'application/octet-stream', name);
          return json(engine.store.stageAttachment(prepared), 201);
        } finally { uploading--; }
      }
      const uploadMatch = path.match(/^\/api\/uploads\/([a-zA-Z0-9-]+)$/);
      if (uploadMatch && method === 'DELETE') { engine.store.deleteStagedAttachment(uploadMatch[1]!); return json({ ok: true }); }
      const attachmentMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/attachments\/([a-zA-Z0-9-]+)$/);
      if (attachmentMatch && (method === 'GET' || method === 'HEAD')) {
        const [, taskId, attachmentId] = attachmentMatch;
        const metadata = engine.store.getAttachment(taskId!, attachmentId!);
        const preview = url.searchParams.get('preview') === '1' && url.searchParams.get('download') !== '1';
        if (preview && !metadata.previewable) throw new AppError('У этого файла нет безопасного предпросмотра', 415);
        const value = method === 'HEAD' ? null : preview ? engine.store.readAttachmentPreview(taskId!, attachmentId!) : engine.store.readAttachment(taskId!, attachmentId!);
        const inline = preview;
        return new Response(method === 'HEAD' ? null : value!.data as BodyInit, { headers: {
          ...securityHeaders,
          'Content-Type': preview ? 'image/png' : metadata.mime,
          'Content-Length': String(preview ? method === 'HEAD' ? engine.store.attachmentPreviewSize(taskId!, attachmentId!) : value!.data.byteLength : metadata.size),
          'Content-Disposition': attachmentDisposition(metadata.name, inline),
          'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
          'Cross-Origin-Resource-Policy': 'same-origin'
        } });
      }
      if (path === '/api/avatars' && method === 'POST') {
        const mime = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        const data = await readBody(req, MAX_AVATAR_BYTES);
        validateAvatar(data, mime);
        return json({ avatarUrl: engine.store.saveAvatar(data, mime) }, 201);
      }
      const avatarMatch = path.match(/^\/api\/avatars\/([a-f0-9]{64})$/);
      if (avatarMatch && (method === 'GET' || method === 'HEAD')) {
        const avatar = engine.store.getAvatar(avatarMatch[1]!);
        return new Response(method === 'HEAD' ? null : new Uint8Array(avatar.data), { headers: { ...securityHeaders, 'Content-Type': avatar.mime, 'Content-Length': String(avatar.data.byteLength), 'Content-Disposition': 'inline' } });
      }
      if (path === '/api/models' && method === 'GET') return json(engine.store.listModels());
      if (path === '/api/models' && method === 'POST') return json(engine.store.createModel(validateModel(await body(req))), 201);
      const modelMatch = path.match(/^\/api\/models\/([a-zA-Z0-9-]+)$/);
      if (modelMatch) {
        const id = modelMatch[1]!;
        if (method === 'GET') return json(engine.store.getModel(id));
        if (method === 'PATCH') return json(engine.store.updateModel(id, validateModelPatch(await body(req))));
        if (method === 'DELETE') { engine.store.deleteModel(id); return json({ ok: true }); }
      }
      if (path === '/api/workers' && method === 'GET') return json(engine.store.listWorkers());
      if (path === '/api/workers' && method === 'POST') return json(engine.store.createWorker(validateWorker(await body(req))), 201);
      const workerMatch = path.match(/^\/api\/workers\/([a-zA-Z0-9-]+)$/);
      if (workerMatch) {
        const id = workerMatch[1]!;
        if (method === 'GET') return json(engine.store.getWorker(id));
        if (method === 'PATCH') {
          const current = engine.store.getWorker(id), patch = await body(req);
          // A provider-only edit must not carry an incompatible old model across.
          const model = patch.model === undefined && patch.provider !== undefined && patch.provider !== current.provider ? null : current.model;
          return json(engine.store.updateWorker(id, validateWorker({ ...current, model, ...patch })));
        }
        if (method === 'DELETE') return json(engine.store.archiveWorker(id));
      }
      if (path === '/api/instructions' && method === 'GET') return json(engine.store.listInstructions());
      if (path === '/api/instructions' && method === 'POST') return json(engine.store.createInstruction(validateInstruction(await body(req, INSTRUCTION_JSON_LIMIT))), 201);
      const instructionMatch = path.match(/^\/api\/instructions\/([a-zA-Z0-9-]+)$/);
      if (instructionMatch) {
        const id = instructionMatch[1]!;
        if (method === 'GET') return json(engine.store.getInstruction(id));
        if (method === 'PATCH') return json(engine.store.updateInstruction(id, validateInstructionPatch(await body(req, INSTRUCTION_JSON_LIMIT))));
        if (method === 'DELETE') { engine.store.deleteInstruction(id); return json({ ok: true }); }
      }
      if (path === '/api/tasks' && method === 'GET') return json(engine.store.listTasks());
      if (path === '/api/tasks' && method === 'POST') return json(engine.store.createTask(await validateTask(await body(req, TASK_JSON_LIMIT))), 201);
      const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(run|comments))?$/);
      if (taskMatch) {
        const [, id, action] = taskMatch;
        if (!action && method === 'GET') return json(engine.store.detail(id));
        if (!action && method === 'PATCH') {
          const current = engine.store.getTask(id);
          const patch = await body(req, TASK_JSON_LIMIT);
          // Stopping a schedule must remain possible after its project mount disappears.
          if (Object.keys(patch).length === 1 && 'paused' in patch) {
            if (typeof patch.paused !== 'boolean') throw new AppError('paused должен быть boolean');
            return json(engine.store.updateTask(id, { ...current, paused: patch.paused }));
          }
          return json(engine.store.updateTask(id, await validateTask({ ...current, ...patch })));
        }
        if (action === 'run' && method === 'POST') { await body(req); return json(engine.start(id), 201); }
        if (action === 'comments' && method === 'POST') {
          const value = await body(req);
          const ids = attachmentIds(value.attachmentIds);
          const text = (value.body === undefined || value.body === '') && ids.length ? '' : textField(value.body, 'Комментарий', 8_000);
          return json(engine.store.comment(id, null, 'user', text, Date.now(), undefined, ids), 201);
        }
      }
      const runMatch = path.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/(resume|cancel|retry)$/);
      if (runMatch && method === 'POST') {
        const [, id, action] = runMatch;
        const value = await body(req);
        if (action === 'cancel') return json(engine.cancel(id, value.acknowledgeInterruption === true));
        if (action === 'retry') return json(engine.retry(id, value.acknowledgeInterruption === true));
        const ids = attachmentIds(value.attachmentIds);
        const answer = (value.answer === undefined || value.answer === '') && ids.length ? 'Ответ приложен во вложениях.' : textField(value.answer, 'Ответ', 8_000);
        return json(engine.resume(id, answer, value.acknowledgeInterruption === true, ids));
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
