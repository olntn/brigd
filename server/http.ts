import { homedir } from 'node:os';
import { closeSync, createReadStream, fstatSync, openSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { AppInfo, GeneralSettings } from '../src/lib/types';
import { Engine } from './engine';
import { AppError } from './store';
import { MAX_AVATAR_BYTES, validateAvatar } from './avatars';
import { textField, validateAutopilot, validateIntegratorProfile, validateTask, validateWorker } from './validation';
import { TASK_JSON_LIMIT } from './workflows';
import { ATTACHMENT_MAX_BYTES } from '../src/lib/attachments';
import { attachmentIds, attachmentDisposition, prepareAttachment, renderAttachmentView } from './attachments';
import { INSTRUCTION_JSON_LIMIT, validateInstruction, validateInstructionPatch } from './instructions';
import { DOC_JSON_LIMIT } from './docs';
import { validateModel, validateModelPatch } from './models';
import { validateFollowup } from './followups';
import { validateTag, validateTagPatch, validateTaskTags } from './tags';
import { claudeStatus, codexStatus, configureClaude, configureCodex } from './cli-config';
import { validateIntegrationChecks } from '../src/lib/integration-checks';
import { BackupManager, BACKUP_MAX_BYTES } from './backups';

export interface HttpOptions { port: number; dev?: boolean; root?: string; startedAt?: number; allowedHosts?: string[]; allowedOrigins?: string[]; defaultCwd?: string;
  /** Home folder whose ~/.claude and ~/.codex the CLI setup buttons check and edit. */
  cliHome?: string;
  updateBackupDir?: string;
  backupManager?: BackupManager;
  restoreBackup?: (backups: BackupManager, id: string) => Promise<void>;
  /** Recheck an invocation-scoped internal caller immediately before writes. */
  authorizeMutation?: () => void;
}
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
async function readJsonBody(req: Request, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('Нужен Content-Type: application/json', 415);
  const bytes = await readBody(req, limit);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new AppError('Некорректный JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('Ожидается JSON-объект');
  return parsed as Record<string, unknown>;
}

export function createHandler(engine: Engine, options: HttpOptions) {
  const body = async (req: Request, limit?: number) => {
    const value = await readJsonBody(req, limit);
    options.authorizeMutation?.();
    return value;
  };
  const hostnames = new Set(options.allowedHosts ?? [`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set(options.allowedOrigins ?? [...hostnames].map(host => `http://${host}`));
  if (options.dev) { origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:5173'); }
  const dist = resolve(options.root ?? process.cwd(), 'dist');
  const startedAt = options.startedAt ?? Date.now();
  const cliHome = options.cliHome ?? homedir();
  const generalSettings = (): GeneralSettings => ({
    defaultCwd: engine.store.getDefaultCwd() ?? options.defaultCwd ?? process.cwd(),
    defaultSchedule: engine.store.getDefaultSchedule(),
    fallbackWorkers: engine.store.getFallbackWorkers(),
  });
  let uploading = 0;
  let backupUploading = false;
  let backups = options.backupManager;
  const backupManager = () => backups ??= new BackupManager({ dbPath: engine.store.db.filename,
    updateBackupDir: options.updateBackupDir ?? resolve(options.root ?? process.cwd(), '.brigd-updates/backup') });
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
      if (path === '/api/backups' && method === 'GET') return json(backupManager().list());
      if (path === '/api/backups' && method === 'POST') {
        const value = await body(req);
        if (Object.keys(value).length) throw new AppError('Ожидается пустой JSON-объект');
        return json(backupManager().create(), 201);
      }
      if (path === '/api/backups/upload' && method === 'POST') {
        if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') {
          throw new AppError('Нужен Content-Type: application/octet-stream', 415);
        }
        if (backupUploading) throw new AppError('Дождитесь завершения загрузки бэкапа.', 429);
        let name: string;
        try { name = decodeURIComponent(req.headers.get('x-backup-name') ?? ''); }
        catch { throw new AppError('Некорректное имя бэкапа'); }
        backupUploading = true;
        try { return json(backupManager().upload(await readBody(req, BACKUP_MAX_BYTES), name), 201); }
        finally { backupUploading = false; }
      }
      const backupMatch = path.match(/^\/api\/backups\/([^/]+)(?:\/(select|download))?$/);
      if (backupMatch) {
        const action = backupMatch[2];
        let id: string;
        try { id = decodeURIComponent(backupMatch[1]!); }
        catch { throw new AppError('Бэкап не найден', 404); }
        const manager = backupManager();
        if (action === 'download' && (method === 'GET' || method === 'HEAD')) {
          const backup = manager.download(id!);
          // Hold this inode so an automatic refresh cannot replace a download in progress.
          const fd = openSync(backup.path, 'r');
          let stream: ReadableStream | null;
          let size: number;
          try {
            size = fstatSync(fd).size;
            if (method === 'HEAD') { closeSync(fd); stream = null; }
            else stream = Readable.toWeb(createReadStream(backup.path, { fd, autoClose: true })) as unknown as ReadableStream;
          } catch (error) { closeSync(fd); throw error; }
          return new Response(stream, { headers: { ...securityHeaders,
            'Content-Type': 'application/vnd.sqlite3', 'Content-Length': String(size),
            'Content-Disposition': attachmentDisposition(backup.name), 'Cross-Origin-Resource-Policy': 'same-origin',
          } });
        }
        if (!action && method === 'PATCH') {
          const value = await body(req);
          if (Object.keys(value).length !== 1 || (!Object.hasOwn(value, 'autoUpdate') && !Object.hasOwn(value, 'name'))) {
            throw new AppError('Укажите одно поле: name или autoUpdate');
          }
          return json(Object.hasOwn(value, 'name') ? manager.rename(id, value.name) : manager.setAutoUpdate(id, value.autoUpdate));
        }
        if (action === 'select' && method === 'POST') {
          const value = await body(req);
          if (Object.keys(value).length) throw new AppError('Ожидается пустой JSON-объект');
          if (!options.restoreBackup) throw new AppError('Восстановление недоступно для этого запуска сервера.', 503);
          await options.restoreBackup(manager, id!);
          return json(manager.list().backups.find(backup => backup.id === id));
        }
        if (!action && method === 'DELETE') {
          await body(req);
          manager.delete(id!);
          return json({ ok: true });
        }
      }
      if (path === '/api/info' && method === 'GET') {
        const info: AppInfo = { mode: engine.mock ? 'mock' : 'cli', cwd: generalSettings().defaultCwd, scheduler: 'running', startedAt,
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
        const download = url.searchParams.get('download') === '1';
        const preview = url.searchParams.get('preview') === '1' && !download;
        const view = url.searchParams.get('view') === '1' && !download && !preview;
        if ((preview || view) && !metadata.previewable) throw new AppError('У этого файла нет безопасного предпросмотра', 415);
        // The full-size view is rendered on demand from the verified raster; like the preview it is never the raw original.
        const rendered = view ? await renderAttachmentView(engine.store.readAttachment(taskId!, attachmentId!).data, metadata.mime, metadata.sha256) : null;
        const value = method === 'HEAD' ? null : rendered ?? (preview ? engine.store.readAttachmentPreview(taskId!, attachmentId!) : engine.store.readAttachment(taskId!, attachmentId!));
        const inline = preview || view;
        return new Response(method === 'HEAD' ? null : value!.data as BodyInit, { headers: {
          ...securityHeaders,
          'Content-Type': rendered ? rendered.mime : preview ? 'image/png' : metadata.mime,
          'Content-Length': String(rendered ? rendered.data.byteLength : preview ? method === 'HEAD' ? engine.store.attachmentPreviewSize(taskId!, attachmentId!) : value!.data.byteLength : metadata.size),
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
      if (path === '/api/cli-config' && method === 'GET') return json({ claude: claudeStatus(cliHome), codex: codexStatus(cliHome) });
      const cliMatch = path.match(/^\/api\/cli-config\/(claude|codex)$/);
      if (cliMatch && method === 'POST') { await body(req); return json(cliMatch[1] === 'claude' ? configureClaude(cliHome) : configureCodex(cliHome)); }
      if (path === '/api/settings/permissions' && method === 'GET') return json(engine.getCliAccessSettings());
      if (path === '/api/settings/permissions' && method === 'PATCH') {
        const value = await body(req);
        if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'mode')) throw new AppError('Укажите только поле mode');
        return json(engine.setCliAccessSettings({ mode: value.mode }));
      }
      if (path === '/api/settings/general' && method === 'GET') return json(generalSettings());
      if (path === '/api/settings/general' && method === 'PATCH') {
        const value = await body(req);
        engine.store.updateGeneralSettings(value);
        return json(generalSettings());
      }
      if (path === '/api/settings/autopilot' && method === 'GET') return json(engine.getAutopilotSettings());
      if (path === '/api/settings/autopilot' && method === 'PATCH') {
        const value = await body(req, 128_128);
        if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'integrationChecks')) throw new AppError('Укажите только поле integrationChecks');
        let integrationChecks: string[][] | null;
        try { integrationChecks = value.integrationChecks === null ? null : validateIntegrationChecks(value.integrationChecks); }
        catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректный BRIGD_INTEGRATION_CHECKS'); }
        return json(engine.setAutopilotSettings({ integrationChecks }));
      }
      if (path === '/api/autopilot' && method === 'GET') return json(engine.store.autopilotOverview());
      if (path === '/api/autopilot' && method === 'PATCH') return json(engine.setAutopilot(validateAutopilot(await body(req))));
      if (path === '/api/integrator' && method === 'GET') return json(engine.store.getIntegratorProfile());
      if (path === '/api/integrator' && method === 'PATCH') {
        const current = engine.store.getIntegratorProfile(), patch = await body(req);
        const model = patch.model === undefined && patch.provider !== undefined && patch.provider !== current.provider ? null : current.model;
        return json(engine.store.updateIntegratorProfile(validateIntegratorProfile({ ...current, model, ...patch })));
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
      if (path === '/api/docs' && method === 'GET') return json(engine.store.listDocPages());
      if (path === '/api/docs' && method === 'POST') return json(engine.store.createDocPage(await body(req, DOC_JSON_LIMIT)), 201);
      if (path === '/api/docs/trash' && method === 'GET') return json(engine.store.listDeletedDocPages());
      if (path === '/api/docs/search' && method === 'GET') return json(engine.store.searchDocPages(url.searchParams.get('q') ?? ''));
      const docImageMatch = path.match(/^\/api\/docs\/([a-zA-Z0-9-]+)\/images(?:\/([a-zA-Z0-9-]+))?$/);
      if (docImageMatch && !docImageMatch[2] && method === 'POST') {
        if (uploading >= 4) throw new AppError('Слишком много одновременных загрузок. Повторите через несколько секунд.', 429);
        uploading++;
        try {
          const name = url.searchParams.get('name') ?? '';
          const data = await readBody(req, ATTACHMENT_MAX_BYTES);
          options.authorizeMutation?.();
          const prepared = await prepareAttachment(data, req.headers.get('content-type') ?? 'application/octet-stream', name);
          return json(engine.store.addDocImage(docImageMatch[1]!, prepared), 201);
        } finally { uploading--; }
      }
      if (docImageMatch && docImageMatch[2] && (method === 'GET' || method === 'HEAD')) {
        const { image, data } = engine.store.readDocImage(docImageMatch[1]!, docImageMatch[2]!);
        // Image bytes never change for an id, so the browser may keep them for a day.
        return new Response(method === 'HEAD' ? null : data as BodyInit, { headers: { ...securityHeaders, 'Cache-Control': 'private, max-age=86400',
          'Content-Type': image.mime, 'Content-Length': String(image.size), 'Content-Disposition': attachmentDisposition(image.name, true),
          'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' } });
      }
      const docMatch = path.match(/^\/api\/docs\/([a-zA-Z0-9-]+)(?:\/(restore|purge|export|markdown))?$/);
      if (docMatch) {
        const [, id, action] = docMatch;
        if (!action && method === 'GET') return json(engine.store.getDocPage(id!));
        if (!action && method === 'PUT') return json(engine.store.saveDocPage(id!, await body(req, DOC_JSON_LIMIT) as never));
        if (!action && method === 'PATCH') return json(engine.store.moveDocPage(id!, await body(req)));
        if (!action && method === 'DELETE') { options.authorizeMutation?.(); engine.store.deleteDocPage(id!); return json({ ok: true }); }
        if (action === 'export' && method === 'GET') return json(engine.store.exportDocPage(id!));
        if (action === 'markdown' && method === 'PUT') return json(engine.store.saveDocPageMarkdown(id!, await body(req, DOC_JSON_LIMIT)));
        if (action === 'restore' && method === 'POST') { await body(req); return json(engine.store.restoreDocPage(id!)); }
        if (action === 'purge' && method === 'POST') { await body(req); engine.store.purgeDocPage(id!); return json({ ok: true }); }
      }
      if (path === '/api/tags' && method === 'GET') return json(engine.store.listTags());
      if (path === '/api/tags' && method === 'POST') return json(engine.store.createTag(validateTag(await body(req))), 201);
      const tagMatch = path.match(/^\/api\/tags\/([a-zA-Z0-9-]+)$/);
      if (tagMatch) {
        const id = tagMatch[1]!;
        if (method === 'GET') return json(engine.store.getTag(id));
        if (method === 'PATCH') return json(engine.store.updateTag(id, validateTagPatch(await body(req))));
        if (method === 'DELETE') { engine.store.deleteTag(id); return json({ ok: true }); }
      }
      if (path === '/api/tasks' && method === 'GET') return json(engine.store.listTasks(url.searchParams.get('tagId') ?? undefined));
      if (path === '/api/tasks' && method === 'POST') {
        const input = await validateTask(await body(req, TASK_JSON_LIMIT));
        options.authorizeMutation?.();
        return json(engine.store.createTask(input), 201);
      }
      const taskMatch = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)(?:\/(run|comments|followups|archive|restore|tags))?$/);
      if (taskMatch) {
        const [, id, action] = taskMatch;
        if (!action && method === 'GET') return json(engine.store.detail(id));
        if (!action && method === 'PATCH') {
          const current = engine.store.getTask(id);
          const patch = await body(req, TASK_JSON_LIMIT);
          if (Object.keys(patch).length === 1 && 'tagIds' in patch) return json(engine.store.setTaskTags(id, validateTaskTags(patch)));
          // Stopping a schedule must remain possible after its project mount disappears.
          if (Object.keys(patch).length === 1 && 'paused' in patch) {
            if (typeof patch.paused !== 'boolean') throw new AppError('paused должен быть boolean');
            return json(engine.store.updateTask(id, { ...current, paused: patch.paused }));
          }
          const input = await validateTask({ ...current, ...patch });
          options.authorizeMutation?.();
          return json(engine.store.updateTask(id, input));
        }
        if (action === 'tags' && method === 'PATCH') return json(engine.store.setTaskTags(id, validateTaskTags(await body(req))));
        if (action === 'run' && method === 'POST') { await body(req); return json(engine.start(id), 201); }
        if (action === 'archive' && method === 'POST') { await body(req); return json(engine.store.archiveTask(id)); }
        if (action === 'restore' && method === 'POST') { await body(req); return json(engine.store.restoreTask(id)); }
        if (action === 'followups' && method === 'POST') return json(engine.followup(id, validateFollowup(await body(req))), 201);
        if (action === 'comments' && method === 'POST') {
          const value = await body(req);
          const ids = attachmentIds(value.attachmentIds);
          const text = (value.body === undefined || value.body === '') && ids.length ? '' : textField(value.body, 'Комментарий', 8_000);
          return json(engine.store.comment(id, null, 'user', text, Date.now(), undefined, ids), 201);
        }
      }
      const diffMatch = path.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/diff$/);
      if (diffMatch && method === 'GET') return json(engine.codeDiffs.get(engine.store.getRun(diffMatch[1]!)));
      const runMatch = path.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/(resume|cancel|retry|integrate|cancel-integration|reconcile)$/);
      if (runMatch && method === 'POST') {
        const [, id, action] = runMatch;
        const value = await body(req);
        if (action === 'integrate') return json(engine.integrate(id, value.acknowledgeInterruption === true));
        if (action === 'reconcile') return json(engine.reconcile(id), 201);
        if (action === 'cancel-integration') return json(engine.cancelIntegration(id, value.acknowledgeInterruption === true));
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
