import { Database } from 'bun:sqlite';
import { readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Attachment, Comment, Instruction, InstructionInput, InstructionSnapshot, ModelCatalogEntry, ModelCatalogInput, Provider, Run, RunStatus, RunStep, StepAttempt, Task, TaskDetail, TaskInput, TaskStepInput, Worker, WorkerInput, WorkerSnapshot } from '../src/lib/types';
import { INSTRUCTION_COUNT_LIMIT } from '../src/lib/instructions';
import { validateInstruction, validateInstructionPatch, validateInstructionSnapshots } from './instructions';
import { AppError } from './errors';
import { validateWorkflowSteps } from './workflows';
import { validateSessionId } from './protocol';
import { effortOptions, MODEL_CATALOG_PROVIDER_LIMIT, modelPresets, normalizeModel, normalizeWorkerDescription } from '../src/lib/workers';
import { validateModel, validateModelPatch } from './models';
import { attachmentIds, preparedAttachmentPayload, type PreparedAttachment } from './attachments';
import { ATTACHMENT_MAX_COUNT, ATTACHMENT_TASK_MAX_COUNT, ATTACHMENT_TASK_MAX_BYTES, ATTACHMENT_STAGING_MAX_COUNT, ATTACHMENT_STAGING_MAX_BYTES, ATTACHMENT_TOTAL_MAX_BYTES, ATTACHMENT_STAGING_TTL_MS } from '../src/lib/attachments';
export { AppError } from './errors';
type Row = Record<string, any>;
const ATTACHMENT_COLUMNS = 'a.id,a.task_id,a.comment_id,a.run_id,a.step_index,a.attempt_id,a.source,a.name,a.mime,a.size,a.sha256,a.previewable,a.created_at';
const OPEN = "'running','cancelling','waiting_input','interrupted'";
const OCCUPIED = `(status IN (${OPEN}) OR (steps_snapshot != '[]' AND status IN ('failed','blocked')))`;
export interface RunFence { turn: number; currentStepIndex: number | null; attemptId: string | null; }
export function runFence(run: Run): RunFence {
  return { turn: run.turn, currentStepIndex: run.currentStepIndex,
    attemptId: run.currentStepIndex === null ? null : run.steps[run.currentStepIndex]?.attempts.at(-1)?.id ?? null };
}
function matchesFence(run: Run, fence?: RunFence): boolean {
  if (!fence) return true;
  const current = runFence(run);
  return current.turn === fence.turn && current.currentStepIndex === fence.currentStepIndex && current.attemptId === fence.attemptId;
}
function workerSnapshot(worker: Worker): WorkerSnapshot {
  return { id: worker.id, name: worker.name, description: worker.description, provider: worker.provider, model: worker.model, effort: worker.effort,
    communicationStyle: worker.communicationStyle, avatarUrl: worker.avatarUrl };
}
function validatedModel(value: unknown): string | null {
  try { return normalizeModel(value); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректная модель'); }
}
function validatedDescription(value: unknown): string {
  try { return normalizeWorkerDescription(value); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректное описание'); }
}
function validWorkerSnapshot(value: unknown): value is WorkerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const worker = value as WorkerSnapshot;
  const keys = Object.keys(worker).filter(key => key !== 'model' && key !== 'description').sort().join(',');
  if (keys !== 'avatarUrl,communicationStyle,effort,id,name,provider') return false;
  if (typeof worker.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(worker.id) || typeof worker.name !== 'string' || !worker.name.trim() || worker.name.length > 80 || worker.name.includes('\0')) return false;
  if (!['codex', 'claude'].includes(worker.provider) || !effortOptions[worker.provider]?.includes(worker.effort)) return false;
  if (typeof worker.communicationStyle !== 'string' || worker.communicationStyle.length > 4_000 || worker.communicationStyle.includes('\0')) return false;
  if (worker.avatarUrl !== null && (typeof worker.avatarUrl !== 'string' || !/^\/api\/avatars\/[a-f0-9]{64}$/.test(worker.avatarUrl))) return false;
  try {
    const model = normalizeModel(worker.model);
    if ('model' in worker && worker.model !== model) return false;
    const description = normalizeWorkerDescription(worker.description);
    if (worker.description != null && worker.description !== description) return false;
    // Upgrade legacy JSON in memory only; opening a database never rewrites snapshots.
    worker.model = model;
    worker.description = description;
    return true;
  } catch { return false; }
}
function sameWorker(left: WorkerSnapshot, right: WorkerSnapshot): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description && left.provider === right.provider && left.model === right.model && left.effort === right.effort && left.communicationStyle === right.communicationStyle && left.avatarUrl === right.avatarUrl;
}
function beginAttempt(step: RunStep, turn: number, now: number) {
  const attempt: StepAttempt = { id: crypto.randomUUID(), number: step.attempts.length + 1, status: 'running', sessionId: null,
    turn, startedAt: now, updatedAt: now, finishedAt: null, summary: null, error: null };
  step.attempts.push(attempt);
  Object.assign(step, { status: 'running', sessionId: null, startedAt: step.startedAt ?? now, updatedAt: now, finishedAt: null, summary: null, error: null });
}
function updateStep(step: RunStep, patch: Partial<StepAttempt>) {
  const { id: _id, number: _number, turn: _turn, ...state } = patch;
  Object.assign(step, state);
  const attempt = step.attempts.at(-1);
  if (attempt) Object.assign(attempt, patch);
}

// PID alone is not an identity: containers routinely reuse it after a restart.
function processIdentity(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const namespace = readlinkSync(`/proc/${pid}/ns/pid`);
    return `${boot}:${namespace}:${start}`;
  } catch { return null; }
}
export function nextOccurrence(due: number, intervalMinutes: number, now: number) {
  const interval = intervalMinutes * 60_000;
  const latest = due + Math.max(0, Math.floor((now - due) / interval)) * interval;
  return { latest, next: latest + interval };
}

export class Store {
  readonly db: Database;
  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS avatars (
        id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, effort TEXT NOT NULL,
        communication_style TEXT NOT NULL DEFAULT '', avatar_url TEXT, archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instructions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL, provider TEXT NOT NULL,
        cwd TEXT NOT NULL, schedule TEXT NOT NULL, interval_minutes INTEGER, first_run_at INTEGER,
        next_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), provider TEXT NOT NULL,
        cwd TEXT NOT NULL, instruction TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for INTEGER,
        status TEXT NOT NULL, session_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        finished_at INTEGER, summary TEXT, error TEXT, turn INTEGER NOT NULL DEFAULT 1, mock INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_run ON runs(task_id) WHERE status IN (${OPEN});
      CREATE UNIQUE INDEX IF NOT EXISTS one_occurrence ON runs(task_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
      CREATE TABLE IF NOT EXISTS comments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id), kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_runs ON runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS task_comments ON comments(task_id, seq);
      CREATE TABLE IF NOT EXISTS service_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL, identity TEXT);
    `);
    if (!(this.db.query('PRAGMA table_info(service_lease)').all() as Row[]).some(row => row.name === 'identity')) this.db.exec('ALTER TABLE service_lease ADD COLUMN identity TEXT');
    // Additive migrations preserve existing task IDs, runs, comments, and CLI sessions.
    this.db.transaction(() => {
      for (const [table, column, definition] of [
        ['workers', 'model', 'TEXT'],
        ['workers', 'description', "TEXT NOT NULL DEFAULT ''"],
        ['tasks', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_snapshot', 'TEXT'],
        ['runs', 'instructions_snapshot', "TEXT NOT NULL DEFAULT '[]'"],
        ['tasks', 'steps_template', "TEXT NOT NULL DEFAULT '[]'"],
        ['runs', 'steps_snapshot', "TEXT NOT NULL DEFAULT '[]'"],
        ['runs', 'current_step_index', 'INTEGER'],
        ['runs', 'workflow_version', 'INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0'],
        ['comments', 'step_index', 'INTEGER'],
      ]) {
        if (!(this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).some(row => row.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    }).immediate();
    // The explicit marker makes even an intentionally empty catalog persistent.
    // Creation, seeding and the marker commit together, including concurrent opens.
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS model_catalog (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
          model_id TEXT NOT NULL COLLATE BINARY, label TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(provider,model_id)
        );
      `);
      if (!this.db.query('SELECT name FROM app_migrations WHERE name=?').get('model_catalog_v1')) {
        const now = Date.now();
        const insert = this.db.query('INSERT INTO model_catalog (id,provider,model_id,label,created_at,updated_at) VALUES (?,?,?,?,?,?)');
        for (const provider of ['codex', 'claude'] as const) {
          for (const model of modelPresets[provider]) insert.run(crypto.randomUUID(), provider, model.id, model.label, now, now);
        }
        this.db.query('INSERT INTO app_migrations (name,applied_at) VALUES (?,?)').run('model_catalog_v1', now);
      }
    }).immediate();
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), comment_id TEXT REFERENCES comments(id),
          run_id TEXT REFERENCES runs(id), step_index INTEGER, attempt_id TEXT, created_turn INTEGER,
          source TEXT NOT NULL CHECK(source IN ('user','agent')), name TEXT NOT NULL, mime TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size>=0), sha256 TEXT NOT NULL, previewable INTEGER NOT NULL CHECK(previewable IN (0,1)),
          created_at INTEGER NOT NULL, expires_at INTEGER, data BLOB NOT NULL, preview BLOB, preview_size INTEGER NOT NULL DEFAULT 0,
          CHECK(length(data)=size), CHECK((preview IS NULL AND preview_size=0 AND previewable=0) OR (preview IS NOT NULL AND preview_size=length(preview) AND previewable=1)),
          CHECK((task_id IS NULL AND expires_at IS NOT NULL AND source='user') OR (task_id IS NOT NULL AND expires_at IS NULL))
        );
        CREATE INDEX IF NOT EXISTS task_attachment_metadata ON attachments(task_id,created_at);
        CREATE INDEX IF NOT EXISTS attachment_staging_expiry ON attachments(expires_at) WHERE task_id IS NULL;
        CREATE INDEX IF NOT EXISTS attachment_run_output ON attachments(run_id,created_turn);
        CREATE TABLE IF NOT EXISTS task_attachment_links (
          task_id TEXT NOT NULL REFERENCES tasks(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), position INTEGER NOT NULL,
          PRIMARY KEY(task_id,attachment_id)
        );
        CREATE TABLE IF NOT EXISTS comment_attachment_links (
          comment_id TEXT NOT NULL REFERENCES comments(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), position INTEGER NOT NULL,
          PRIMARY KEY(comment_id,attachment_id)
        );
        CREATE INDEX IF NOT EXISTS task_attachment_reverse ON task_attachment_links(attachment_id);
        CREATE INDEX IF NOT EXISTS comment_attachment_reverse ON comment_attachment_links(attachment_id);
        CREATE TABLE IF NOT EXISTS run_attachment_inputs (
          run_id TEXT NOT NULL REFERENCES runs(id), turn INTEGER NOT NULL, attachment_id TEXT NOT NULL REFERENCES attachments(id),
          PRIMARY KEY(run_id,turn,attachment_id)
        );
        CREATE TABLE IF NOT EXISTS attachment_publications (
          key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, result_id TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS attachments_immutable BEFORE UPDATE ON attachments
          WHEN OLD.task_id IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.source IS NOT OLD.source OR NEW.name IS NOT OLD.name
          OR NEW.mime IS NOT OLD.mime OR NEW.size IS NOT OLD.size OR NEW.sha256 IS NOT OLD.sha256 OR NEW.previewable IS NOT OLD.previewable
          OR NEW.created_at IS NOT OLD.created_at OR NEW.data IS NOT OLD.data OR NEW.preview IS NOT OLD.preview OR NEW.preview_size IS NOT OLD.preview_size
          BEGIN SELECT RAISE(ABORT, 'Committed attachment content and metadata are immutable'); END;
      `);
    }).immediate();
    // Upgrade the occupancy index without leaving an unguarded migration window.
    this.db.transaction(() => {
      this.db.exec(`DROP INDEX IF EXISTS one_open_run; CREATE UNIQUE INDEX one_open_run ON runs(task_id) WHERE ${OCCUPIED}`);
    }).immediate();
  }
  close() { this.db.close(); }
  acquireLease(pid = process.pid): string {
    return this.db.transaction(() => {
      const existing = this.db.query('SELECT pid, identity FROM service_lease WHERE singleton=1').get() as { pid: number; identity: string | null } | null;
      if (existing) {
        let alive = true;
        try { process.kill(existing.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
        const currentIdentity = processIdentity(existing.pid);
        if (existing.identity && currentIdentity && existing.identity !== currentIdentity) alive = false;
        // Missing identity or inaccessible /proc fails closed, unless the PID is confirmed dead.
        if (alive) throw new AppError(`База уже занята процессом PID ${existing.pid}. Остановите второй brigd перед запуском.`, 409);
      }
      const owner = crypto.randomUUID();
      this.db.query('INSERT OR REPLACE INTO service_lease (singleton,pid,owner,identity) VALUES (1,?,?,?)').run(pid, owner, processIdentity(pid));
      return owner;
    }).immediate();
  }
  releaseLease(owner: string) { this.db.query('DELETE FROM service_lease WHERE singleton=1 AND owner=?').run(owner); }
  private mapModel(row: Row): ModelCatalogEntry {
    return { id: row.id, provider: row.provider, modelId: row.model_id, label: row.label,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listModels(): ModelCatalogEntry[] {
    return (this.db.query('SELECT * FROM model_catalog ORDER BY seq').all() as Row[]).map(row => this.mapModel(row));
  }
  getModel(id: string): ModelCatalogEntry {
    const row = this.db.query('SELECT * FROM model_catalog WHERE id=?').get(id) as Row | null;
    if (!row) throw new AppError('Модель не найдена', 404);
    return this.mapModel(row);
  }
  private checkModelCapacity(provider: Provider, modelId: string, excludingId: string | null = null) {
    if (this.db.query('SELECT id FROM model_catalog WHERE provider=? AND model_id=? AND id IS NOT ?').get(provider, modelId, excludingId)) {
      throw new AppError('Модель с таким ID уже есть у этого провайдера', 409);
    }
    const count = (this.db.query('SELECT count(*) AS n FROM model_catalog WHERE provider=? AND id IS NOT ?').get(provider, excludingId) as Row).n;
    if (count >= MODEL_CATALOG_PROVIDER_LIMIT) throw new AppError(`Можно сохранить не больше ${MODEL_CATALOG_PROVIDER_LIMIT} моделей для каждого провайдера`, 409);
  }
  createModel(value: ModelCatalogInput, now = Date.now()): ModelCatalogEntry {
    const input = validateModel(value);
    return this.db.transaction(() => {
      this.checkModelCapacity(input.provider, input.modelId);
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO model_catalog (id,provider,model_id,label,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.provider, input.modelId, input.label, now, now);
      return this.getModel(id);
    }).immediate();
  }
  updateModel(id: string, value: Partial<ModelCatalogInput>, now = Date.now()): ModelCatalogEntry {
    return this.db.transaction(() => {
      const current = this.getModel(id);
      const input = { ...current, ...validateModelPatch(value) };
      this.checkModelCapacity(input.provider, input.modelId, id);
      this.db.query('UPDATE model_catalog SET provider=?,model_id=?,label=?,updated_at=? WHERE id=?')
        .run(input.provider, input.modelId, input.label, now, id);
      return this.getModel(id);
    }).immediate();
  }
  deleteModel(id: string): void {
    this.db.transaction(() => {
      this.getModel(id);
      this.db.query('DELETE FROM model_catalog WHERE id=?').run(id);
    }).immediate();
  }
  private mapInstruction(row: Row): Instruction {
    return { id: row.id, title: row.title, body: row.body, enabled: !!row.enabled,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listInstructions(): Instruction[] {
    return (this.db.query('SELECT * FROM instructions ORDER BY created_at, seq').all() as Row[]).map(row => this.mapInstruction(row));
  }
  getInstruction(id: string): Instruction {
    const row = this.db.query('SELECT * FROM instructions WHERE id=?').get(id) as Row | null;
    if (!row) throw new AppError('Инструкция не найдена', 404);
    return this.mapInstruction(row);
  }
  private enabledInstructions(): InstructionSnapshot[] {
    const snapshots = this.listInstructions().filter(item => item.enabled).map(({ id, title, body }) => ({ id, title, body }));
    validateInstructionSnapshots(snapshots);
    return snapshots;
  }
  createInstruction(value: InstructionInput, now = Date.now()): Instruction {
    const input = validateInstruction(value);
    return this.db.transaction(() => {
      if ((this.db.query('SELECT count(*) AS n FROM instructions').get() as Row).n >= INSTRUCTION_COUNT_LIMIT) {
        throw new AppError(`Можно сохранить не больше ${INSTRUCTION_COUNT_LIMIT} инструкций. Удалите ненужную инструкцию.`);
      }
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO instructions (id,title,body,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.title, input.body, +input.enabled, now, now);
      this.enabledInstructions(); // A failed aggregate check rolls back the entire write.
      return this.getInstruction(id);
    }).immediate();
  }
  updateInstruction(id: string, value: Partial<InstructionInput>, now = Date.now()): Instruction {
    return this.db.transaction(() => {
      const current = this.getInstruction(id);
      const input = { ...current, ...validateInstructionPatch(value) };
      this.db.query('UPDATE instructions SET title=?,body=?,enabled=?,updated_at=? WHERE id=?')
        .run(input.title, input.body, +input.enabled, now, id);
      this.enabledInstructions();
      return this.getInstruction(id);
    }).immediate();
  }
  deleteInstruction(id: string): void {
    const result = this.db.query('DELETE FROM instructions WHERE id=?').run(id);
    if (!result.changes) throw new AppError('Инструкция не найдена', 404);
  }
  private mapWorker(row: Row): Worker {
    return { id: row.id, name: row.name, description: validatedDescription(row.description), provider: row.provider, model: validatedModel(row.model), effort: row.effort,
      communicationStyle: row.communication_style, avatarUrl: row.avatar_url, archived: !!row.archived,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listWorkers(): Worker[] {
    return (this.db.query('SELECT * FROM workers ORDER BY archived, created_at DESC, rowid DESC').all() as Row[]).map(row => this.mapWorker(row));
  }
  getWorker(id: string): Worker {
    const row = this.db.query('SELECT * FROM workers WHERE id=?').get(id) as Row | null;
    if (!row) throw new AppError('Работник не найден', 404);
    return this.mapWorker(row);
  }
  private assertAvatar(avatarUrl: string | null) {
    if (avatarUrl === null) return;
    const match = avatarUrl.match(/^\/api\/avatars\/([a-f0-9]{64})$/);
    if (!match || !this.db.query('SELECT id FROM avatars WHERE id=?').get(match[1]!)) throw new AppError('Выберите загруженный аватар');
  }
  createWorker(input: WorkerInput, now = Date.now()): Worker {
    const model = validatedModel(input.model);
    const description = validatedDescription(input.description);
    this.assertAvatar(input.avatarUrl);
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO workers (id,name,description,provider,model,effort,communication_style,avatar_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.name, description, input.provider, model, input.effort, input.communicationStyle, input.avatarUrl, now, now);
    return this.getWorker(id);
  }
  updateWorker(id: string, input: WorkerInput & { archived?: boolean }, now = Date.now()): Worker {
    const current = this.getWorker(id);
    const model = validatedModel(input.model === undefined && input.provider === current.provider ? current.model : input.model);
    const description = validatedDescription(input.description === undefined ? current.description : input.description);
    this.assertAvatar(input.avatarUrl);
    this.db.query('UPDATE workers SET name=?,description=?,provider=?,model=?,effort=?,communication_style=?,avatar_url=?,archived=?,updated_at=? WHERE id=?')
      .run(input.name, description, input.provider, model, input.effort, input.communicationStyle, input.avatarUrl, +(input.archived ?? current.archived), now, id);
    return this.getWorker(id);
  }
  archiveWorker(id: string, now = Date.now()): Worker {
    this.getWorker(id);
    // Keep references and immutable avatars so scheduled tasks and old sessions remain usable.
    this.db.query('UPDATE workers SET archived=1,updated_at=? WHERE id=?').run(now, id);
    return this.getWorker(id);
  }
  saveAvatar(data: Uint8Array, mime: string, now = Date.now()): string {
    const id = createHash('sha256').update(data).digest('hex');
    this.db.query('INSERT OR IGNORE INTO avatars (id,mime,data,created_at) VALUES (?,?,?,?)').run(id, mime, data, now);
    return `/api/avatars/${id}`;
  }
  getAvatar(id: string): { mime: string; data: Uint8Array } {
    const row = this.db.query('SELECT mime,data FROM avatars WHERE id=?').get(id) as { mime: string; data: Uint8Array } | null;
    if (!row) throw new AppError('Аватар не найден', 404);
    return row;
  }
  private mapAttachment(row: Row): Attachment {
    return { id: row.id, taskId: row.task_id, commentId: row.comment_id, runId: row.run_id,
      stepIndex: row.step_index, attemptId: row.attempt_id, source: row.source,
      name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, previewable: !!row.previewable, createdAt: row.created_at };
  }
  private attachmentRows(sql: string, ...params: (string | number)[]): Attachment[] {
    return (this.db.query(sql).all(...params) as Row[]).map(row => this.mapAttachment(row));
  }
  /** This explicit metadata projection must never include original or preview BLOBs. */
  private taskAttachments(taskId: string): Attachment[] {
    return this.attachmentRows(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a JOIN task_attachment_links l ON l.attachment_id=a.id WHERE l.task_id=? ORDER BY l.position,a.created_at,a.id`, taskId);
  }
  private commentAttachments(commentId: string): Attachment[] {
    return this.attachmentRows(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a JOIN comment_attachment_links l ON l.attachment_id=a.id WHERE l.comment_id=? ORDER BY l.position,a.created_at,a.id`, commentId);
  }
  listTaskAttachments(taskId: string): Attachment[] {
    this.getTask(taskId);
    return this.attachmentRows(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.task_id=? AND (EXISTS(SELECT 1 FROM task_attachment_links l WHERE l.attachment_id=a.id) OR EXISTS(SELECT 1 FROM comment_attachment_links c WHERE c.attachment_id=a.id)) ORDER BY a.created_at,a.id`, taskId);
  }
  getAttachment(taskId: string, id: string): Attachment {
    const row = this.db.query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.id=? AND a.task_id=?`).get(id, taskId) as Row | null;
    if (!row) throw new AppError('Вложение не найдено в этой задаче', 404);
    return this.mapAttachment(row);
  }
  readAttachment(taskId: string, id: string): { attachment: Attachment; data: Uint8Array } {
    const attachment = this.getAttachment(taskId, id);
    const row = this.db.query('SELECT data FROM attachments WHERE id=? AND task_id=?').get(id, taskId) as Row;
    return { attachment, data: row.data };
  }
  attachmentPreviewSize(taskId: string, id: string): number {
    const attachment = this.getAttachment(taskId, id);
    if (!attachment.previewable) throw new AppError('У этого файла нет безопасного предпросмотра', 415);
    return (this.db.query('SELECT preview_size FROM attachments WHERE id=? AND task_id=?').get(id, taskId) as Row).preview_size;
  }
  readAttachmentPreview(taskId: string, id: string): { attachment: Attachment; data: Uint8Array; mime: string } {
    const attachment = this.getAttachment(taskId, id);
    if (!attachment.previewable) throw new AppError('У этого файла нет безопасного предпросмотра', 415);
    const row = this.db.query('SELECT preview FROM attachments WHERE id=? AND task_id=?').get(id, taskId) as Row;
    if (!row.preview) throw new AppError('Предпросмотр недоступен', 404);
    return { attachment, data: row.preview, mime: 'image/png' };
  }
  private inputAttachments(runId: string, turn: number): Attachment[] {
    return this.attachmentRows(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a JOIN run_attachment_inputs i ON i.attachment_id=a.id WHERE i.run_id=? AND i.turn=? ORDER BY a.created_at,a.id`, runId, turn);
  }
  private assertPublicationRun(runId: string, fence: RunFence): Run {
    const run = this.getRun(runId);
    if (run.status !== 'running' || !matchesFence(run, fence)) throw new AppError('Этот вызов агента уже завершён или заменён', 409);
    return run;
  }
  listRunAttachments(runId: string, fence: RunFence): Attachment[] {
    const run = this.assertPublicationRun(runId, fence);
    return this.attachmentRows(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.task_id=? AND (EXISTS(SELECT 1 FROM run_attachment_inputs i WHERE i.attachment_id=a.id AND i.run_id=? AND i.turn=?) OR (a.run_id=? AND a.created_turn=?)) ORDER BY a.created_at,a.id`, run.taskId, runId, run.turn, runId, run.turn);
  }
  private advanceAttachmentInputs(run: Run, nextTurn: number, extraIds: string[] = []) {
    this.db.query('INSERT OR IGNORE INTO run_attachment_inputs(run_id,turn,attachment_id) SELECT run_id,?,attachment_id FROM run_attachment_inputs WHERE run_id=? AND turn=?').run(nextTurn, run.id, run.turn);
    this.db.query('INSERT OR IGNORE INTO run_attachment_inputs(run_id,turn,attachment_id) SELECT ?,?,id FROM attachments WHERE task_id=? AND run_id=?').run(run.id, nextTurn, run.taskId, run.id);
    for (const id of extraIds) this.db.query('INSERT OR IGNORE INTO run_attachment_inputs(run_id,turn,attachment_id) VALUES (?,?,?)').run(run.id, nextTurn, id);
  }
  /** Bounded cleanup never touches committed files, including files retained by old run snapshots. */
  cleanupAttachments(now = Date.now(), limit = 100): number {
    const bound = Math.max(1, Math.min(100, Math.floor(limit) || 100));
    return this.db.query('DELETE FROM attachments WHERE id IN (SELECT id FROM attachments WHERE task_id IS NULL AND expires_at<=? ORDER BY expires_at LIMIT ?)').run(now, bound).changes;
  }
  private assertAttachmentQuota(size: number, previewSize: number, taskId: string | null) {
    const total = this.db.query('SELECT COALESCE(sum(size+preview_size),0) AS bytes FROM attachments').get() as Row;
    if (total.bytes + size + previewSize > ATTACHMENT_TOTAL_MAX_BYTES) throw new AppError('Достигнут общий лимит вложений (1 ГиБ)', 413);
    if (taskId === null) {
      const usage = this.db.query('SELECT count(*) AS n,COALESCE(sum(size),0) AS bytes FROM attachments WHERE task_id IS NULL').get() as Row;
      if (usage.n >= ATTACHMENT_STAGING_MAX_COUNT || usage.bytes + size > ATTACHMENT_STAGING_MAX_BYTES) throw new AppError('Слишком много незавершённых загрузок. Удалите лишние файлы или сохраните их в задачу.', 413);
    } else this.assertTaskAttachmentQuota(taskId, 1, size);
  }
  private assertTaskAttachmentQuota(taskId: string, count: number, size: number) {
    const usage = this.db.query('SELECT count(*) AS n,COALESCE(sum(size),0) AS bytes FROM attachments WHERE task_id=?').get(taskId) as Row;
    if (usage.n + count > ATTACHMENT_TASK_MAX_COUNT || usage.bytes + size > ATTACHMENT_TASK_MAX_BYTES) throw new AppError('Лимит вложений задачи: 200 файлов и 200 МиБ, включая историю запусков', 413);
  }
  private insertAttachment(prepared: PreparedAttachment, now: number, identity?: { run: Run; fence: RunFence; commentId: string | null }): Attachment {
    const payload = preparedAttachmentPayload(prepared);
    const taskId = identity?.run.taskId ?? null;
    this.assertAttachmentQuota(prepared.size, payload.preview?.byteLength ?? 0, taskId);
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO attachments (id,task_id,comment_id,run_id,step_index,attempt_id,created_turn,source,name,mime,size,sha256,previewable,created_at,expires_at,data,preview,preview_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, taskId, identity?.commentId ?? null, identity?.run.id ?? null, identity?.fence.currentStepIndex ?? null, identity?.fence.attemptId ?? null, identity?.run.turn ?? null,
        identity ? 'agent' : 'user', prepared.name, prepared.mime, prepared.size, prepared.sha256, +prepared.previewable, now, identity ? null : now + ATTACHMENT_STAGING_TTL_MS, payload.data, payload.preview, payload.preview?.byteLength ?? 0);
    return this.mapAttachment(this.db.query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.id=?`).get(id) as Row);
  }
  stageAttachment(prepared: PreparedAttachment, now = Date.now()): Attachment {
    return this.db.transaction(() => { this.cleanupAttachments(now); return this.insertAttachment(prepared, now); }).immediate();
  }
  deleteStagedAttachment(id: string): void {
    this.db.transaction(() => {
      const row = this.db.query('SELECT task_id FROM attachments WHERE id=?').get(id) as Row | null;
      if (!row) throw new AppError('Загрузка не найдена', 404);
      if (row.task_id !== null) throw new AppError('Сохранённое вложение нельзя удалить как временную загрузку', 409);
      this.db.query('DELETE FROM attachments WHERE id=? AND task_id IS NULL').run(id);
    }).immediate();
  }
  private bindAttachments(taskId: string, idsValue: unknown, now: number, commentId: string | null = null, run: Run | null = null, allowBound = false): string[] {
    const ids = attachmentIds(idsValue);
    const staged: Attachment[] = [];
    for (const id of ids) {
      const row = this.db.query(`SELECT ${ATTACHMENT_COLUMNS},a.expires_at FROM attachments a WHERE a.id=?`).get(id) as Row | null;
      if (!row || (row.task_id === null && row.expires_at <= now)) throw new AppError('Загрузка не найдена или срок её хранения истёк. Загрузите файл снова.', 404);
      if (row.task_id !== null && (row.task_id !== taskId || !allowBound)) throw new AppError('Вложение уже сохранено в другой записи', 409);
      if (row.task_id === null) staged.push(this.mapAttachment(row));
    }
    this.assertTaskAttachmentQuota(taskId, staged.length, staged.reduce((sum, item) => sum + item.size, 0));
    for (const item of staged) this.db.query('UPDATE attachments SET task_id=?,comment_id=?,run_id=?,step_index=?,attempt_id=?,created_turn=?,expires_at=NULL WHERE id=? AND task_id IS NULL')
      .run(taskId, commentId, run?.id ?? null, run?.currentStepIndex ?? null, run ? runFence(run).attemptId : null, run?.turn ?? null, item.id);
    return ids;
  }
  private replaceTaskAttachments(taskId: string, value: unknown, now: number) {
    if (value === undefined) return;
    const ids = this.bindAttachments(taskId, value, now, null, null, true);
    // Existing comment attachments are not moved or re-parented by task editing.
    for (const id of ids) {
      const original = this.getAttachment(taskId, id);
      if (original.commentId !== null) throw new AppError('Для задачи выберите отдельную загрузку, а не файл комментария', 409);
    }
    this.db.query('DELETE FROM task_attachment_links WHERE task_id=?').run(taskId);
    ids.forEach((id, position) => this.db.query('INSERT INTO task_attachment_links(task_id,attachment_id,position) VALUES (?,?,?)').run(taskId, id, position));
  }
  private publicationKey(run: Run, fence: RunFence, requestId: string): string {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(requestId)) throw new AppError('Некорректный requestId');
    return JSON.stringify([run.id, run.turn, fence.currentStepIndex, fence.attemptId, requestId]);
  }
  private readPublication(key: string, fingerprint: string): string | null {
    const row = this.db.query('SELECT fingerprint,result_id FROM attachment_publications WHERE key=?').get(key) as Row | null;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new AppError('requestId уже использован для другого содержимого', 409);
    return row.result_id;
  }
  publishAgentAttachment(runId: string, fence: RunFence, requestId: string, prepared: PreparedAttachment, caption?: string, now = Date.now()): Attachment {
    if (caption !== undefined && (typeof caption !== 'string' || caption.length > 16_000 || caption.includes('\0'))) throw new AppError('Подпись: не больше 16000 символов');
    const cleanCaption = caption?.trim() || null;
    preparedAttachmentPayload(prepared);
    return this.db.transaction(() => {
      const run = this.assertPublicationRun(runId, fence);
      const key = this.publicationKey(run, fence, requestId);
      const fingerprint = createHash('sha256').update(JSON.stringify(['add_attachment', prepared.name, prepared.mime, prepared.sha256, cleanCaption])).digest('hex');
      const prior = this.readPublication(key, fingerprint);
      if (prior) return this.getAttachment(run.taskId, prior);
      const comment = cleanCaption ? this.comment(run.taskId, runId, 'agent', cleanCaption, now, run.currentStepIndex) : null;
      const result = this.insertAttachment(prepared, now, { run, fence, commentId: comment?.id ?? null });
      if (comment) this.db.query('INSERT INTO comment_attachment_links(comment_id,attachment_id,position) VALUES (?,?,0)').run(comment.id, result.id);
      else {
        const count = (this.db.query('SELECT count(*) AS n FROM task_attachment_links WHERE task_id=?').get(run.taskId) as Row).n;
        if (count >= ATTACHMENT_MAX_COUNT) throw new AppError('У задачи уже 20 прямых вложений. Добавьте файл с подписью в комментарий.', 413);
        this.db.query('INSERT INTO task_attachment_links(task_id,attachment_id,position) VALUES (?,?,?)').run(run.taskId, result.id, count);
      }
      this.db.query('INSERT INTO attachment_publications(key,run_id,fingerprint,result_id) VALUES (?,?,?,?)').run(key, runId, fingerprint, result.id);
      return result;
    }).immediate();
  }
  publishAgentComment(runId: string, fence: RunFence, requestId: string, value: { body: string; attachmentIds?: string[] }, now = Date.now()): Comment {
    const ids = attachmentIds(value.attachmentIds);
    if (typeof value.body !== 'string' || value.body.length > 16_000 || value.body.includes('\0') || (!value.body.trim() && !ids.length)) throw new AppError('Комментарий: введите текст или приложите файл');
    const body = value.body.trim();
    return this.db.transaction(() => {
      const run = this.assertPublicationRun(runId, fence);
      const key = this.publicationKey(run, fence, requestId);
      const fingerprint = createHash('sha256').update(JSON.stringify(['add_comment', body, ids])).digest('hex');
      const prior = this.readPublication(key, fingerprint);
      if (prior) return this.mapComment(this.db.query('SELECT * FROM comments WHERE id=?').get(prior) as Row);
      const visible = new Set(this.listRunAttachments(runId, fence).map(item => item.id));
      if (ids.some(id => !visible.has(id))) throw new AppError('Вложение недоступно этому вызову агента', 404);
      const comment = this.comment(run.taskId, run.id, 'agent', body, now, run.currentStepIndex);
      ids.forEach((id, position) => this.db.query('INSERT INTO comment_attachment_links(comment_id,attachment_id,position) VALUES (?,?,?)').run(comment.id, id, position));
      this.db.query('INSERT INTO attachment_publications(key,run_id,fingerprint,result_id) VALUES (?,?,?,?)').run(key, runId, fingerprint, comment.id);
      return this.mapComment(this.db.query('SELECT * FROM comments WHERE id=?').get(comment.id) as Row);
    }).immediate();
  }
  private mapComment(row: Row): Comment {
    return { stepIndex: row.step_index ?? null, id: row.id, taskId: row.task_id, runId: row.run_id, kind: row.kind, body: row.body, createdAt: row.created_at, attachments: this.commentAttachments(row.id) };
  }
  private assignedWorker(id: string | null | undefined, currentId?: string | null): Worker | null {
    if (id == null) return null;
    const worker = this.getWorker(id);
    if (worker.archived && worker.id !== currentId) throw new AppError('Работник в архиве. Восстановите его или выберите другого.', 409);
    return worker;
  }
  private mapRun(row: Row): Run {
    const steps = JSON.parse(row.steps_snapshot ?? '[]') as RunStep[];
    const invalid = (): never => { throw new AppError('Повреждён снимок этапов. Запуск остановлен; восстановите базу из резервной копии.', 409); };
    const worker = row.worker_snapshot ? JSON.parse(row.worker_snapshot) as unknown : null;
    if (worker !== null && !validWorkerSnapshot(worker)) invalid();
    if (!Array.isArray(steps)) invalid();
    if (row.workflow_version === 0) {
      if (steps.length || row.current_step_index !== null) invalid();
    } else if (row.workflow_version === 1) {
      if (steps.length < 2 || steps.length > 20 || !Number.isInteger(row.current_step_index) || row.current_step_index < 0 || row.current_step_index >= steps.length) invalid();
      validateWorkflowSteps(steps.map(({ workerId, title, instruction }) => ({ workerId, title, instruction })));
      if (![0, 1].includes(row.cancel_requested) || (row.status === 'completed' && row.current_step_index !== steps.length - 1) || (row.status === 'cancelled' && !row.cancel_requested)) invalid();
      const statuses = ['running', 'cancelling', 'waiting_input', 'interrupted', 'failed', 'blocked', 'completed', 'cancelled'];
      const nullableText = (value: unknown) => value === null || typeof value === 'string';
      for (const [index, step] of steps.entries()) {
        if (!validWorkerSnapshot(step.worker) || step.worker.id !== step.workerId || !Array.isArray(step.attempts) || !['pending', ...statuses].includes(step.status)) invalid();
        if (!nullableText(step.summary) || !nullableText(step.error) || !nullableText(step.sessionId)) invalid();
        if (step.sessionId !== null) validateSessionId(step.sessionId);
        for (const [attemptIndex, attempt] of step.attempts.entries()) {
          if (!attempt || typeof attempt.id !== 'string' || !attempt.id || attempt.number !== attemptIndex + 1 || !statuses.includes(attempt.status) || !Number.isSafeInteger(attempt.turn) || attempt.turn < 1 || attempt.turn > row.turn || !nullableText(attempt.sessionId)) invalid();
          if (attempt.sessionId !== null) validateSessionId(attempt.sessionId);
          if (attemptIndex < step.attempts.length - 1 && !['failed', 'blocked', 'interrupted'].includes(attempt.status)) invalid();
        }
        const latest = step.attempts.at(-1);
        if (latest && (latest.summary !== step.summary || latest.error !== step.error || latest.sessionId !== step.sessionId)) invalid();
        if (index < row.current_step_index && (step.status !== 'completed' || step.attempts.at(-1)?.status !== 'completed')) invalid();
        if (index > row.current_step_index && (step.attempts.length || step.status !== (row.cancel_requested ? 'cancelled' : 'pending') || step.sessionId !== null)) invalid();
        if (index === row.current_step_index) {
          if (!validWorkerSnapshot(worker) || !sameWorker(step.worker, worker)) invalid();
          const attempt = step.attempts.at(-1);
          if (!attempt || attempt.turn !== row.turn || attempt.sessionId !== row.session_id || step.sessionId !== row.session_id || step.workerId !== row.worker_id || step.worker.provider !== row.provider) invalid();
          if (row.status !== 'cancelled' && (step.status !== row.status || attempt!.status !== row.status)) invalid();
          if (row.status === 'cancelled' && (!['cancelled', 'completed'].includes(step.status) || !['cancelled', 'completed', 'failed', 'blocked'].includes(attempt!.status))) invalid();
        }
      }
    } else invalid();
    return { inputAttachments: this.inputAttachments(row.id, row.turn), steps, currentStepIndex: row.current_step_index ?? null, id: row.id, taskId: row.task_id, instructions: JSON.parse(row.instructions_snapshot ?? '[]') as InstructionSnapshot[], workerId: row.worker_id ?? null, worker: worker as WorkerSnapshot | null, provider: row.provider, cwd: row.cwd, instruction: row.instruction,
      trigger: row.trigger, scheduledFor: row.scheduled_for, status: row.status, sessionId: row.session_id,
      startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, summary: row.summary,
      error: row.error, turn: row.turn, mock: !!row.mock };
  }
  private mapTask(row: Row): Task {
    const latest = this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(row.id) as Row | null;
    const worker = row.worker_id ? this.getWorker(row.worker_id) : null;
    return { attachments: this.taskAttachments(row.id), steps: validateWorkflowSteps(JSON.parse(row.steps_template ?? '[]')), id: row.id, workerId: row.worker_id ?? null, worker, title: row.title, instruction: row.instruction, provider: worker?.provider ?? row.provider, cwd: row.cwd,
      schedule: row.schedule, intervalMinutes: row.interval_minutes, firstRunAt: row.first_run_at,
      nextRunAt: row.next_run_at, paused: !!row.paused, createdAt: row.created_at, updatedAt: row.updated_at,
      status: latest?.status ?? 'ready', latestRun: latest ? this.mapRun(latest) : null,
      runCount: (this.db.query('SELECT count(*) AS n FROM runs WHERE task_id = ?').get(row.id) as Row).n };
  }
  listTasks(): Task[] { return (this.db.query('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(row => this.mapTask(row)); }
  getTask(id: string): Task {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Row | null;
    if (!row) throw new AppError('Задача не найдена', 404);
    return this.mapTask(row);
  }
  getRun(id: string): Run {
    const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as Row | null;
    if (!row) throw new AppError('Запуск не найден', 404);
    return this.mapRun(row);
  }
  activeRun(taskId: string): Run | null {
    const row = this.db.query(`SELECT * FROM runs WHERE task_id = ? AND ${OCCUPIED}`).get(taskId) as Row | null;
    return row ? this.mapRun(row) : null;
  }
  detail(id: string): TaskDetail {
    return { task: this.getTask(id), attachments: this.listTaskAttachments(id), runs: (this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(id) as Row[]).map(r => this.mapRun(r)),
      comments: (this.db.query('SELECT * FROM comments WHERE task_id = ? ORDER BY seq').all(id) as Row[]).map(r => this.mapComment(r)) };
  }
  private taskSteps(value: unknown, previous: TaskStepInput[] = []): TaskStepInput[] {
    const steps = validateWorkflowSteps(value);
    const remaining = new Map<string, number>();
    for (const step of previous) remaining.set(step.workerId, (remaining.get(step.workerId) ?? 0) + 1);
    for (const step of steps) {
      const count = remaining.get(step.workerId) ?? 0;
      this.assignedWorker(step.workerId, count > 0 ? step.workerId : null);
      if (count > 0) remaining.set(step.workerId, count - 1);
    }
    return steps;
  }
  createTask(input: TaskInput, now = Date.now()): Task {
    return this.db.transaction(() => {
      const id = crypto.randomUUID();
      const steps = this.taskSteps(input.steps);
      const worker = steps.length ? null : this.assignedWorker(input.workerId);
      const provider = steps.length ? this.getWorker(steps[0]!.workerId).provider : worker?.provider ?? input.provider;
      this.db.query(`INSERT INTO tasks (id,title,instruction,provider,cwd,schedule,interval_minutes,first_run_at,next_run_at,paused,created_at,updated_at,worker_id,steps_template) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title, input.instruction, provider,
        input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt,
        input.schedule === 'interval' ? (input.firstRunAt ?? now) : null, +input.paused, now, now, worker?.id ?? null, JSON.stringify(steps));
      this.replaceTaskAttachments(id, input.attachmentIds, now);
      return this.getTask(id);
    }).immediate();
  }
  updateTask(id: string, input: TaskInput, now = Date.now()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      const steps = this.taskSteps(input.steps === undefined ? task.steps : input.steps, task.steps);
      const worker = steps.length ? null : this.assignedWorker(input.workerId === undefined ? task.workerId : input.workerId, task.workerId);
      const provider = steps.length ? this.getWorker(steps[0]!.workerId).provider : worker?.provider ?? input.provider;
      const changedSchedule = input.schedule !== task.schedule || input.intervalMinutes !== task.intervalMinutes || input.firstRunAt !== task.firstRunAt;
      let next = task.nextRunAt;
      if (changedSchedule) next = input.schedule === 'interval' ? (input.firstRunAt ?? now) : null;
      this.db.query(`UPDATE tasks SET title=?,instruction=?,provider=?,cwd=?,schedule=?,interval_minutes=?,first_run_at=?,next_run_at=?,paused=?,updated_at=?,worker_id=?,steps_template=? WHERE id=?`)
        .run(input.title, input.instruction, provider, input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt, next, +input.paused, now, worker?.id ?? null, JSON.stringify(steps), id);
      this.replaceTaskAttachments(id, input.attachmentIds, now);
      return this.getTask(id);
    }).immediate();
  }
  comment(taskId: string, runId: string | null, kind: Comment['kind'], body: string, now = Date.now(), stepIndex?: number | null, ids?: string[]): Comment {
    return this.db.transaction(() => {
      this.getTask(taskId);
      const run = runId ? this.getRun(runId) : null;
      if (run && run.taskId !== taskId) throw new AppError('Запуск относится к другой задаче', 409);
      const id = crypto.randomUUID();
      const index = stepIndex === undefined && run ? run.currentStepIndex : stepIndex ?? null;
      this.db.query('INSERT INTO comments (id,task_id,run_id,kind,body,created_at,step_index) VALUES (?,?,?,?,?,?,?)').run(id, taskId, runId, kind, body, now, index);
      const bound = this.bindAttachments(taskId, ids, now, id, run);
      bound.forEach((attachmentId, position) => this.db.query('INSERT INTO comment_attachment_links(comment_id,attachment_id,position) VALUES (?,?,?)').run(id, attachmentId, position));
      return this.mapComment(this.db.query('SELECT * FROM comments WHERE id=?').get(id) as Row);
    }).immediate();
  }
  private insertRun(task: Task, trigger: Run['trigger'], scheduledFor: number | null, mock: boolean, now: number): Run {
    if (this.activeRun(task.id)) throw new AppError('У задачи уже есть активный запуск. Ответьте агенту, повторите текущий этап или отмените запуск.', 409);
    const id = crypto.randomUUID();
    const steps: RunStep[] = task.steps.map(step => ({ ...step, worker: workerSnapshot(this.getWorker(step.workerId)), status: 'pending',
      sessionId: null, startedAt: null, updatedAt: now, finishedAt: null, summary: null, error: null, attempts: [] }));
    if (steps.length) beginAttempt(steps[0]!, 1, now);
    const worker = steps.length ? steps[0]!.worker : task.worker ? workerSnapshot(task.worker) : null;
    const instructions = this.enabledInstructions();
    this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,scheduled_for,status,started_at,updated_at,mock,worker_id,worker_snapshot,instructions_snapshot,steps_snapshot,current_step_index,workflow_version) VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?)`)
      .run(id, task.id, worker?.provider ?? task.provider, task.cwd, task.instruction, trigger, scheduledFor, now, now, +mock, worker?.id ?? null,
        worker ? JSON.stringify(worker) : null, JSON.stringify(instructions), JSON.stringify(steps), steps.length ? 0 : null, steps.length ? 1 : 0);
    for (const attachment of this.listTaskAttachments(task.id)) this.db.query('INSERT INTO run_attachment_inputs(run_id,turn,attachment_id) VALUES (?,1,?)').run(id, attachment.id);
    this.comment(task.id, id, 'system', mock ? 'Демо-запуск: используется тестовый агент, реальные CLI не вызываются.' : `Запуск ${worker?.provider === 'claude' || (!worker && task.provider === 'claude') ? 'Claude Code' : 'Codex'} через CLI.`, now);
    return this.getRun(id);
  }
  startManual(taskId: string, mock: boolean, now = Date.now()): Run {
    return this.db.transaction(() => this.insertRun(this.getTask(taskId), 'manual', null, mock, now)).immediate();
  }
  claimDue(mock: boolean, now = Date.now()): Run[] {
    return this.db.transaction(() => {
      const due = this.db.query("SELECT * FROM tasks WHERE paused=0 AND schedule='interval' AND next_run_at<=?").all(now) as Row[];
      const claimed: Run[] = [];
      for (const row of due) {
        const task = this.mapTask(row);
        const occurrence = nextOccurrence(task.nextRunAt!, task.intervalMinutes!, now);
        // Consume this occurrence even while waiting. Never accumulate a missed backlog.
        this.db.query('UPDATE tasks SET next_run_at=? WHERE id=?').run(occurrence.next, task.id);
        if (this.activeRun(task.id)) continue;
        if (this.db.query('SELECT id FROM runs WHERE task_id=? AND scheduled_for=?').get(task.id, occurrence.latest)) continue;
        claimed.push(this.insertRun(task, 'schedule', occurrence.latest, mock, now));
      }
      return claimed;
    }).immediate();
  }
  isCurrent(id: string, fence: RunFence): boolean {
    const run = this.getRun(id);
    return run.status === 'running' && matchesFence(run, fence);
  }
  private persistSteps(run: Run) {
    this.db.query('UPDATE runs SET steps_snapshot=? WHERE id=?').run(JSON.stringify(run.steps), run.id);
  }
  setSession(id: string, sessionId: string, fence?: RunFence) {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'running' || !matchesFence(run, fence)) return;
      validateSessionId(sessionId);
      if (run.sessionId && run.sessionId !== sessionId) throw new AppError('CLI вернул другую сессию; запуск остановлен.', 409);
      const now = Date.now();
      this.db.query('UPDATE runs SET session_id=?,updated_at=? WHERE id=?').run(sessionId, now, id);
      if (run.currentStepIndex !== null) {
        updateStep(run.steps[run.currentStepIndex]!, { sessionId, updatedAt: now });
        this.persistSteps(run);
      }
    }).immediate();
  }
  finish(id: string, status: Exclude<RunStatus, 'running'>, summary: string | null, error: string | null, now = Date.now(), fence?: RunFence): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'running' || !matchesFence(run, fence)) return run;
      if (run.steps.length && (status === 'cancelled' || status === 'cancelling')) return this.cancel(id, now, status === 'cancelling');
      const cancelRequested = Boolean((this.db.query('SELECT cancel_requested FROM runs WHERE id=?').get(id) as Row).cancel_requested);
      if (run.currentStepIndex !== null) {
        const step = run.steps[run.currentStepIndex]!;
        updateStep(step, { status, summary, error, updatedAt: now, finishedAt: status === 'waiting_input' ? null : now });
        // Completion and successor claim are a single durable transaction. A crash
        // after commit leaves an interrupted successor, never a replayed predecessor.
        if (status === 'completed' && !cancelRequested && run.currentStepIndex + 1 < run.steps.length) {
          const index = run.currentStepIndex + 1;
          const next = run.steps[index]!;
          if (next.status !== 'pending') throw new AppError('Следующий этап уже был запущен', 409);
          beginAttempt(next, run.turn + 1, now);
          this.advanceAttachmentInputs(run, run.turn + 1);
          this.persistSteps(run);
          this.db.query(`UPDATE runs SET current_step_index=?,provider=?,worker_id=?,worker_snapshot=?,session_id=NULL,turn=turn+1,updated_at=?,summary=NULL,error=NULL,finished_at=NULL WHERE id=?`)
            .run(index, next.worker.provider, next.workerId, JSON.stringify(next.worker), now, id);
          return this.getRun(id);
        }
        this.persistSteps(run);
      }
      const cancelledChain = run.steps.length && status === 'completed' && cancelRequested;
      this.db.query(`UPDATE runs SET status=?,summary=?,error=?,updated_at=?,finished_at=? WHERE id=?`)
        .run(cancelledChain ? 'cancelled' : status, summary, error, now, status === 'waiting_input' ? null : now, id);
      return this.getRun(id);
    }).immediate();
  }
  resume(id: string, answer: string, acknowledgeInterruption = false, now = Date.now(), ids?: string[]): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (!['waiting_input', 'interrupted'].includes(run.status)) throw new AppError('Этот запуск нельзя продолжить', 409);
      if (!run.sessionId) throw new AppError('CLI не сохранил ID сессии. Для сложной задачи повторите текущий этап с подтверждением; иначе отмените запуск и создайте новый.', 409);
      if (run.status === 'interrupted' && !acknowledgeInterruption) throw new AppError('Сначала подтвердите, что предыдущий CLI-процесс остановлен. Повторный запуск может продублировать действия.', 409);
      this.db.query("UPDATE runs SET status='running',turn=turn+1,updated_at=?,finished_at=NULL,error=NULL WHERE id=?").run(now, id);
      if (run.currentStepIndex !== null) {
        updateStep(run.steps[run.currentStepIndex]!, { status: 'running', turn: run.turn + 1, updatedAt: now, finishedAt: null, error: null });
        this.persistSteps(run);
      }
      this.comment(run.taskId, id, 'user', answer, now, undefined, ids);
      this.advanceAttachmentInputs(run, run.turn + 1, attachmentIds(ids));
      return this.getRun(id);
    }).immediate();
  }
  retry(id: string, acknowledgeInterruption = false, now = Date.now()): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.currentStepIndex === null || !run.steps.length) throw new AppError('Повтор отдельного этапа доступен только для сложной задачи', 409);
      if (run.status === 'interrupted' && !run.sessionId) {
        if (!acknowledgeInterruption) throw new AppError('Подтвердите, что предыдущий CLI-процесс остановлен: повтор этапа может продублировать его действия.', 409);
      } else if (!['failed', 'blocked'].includes(run.status)) throw new AppError('Этот этап нельзя повторить. Сохранённую прерванную сессию нужно продолжить.', 409);
      const step = run.steps[run.currentStepIndex]!;
      beginAttempt(step, run.turn + 1, now);
      this.advanceAttachmentInputs(run, run.turn + 1);
      this.persistSteps(run);
      this.db.query("UPDATE runs SET status='running',session_id=NULL,turn=turn+1,updated_at=?,finished_at=NULL,summary=NULL,error=NULL WHERE id=?").run(now, id);
      this.comment(run.taskId, id, 'system', 'Повтор текущего этапа в новой сессии. Предыдущие попытки сохранены; выполненные действия не откатываются. Разрешения CLI не изменены.', now);
      return this.getRun(id);
    }).immediate();
  }
  cancel(id: string, now = Date.now(), pending = false, acknowledgeInterruption = false): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.steps.length && run.status === 'interrupted' && !acknowledgeInterruption) throw new AppError('Сначала подтвердите, что предыдущий CLI-процесс остановлен. Отмена освобождает задачу для новых запусков.', 409);
      const cancellable = ['running', 'waiting_input', 'interrupted', ...(run.steps.length ? ['failed', 'blocked'] : [])];
      if (!cancellable.includes(run.status)) throw new AppError('Запуск уже завершён', 409);
      this.db.query('UPDATE runs SET status=?,updated_at=?,finished_at=?,cancel_requested=1 WHERE id=?').run(pending ? 'cancelling' : 'cancelled', now, pending ? null : now, id);
      if (run.currentStepIndex !== null) {
        const current = run.steps[run.currentStepIndex]!;
        // Preserve the final failed/blocked attempt as history when abandoning it.
        if (['failed', 'blocked'].includes(current.status)) Object.assign(current, { status: 'cancelled', updatedAt: now, finishedAt: now });
        else updateStep(current, { status: pending ? 'cancelling' : 'cancelled', updatedAt: now, finishedAt: pending ? null : now });
        for (const step of run.steps.slice(run.currentStepIndex + 1)) if (step.status === 'pending') Object.assign(step, { status: 'cancelled', updatedAt: now, finishedAt: now });
        this.persistSteps(run);
      }
      this.comment(run.taskId, id, 'system', pending ? 'Останавливаем CLI. Задача остаётся занята до завершения процесса. Уже выполненные действия не откатываются.' : 'Запуск отменён. Уже выполненные агентом действия не откатываются.', now);
      return this.getRun(id);
    }).immediate();
  }
  completeCancellation(id: string, now = Date.now(), fence?: RunFence) {
    this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'cancelling' || !matchesFence(run, fence)) return;
      this.db.query("UPDATE runs SET status='cancelled',updated_at=?,finished_at=? WHERE id=?").run(now, now, id);
      if (run.currentStepIndex !== null) {
        updateStep(run.steps[run.currentStepIndex]!, { status: 'cancelled', updatedAt: now, finishedAt: now });
        this.persistSteps(run);
      }
    }).immediate();
  }
  reconcile(now = Date.now()): number {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT * FROM runs WHERE status IN ('running','cancelling')").all() as Row[];
      for (const row of rows) {
        const run = this.mapRun(row);
        const error = 'Сервис остановился во время запуска. Автоматический повтор отключён; проверьте предыдущий CLI-процесс перед продолжением.';
        this.db.query("UPDATE runs SET status='interrupted',updated_at=?,error=? WHERE id=?").run(now, error, run.id);
        if (run.currentStepIndex !== null) {
          updateStep(run.steps[run.currentStepIndex]!, { status: 'interrupted', updatedAt: now, error });
          this.persistSteps(run);
          // A cancellation interrupted by service exit remains cancelled for
          // successors. Continuing the current session cannot resurrect them.
        }
        this.comment(run.taskId, run.id, 'system', 'Запуск прерван перезапуском сервиса. Сессия сохранена, если CLI успел вернуть её ID. Автоматического повтора не будет.', now);
      }
      return rows.length;
    }).immediate();
  }
}
