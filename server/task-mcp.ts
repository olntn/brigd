import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, fchmodSync, mkdtempSync, chmodSync, existsSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'bun';
import type { Attachment, Run, Task } from '../src/lib/types';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from '../src/lib/attachments';
import { AppError, type RunFence, type Store } from './store';
import { attachmentName, prepareAttachment } from './attachments';
import { commitPaths, commitWorkspace } from './commits';
import { createTaskAppController, type TaskAppAccess } from './task-mcp-app';
import { MAX_TASK_IMAGE_BYTES, MAX_TASK_READ_BYTES, MAX_TASK_REQUEST_BYTES, MAX_TASK_RESULT_BYTES, MAX_TASK_RESULT_TOTAL_BYTES, MAX_TASK_TOOL_CALLS, TASK_MCP_TOOLS, type TaskAttachmentContext, type TaskBridgeConfig, type TaskBrokerRequest, type TaskToolResult } from './task-mcp-protocol';
export type { TaskBridgeConfig } from './task-mcp-protocol';
export type { TaskAppAccess } from './task-mcp-app';

const text = (value: unknown): TaskToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const failure = (message: string): TaskToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });
const expired = () => failure('Task attachment capability is unavailable or expired. Stop using this task bridge.');
const context = (a: Attachment): TaskAttachmentContext => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, previewable: a.previewable });
const taskContext = (task: Task) => ({ id: task.id, title: task.title, instruction: task.instruction, status: task.status,
  archived: task.archivedAt !== null, createdAt: task.createdAt, updatedAt: task.updatedAt,
  provider: task.provider, cwd: task.cwd, schedule: task.schedule, paused: task.paused, priority: task.priority, intervalMinutes: task.intervalMinutes,
  firstRunAt: task.firstRunAt, nextRunAt: task.nextRunAt, workerId: task.workerId, tagIds: task.tagIds, steps: task.steps,
  latestRunId: task.latestRun?.id ?? null, hasCompletedRun: task.hasCompletedRun ?? false });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const BUNDLED_HELPER = fileURLToPath(new URL('../dist/task-mcp-stdio.js', import.meta.url));
const SOURCE_HELPER = fileURLToPath(new URL('./task-mcp-stdio.ts', import.meta.url));
// The helper's tool catalogue lives in server/*.ts and imports src/lib/*.ts; a bundle older than any of them may lack current tools.
const HELPER_SOURCES = ['./', '../src/lib/'].map(path => fileURLToPath(new URL(path, import.meta.url)));
/** The packaged helper starts faster, but only a bundle built after every source it could include is used.
 * `bun run dev` never rebuilds dist: after an update a stale bundle would hide new task tools that the prompt already asks the agent to call. */
export function taskHelperPath(bundled = BUNDLED_HELPER, sources = HELPER_SOURCES, fallback = SOURCE_HELPER): string {
  try {
    const built = statSync(bundled).mtimeMs;
    for (const directory of sources) for (const name of readdirSync(directory)) {
      if (name.endsWith('.ts') && statSync(join(directory, name)).mtimeMs > built) return fallback;
    }
    return bundled;
  } catch { return fallback; }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AppError('Invalid task tool arguments.');
  return value;
}
function string(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new AppError(`Invalid ${label}.`);
  return value;
}
function integer(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AppError('Invalid bounded read or page range.');
  return value;
}

/** A flat, descriptor-anchored outbox. Refusing nested paths avoids traversal races
 * on platforms without an openat API. Linux /proc/self/fd pins the parent inode,
 * even if the visible directory is swapped while a generated file is opening. */
export class TaskOutputDirectory {
  readonly path: string;
  private fd: number;
  private identity: ReturnType<typeof fstatSync>;
  private materializations = new Map<string, { ino: number; dev: number; size: number; sha256: string }>();
  private materializedBytes = 0;
  constructor(cwd: string, prefix = '.brigd-outbox-') {
    if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) throw new AppError('Secure task attachment publication requires Linux /proc/self/fd.', 503);
    this.path = mkdtempSync(join(cwd, prefix));
    chmodSync(this.path, 0o700);
    this.fd = openSync(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.identity = fstatSync(this.fd);
  }
  read(relative: string): Buffer {
    if (this.fd < 0) throw new AppError('Task output directory is closed.', 409);
    if (attachmentName(relative) !== relative || relative.includes('/') || relative.includes('\\')) throw new AppError('Use a single relative filename in the task output directory.');
    const assertRoot = () => {
      const visible = lstatSync(this.path), pinned = fstatSync(this.fd);
      if (!visible.isDirectory() || visible.isSymbolicLink() || visible.dev !== this.identity.dev || visible.ino !== this.identity.ino || pinned.ino !== this.identity.ino || pinned.nlink < 1) {
        throw new AppError('Task output directory changed during publication.');
      }
    };
    assertRoot();
    // O_NONBLOCK prevents a FIFO substituted for a file from hanging the app.
    const fd = openSync(`/proc/self/fd/${this.fd}/${relative}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > ATTACHMENT_MAX_BYTES) throw new AppError('Only regular, single-link output files within the attachment size limit can be published.');
      const data = Buffer.alloc(before.size);
      let position = 0;
      while (position < data.byteLength) {
        const n = readSync(fd, data, position, Math.min(64 * 1024, data.byteLength - position), position);
        if (!n) throw new AppError('Output file changed during publication.');
        position += n;
      }
      const after = fstatSync(fd);
      if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AppError('Output file changed during publication.');
      assertRoot();
      const visible = lstatSync(`/proc/self/fd/${this.fd}/${relative}`);
      if (!visible.isFile() || visible.nlink !== 1 || visible.dev !== after.dev || visible.ino !== after.ino) throw new AppError('Output file changed during publication.');
      return data;
    } finally { closeSync(fd); }
  }
  materialize(data: Uint8Array, extension: string): string {
    if (this.fd < 0 || data.byteLength > ATTACHMENT_MAX_BYTES) throw new AppError('Task input directory is closed or the attachment is too large.');
    if (!/^\.[a-z0-9]{1,8}$/.test(extension)) throw new AppError('Invalid materialized file extension.');
    if (this.materializations.size >= 20 || this.materializedBytes + data.byteLength > 64 * 1024 * 1024) throw new AppError('Task original-file materialization limit reached. Use bounded read_attachment or view_attachment instead.');
    const root = lstatSync(this.path);
    if (!root.isDirectory() || root.dev !== this.identity.dev || root.ino !== this.identity.ino) throw new AppError('Task input directory changed.');
    const name = `${randomBytes(16).toString('hex')}${extension}`;
    const fd = openSync(`/proc/self/fd/${this.fd}/${name}`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      let position = 0;
      while (position < data.byteLength) position += writeSync(fd, data, position, Math.min(64 * 1024, data.byteLength - position), position);
      fchmodSync(fd, 0o400);
      const after = fstatSync(fd), visible = lstatSync(this.path);
      if (!after.isFile() || after.nlink !== 1 || after.size !== data.byteLength || !visible.isDirectory() || visible.dev !== this.identity.dev || visible.ino !== this.identity.ino) throw new AppError('Task input directory changed during materialization.');
      this.materializations.set(name, { ino: after.ino, dev: after.dev, size: after.size, sha256: createHash('sha256').update(data).digest('hex') });
      this.materializedBytes += data.byteLength;
    } finally { closeSync(fd); }
    return join(this.path, name);
  }
  close(): void {
    if (this.fd < 0) return;
    // Delete only still-identical app-created input copies via the pinned directory.
    // Never recursively traverse a directory that the worker can rename or replace.
    for (const [name, original] of this.materializations) {
      try {
        const root = lstatSync(this.path);
        if (!root.isDirectory() || root.dev !== this.identity.dev || root.ino !== this.identity.ino) break;
        const data = this.read(name), visible = lstatSync(`/proc/self/fd/${this.fd}/${name}`);
        if (visible.ino === original.ino && visible.dev === original.dev && data.byteLength === original.size && createHash('sha256').update(data).digest('hex') === original.sha256) unlinkSync(`/proc/self/fd/${this.fd}/${name}`);
      } catch { /* Preserve any modified, replaced, or unavailable file for review. */ }
    }
    closeSync(this.fd); this.fd = -1;
    // Preserve generated files for review, remove only an unchanged empty outbox.
    try { const st = lstatSync(this.path); if (st.isDirectory() && st.ino === this.identity.ino && st.dev === this.identity.dev) rmdirSync(this.path); } catch { /* Nonempty output remains. */ }
  }
}
export interface TaskBroker {
  agentConfig: TaskBridgeConfig;
  dispatch(request: unknown): Promise<TaskToolResult>;
  /** Run accepted self-stop/restore actions only after their receipt is delivered. */
  flushPendingActions(result?: TaskToolResult): void;
  close(): void;
}
/** In-process authoritative capability broker; exported for deterministic security tests. */
export function createTaskBroker(store: Store, run: Run, suppliedFence: RunFence, appAccess?: TaskAppAccess): TaskBroker {
  const fence = { ...suppliedFence }, runId = run.id, taskId = run.taskId;
  if (!store.isCurrent(runId, fence)) throw new AppError('Task invocation is no longer current.', 409);
  const inputs = store.listRunAttachments(runId, fence).map(context);
  const allowed = new Set(inputs.map(a => a.id));
  const currentScope = { task: taskContext(store.getTask(taskId)), commentSequence: store.commentCursor(taskId), attachments: inputs, allowed };
  const references = new Map<string, typeof currentScope>();
  const readScope = (value: unknown) => {
    if (value === undefined) return currentScope;
    const task = store.resolveTaskReference(string(value, 36, 'task ID'));
    if (task.id === taskId) return currentScope;
    let scope = references.get(task.id);
    if (!scope) {
      const attachments = store.listTaskAttachments(task.id).map(context);
      scope = { task: taskContext(task), commentSequence: store.commentCursor(task.id), attachments, allowed: new Set(attachments.map(a => a.id)) };
      references.set(task.id, scope);
    }
    return scope;
  };
  const scopeAttachments = (scope: typeof currentScope) => scope === currentScope
    ? store.listRunAttachments(runId, fence).filter(a => allowed.has(a.id)).map(context) : scope.attachments;
  const output = new TaskOutputDirectory(run.cwd);
  let inputDirectory: TaskOutputDirectory | undefined;

  const capability = randomBytes(32).toString('hex');
  const agentConfig: TaskBridgeConfig = {
    name: `brigd_task_${randomBytes(8).toString('hex')}`, command: process.execPath, args: [taskHelperPath()],
    env: { BRIGD_TASK_SOCKET: '', BRIGD_TASK_CAPABILITY: capability },
    context: { taskId, runId, turn: fence.turn, stepIndex: fence.currentStepIndex, attachments: inputs, outputDirectory: output.path },
  };
  let active = true, calls = 0, resultBytes = 0, busy = false, receiptReservation = 0;
  const pendingActions = new Map<TaskToolResult, (() => void)[]>();
  let callActions: (() => void)[] = [];
  const close = () => { active = false; pendingActions.clear(); output.close(); inputDirectory?.close(); };
  const current = () => active && store.isCurrent(runId, fence);
  const app = createTaskAppController(store, run, fence, appAccess, current, action => callActions.push(action));
  const flushPendingActions = (result?: TaskToolResult) => {
    const receipts = result ? [result] : [...pendingActions.keys()];
    for (const receipt of receipts) {
      const actions = pendingActions.get(receipt);
      pendingActions.delete(receipt);
      if (current()) actions?.forEach(action => action());
    }
  };
  const mutationKey = (value: unknown) => {
    const key = string(value, 100, 'idempotency key');
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new AppError('Invalid idempotency key.');
    return key;
  };
  const attachmentId = (value: unknown, scope = currentScope) => {
    const id = string(value, 100, 'attachment ID');
    if (!scope.allowed.has(id)) throw new AppError('Attachment is not part of the selected task snapshot.', 403);
    return id;
  };
  const execute = async (request: TaskBrokerRequest): Promise<TaskToolResult> => {
    if (app.has(request.tool)) {
      const result = await app.execute(request.tool, request.arguments);
      if (!result.isError && ['update_task', 'archive_task', 'restore_task', 'set_task_tags'].includes(request.tool) && record(request.arguments)) {
        const task = store.resolveTaskReference(request.arguments.task_id as string);
        const scope = task.id === taskId ? currentScope : references.get(task.id);
        if (scope) scope.task = taskContext(task);
      }
      return result;
    }
    switch (request.tool) {
      case 'get_task': {
        const args = object(request.arguments, ['task_id']);
        const scope = readScope(args.task_id), attachments = scopeAttachments(scope);
        const result = text({ task: scope.task, attachments: attachments.slice(0, 20), attachment_count: attachments.length,
          next_offset: attachments.length > 20 ? 20 : null });
        if (Buffer.byteLength(JSON.stringify(result)) + 1 > MAX_TASK_RESULT_BYTES) throw new AppError('Task details exceed the MCP response limit. Use list_tasks for its summary.');
        return result;
      }
      case 'list_comments': {
        const args = object(request.arguments, ['task_id', 'offset', 'limit']);
        const scope = readScope(args.task_id);
        const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 20, 20, 1);
        const rows = store.listTaskComments(scope.task.id, { offset, limit: limit + 1, throughSequence: scope.commentSequence });
        const comments = [];
        for (const comment of rows.slice(0, limit)) {
          const item = { ...comment, attachments: (comment.attachments ?? []).map(a => ({ ...context(a), available: scope.allowed.has(a.id) })) };
          // The text result is JSON-encoded again by MCP. Measure that actual wire
          // representation so long Markdown/Unicode discussions stay readable.
          const candidate = text({ comments: [...comments, item], next_offset: Number.MAX_SAFE_INTEGER });
          if (Buffer.byteLength(JSON.stringify(candidate)) + 1 > MAX_TASK_RESULT_BYTES) {
            if (!comments.length) throw new AppError('This comment exceeds the task tool response size limit.');
            break;
          }
          comments.push(item);
        }
        return text({ comments, next_offset: rows.length > comments.length ? offset + comments.length : null });
      }
      case 'list_attachments': {
        const args = object(request.arguments, ['task_id', 'offset', 'limit']);
        const attachments = scopeAttachments(readScope(args.task_id));
        const offset = integer(args.offset, 0, attachments.length), limit = integer(args.limit, 20, 20, 1);
        return text({ attachments: attachments.slice(offset, offset + limit), next_offset: offset + limit < attachments.length ? offset + limit : null });
      }
      case 'read_attachment': {
        const args = object(request.arguments, ['task_id', 'attachment_id', 'offset', 'max_bytes', 'materialize']);
        const scope = readScope(args.task_id);
        const id = attachmentId(args.attachment_id, scope), { attachment, data } = store.readAttachment(scope.task.id, id);
        const offset = integer(args.offset, 0, data.byteLength), maximum = integer(args.max_bytes, MAX_TASK_READ_BYTES, MAX_TASK_READ_BYTES, 1);
        if (args.materialize !== undefined && typeof args.materialize !== 'boolean') throw new AppError('Invalid materialize flag.');
        let localPath: string | undefined;
        if (args.materialize) {
          inputDirectory ??= new TaskOutputDirectory(run.cwd, '.brigd-inputs-');
          // Never accept a destination or derive a filesystem component from a user filename.
          const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf', 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv' } as Record<string, string>)[attachment.mime] ?? '.bin';
          localPath = inputDirectory.materialize(data, extension);
        }
        const chunk = Buffer.from(data.subarray(offset, offset + maximum));
        const isText = attachment.mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(attachment.mime);
        let encoding: 'utf-8' | 'base64' = 'base64', content = chunk.toString('base64');
        // Byte offsets may split a UTF-8 sequence. Never replace bytes with U+FFFD;
        // return a lossless base64 chunk instead so callers can concatenate it.
        if (isText) { try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(chunk); encoding = 'utf-8'; } catch { /* Keep lossless binary encoding. */ } }
        return text({ attachment: context(attachment), ...(localPath ? { local_path: localPath, sha256: attachment.sha256, native_permissions_apply: true } : {}), offset, bytes: chunk.byteLength, next_offset: offset + chunk.byteLength < data.byteLength ? offset + chunk.byteLength : null,
          encoding, data: content });
      }
      case 'view_attachment': {
        const args = object(request.arguments, ['task_id', 'attachment_id']);
        const scope = readScope(args.task_id);
        const { attachment, data, mime } = store.readAttachmentPreview(scope.task.id, attachmentId(args.attachment_id, scope));
        if (data.byteLength > MAX_TASK_IMAGE_BYTES || mime !== 'image/png') throw new AppError('Image preview is unavailable within the safe size limit.');
        return { content: [{ type: 'text', text: JSON.stringify({ attachment: context(attachment), preview: true }) }, { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: mime }] };
      }
      case 'add_comment': {
        const args = object(request.arguments, ['body', 'attachment_ids', 'idempotency_key']);
        const body = string(args.body, 16000, 'comment body');
        const ids = args.attachment_ids === undefined ? [] : args.attachment_ids;
        if (!Array.isArray(ids) || ids.length > ATTACHMENT_MAX_COUNT || new Set(ids).size !== ids.length) throw new AppError('Invalid comment attachments.');
        const comment = store.publishAgentComment(runId, fence, mutationKey(args.idempotency_key), { body, attachmentIds: ids.map(id => attachmentId(id)) });
        return text({ comment_id: comment.id, published: true });
      }
      case 'add_attachment': {
        const args = object(request.arguments, ['path', 'name', 'mime', 'caption', 'idempotency_key']);
        const path = string(args.path, 240, 'relative output filename');
        const name = args.name === undefined ? path : string(args.name, 240, 'attachment name');
        const mime = string(args.mime, 120, 'MIME type');
        const caption = args.caption === undefined ? undefined : string(args.caption, 16000, 'caption');
        const key = mutationKey(args.idempotency_key);
        const prepared = await prepareAttachment(output.read(path), mime, name);
        if (!current()) return expired();
        const attachment = store.publishAgentAttachment(runId, fence, key, prepared, caption);
        allowed.add(attachment.id);
        return text({ attachment: context(attachment), published: true });
      }
      case 'set_progress': {
        const args = object(request.arguments, ['status']);
        const progress = store.setRunProgress(runId, fence, args.status).progress;
        return text({ progress: progress?.text ?? null, updated_at: progress?.updatedAt ?? null });
      }
      case 'commit_changes': {
        const args = object(request.arguments, ['message', 'paths']);
        const message = string(args.message, 5000, 'commit message');
        const paths = args.paths === undefined ? undefined : commitPaths(args.paths);
        if (!current()) return expired();
        const result = await commitWorkspace(run, message, paths);
        return text({ committed: result.committed, commit: result.commit, branch: result.branch, files: result.files, file_count: result.fileCount });
      }
      default: throw new AppError('Unknown task attachment tool.');
    }
  };
  const dispatch = async (raw: unknown): Promise<TaskToolResult> => {
    // Invalid credentials never reveal task metadata and cannot consume the owner's budget.
    if (!record(raw) || typeof raw.capability !== 'string' || !/^[a-f0-9]{64}$/.test(raw.capability) || !timingSafeEqual(Buffer.from(raw.capability), Buffer.from(capability))) return expired();
    if (!current()) { close(); return expired(); }
    if (++calls > MAX_TASK_TOOL_CALLS || resultBytes >= MAX_TASK_RESULT_TOTAL_BYTES) { close(); return failure('Task attachment tool budget exhausted.'); }
    if (busy) {
      if (resultBytes + receiptReservation + 256 > MAX_TASK_RESULT_TOTAL_BYTES) { close(); return failure('Task attachment tool output budget exhausted.'); }
      resultBytes += 256;
      return failure('Another task tool call is in progress. Retry after it finishes.');
    }
    // Reserve the entire bounded receipt before a mutation. Never commit a write
    // and then report failure merely because its success receipt exceeded budget.
    const mutation = raw.tool === 'add_comment' || raw.tool === 'add_attachment' || raw.tool === 'set_progress' || raw.tool === 'commit_changes' ||
      typeof raw.tool === 'string' && app.has(raw.tool) && app.mutates(raw.tool);
    if (mutation && resultBytes + 4096 > MAX_TASK_RESULT_TOTAL_BYTES) {
      close(); return failure('Task attachment tool output budget exhausted before publication. Nothing was published.');
    }
    receiptReservation = mutation ? 4096 : 0;
    busy = true;
    callActions = [];
    let result: TaskToolResult;
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_TASK_REQUEST_BYTES) throw new AppError('Task tool request exceeds the size limit.');
      object(raw, ['capability', 'requestId', 'tool', 'arguments']);
      const requestId = string(raw.requestId, 100, 'request ID');
      if (!/^[a-zA-Z0-9_-]+$/.test(requestId) || typeof raw.tool !== 'string' || !TASK_MCP_TOOLS.includes(raw.tool as typeof TASK_MCP_TOOLS[number])) throw new AppError('Invalid task tool request.');
      result = await execute({ capability, requestId, tool: raw.tool, arguments: raw.arguments });
      if (!current()) result = expired();
    } catch (error) {
      result = failure(error instanceof AppError ? error.message : 'Unable to read or publish this task attachment. Check the file and try again.');
    } finally { busy = false; receiptReservation = 0; }
    const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
    if (bytes > MAX_TASK_RESULT_BYTES || resultBytes + bytes > MAX_TASK_RESULT_TOTAL_BYTES) { close(); return failure('Task attachment tool output budget exhausted.'); }
    resultBytes += bytes;
    if (!result.isError && callActions.length) pendingActions.set(result, callActions);
    callActions = [];
    return result;
  };
  return { agentConfig, dispatch, close, flushPendingActions };
}

interface SocketState { pending: Buffer; handled: boolean; response: Buffer | null; offset: number; receipt?: TaskToolResult; delivered?: boolean; }
/** Private local transport, never added to the app's HTTP routes. */
export function createTaskBridge(store: Store, run: Run, fence: RunFence, appAccess?: TaskAppAccess): TaskBroker {
  const broker = createTaskBroker(store, run, fence, appAccess);
  const directory = mkdtempSync(join(tmpdir(), 'brigd-task-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'broker.sock');
  const sockets = new Set<Socket<SocketState>>();
  const flush = (socket: Socket<SocketState>) => {
    const state = socket.data;
    if (!state.response) return;
    const accepted = socket.write(state.response.subarray(state.offset));
    if (accepted < 0) { socket.terminate(); return; }
    state.offset += accepted;
    if (state.offset >= state.response.byteLength) { state.response = null; state.delivered = true; socket.end(); }
  };
  let listener: ReturnType<typeof Bun.listen<SocketState>>;
  try {
    listener = Bun.listen<SocketState>({ unix: path, socket: {
      open(socket) { if (sockets.size >= 16) { socket.terminate(); return; } socket.data = { pending: Buffer.alloc(0), handled: false, response: null, offset: 0 }; sockets.add(socket); socket.timeout(15); },
      data(socket, data) {
        if (!sockets.has(socket)) return;
        const state = socket.data;
        if (state.handled) return;
        state.pending = Buffer.concat([state.pending, data]);
        if (state.pending.byteLength > MAX_TASK_REQUEST_BYTES) { state.handled = true; socket.end(); return; }
        const newline = state.pending.indexOf(10);
        if (newline < 0) return;
        state.handled = true;
        let request: unknown;
        try {
          if (state.pending.subarray(newline + 1).toString().trim()) throw new Error();
          request = JSON.parse(state.pending.subarray(0, newline).toString());
        } catch { socket.end(); return; }
        state.pending = Buffer.alloc(0);
        void broker.dispatch(request).then(result => {
          if (!sockets.has(socket)) return;
          state.receipt = result;
          state.response = Buffer.from(JSON.stringify(result) + '\n'); flush(socket);
        }).catch(() => socket.end());
      },
      drain: flush,
      timeout(socket) { socket.end(); },
      error(socket) { sockets.delete(socket); },
      close(socket) {
        sockets.delete(socket);
        const receipt = socket.data.receipt;
        // The helper destroys its connection after consuming the complete JSON.
        // Let its stdio response reach the CLI before stopping that same agent.
        if (socket.data.delivered && receipt) setTimeout(() => broker.flushPendingActions(receipt), 50);
      },
    } });
    chmodSync(path, 0o600);
  } catch {
    broker.close(); rmSync(directory, { recursive: true, force: true });
    throw new AppError('Could not create the private task attachment socket. Local socket access is required; native security restrictions remain active.', 503);
  }
  broker.agentConfig.env.BRIGD_TASK_SOCKET = path;
  let closed = false;
  return { agentConfig: broker.agentConfig, dispatch: broker.dispatch, flushPendingActions: broker.flushPendingActions, close() {
    if (closed) return; closed = true;
    broker.close(); // Revoke before cleanup, including any in-flight asynchronous preparation.
    for (const socket of sockets) socket.terminate();
    sockets.clear(); listener.stop(true); rmSync(directory, { recursive: true, force: true });
  } };
}
