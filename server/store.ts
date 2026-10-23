import { Database } from 'bun:sqlite';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Attachment, AutopilotInput, AutopilotOverview, AutopilotState, AutopilotStopReason, CheckTriage, CheckTriageCounts, CheckTriageOutcome, CliAccessMode, Comment, ConcurrencySettings, DocBlock, DocImage, DocPage, DocPageContentInput, DocPageCreateInput, DocPageExport, DocPageMarkdownInput, DocPageMoveInput, DocPageSummary, DocSearchHit, FallbackWorkers, FollowupInput, Instruction, InstructionInput, InstructionSnapshot, Integration, IntegratorProfile, IntegratorProfileInput, ModelCatalogEntry, ModelCatalogInput, Provider, Run, RunCheckFailure, RunFollowup, RunReconcile, RunStatus, RunStep, StepAttempt, Tag, TagInput, Task, TaskDetail, TaskInput, TaskLog, TaskLogInput, TaskStepInput, Worker, WorkerInput, WorkerSnapshot, WorkspaceSnapshot } from '../src/lib/types';
import type { RepositoryLocation } from './workspaces';
import type { IntegrationRecord, WorkspaceRun } from './workspace-storage';
import { clock } from './clock';
import { agentTimeoutMessage } from './adapter';
import { validateTimeLimitMinutes } from './validation';
import { INSTRUCTION_COUNT_LIMIT } from '../src/lib/instructions';
import { AUTOPILOT_FAILURE_LIMIT } from '../src/lib/autopilot';
import { DEFAULT_TASK_PRIORITY, isTaskPriority, TASK_PRIORITIES, TASK_PRIORITY_LABELS } from '../src/lib/priority';
import { validateIntegrationChecks } from '../src/lib/integration-checks';
import { CHECK_HANDBACK_LIMIT, CHECK_HANDBACK_OUTPUT_LIMIT, countTriage, emptyTriageCounts } from '../src/lib/check-triage';
import { CONCURRENCY_LIMIT_MAX, validateConcurrencyLimit } from '../src/lib/concurrency';
import { DEFAULT_TAG_COLOR, TAG_COUNT_LIMIT } from '../src/lib/tags';
import { normalizeProgress, RUN_PROGRESS_MAX_LENGTH } from '../src/lib/progress';
import { tagNameKey, validateTag, validateTagIds, validateTagPatch } from './tags';
import { validateInstruction, validateInstructionPatch, validateInstructionSnapshots } from './instructions';
import { assertDocPageSize, docSearchQuery, validateDocBlocks, validateDocPageContent, validateDocPageCreate, validateDocPageMarkdown, validateDocPageMove } from './docs';
import { DOC_DEPTH_LIMIT, DOC_IMAGE_MAX_COUNT, DOC_IMAGE_ORPHAN_TTL_MS, DOC_IMAGES_TOTAL_MAX_BYTES, DOC_PAGE_LIMIT, DOC_SEARCH_LIMIT, docSearchText } from '../src/lib/docs';
import { docBlocksToMarkdown, markdownToDocBlocks } from '../src/lib/docs-markdown';
import { AppError } from './errors';
import { validateWorkflowSteps } from './workflows';
import { validateSessionId } from './protocol';
import { sanitizeLogError } from './log-errors';
import { effortOptions, INTEGRATOR_WORKER_ID, integratorSnapshot, isBuiltinWorker, MODEL_CATALOG_PROVIDER_LIMIT, modelPresets, normalizeModel, normalizeWorkerDescription } from '../src/lib/workers';
import { validateModel, validateModelPatch } from './models';
import { followupRequestText, handbackOutput, validateFollowup } from './followups';
import { attachmentIds, preparedAttachmentPayload, type PreparedAttachment } from './attachments';
import { ATTACHMENT_MAX_COUNT, ATTACHMENT_TASK_MAX_COUNT, ATTACHMENT_TASK_MAX_BYTES, ATTACHMENT_STAGING_MAX_COUNT, ATTACHMENT_STAGING_MAX_BYTES, ATTACHMENT_TOTAL_MAX_BYTES, ATTACHMENT_STAGING_TTL_MS } from '../src/lib/attachments';
export { AppError } from './errors';
type Row = Record<string, any>;
const ATTACHMENT_COLUMNS = 'a.id,a.task_id,a.comment_id,a.run_id,a.step_index,a.attempt_id,a.source,a.name,a.mime,a.size,a.sha256,a.previewable,a.created_at';
const OPEN = "'queued','preparing','running','cancelling','waiting_input','interrupted'";
const OCCUPIED = `(status IN (${OPEN}) OR (steps_snapshot != '[]' AND status IN ('failed','blocked')))`;
/** A conflict handed to the built-in integrator, over the runs table `r`. */
const INTEGRATOR_WORK = "(r.trigger='reconcile')";
/** The most urgent priority sorts first. */
const PRIORITY_RANK = `CASE priority ${TASK_PRIORITIES.map((priority, rank) => `WHEN '${priority}' THEN ${rank}`).join(' ')} END`;
/** Higher priority first; within one priority, the queue order a person arranges by dragging; creation order breaks ties. */
const AUTOPILOT_ORDER = `${PRIORITY_RANK}, autopilot_position IS NULL, autopilot_position, created_at, rowid`;
export interface RunFence { turn: number; currentStepIndex: number | null; attemptId: string | null; }
export interface WorkspaceRecord { snapshot: WorkspaceSnapshot; taskId: string | null; taskTitle: string | null; runs: WorkspaceRun[]; }
const WORKSPACE_RECORD_SQL = `SELECT w.id, r.id AS run_id, r.task_id, r.status, r.started_at, i.state AS integration_state,
  json_extract(i.snapshot, '$.updatedAt') AS integration_updated_at, t.title
  FROM workspaces w LEFT JOIN runs r ON r.workspace_id=w.id LEFT JOIN integrations i ON i.run_id=r.id LEFT JOIN tasks t ON t.id=r.task_id`;
export interface ExecutionRequest { runId: string; turn: number; answer: string | undefined; location: RepositoryLocation; }
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
    ultracode: worker.ultracode, communicationStyle: worker.communicationStyle, avatarUrl: worker.avatarUrl };
}
/** The built-in integrator has no catalog row, so runs it performs keep worker_id NULL beside its frozen snapshot. */
const storedWorkerId = (worker: WorkerSnapshot | null | undefined): string | null => worker && !isBuiltinWorker(worker.id) ? worker.id : null;
/** Resolved results that conflict again are reconciled once more; constant churn stops here for a human. */
export const RECONCILE_DEPTH_LIMIT = 3;
/** A candidate rebuilt this many times because the target kept moving stops for a human. */
export const INTEGRATION_RECHECK_LIMIT = 3;
function validatedModel(value: unknown): string | null {
  try { return normalizeModel(value); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректная модель'); }
}
function validatedDescription(value: unknown): string {
  try { return normalizeWorkerDescription(value); }
  catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректное описание'); }
}
function validatedUltracode(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new AppError('ultracode должен быть boolean');
  return value;
}
/** A task's ultra choice: null follows the worker profile at launch. Stored as a nullable 0/1 column. */
function validatedTaskUltracode(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new AppError('ultracode должен быть true, false или null');
  return value;
}
const storedFlag = (value: boolean | null | undefined): number | null => value == null ? null : +value;
function validatedTaskPriority(value: unknown): Task['priority'] {
  if (!isTaskPriority(value)) throw new AppError(`Приоритет: укажите ${TASK_PRIORITIES.join(', ')}`);
  return value;
}
const readFlag = (value: unknown): boolean | null => value == null ? null : !!value;
function validatedDefaultCwd(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096 || value.includes('\0')) {
    throw new AppError('Рабочая папка по умолчанию: введите от 1 до 4096 символов');
  }
  const input = value.trim();
  if (!isAbsolute(input)) throw new AppError('Нужен абсолютный путь к рабочей папке');
  let cwd: string;
  try {
    cwd = realpathSync(input);
    if (!statSync(cwd).isDirectory()) throw new Error('Not a directory');
  } catch { throw new AppError('Рабочая папка не существует или недоступна сервису'); }
  if (cwd.length > 4_096) throw new AppError('Рабочая папка по умолчанию: не больше 4096 символов');
  return cwd;
}
function validatedDefaultSchedule(value: unknown): TaskInput['schedule'] {
  if (value !== 'auto' && value !== 'manual' && value !== 'interval') {
    throw new AppError('Тип запуска по умолчанию: выберите Автопилот, Вручную или По расписанию');
  }
  return value;
}
function validWorkerSnapshot(value: unknown): value is WorkerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const worker = value as WorkerSnapshot;
  const keys = Object.keys(worker).filter(key => key !== 'model' && key !== 'description' && key !== 'ultracode').sort().join(',');
  if (keys !== 'avatarUrl,communicationStyle,effort,id,name,provider') return false;
  if ('ultracode' in worker && typeof worker.ultracode !== 'boolean') return false;
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
    worker.ultracode ??= false;
    return true;
  } catch { return false; }
}
function sameWorker(left: WorkerSnapshot, right: WorkerSnapshot): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description && left.provider === right.provider && left.model === right.model && left.ultracode === right.ultracode && left.effort === right.effort && left.communicationStyle === right.communicationStyle && left.avatarUrl === right.avatarUrl;
}
/** Lists the board polls every two seconds keep the exit codes but leave check output to the card, run and integration reads. */
function withoutCheckOutput(run: Run): Run;
function withoutCheckOutput(run: Run | null): Run | null;
function withoutCheckOutput(run: Run | null): Run | null {
  if (!run) return run;
  const integration = run.integration, triage = integration?.triage, failure = run.followup?.checkFailure;
  const outputs = !!triage || !!failure?.output || !!integration?.checks.some(check => check.output !== undefined);
  if (!outputs) return run;
  return { ...run,
    ...(failure ? { followup: { ...run.followup!, checkFailure: { ...failure, output: '' } } } : {}),
    ...(integration ? { integration: { ...integration, checks: integration.checks.map(({ argv, exitCode }) => ({ argv, exitCode })),
      ...(triage ? { triage: { ...triage, retries: triage.retries.map(({ check, exitCode }) => ({ check, exitCode })),
        target: triage.target && { ...triage.target, checks: triage.target.checks.map(({ argv, exitCode }) => ({ argv, exitCode })) } } } : {}) } } : {}) };
}
/** Decided by its exit codes as the task's own failure; the engine hands it back or records why not in the same transaction. */
export const awaitsHandback = (job: Integration | null | undefined): boolean =>
  job?.status === 'failed' && job.triage?.stage === 'done' && job.triage.outcome === null && job.triage.target?.passed === true;
function invalidSnapshot(): never {
  throw new AppError('Повреждён снимок запуска. Запуск остановлен; восстановите базу из резервной копии.', 409);
}
function completedWorkflowSnapshot(value: unknown): asserts value is NonNullable<RunFollowup['workflow']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidSnapshot();
  const context = value as NonNullable<RunFollowup['workflow']>;
  if (Object.keys(context).sort().join(',') !== 'currentStepIndex,steps' || !Array.isArray(context.steps) ||
      context.steps.length < 2 || context.steps.length > 20 || !Number.isInteger(context.currentStepIndex) ||
      context.currentStepIndex < 0 || context.currentStepIndex >= context.steps.length) invalidSnapshot();
  validateWorkflowSteps(context.steps.map(({ workerId, title, instruction }) => ({ workerId, title, instruction })));
  const nullableText = (text: unknown) => text === null || (typeof text === 'string' && text.length <= 16_000);
  const time = (timestamp: unknown) => Number.isSafeInteger(timestamp) && (timestamp as number) >= 0;
  for (const step of context.steps) {
    if (!validWorkerSnapshot(step.worker) || step.workerId !== step.worker.id || step.status !== 'completed' ||
        !Array.isArray(step.attempts) || !step.attempts.length || !nullableText(step.summary) || !nullableText(step.error) ||
        !time(step.startedAt) || !time(step.updatedAt) || !time(step.finishedAt)) invalidSnapshot();
    if (step.sessionId !== null) validateSessionId(step.sessionId);
    for (const [index, attempt] of step.attempts.entries()) {
      if (!attempt || typeof attempt.id !== 'string' || !attempt.id || attempt.number !== index + 1 ||
          !Number.isSafeInteger(attempt.turn) || attempt.turn < 1 || !nullableText(attempt.summary) || !nullableText(attempt.error) ||
          !time(attempt.startedAt) || !time(attempt.updatedAt) || (attempt.finishedAt !== null && !time(attempt.finishedAt)) ||
          (index === step.attempts.length - 1 ? attempt.status !== 'completed' : !['failed', 'blocked', 'interrupted'].includes(attempt.status))) invalidSnapshot();
      if (attempt.sessionId !== null) validateSessionId(attempt.sessionId);
    }
    const latest = step.attempts.at(-1)!;
    if (latest.sessionId !== step.sessionId || latest.summary !== step.summary || latest.error !== step.error ||
        latest.updatedAt !== step.updatedAt || latest.finishedAt !== step.finishedAt) invalidSnapshot();
  }
}
function followupSnapshot(row: Row, worker: WorkerSnapshot | null): RunFollowup | null {
  if (row.followup_snapshot == null) {
    if (row.trigger === 'followup') invalidSnapshot();
    return null;
  }
  if (row.trigger !== 'followup' || row.workflow_version !== 0 || row.steps_snapshot !== '[]' || row.current_step_index !== null || row.scheduled_for !== null) invalidSnapshot();
  const value = JSON.parse(row.followup_snapshot) as RunFollowup;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).filter(key => key !== 'checkFailure').sort().join(',') !== 'request,sourceRunId,sourceStepIndex,workflow' ||
      typeof value.sourceRunId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.sourceRunId) || value.sourceRunId === row.id ||
      (value.sourceStepIndex !== null && (!Number.isInteger(value.sourceStepIndex) || value.sourceStepIndex < 0)) ||
      typeof value.request !== 'string' || !value.request.trim() || value.request.length > 8_000 || value.request.includes('\0')) invalidSnapshot();
  validateSessionId(row.session_id);
  validateInstructionSnapshots(JSON.parse(row.instructions_snapshot));
  if (worker ? storedWorkerId(worker) !== row.worker_id || worker.provider !== row.provider : row.worker_id !== null) invalidSnapshot();
  if (!['codex', 'claude'].includes(row.provider) || typeof row.cwd !== 'string' || !isAbsolute(row.cwd) || row.cwd.length > 4_096 || row.cwd.includes('\0') ||
      !Number.isSafeInteger(row.turn) || row.turn < 1 ||
      typeof row.instruction !== 'string' || !row.instruction.trim() || row.instruction.length > 16_000 || row.instruction.includes('\0')) invalidSnapshot();
  if (value.workflow !== null) {
    completedWorkflowSnapshot(value.workflow);
    if (value.sourceStepIndex !== null && value.sourceStepIndex !== value.workflow.currentStepIndex) invalidSnapshot();
    const selected = value.workflow.steps[value.workflow.currentStepIndex]!;
    if (!worker || !sameWorker(worker, selected.worker) || row.session_id !== selected.sessionId) invalidSnapshot();
  } else if (value.sourceStepIndex !== null) invalidSnapshot();
  if (Object.hasOwn(value, 'checkFailure')) checkFailureSnapshot(value.checkFailure);
  return value;
}
function checkFailureSnapshot(value: unknown): asserts value is RunCheckFailure {
  const failure = value as RunCheckFailure;
  const text = (item: unknown, maximum: number) => typeof item === 'string' && item.length <= maximum && !item.includes('\0');
  if (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
      Object.keys(failure).sort().join(',') !== 'argv,exitCode,integrationId,output,outputTruncated,round,targetBranch,targetCommit' ||
      typeof failure.integrationId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(failure.integrationId) ||
      !Number.isInteger(failure.round) || failure.round < 1 || failure.round > CHECK_HANDBACK_LIMIT ||
      !text(failure.targetBranch, 4_096) || !failure.targetBranch || typeof failure.targetCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(failure.targetCommit) ||
      !Array.isArray(failure.argv) || !failure.argv.length || failure.argv.length > 30 || !failure.argv.every(arg => text(arg, 4_096) && !!arg) ||
      !Number.isSafeInteger(failure.exitCode) || !text(failure.output, CHECK_HANDBACK_OUTPUT_LIMIT) || typeof failure.outputTruncated !== 'boolean') invalidSnapshot();
}
function reconcileSnapshot(row: Row, worker: WorkerSnapshot | null): RunReconcile | null {
  if (row.reconcile_snapshot == null) {
    if (row.trigger === 'reconcile') invalidSnapshot();
    return null;
  }
  if (row.trigger !== 'reconcile' || row.workflow_version !== 0 || row.steps_snapshot !== '[]' || row.current_step_index !== null || row.scheduled_for !== null || row.followup_snapshot != null) invalidSnapshot();
  const value = JSON.parse(row.reconcile_snapshot) as RunReconcile;
  const id = (text: unknown) => typeof text === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(text);
  const path = (text: unknown) => typeof text === 'string' && !!text && text.length <= 4_096 && !text.includes('\0');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'conflicts,depth,integrationId,sourceRunId,targetBranch,targetCommit' ||
      !id(value.sourceRunId) || value.sourceRunId === row.id || !id(value.integrationId) || !path(value.targetBranch) ||
      (value.targetCommit !== null && (typeof value.targetCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.targetCommit))) ||
      !Array.isArray(value.conflicts) || value.conflicts.length > 200 || !value.conflicts.every(path) ||
      !Number.isInteger(value.depth) || value.depth < 1 || value.depth > RECONCILE_DEPTH_LIMIT) invalidSnapshot();
  if (!worker || worker.id !== INTEGRATOR_WORKER_ID || row.worker_id !== null || worker.provider !== row.provider) invalidSnapshot();
  return value;
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
      CREATE TABLE IF NOT EXISTS tags (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL, name_key TEXT UNIQUE NOT NULL, color TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_tags (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, position INTEGER NOT NULL,
        PRIMARY KEY(task_id,tag_id)
      );
      CREATE INDEX IF NOT EXISTS tagged_tasks ON task_tags(tag_id,task_id);
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
      CREATE TABLE IF NOT EXISTS run_code_diffs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), baseline TEXT, result TEXT
      );
      CREATE INDEX IF NOT EXISTS task_comments ON comments(task_id, seq);
      CREATE TABLE IF NOT EXISTS task_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id), step_index INTEGER, kind TEXT NOT NULL, summary TEXT NOT NULL,
        details TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ordered_task_logs ON task_logs(task_id, seq);
      CREATE TABLE IF NOT EXISTS service_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL, identity TEXT);
    `);
    if (!(this.db.query('PRAGMA table_info(service_lease)').all() as Row[]).some(row => row.name === 'identity')) this.db.exec('ALTER TABLE service_lease ADD COLUMN identity TEXT');
    // Additive migrations preserve existing task IDs, runs, comments, and CLI sessions.
    this.db.transaction(() => {
      for (const [table, column, definition] of [
        ['tags', 'color', `TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}'`],
        ['workers', 'model', 'TEXT'],
        ['workers', 'description', "TEXT NOT NULL DEFAULT ''"],
        ['workers', 'ultracode', 'INTEGER NOT NULL DEFAULT 0 CHECK(ultracode IN (0,1))'],
        // The worker that picks up when this profile's provider runs out of usage limits; NULL follows the general settings.
        ['workers', 'fallback_worker_id', 'TEXT REFERENCES workers(id)'],
        // A deleted profile whose runs still reference it stays as a hidden row; NULL for every listed profile.
        ['workers', 'deleted_at', 'INTEGER'],
        // The turn a replacement worker started after an exhausted limit; NULL while nobody was replaced.
        ['runs', 'fallback_turn', 'INTEGER'],
        // The stage of work the agent reported through set_progress, and the turn it belongs to: a new turn never shows it.
        ['runs', 'progress', 'TEXT'],
        ['runs', 'progress_at', 'INTEGER'],
        ['runs', 'progress_turn', 'INTEGER'],
        ['tasks', 'time_limit_minutes', 'INTEGER CHECK(time_limit_minutes BETWEEN 1 AND 1440)'],
        ['runs', 'time_limit_minutes', 'INTEGER CHECK(time_limit_minutes BETWEEN 1 AND 1440)'],
        ['tasks', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_snapshot', 'TEXT'],
        ['runs', 'instructions_snapshot', "TEXT NOT NULL DEFAULT '[]'"],
        ['tasks', 'steps_template', "TEXT NOT NULL DEFAULT '[]'"],
        ['runs', 'steps_snapshot', "TEXT NOT NULL DEFAULT '[]'"],
        ['runs', 'current_step_index', 'INTEGER'],
        ['runs', 'workflow_version', 'INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0'],
        ['runs', 'followup_snapshot', 'TEXT'],
        ['runs', 'workspace_id', 'TEXT'],
        ['runs', 'reconcile_snapshot', 'TEXT'],
        ['comments', 'step_index', 'INTEGER'],
        ['task_logs', 'error', 'TEXT'],
        ['tasks', 'archived_at', 'INTEGER'],
        // NULL keeps the worker profile's setting, so existing cards and runs behave exactly as before.
        ['tasks', 'ultracode', 'INTEGER CHECK(ultracode IN (0,1))'],
        ['runs', 'ultracode', 'INTEGER CHECK(ultracode IN (0,1))'],
        // The card's place in the autopilot queue; NULL while the card is not scheduled as auto.
        ['tasks', 'autopilot_position', 'INTEGER'],
        // Existing cards become normal; the autopilot claims more urgent cards first.
        ['tasks', 'priority', `TEXT NOT NULL DEFAULT '${DEFAULT_TASK_PRIORITY}' CHECK(priority IN (${TASK_PRIORITIES.map(priority => `'${priority}'`).join(',')}))`],
      ]) {
        if (!(this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).some(row => row.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
      // Auto cards that predate the queue order, or come from an older backup, join its end in creation order.
      const unordered = this.db.query("SELECT id FROM tasks WHERE schedule='auto' AND autopilot_position IS NULL ORDER BY created_at, rowid").all() as Row[];
      const start = this.nextAutopilotPosition();
      unordered.forEach((row, index) => { this.db.query('UPDATE tasks SET autopilot_position=? WHERE id=?').run(start + index, row.id); });
      // Replace the legacy predicate atomically: queued work also occupies a task.
      this.db.exec(`DROP INDEX IF EXISTS one_open_run;
        CREATE UNIQUE INDEX one_open_run ON runs(task_id) WHERE status IN (${OPEN});
        CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_requests (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), turn INTEGER NOT NULL,
          repository_id TEXT NOT NULL, location TEXT NOT NULL, answer TEXT, state TEXT NOT NULL,
          UNIQUE(run_id,turn)
        );
        DROP INDEX IF EXISTS one_repository_execution;
        CREATE INDEX IF NOT EXISTS repository_executions ON execution_requests(repository_id,state);
        CREATE TABLE IF NOT EXISTS integrations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id),
          repository_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, snapshot TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_repository_integration ON integrations(repository_id)
          WHERE state IN ('checking','merging','cancelling','interrupted');`);
    }).immediate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS followup_requests (
      task_id TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
      PRIMARY KEY(task_id,request_id)
    )`);
    // The built-in integrator's single profile. The seeded inherit mode keeps the earlier behaviour until it is edited.
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS integrator_profile (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL CHECK(mode IN ('inherit','custom')),
        provider TEXT NOT NULL CHECK(provider IN ('codex','claude')), model TEXT, effort TEXT NOT NULL,
        communication_style TEXT NOT NULL DEFAULT '', avatar_url TEXT, updated_at INTEGER NOT NULL
      )`);
      this.db.query(`INSERT OR IGNORE INTO integrator_profile (singleton,mode,provider,model,effort,communication_style,avatar_url,updated_at)
        VALUES (1,'inherit','codex',NULL,'default','',NULL,?)`).run(clock());
    }).immediate();
    // The autopilot switch. It is off after every open: unattended work never resumes on its own after a restart.
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 0, until INTEGER,
        started_at INTEGER, stopped_at INTEGER, stop_reason TEXT CHECK(stop_reason IN ('manual','until','failures','restart')),
        failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      )`);
      this.db.query('INSERT OR IGNORE INTO autopilot (singleton,enabled,updated_at) VALUES (1,0,?)').run(clock());
    }).immediate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), integration_checks TEXT
    ); INSERT OR IGNORE INTO autopilot_settings (singleton,integration_checks) VALUES (1,NULL)`);
    // Failed-check triage: the saved switch (NULL follows the service's default) and how often each outcome happened.
    this.db.exec(`CREATE TABLE IF NOT EXISTS check_triage_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER CHECK(enabled IN (0,1)),
      flaky INTEGER NOT NULL DEFAULT 0, target_failed INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0,
      exhausted INTEGER NOT NULL DEFAULT 0, not_returned INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0
    ); INSERT OR IGNORE INTO check_triage_settings (singleton) VALUES (1)`);
    // Documentation pages: a global tree with the page content as one JSON array of blocks.
    this.db.exec(`CREATE TABLE IF NOT EXISTS doc_pages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      parent_id TEXT REFERENCES doc_pages(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
    ); CREATE INDEX IF NOT EXISTS doc_page_siblings ON doc_pages(parent_id, position);
    CREATE TABLE IF NOT EXISTS doc_images (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES doc_pages(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), sha256 TEXT NOT NULL, data BLOB NOT NULL,
      created_at INTEGER NOT NULL, orphaned_at INTEGER, CHECK(length(data)=size)
    ); CREATE INDEX IF NOT EXISTS doc_page_images ON doc_images(page_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_search USING fts5(page_id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2')`);
    this.rebuildDocSearch();
    this.db.exec(`CREATE TABLE IF NOT EXISTS cli_access_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT CHECK(mode IN ('standard','full'))
    ); INSERT OR IGNORE INTO cli_access_settings (singleton,mode) VALUES (1,NULL)`);
    // Saved process limits; NULL follows BRIGD_MAX_PARALLEL / BRIGD_MAX_PER_REPOSITORY.
    this.db.exec(`CREATE TABLE IF NOT EXISTS concurrency_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      max_parallel INTEGER CHECK(max_parallel BETWEEN 1 AND ${CONCURRENCY_LIMIT_MAX}),
      max_per_repository INTEGER CHECK(max_per_repository BETWEEN 1 AND ${CONCURRENCY_LIMIT_MAX})
    ); INSERT OR IGNORE INTO concurrency_settings (singleton) VALUES (1)`);
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS general_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), default_cwd TEXT,
        default_schedule TEXT NOT NULL DEFAULT 'manual' CHECK(default_schedule IN ('auto','manual','interval'))
      )`);
      const columns = (this.db.query('PRAGMA table_info(general_settings)').all() as Row[]).map(row => row.name as string);
      if (!columns.includes('default_schedule')) {
        this.db.exec("ALTER TABLE general_settings ADD COLUMN default_schedule TEXT NOT NULL DEFAULT 'manual' CHECK(default_schedule IN ('auto','manual','interval'))");
      }
      for (const column of ['agent_time_limit_minutes', 'integration_check_time_limit_minutes']) {
        if (!columns.includes(column)) this.db.exec(`ALTER TABLE general_settings ADD COLUMN ${column} INTEGER CHECK(${column} BETWEEN 1 AND 1440)`);
      }
      // Per provider: the worker that picks up a fresh run when that CLI reports exhausted usage limits.
      for (const column of ['fallback_codex', 'fallback_claude']) {
        if (!columns.includes(column)) this.db.exec(`ALTER TABLE general_settings ADD COLUMN ${column} TEXT REFERENCES workers(id)`);
      }
      // The worker preselected in the form of a new single-worker card.
      if (!columns.includes('default_worker_id')) this.db.exec('ALTER TABLE general_settings ADD COLUMN default_worker_id TEXT REFERENCES workers(id)');
      this.db.exec('INSERT OR IGNORE INTO general_settings (singleton,default_cwd) VALUES (1,NULL)');
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
        const now = clock();
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
        CREATE TABLE IF NOT EXISTS task_tool_operations (
          key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, result TEXT
        );
        CREATE TABLE IF NOT EXISTS mcp_tool_operations (
          key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT
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
  getCliAccessMode(): CliAccessMode | undefined {
    const row = this.db.query('SELECT mode FROM cli_access_settings WHERE singleton=1').get() as { mode: CliAccessMode | null };
    return row.mode ?? undefined;
  }
  setCliAccessMode(value: unknown): void {
    if (value !== 'standard' && value !== 'full') throw new AppError('Режим доступа должен быть standard или full');
    this.db.query('UPDATE cli_access_settings SET mode=? WHERE singleton=1').run(value);
  }
  getTimeLimits(): { agentTimeLimitMinutes: number | null; integrationCheckTimeLimitMinutes: number | null } {
    const row = this.db.query('SELECT agent_time_limit_minutes,integration_check_time_limit_minutes FROM general_settings WHERE singleton=1').get() as Row;
    return { agentTimeLimitMinutes: validateTimeLimitMinutes(row.agent_time_limit_minutes),
      integrationCheckTimeLimitMinutes: validateTimeLimitMinutes(row.integration_check_time_limit_minutes) };
  }
  private turnTimeLimit(taskId: string): number | null {
    // Read only the card's limit: workflow transitions may be midway through updating their snapshot here.
    const row = this.db.query('SELECT time_limit_minutes FROM tasks WHERE id=?').get(taskId) as Row;
    return validateTimeLimitMinutes(row.time_limit_minutes) ?? this.getTimeLimits().agentTimeLimitMinutes;
  }
  private snapshotTimeLimit(runId: string, taskId: string): void {
    this.db.query('UPDATE runs SET time_limit_minutes=? WHERE id=?').run(this.turnTimeLimit(taskId), runId);
  }
  getDefaultCwd(): string | null {
    const row = this.db.query('SELECT default_cwd FROM general_settings WHERE singleton=1').get() as { default_cwd: string | null };
    return row.default_cwd;
  }
  setDefaultCwd(value: unknown): string {
    const cwd = validatedDefaultCwd(value);
    this.db.query('UPDATE general_settings SET default_cwd=? WHERE singleton=1').run(cwd);
    return cwd;
  }
  getDefaultSchedule(): TaskInput['schedule'] {
    const row = this.db.query('SELECT default_schedule FROM general_settings WHERE singleton=1').get() as { default_schedule: TaskInput['schedule'] };
    return row.default_schedule;
  }
  setDefaultSchedule(value: unknown): TaskInput['schedule'] {
    const schedule = validatedDefaultSchedule(value);
    this.db.query('UPDATE general_settings SET default_schedule=? WHERE singleton=1').run(schedule);
    return schedule;
  }
  /** Saved ID as it is; the form skips an archived default instead of rewriting it. */
  getDefaultWorkerId(): string | null {
    const row = this.db.query('SELECT default_worker_id FROM general_settings WHERE singleton=1').get() as { default_worker_id: string | null };
    return row.default_worker_id ?? null;
  }
  /** Saved IDs as they are; an archived or missing worker is skipped at launch time, never silently rewritten. */
  getFallbackWorkers(): FallbackWorkers {
    const row = this.db.query('SELECT fallback_codex,fallback_claude FROM general_settings WHERE singleton=1').get() as { fallback_codex: string | null; fallback_claude: string | null };
    return { codex: row.fallback_codex ?? null, claude: row.fallback_claude ?? null };
  }
  /** A replacement must be a live, active profile; null switches the substitution off. */
  private validatedFallbackWorker(value: unknown, selfId: string | null = null, keptId: string | null = null): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new AppError('Замена при лимитах: выберите работника или оставьте поле пустым');
    if (value === selfId) throw new AppError('Работник не может заменять сам себя');
    const row = this.db.query('SELECT archived FROM workers WHERE id=? AND deleted_at IS NULL').get(value) as Row | null;
    if (!row) throw new AppError('Работник замены не найден', 404);
    if (row.archived && value !== keptId) throw new AppError('Работник замены в архиве. Восстановите его или выберите другого.', 409);
    return value;
  }
  /** The default must be an active profile; the already saved one may stay while archived; null clears it. */
  private validatedDefaultWorker(value: unknown, keptId: string | null): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new AppError('Работник по умолчанию: выберите работника или оставьте поле пустым');
    const row = this.db.query('SELECT archived FROM workers WHERE id=? AND deleted_at IS NULL').get(value) as Row | null;
    if (!row) throw new AppError('Работник по умолчанию не найден', 404);
    if (row.archived && value !== keptId) throw new AppError('Работник по умолчанию в архиве. Восстановите его или выберите другого.', 409);
    return value;
  }
  setFallbackWorkers(value: unknown): FallbackWorkers {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('fallbackWorkers: ожидается объект с полями codex и claude');
    const input = value as Record<string, unknown>;
    if (!Object.keys(input).length || Object.keys(input).some(key => key !== 'codex' && key !== 'claude')) throw new AppError('fallbackWorkers: допустимы только поля codex и claude');
    return this.db.transaction(() => {
      const current = this.getFallbackWorkers();
      const codex = Object.hasOwn(input, 'codex') ? this.validatedFallbackWorker(input.codex, null, current.codex) : current.codex;
      const claude = Object.hasOwn(input, 'claude') ? this.validatedFallbackWorker(input.claude, null, current.claude) : current.claude;
      this.db.query('UPDATE general_settings SET fallback_codex=?,fallback_claude=? WHERE singleton=1').run(codex, claude);
      return this.getFallbackWorkers();
    }).immediate();
  }
  updateGeneralSettings(value: Record<string, unknown>): void {
    const keys = Object.keys(value);
    if (!keys.length || keys.some(key => key !== 'defaultCwd' && key !== 'defaultSchedule' && key !== 'defaultWorkerId' && key !== 'fallbackWorkers' && key !== 'agentTimeLimitMinutes' && key !== 'integrationCheckTimeLimitMinutes')) {
      throw new AppError('Укажите defaultCwd, defaultSchedule, defaultWorkerId, fallbackWorkers, agentTimeLimitMinutes и/или integrationCheckTimeLimitMinutes');
    }
    const cwd = Object.hasOwn(value, 'defaultCwd') ? validatedDefaultCwd(value.defaultCwd) : null;
    const schedule = Object.hasOwn(value, 'defaultSchedule') ? validatedDefaultSchedule(value.defaultSchedule) : null;
    this.db.transaction(() => {
      for (const [field, column] of [['agentTimeLimitMinutes', 'agent_time_limit_minutes'], ['integrationCheckTimeLimitMinutes', 'integration_check_time_limit_minutes']] as const) {
        if (Object.hasOwn(value, field)) this.db.query(`UPDATE general_settings SET ${column}=? WHERE singleton=1`).run(validateTimeLimitMinutes(value[field]));
      }
      if (Object.hasOwn(value, 'fallbackWorkers')) this.setFallbackWorkers(value.fallbackWorkers);
      const current = this.getDefaultWorkerId();
      const worker = Object.hasOwn(value, 'defaultWorkerId') ? this.validatedDefaultWorker(value.defaultWorkerId, current) : current;
      this.db.query(`UPDATE general_settings SET default_cwd=COALESCE(?,default_cwd),
        default_schedule=COALESCE(?,default_schedule), default_worker_id=? WHERE singleton=1`).run(cwd, schedule, worker);
    }).immediate();
  }
  getIntegrationChecks(): string[][] | null {
    const row = this.db.query('SELECT integration_checks FROM autopilot_settings WHERE singleton=1').get() as { integration_checks: string | null };
    if (row.integration_checks === null) return null;
    try { return validateIntegrationChecks(JSON.parse(row.integration_checks)); }
    catch { throw new AppError('Повреждена настройка BRIGD_INTEGRATION_CHECKS. Сохраните команды в настройках → Автопилот.', 409); }
  }
  setIntegrationChecks(checks: string[][] | null): void {
    let validated: string[][] | null;
    try { validated = checks === null ? null : validateIntegrationChecks(checks); }
    catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректный BRIGD_INTEGRATION_CHECKS'); }
    this.db.query('UPDATE autopilot_settings SET integration_checks=? WHERE singleton=1').run(validated === null ? null : JSON.stringify(validated));
  }
  /** The saved switch of failed-check triage; null follows the service's default. */
  getCheckTriage(): boolean | null {
    const row = this.db.query('SELECT enabled FROM check_triage_settings WHERE singleton=1').get() as { enabled: number | null };
    return row.enabled === null ? null : !!row.enabled;
  }
  setCheckTriage(enabled: unknown): void {
    if (enabled !== null && typeof enabled !== 'boolean') throw new AppError('enabled должен быть true, false или null');
    this.db.query('UPDATE check_triage_settings SET enabled=? WHERE singleton=1').run(enabled === null ? null : +enabled);
  }
  checkTriageCounts(): CheckTriageCounts {
    const row = this.db.query('SELECT flaky,target_failed,returned,exhausted,not_returned,stopped FROM check_triage_settings WHERE singleton=1').get() as Row;
    return { flaky: row.flaky, targetFailed: row.target_failed, returned: row.returned, exhausted: row.exhausted, notReturned: row.not_returned, stopped: row.stopped };
  }
  /** Counted once per finished attempt, when its outcome is final. */
  private recordTriage(triage: CheckTriage | null | undefined) {
    const counts = emptyTriageCounts();
    countTriage(counts, triage);
    if (!Object.values(counts).some(Boolean)) return;
    this.db.query(`UPDATE check_triage_settings SET flaky=flaky+?,target_failed=target_failed+?,returned=returned+?,exhausted=exhausted+?,
      not_returned=not_returned+?,stopped=stopped+? WHERE singleton=1`).run(counts.flaky, counts.targetFailed, counts.returned, counts.exhausted, counts.notReturned, counts.stopped);
  }
  getConcurrencyLimits(): ConcurrencySettings['saved'] {
    const row = this.db.query('SELECT max_parallel,max_per_repository FROM concurrency_settings WHERE singleton=1').get() as { max_parallel: number | null; max_per_repository: number | null };
    return { maxParallel: row.max_parallel, maxPerRepository: row.max_per_repository };
  }
  /** Saves either limit or both; null returns that limit to the service's start-up value. */
  setConcurrencyLimits(value: Record<string, unknown>): ConcurrencySettings['saved'] {
    const keys = Object.keys(value);
    if (!keys.length || keys.some(key => key !== 'maxParallel' && key !== 'maxPerRepository')) throw new AppError('Укажите maxParallel и/или maxPerRepository');
    const field = (key: 'maxParallel' | 'maxPerRepository') => {
      if (value[key] === null) return null;
      try { return validateConcurrencyLimit(value[key], key); }
      catch (error) { throw new AppError(error instanceof Error ? error.message : 'Некорректный лимит'); }
    };
    const patch = { maxParallel: Object.hasOwn(value, 'maxParallel') ? field('maxParallel') : undefined, maxPerRepository: Object.hasOwn(value, 'maxPerRepository') ? field('maxPerRepository') : undefined };
    return this.db.transaction(() => {
      const current = this.getConcurrencyLimits();
      this.db.query('UPDATE concurrency_settings SET max_parallel=?,max_per_repository=? WHERE singleton=1')
        .run(patch.maxParallel === undefined ? current.maxParallel : patch.maxParallel, patch.maxPerRepository === undefined ? current.maxPerRepository : patch.maxPerRepository);
      return this.getConcurrencyLimits();
    }).immediate();
  }
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
  createModel(value: ModelCatalogInput, now = clock()): ModelCatalogEntry {
    const input = validateModel(value);
    return this.db.transaction(() => {
      this.checkModelCapacity(input.provider, input.modelId);
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO model_catalog (id,provider,model_id,label,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.provider, input.modelId, input.label, now, now);
      return this.getModel(id);
    }).immediate();
  }
  updateModel(id: string, value: Partial<ModelCatalogInput>, now = clock()): ModelCatalogEntry {
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
  createInstruction(value: InstructionInput, now = clock()): Instruction {
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
  updateInstruction(id: string, value: Partial<InstructionInput>, now = clock()): Instruction {
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
  private mapDocSummary(row: Row): DocPageSummary {
    return { id: row.id, parentId: row.parent_id ?? null, position: row.position, title: row.title,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null };
  }
  private docRow(id: string): Row {
    const row = this.db.query('SELECT * FROM doc_pages WHERE id=?').get(id) as Row | null;
    if (!row) throw new AppError('Страница не найдена', 404);
    return row;
  }
  /** The page and every descendant, trashed ones included, with their distance from the page. */
  private docSubtree(id: string): { id: string; depth: number }[] {
    return this.db.query(`WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 0 FROM doc_pages WHERE id=? UNION ALL SELECT p.id, sub.depth + 1 FROM doc_pages p JOIN sub ON p.parent_id = sub.id
    ) SELECT id, depth FROM sub`).all(id) as { id: string; depth: number }[];
  }
  /** 1 for a root page. */
  private docDepth(id: string): number {
    const row = this.db.query(`WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 1 FROM doc_pages WHERE id=? UNION ALL SELECT p.id, p.parent_id, up.depth + 1 FROM doc_pages p JOIN up ON p.id = up.parent_id
    ) SELECT max(depth) AS depth FROM up`).get(id) as Row;
    return row.depth ?? 0;
  }
  private docSiblings(parentId: string | null, except?: string): string[] {
    return (this.db.query('SELECT id FROM doc_pages WHERE parent_id IS ? AND deleted_at IS NULL ORDER BY position, seq').all(parentId) as Row[])
      .map(row => row.id as string).filter(id => id !== except);
  }
  private renumberDocSiblings(parentId: string | null): void {
    this.docSiblings(parentId).forEach((id, position) => { this.db.query('UPDATE doc_pages SET position=? WHERE id=? AND position!=?').run(position, id, position); });
  }
  private docParent(parentId: string | null): Row | null {
    if (parentId === null) return null;
    const parent = this.db.query('SELECT * FROM doc_pages WHERE id=?').get(parentId) as Row | null;
    if (!parent || parent.deleted_at !== null) throw new AppError('Родительская страница не найдена', 404);
    return parent;
  }
  /** FTS rows mirror live pages; trashed pages stay unsearchable until restored. */
  private indexDocPage(id: string): void {
    this.db.query('DELETE FROM doc_search WHERE page_id=?').run(id);
    const row = this.db.query('SELECT title, blocks, deleted_at FROM doc_pages WHERE id=?').get(id) as Row | null;
    if (!row || row.deleted_at !== null) return;
    this.db.query('INSERT INTO doc_search (page_id,title,body) VALUES (?,?,?)').run(id, row.title, docSearchText(JSON.parse(row.blocks) as DocBlock[]));
  }
  /** Databases from before the index existed get it filled once at startup. */
  private rebuildDocSearch(): void {
    const indexed = (this.db.query('SELECT count(*) AS n FROM doc_search').get() as Row).n;
    const live = this.db.query('SELECT id FROM doc_pages WHERE deleted_at IS NULL').all() as Row[];
    if (indexed || !live.length) return;
    this.db.transaction(() => { for (const row of live) this.indexDocPage(row.id); }).immediate();
  }
  listDocPages(): DocPageSummary[] {
    return (this.db.query('SELECT id,parent_id,position,title,created_at,updated_at,deleted_at FROM doc_pages WHERE deleted_at IS NULL ORDER BY parent_id IS NOT NULL, position, seq').all() as Row[])
      .map(row => this.mapDocSummary(row));
  }
  /** Roots of trashed subtrees: pages whose parent is live, missing, or was trashed separately. */
  listDeletedDocPages(): DocPageSummary[] {
    return (this.db.query(`SELECT p.id,p.parent_id,p.position,p.title,p.created_at,p.updated_at,p.deleted_at FROM doc_pages p LEFT JOIN doc_pages q ON q.id = p.parent_id
      WHERE p.deleted_at IS NOT NULL AND (q.id IS NULL OR q.deleted_at IS NULL OR q.deleted_at != p.deleted_at) ORDER BY p.deleted_at DESC, p.seq`).all() as Row[])
      .map(row => this.mapDocSummary(row));
  }
  getDocPage(id: string): DocPage {
    const row = this.docRow(id);
    return { ...this.mapDocSummary(row), blocks: JSON.parse(row.blocks) as DocBlock[], version: row.version };
  }
  searchDocPages(value: unknown): DocSearchHit[] {
    const match = docSearchQuery(value);
    if (!match) return [];
    let rows: Row[];
    try {
      rows = this.db.query(`SELECT doc_search.page_id AS id, p.parent_id, p.title, snippet(doc_search, 2, '[', ']', '…', 14) AS snippet
        FROM doc_search JOIN doc_pages p ON p.id = doc_search.page_id WHERE doc_search MATCH ? AND p.deleted_at IS NULL ORDER BY bm25(doc_search, 0, 4, 1) LIMIT ?`).all(match, DOC_SEARCH_LIMIT) as Row[];
    } catch { throw new AppError('Некорректный поисковый запрос'); }
    return rows.map(row => ({ id: row.id, parentId: row.parent_id ?? null, title: row.title, snippet: row.snippet }));
  }
  exportDocPage(id: string): DocPageExport {
    const page = this.getDocPage(id);
    return { id: page.id, parentId: page.parentId, title: page.title, childIds: this.docSiblings(id), updatedAt: page.updatedAt, markdown: docBlocksToMarkdown(page.blocks, { pageId: id }) };
  }
  createDocPage(value: DocPageCreateInput, now = clock()): DocPage {
    const input = validateDocPageCreate(value);
    return this.db.transaction(() => {
      if ((this.db.query('SELECT count(*) AS n FROM doc_pages').get() as Row).n >= DOC_PAGE_LIMIT) {
        throw new AppError(`Можно сохранить не больше ${DOC_PAGE_LIMIT} страниц. Удалите ненужные страницы из корзины.`);
      }
      const parentId = input.parentId ?? null;
      if (this.docParent(parentId) && this.docDepth(parentId!) >= DOC_DEPTH_LIMIT) {
        throw new AppError(`Вложенность страниц ограничена ${DOC_DEPTH_LIMIT} уровнями`);
      }
      const id = crypto.randomUUID();
      const title = input.title ?? '';
      const blocks = input.markdown === undefined ? [] : validateDocBlocks(markdownToDocBlocks(input.markdown, { pageId: id }));
      assertDocPageSize(title, blocks);
      this.assertDocReferences(id, blocks);
      this.db.query('INSERT INTO doc_pages (id,parent_id,position,title,blocks,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, parentId, this.docSiblings(parentId).length, title, JSON.stringify(blocks), 1, now, now);
      this.indexDocPage(id);
      return this.getDocPage(id);
    }).immediate();
  }
  /** Content saves are optimistic: the caller's version must match, so a stale tab never overwrites newer text. */
  saveDocPage(id: string, value: DocPageContentInput, now = clock()): DocPage {
    const input = validateDocPageContent(value);
    return this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at !== null) throw new AppError('Страница в корзине. Восстановите её, чтобы редактировать.', 409);
      if (row.version !== input.version) throw new AppError('Страница изменена в другом окне. Загрузите новую версию, чтобы продолжить.', 409);
      this.assertDocReferences(id, input.blocks);
      this.db.query('UPDATE doc_pages SET title=?,blocks=?,version=version+1,updated_at=? WHERE id=?').run(input.title, JSON.stringify(input.blocks), now, id);
      this.refreshDocImages(id, input.blocks, now);
      this.indexDocPage(id);
      return this.getDocPage(id);
    }).immediate();
  }
  /** Whole-content replacement from Markdown for API callers; the version grows so an open editor notices. */
  saveDocPageMarkdown(id: string, value: DocPageMarkdownInput, now = clock()): DocPage {
    const input = validateDocPageMarkdown(value);
    return this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at !== null) throw new AppError('Страница в корзине. Восстановите её, чтобы редактировать.', 409);
      const title = input.title ?? row.title;
      const blocks = input.markdown === undefined ? JSON.parse(row.blocks) as DocBlock[] : validateDocBlocks(markdownToDocBlocks(input.markdown, { pageId: id }));
      assertDocPageSize(title, blocks);
      this.assertDocReferences(id, blocks);
      this.db.query('UPDATE doc_pages SET title=?,blocks=?,version=version+1,updated_at=? WHERE id=?').run(title, JSON.stringify(blocks), now, id);
      this.refreshDocImages(id, blocks, now);
      this.indexDocPage(id);
      return this.getDocPage(id);
    }).immediate();
  }
  private assertDocReferences(pageId: string, blocks: DocBlock[]): void {
    for (const block of blocks) {
      if (block.type === 'image' && block.imageId && !this.db.query('SELECT 1 FROM doc_images WHERE id=? AND page_id=?').get(block.imageId, pageId)) {
        throw new AppError('Изображение не найдено на этой странице. Загрузите файл заново.');
      }
      if (block.type === 'task' && block.taskId && !this.db.query('SELECT 1 FROM tasks WHERE id=?').get(block.taskId)) throw new AppError('Задача из блока не найдена');
    }
  }
  /** Images the page stops showing stay for an hour so an undo can bring them back, then disappear. */
  private refreshDocImages(pageId: string, blocks: DocBlock[], now: number): void {
    const referenced = blocks.flatMap(block => block.type === 'image' && block.imageId ? [block.imageId] : []);
    const placeholders = referenced.map(() => '?').join(',');
    this.db.query(`UPDATE doc_images SET orphaned_at=? WHERE page_id=? AND orphaned_at IS NULL${referenced.length ? ` AND id NOT IN (${placeholders})` : ''}`).run(now, pageId, ...referenced);
    if (referenced.length) this.db.query(`UPDATE doc_images SET orphaned_at=NULL WHERE page_id=? AND id IN (${placeholders})`).run(pageId, ...referenced);
    this.sweepDocImages(now);
  }
  private sweepDocImages(now: number): void {
    this.db.query('DELETE FROM doc_images WHERE orphaned_at IS NOT NULL AND orphaned_at<=?').run(now - DOC_IMAGE_ORPHAN_TTL_MS);
  }
  private mapDocImage(row: Row): DocImage {
    return { id: row.id, pageId: row.page_id, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at };
  }
  listDocImages(pageId: string): DocImage[] {
    this.docRow(pageId);
    return (this.db.query('SELECT id,page_id,name,mime,size,created_at FROM doc_images WHERE page_id=? ORDER BY created_at, id').all(pageId) as Row[]).map(row => this.mapDocImage(row));
  }
  /** Only raster images that passed the attachment decoder are accepted; the upload counts as unreferenced until a block uses it. */
  addDocImage(pageId: string, prepared: PreparedAttachment, now = clock()): DocImage {
    if (!prepared.previewable) throw new AppError('Поддерживаются изображения PNG, JPEG, WebP и GIF', 415);
    return this.db.transaction(() => {
      const row = this.docRow(pageId);
      if (row.deleted_at !== null) throw new AppError('Страница в корзине. Восстановите её, чтобы добавлять изображения.', 409);
      this.sweepDocImages(now);
      if ((this.db.query('SELECT count(*) AS n FROM doc_images WHERE page_id=?').get(pageId) as Row).n >= DOC_IMAGE_MAX_COUNT) {
        throw new AppError(`На одной странице допустимо не больше ${DOC_IMAGE_MAX_COUNT} изображений`);
      }
      const total = (this.db.query('SELECT COALESCE(sum(size),0) AS bytes FROM doc_images').get() as Row).bytes as number;
      if (total + prepared.size > DOC_IMAGES_TOTAL_MAX_BYTES) throw new AppError('Хранилище изображений документации заполнено (1 ГиБ). Удалите ненужные картинки.', 413);
      const { data } = preparedAttachmentPayload(prepared);
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO doc_images (id,page_id,name,mime,size,sha256,data,created_at,orphaned_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, pageId, prepared.name, prepared.mime, prepared.size, prepared.sha256, data, now, now);
      return this.mapDocImage(this.db.query('SELECT id,page_id,name,mime,size,created_at FROM doc_images WHERE id=?').get(id) as Row);
    }).immediate();
  }
  readDocImage(pageId: string, id: string): { image: DocImage; data: Uint8Array } {
    const row = this.db.query('SELECT * FROM doc_images WHERE id=? AND page_id=?').get(id, pageId) as Row | null;
    if (!row) throw new AppError('Изображение не найдено', 404);
    return { image: this.mapDocImage(row), data: row.data };
  }
  moveDocPage(id: string, value: DocPageMoveInput, now = clock()): DocPageSummary {
    const input = validateDocPageMove(value);
    return this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at !== null) throw new AppError('Страница в корзине. Сначала восстановите её.', 409);
      const parentId = input.parentId === undefined ? row.parent_id ?? null : input.parentId;
      const subtree = this.docSubtree(id);
      if (parentId !== null) {
        this.docParent(parentId);
        if (subtree.some(node => node.id === parentId)) throw new AppError('Нельзя вложить страницу в саму себя или в её подстраницу');
        if (this.docDepth(parentId) + 1 + Math.max(...subtree.map(node => node.depth)) > DOC_DEPTH_LIMIT) {
          throw new AppError(`Вложенность страниц ограничена ${DOC_DEPTH_LIMIT} уровнями`);
        }
      }
      const siblings = this.docSiblings(parentId, id);
      const position = Math.min(input.position ?? (parentId === (row.parent_id ?? null) ? row.position : siblings.length), siblings.length);
      siblings.splice(position, 0, id);
      siblings.forEach((sibling, index) => { this.db.query('UPDATE doc_pages SET position=? WHERE id=?').run(index, sibling); });
      this.db.query('UPDATE doc_pages SET parent_id=?,updated_at=? WHERE id=?').run(parentId, now, id);
      if (parentId !== (row.parent_id ?? null)) this.renumberDocSiblings(row.parent_id ?? null);
      return this.mapDocSummary(this.docRow(id));
    }).immediate();
  }
  /** Moves the page and its live descendants to the trash under one stamp so they come back together. */
  deleteDocPage(id: string, now = clock()): void {
    this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at !== null) return;
      const latest = (this.db.query('SELECT max(deleted_at) AS stamp FROM doc_pages').get() as Row).stamp as number | null;
      const stamp = Math.max(now, (latest ?? 0) + 1);
      for (const node of this.docSubtree(id)) {
        this.db.query('UPDATE doc_pages SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL').run(stamp, now, node.id);
        this.db.query('DELETE FROM doc_search WHERE page_id=?').run(node.id);
      }
      this.renumberDocSiblings(row.parent_id ?? null);
    }).immediate();
  }
  /** Restores the subtree trashed together with the page; a page whose parent is still trashed returns to the root level. */
  restoreDocPage(id: string, now = clock()): DocPageSummary {
    return this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at === null) return this.mapDocSummary(row);
      const parent = row.parent_id ? this.db.query('SELECT deleted_at FROM doc_pages WHERE id=?').get(row.parent_id) as Row | null : null;
      const parentId = parent && parent.deleted_at === null ? row.parent_id as string : null;
      const subtree = this.docSubtree(id);
      for (const node of subtree) this.db.query('UPDATE doc_pages SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at=?').run(now, node.id, row.deleted_at);
      this.db.query('UPDATE doc_pages SET parent_id=?,position=? WHERE id=?').run(parentId, this.docSiblings(parentId, id).length, id);
      for (const node of subtree) this.indexDocPage(node.id);
      return this.mapDocSummary(this.docRow(id));
    }).immediate();
  }
  /** Permanently removes a trashed page with everything under it, including pages trashed separately and their images. */
  purgeDocPage(id: string): void {
    this.db.transaction(() => {
      const row = this.docRow(id);
      if (row.deleted_at === null) throw new AppError('Сначала переместите страницу в корзину', 409);
      for (const node of this.docSubtree(id)) this.db.query('DELETE FROM doc_search WHERE page_id=?').run(node.id);
      this.db.query('DELETE FROM doc_pages WHERE id=?').run(id);
    }).immediate();
  }
  private mapTag(row: Row): Tag {
    return { id: row.id, name: row.name, color: row.color ?? DEFAULT_TAG_COLOR, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listTags(): Tag[] {
    return (this.db.query('SELECT * FROM tags ORDER BY seq').all() as Row[]).map(row => this.mapTag(row));
  }
  getTag(id: string): Tag {
    const row = this.db.query('SELECT * FROM tags WHERE id=?').get(id) as Row | null;
    if (!row) throw new AppError('Тег не найден', 404);
    return this.mapTag(row);
  }
  private checkTagName(name: string, excludingId: string | null = null): void {
    if (this.db.query('SELECT id FROM tags WHERE name_key=? AND id IS NOT ?').get(tagNameKey(name), excludingId)) {
      throw new AppError('Тег с таким названием уже существует', 409);
    }
  }
  createTag(value: TagInput, now = clock()): Tag {
    const input = validateTag(value);
    return this.db.transaction(() => {
      this.checkTagName(input.name);
      if ((this.db.query('SELECT count(*) AS n FROM tags').get() as Row).n >= TAG_COUNT_LIMIT) {
        throw new AppError(`Можно сохранить не больше ${TAG_COUNT_LIMIT} тегов. Удалите ненужный тег.`, 409);
      }
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO tags(id,name,name_key,color,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, input.name, tagNameKey(input.name), input.color, now, now);
      return this.getTag(id);
    }).immediate();
  }
  updateTag(id: string, value: Partial<TagInput>, now = clock()): Tag {
    return this.db.transaction(() => {
      const current = this.getTag(id);
      const input = { ...current, ...validateTagPatch(value) };
      this.checkTagName(input.name, id);
      this.db.query('UPDATE tags SET name=?,name_key=?,color=?,updated_at=? WHERE id=?')
        .run(input.name, tagNameKey(input.name), input.color, now, id);
      return this.getTag(id);
    }).immediate();
  }
  deleteTag(id: string): void {
    const result = this.db.query('DELETE FROM tags WHERE id=?').run(id);
    if (!result.changes) throw new AppError('Тег не найден', 404);
  }
  private taskTags(taskId: string): Tag[] {
    return (this.db.query('SELECT t.* FROM tags t JOIN task_tags tt ON tt.tag_id=t.id WHERE tt.task_id=? ORDER BY tt.position').all(taskId) as Row[])
      .map(row => this.mapTag(row));
  }
  private replaceTaskTags(taskId: string, value: unknown): void {
    const ids = validateTagIds(value);
    // Check the complete assignment before removing any existing relation.
    for (const id of ids) if (!this.db.query('SELECT id FROM tags WHERE id=?').get(id)) throw new AppError('Выбранный тег не найден. Обновите список тегов.');
    this.db.query('DELETE FROM task_tags WHERE task_id=?').run(taskId);
    const insert = this.db.query('INSERT INTO task_tags(task_id,tag_id,position) VALUES (?,?,?)');
    ids.forEach((id, position) => insert.run(taskId, id, position));
  }
  /** Tag assignment is metadata: it never rewrites execution settings or run snapshots. */
  setTaskTags(id: string, ids: string[], now = clock()): Task {
    return this.db.transaction(() => {
      this.assertNotArchived(this.getTask(id));
      this.replaceTaskTags(id, ids);
      this.db.query('UPDATE tasks SET updated_at=? WHERE id=?').run(now, id);
      return this.getTask(id);
    }).immediate();
  }
  private mapWorker(row: Row): Worker {
    return { id: row.id, name: row.name, description: validatedDescription(row.description), provider: row.provider, model: validatedModel(row.model), effort: row.effort,
      ultracode: !!row.ultracode, communicationStyle: row.communication_style, avatarUrl: row.avatar_url, fallbackWorkerId: row.fallback_worker_id ?? null, archived: !!row.archived,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listWorkers(): Worker[] {
    return (this.db.query('SELECT * FROM workers WHERE deleted_at IS NULL ORDER BY archived, created_at DESC, rowid DESC').all() as Row[]).map(row => this.mapWorker(row));
  }
  getWorker(id: string): Worker {
    const row = this.db.query('SELECT * FROM workers WHERE id=? AND deleted_at IS NULL').get(id) as Row | null;
    if (!row) throw new AppError('Работник не найден', 404);
    return this.mapWorker(row);
  }
  private assertAvatar(avatarUrl: string | null) {
    if (avatarUrl === null) return;
    const match = avatarUrl.match(/^\/api\/avatars\/([a-f0-9]{64})$/);
    if (!match || !this.db.query('SELECT id FROM avatars WHERE id=?').get(match[1]!)) throw new AppError('Выберите загруженный аватар');
  }
  createWorker(input: WorkerInput, now = clock()): Worker {
    const model = validatedModel(input.model);
    const description = validatedDescription(input.description);
    const ultracode = validatedUltracode(input.ultracode);
    this.assertAvatar(input.avatarUrl);
    return this.db.transaction(() => {
      const fallback = this.validatedFallbackWorker(input.fallbackWorkerId);
      const id = crypto.randomUUID();
      this.db.query(`INSERT INTO workers (id,name,description,provider,model,ultracode,effort,communication_style,avatar_url,fallback_worker_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.name, description, input.provider, model, +ultracode, input.effort, input.communicationStyle, input.avatarUrl, fallback, now, now);
      return this.getWorker(id);
    }).immediate();
  }
  updateWorker(id: string, input: WorkerInput & { archived?: boolean }, now = clock()): Worker {
    return this.db.transaction(() => {
      const current = this.getWorker(id);
      const model = validatedModel(input.model === undefined && input.provider === current.provider ? current.model : input.model);
      const description = validatedDescription(input.description === undefined ? current.description : input.description);
      const ultracode = validatedUltracode(input.ultracode === undefined ? current.ultracode : input.ultracode);
      // An already saved replacement survives its own archiving until the profile picks another one.
      const fallback = this.validatedFallbackWorker(input.fallbackWorkerId === undefined ? current.fallbackWorkerId : input.fallbackWorkerId, id, current.fallbackWorkerId);
      this.assertAvatar(input.avatarUrl);
      this.db.query('UPDATE workers SET name=?,description=?,provider=?,model=?,ultracode=?,effort=?,communication_style=?,avatar_url=?,fallback_worker_id=?,archived=?,updated_at=? WHERE id=?')
        .run(input.name, description, input.provider, model, +ultracode, input.effort, input.communicationStyle, input.avatarUrl, fallback, +(input.archived ?? current.archived), now, id);
      return this.getWorker(id);
    }).immediate();
  }
  /** Who picks up a run whose provider ran out of usage limits: the worker profile's own choice, else the general setting for that provider. */
  fallbackWorkerFor(run: Pick<Run, 'provider' | 'worker'>): { worker: Worker | null; reason: string } {
    const own = run.worker && !isBuiltinWorker(run.worker.id) ? (this.db.query('SELECT fallback_worker_id FROM workers WHERE id=?').get(run.worker.id) as Row | null)?.fallback_worker_id ?? null : null;
    const id = own ?? this.getFallbackWorkers()[run.provider];
    const source = own ? 'в профиле работника' : 'в Настройки → Общие';
    if (!id) return { worker: null, reason: 'Замена при лимитах не настроена: выберите работника в профиле или в Настройки → Общие.' };
    const row = this.db.query('SELECT * FROM workers WHERE id=? AND deleted_at IS NULL').get(id) as Row | null;
    if (!row) return { worker: null, reason: `Работник замены (${source}) не найден.` };
    const worker = this.mapWorker(row);
    if (worker.archived) return { worker: null, reason: `Работник замены ${worker.name} (${source}) в архиве; восстановите его или выберите другого.` };
    if (run.worker && worker.id === run.worker.id) return { worker: null, reason: `Работник замены (${source}) совпадает с текущим работником.` };
    return { worker, reason: '' };
  }
  /** Hands the current fresh turn to a replacement worker in a new session; the failed turn stays in the step history. */
  substituteWorker(id: string, fence: RunFence, replacement: Worker, error: string, now = clock()): Run | null {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'running' || !matchesFence(run, fence) || run.trigger === 'followup' || run.trigger === 'reconcile') return null;
      const snapshot = workerSnapshot(replacement);
      if (run.currentStepIndex !== null) {
        const step = run.steps[run.currentStepIndex]!;
        updateStep(step, { status: 'failed', error, updatedAt: now, finishedAt: now });
        step.workerId = replacement.id;
        step.worker = snapshot;
        beginAttempt(step, run.turn + 1, now);
        this.persistSteps(run);
      }
      this.advanceAttachmentInputs(run, run.turn + 1);
      this.snapshotTimeLimit(id, run.taskId);
      this.db.query(`UPDATE runs SET provider=?,worker_id=?,worker_snapshot=?,session_id=NULL,turn=turn+1,fallback_turn=turn+1,updated_at=?,summary=NULL,error=NULL,finished_at=NULL WHERE id=?`)
        .run(snapshot.provider, replacement.id, JSON.stringify(snapshot), now, id);
      return this.getRun(id);
    }).immediate();
  }
  archiveWorker(id: string, now = clock()): Worker {
    this.getWorker(id);
    // Keep references and immutable avatars so scheduled tasks and old sessions remain usable.
    this.db.query('UPDATE workers SET archived=1,updated_at=? WHERE id=?').run(now, id);
    return this.getWorker(id);
  }
  /** Removes a profile for good. A card that still names it, even an archived one, must be reassigned or deleted first;
   * replacement and default choices pointing at it are cleared. Runs keep their own snapshots, so a profile that has
   * already worked stays behind only as a hidden row its run history refers to. */
  deleteWorker(id: string, now = clock()): void {
    this.db.transaction(() => {
      this.getWorker(id);
      const assigned = this.db.query(`SELECT count(*) AS n, coalesce(sum(archived_at IS NOT NULL),0) AS archived FROM tasks WHERE worker_id=?
        OR EXISTS (SELECT 1 FROM json_each(tasks.steps_template) WHERE json_extract(value,'$.workerId')=?)`).get(id, id) as Row;
      if (assigned.n) {
        throw new AppError(`Работник назначен в задачах: ${assigned.n}${assigned.archived ? `, из них в архиве: ${assigned.archived}` : ''}. Назначьте им другого работника или удалите эти задачи, затем повторите.`, 409);
      }
      this.db.query('UPDATE workers SET fallback_worker_id=NULL WHERE fallback_worker_id=?').run(id);
      this.db.query(`UPDATE general_settings SET fallback_codex=nullif(fallback_codex,?1),fallback_claude=nullif(fallback_claude,?1),
        default_worker_id=nullif(default_worker_id,?1) WHERE singleton=1`).run(id);
      if (this.db.query('SELECT 1 FROM runs WHERE worker_id=? LIMIT 1').get(id)) this.db.query('UPDATE workers SET archived=1,deleted_at=?,updated_at=? WHERE id=?').run(now, now, id);
      else this.db.query('DELETE FROM workers WHERE id=?').run(id);
    }).immediate();
  }
  /** Hidden rows of deleted profiles go once no run history refers to them any more. */
  private pruneDeletedWorkers() {
    this.db.query(`DELETE FROM workers WHERE deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.worker_id=workers.id)
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.worker_id=workers.id) AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.fallback_worker_id=workers.id)
      AND NOT EXISTS (SELECT 1 FROM general_settings g WHERE workers.id IN (g.fallback_codex,g.fallback_claude,g.default_worker_id))`).run();
  }
  private mapIntegratorProfile(row: Row): IntegratorProfile {
    return { mode: row.mode, provider: row.provider, model: row.model ?? null, effort: row.effort,
      communicationStyle: row.communication_style, avatarUrl: row.avatar_url, updatedAt: row.updated_at };
  }
  getIntegratorProfile(): IntegratorProfile {
    return this.mapIntegratorProfile(this.db.query('SELECT * FROM integrator_profile WHERE singleton=1').get() as Row);
  }
  /** Applies to reconcile runs created afterwards; started runs keep their frozen snapshot. */
  updateIntegratorProfile(input: IntegratorProfileInput, now = clock()): IntegratorProfile {
    const model = validatedModel(input.model);
    this.assertAvatar(input.avatarUrl);
    this.db.query('UPDATE integrator_profile SET mode=?,provider=?,model=?,effort=?,communication_style=?,avatar_url=?,updated_at=? WHERE singleton=1')
      .run(input.mode, input.provider, model, input.effort, input.communicationStyle, input.avatarUrl, now);
    return this.getIntegratorProfile();
  }
  private mapAutopilot(row: Row): AutopilotState {
    return { enabled: !!row.enabled, until: row.until ?? null, startedAt: row.started_at ?? null, stoppedAt: row.stopped_at ?? null,
      stopReason: row.stop_reason ?? null, failures: row.failures, updatedAt: row.updated_at };
  }
  getAutopilot(): AutopilotState {
    return this.mapAutopilot(this.db.query('SELECT * FROM autopilot WHERE singleton=1').get() as Row);
  }
  /** Enabling starts a session: the pool, the failure counter and the report count from this moment. Enabling again only changes the stop time. */
  setAutopilot(input: AutopilotInput, now = clock()): AutopilotState {
    return this.db.transaction(() => {
      const state = this.getAutopilot();
      if (input.enabled && !state.enabled) {
        this.db.query('UPDATE autopilot SET enabled=1,until=?,started_at=?,stopped_at=NULL,stop_reason=NULL,failures=0,updated_at=? WHERE singleton=1').run(input.until, now, now);
      } else if (!input.enabled && state.enabled) {
        this.db.query("UPDATE autopilot SET enabled=0,until=?,stopped_at=?,stop_reason='manual',updated_at=? WHERE singleton=1").run(input.until, now, now);
      } else {
        this.db.query('UPDATE autopilot SET until=?,updated_at=? WHERE singleton=1').run(input.until, now);
      }
      return this.getAutopilot();
    }).immediate();
  }
  /** The autopilot switches itself off at the stop time, after too many failures or when the service restarts. Running work is never cancelled. */
  stopAutopilot(reason: Exclude<AutopilotStopReason, 'manual'>, now = clock()): AutopilotState {
    this.db.query('UPDATE autopilot SET enabled=0,stopped_at=?,stop_reason=?,updated_at=? WHERE singleton=1 AND enabled=1').run(now, reason, now);
    return this.getAutopilot();
  }
  /** Pool tasks in claim order: the queue's head first. With a session start, tasks the autopilot already attempted in that session are left out. */
  private autopilotRows(sessionStart: number | null, taskId?: string): Row[] {
    return (this.db.query(`SELECT * FROM tasks t WHERE schedule='auto' AND paused=0 AND archived_at IS NULL AND (? IS NULL OR id=?)
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.status='completed')
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.trigger='autopilot' AND r.started_at>=?)
      ORDER BY ${AUTOPILOT_ORDER}`).all(taskId ?? null, taskId ?? null, sessionStart ?? Number.MAX_SAFE_INTEGER) as Row[])
      .filter(row => !this.activeRun(row.id));
  }
  /** The end of the autopilot queue. Positions only order the queue, so gaps left by finished cards are harmless. */
  private nextAutopilotPosition(): number {
    return (this.db.query('SELECT COALESCE(MAX(autopilot_position), -1) + 1 AS n FROM tasks').get() as Row).n;
  }
  /**
   * Places an auto card right before another one of the same priority, or at the end of its priority with null.
   * Deferred and already attempted cards keep their places too, so a card returned to the pool resumes its turn.
   */
  moveAutopilotTask(taskId: string, beforeTaskId: string | null): AutopilotOverview {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      this.assertNotArchived(task);
      if (task.schedule !== 'auto') throw new AppError('Задача не стоит в очереди автопилота. Выберите для неё режим «Автопилот».', 409);
      const rows = this.db.query(`SELECT id,priority FROM tasks WHERE schedule='auto' AND archived_at IS NULL AND id!=? ORDER BY ${AUTOPILOT_ORDER}`).all(taskId) as Row[];
      const queue = rows.map(row => row.id as string);
      // Positions are numbered across the whole queue, so the end of the queue is the end of the card's own priority.
      const index = beforeTaskId === null ? queue.length : queue.indexOf(beforeTaskId);
      if (index < 0) throw new AppError('Задача, перед которой нужно поставить эту, больше не в очереди автопилота. Обновите страницу и повторите.', 409);
      if (beforeTaskId !== null && rows[index]!.priority !== task.priority) {
        throw new AppError(`Задачу можно переставить только среди задач с тем же приоритетом («${TASK_PRIORITY_LABELS[task.priority]}»). Чтобы она шла раньше или позже, измените её приоритет.`, 409);
      }
      queue.splice(index, 0, taskId);
      queue.forEach((id, position) => { this.db.query('UPDATE tasks SET autopilot_position=? WHERE id=? AND autopilot_position IS NOT ?').run(position, id, position); });
      return this.autopilotOverview();
    }).immediate();
  }
  autopilotPool(sessionStart: number | null): Task[] { return this.autopilotRows(sessionStart).map(row => this.mapTask(row)); }
  /** The scheduler tick needs only identity and folder. */
  autopilotCandidates(sessionStart: number | null): { id: string; cwd: string }[] { return this.autopilotRows(sessionStart).map(row => ({ id: row.id, cwd: row.cwd })); }
  autopilotAttempts(sessionStart: number | null): Run[] {
    if (sessionStart === null) return [];
    return (this.db.query("SELECT * FROM runs WHERE trigger='autopilot' AND started_at>=? ORDER BY started_at ASC, rowid ASC").all(sessionStart) as Row[]).map(row => this.mapRun(row));
  }
  autopilotOverview(): AutopilotOverview {
    const state = this.getAutopilot();
    return { ...state, pool: this.autopilotPool(state.enabled ? state.startedAt : null).map(task => ({ ...task, latestRun: withoutCheckOutput(task.latestRun) })),
      attempts: this.autopilotAttempts(state.startedAt).map(run => withoutCheckOutput(run)), triage: this.autopilotTriage(state.startedAt) };
  }
  /** Every merge of the session's tasks counts, hand-backs and integrator runs included: their triage is part of the same task. */
  private autopilotTriage(sessionStart: number | null): CheckTriageCounts {
    const counts = emptyTriageCounts();
    if (sessionStart === null) return counts;
    const rows = this.db.query(`SELECT i.snapshot FROM integrations i JOIN runs r ON r.id=i.run_id WHERE r.started_at>=?1
      AND r.task_id IN (SELECT task_id FROM runs WHERE trigger='autopilot' AND started_at>=?1)`).all(sessionStart) as Row[];
    for (const row of rows) countTriage(counts, (JSON.parse(row.snapshot) as Integration).triage);
    return counts;
  }
  /** Starts a pool task on the autopilot's behalf; null when the task left the pool or the autopilot was switched off meanwhile. */
  startAutopilot(taskId: string, mock: boolean, now = clock()): Run | null {
    return this.db.transaction(() => {
      const state = this.getAutopilot();
      if (!state.enabled || (state.until !== null && now >= state.until) || !this.autopilotRows(state.startedAt, taskId).length) return null;
      const run = this.insertRun(this.getTask(taskId), 'autopilot', null, mock, now);
      this.log(taskId, run.id, { kind: 'lifecycle', summary: 'Запуск автопилотом', details: ['Подошла очередь задачи, и освободилось место для запуска.'] }, now);
      return run;
    }).immediate();
  }
  /** Reserves a free process slot and a free repository before the run exists, so the pool never piles up as queued runs. */
  claimAutopilot(taskId: string, location: RepositoryLocation, mock: boolean, maximum: number, perRepository: number, now = clock()): Run | null {
    return this.db.transaction(() => {
      if (this.autopilotCapacity(maximum) < 1 || this.repositoryBusy(location.repositoryId, perRepository, false) ||
          this.db.query("SELECT seq FROM execution_requests WHERE repository_id=? AND state='queued'").get(location.repositoryId)) return null;
      const run = this.startAutopilot(taskId, mock, now);
      return run && this.enqueueExecution(run, location);
    }).immediate();
  }
  /** Process slots left for lazily claimed work: requests already queued count as reserved. */
  autopilotCapacity(maximum: number): number {
    const queued = (this.db.query(`SELECT COUNT(*) AS n FROM execution_requests e JOIN runs r ON r.id=e.run_id AND r.turn=e.turn WHERE e.state='queued' AND r.status='queued'`).get() as { n: number }).n;
    return Math.max(0, maximum - this.occupiedSlots() - queued);
  }
  saveAvatar(data: Uint8Array, mime: string, now = clock()): string {
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
  cleanupAttachments(now = clock(), limit = 100): number {
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
  stageAttachment(prepared: PreparedAttachment, now = clock()): Attachment {
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
  beginTaskToolOperation(runId: string, fence: RunFence, idempotencyKey: string, fingerprint: string): { key: string; result: string | null; fresh: boolean } {
    return this.db.transaction(() => {
      const run = this.assertPublicationRun(runId, fence);
      const key = this.publicationKey(run, fence, idempotencyKey);
      const previous = this.db.query('SELECT fingerprint,result FROM task_tool_operations WHERE key=?').get(key) as Row | null;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError('idempotency_key уже использован для другой операции', 409);
        return { key, result: previous.result, fresh: false };
      }
      // Persist intent before a side effect. An interrupted request is never
      // executed twice, even when a new broker is opened for the same turn.
      this.db.query('INSERT INTO task_tool_operations(key,run_id,fingerprint) VALUES (?,?,?)').run(key, runId, fingerprint);
      return { key, result: null, fresh: true };
    }).immediate();
  }
  finishTaskToolOperation(key: string, result: string): void {
    if (Buffer.byteLength(result) > 4096) throw new AppError('Слишком большой результат операции MCP');
    this.db.query('UPDATE task_tool_operations SET result=? WHERE key=? AND result IS NULL').run(result, key);
  }
  /** External MCP receipts survive reconnects and restarts without creating a run. */
  beginMcpToolOperation(principal: string, idempotencyKey: string, fingerprint: string): { key: string; result: string | null; fresh: boolean } {
    if (!/^[a-f0-9]{64}$/.test(principal) || !/^[a-zA-Z0-9_-]{1,100}$/.test(idempotencyKey)) throw new AppError('Invalid MCP operation identity.');
    const key = JSON.stringify([principal, idempotencyKey]);
    return this.db.transaction(() => {
      const previous = this.db.query('SELECT fingerprint,result FROM mcp_tool_operations WHERE key=?').get(key) as Row | null;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError('idempotency_key уже использован для другой операции', 409);
        return { key, result: previous.result, fresh: false };
      }
      this.db.query('INSERT INTO mcp_tool_operations(key,fingerprint) VALUES (?,?)').run(key, fingerprint);
      return { key, result: null, fresh: true };
    }).immediate();
  }
  finishMcpToolOperation(key: string, result: string): void {
    if (Buffer.byteLength(result) > 4096) throw new AppError('Слишком большой результат операции MCP');
    this.db.query('UPDATE mcp_tool_operations SET result=? WHERE key=? AND result IS NULL').run(result, key);
  }
  publishAgentAttachment(runId: string, fence: RunFence, requestId: string, prepared: PreparedAttachment, caption?: string, now = clock()): Attachment {
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
  publishAgentComment(runId: string, fence: RunFence, requestId: string, value: { body: string; attachmentIds?: string[] }, now = clock()): Comment {
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
  /** The agent's own display-only stage of work; it never changes the run's lifecycle status. */
  setRunProgress(runId: string, fence: RunFence, value: unknown, now = clock()): Run {
    const text = normalizeProgress(value);
    if (text === null) throw new AppError(`Статус выполнения: одна строка до ${RUN_PROGRESS_MAX_LENGTH} символов`);
    return this.db.transaction(() => {
      const run = this.assertPublicationRun(runId, fence);
      if (run.progress?.text === text) return run;
      this.db.query('UPDATE runs SET progress=?,progress_at=?,progress_turn=? WHERE id=?').run(text, now, run.turn, runId);
      this.log(run.taskId, runId, { kind: 'progress', summary: `Статус выполнения: ${text}`, details: ['Работник обновил статус выполнения задачи.'] }, now, run.currentStepIndex);
      return this.getRun(runId);
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
    try { return this.mapRunSnapshot(row); }
    catch { return invalidSnapshot(); }
  }
  private mapRunSnapshot(row: Row): Run {
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
      const statuses = ['queued', 'preparing', 'running', 'cancelling', 'waiting_input', 'interrupted', 'failed', 'blocked', 'completed', 'cancelled'];
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
    const followup = followupSnapshot(row, worker as WorkerSnapshot | null);
    const reconcile = reconcileSnapshot(row, worker as WorkerSnapshot | null);
    const workspace = row.workspace_id ? this.getWorkspace(row.workspace_id) : null;
    return { timeLimitExceeded: row.status === 'failed' && row.time_limit_minutes != null && row.error === agentTimeoutMessage(row.time_limit_minutes), integration: this.integrationForRun(row.id), workspace, followup, reconcile, inputAttachments: this.inputAttachments(row.id, row.turn), steps, currentStepIndex: row.current_step_index ?? null, id: row.id, taskId: row.task_id, instructions: JSON.parse(row.instructions_snapshot ?? '[]') as InstructionSnapshot[], workerId: row.worker_id ?? null, worker: worker as WorkerSnapshot | null, ultracode: readFlag(row.ultracode), timeLimitMinutes: validateTimeLimitMinutes(row.time_limit_minutes), fallbackTurn: row.fallback_turn ?? null,
      progress: row.status === 'running' && row.progress_turn === row.turn && typeof row.progress === 'string' ? { text: row.progress, updatedAt: row.progress_at } : null, provider: row.provider, cwd: row.cwd, instruction: row.instruction,
      trigger: row.trigger, scheduledFor: row.scheduled_for, status: row.status, sessionId: row.session_id,
      startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, summary: row.summary,
      error: row.error, turn: row.turn, mock: !!row.mock };
  }
  private mapTask(row: Row): Task {
    const latest = this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(row.id) as Row | null;
    const worker = row.worker_id ? this.getWorker(row.worker_id) : null;
    const hasCompletedRun = !!this.db.query("SELECT 1 FROM runs WHERE task_id=? AND status='completed' LIMIT 1").get(row.id);
    const tags = this.taskTags(row.id);
    const latestRun = latest ? this.mapRun(latest) : null;
    const integrationStatuses: Partial<Record<Integration['status'], Task['status']>> = {
      queued: 'awaiting_merge', checking: 'integrating', merging: 'integrating', cancelling: 'integrating',
      conflict: 'merge_conflict', failed: 'merge_failed', blocked: 'merge_blocked', interrupted: 'merge_interrupted', cancelled: 'merge_blocked',
    };
    return { tagIds: tags.map(tag => tag.id), tags, hasCompletedRun, attachments: this.taskAttachments(row.id), steps: validateWorkflowSteps(JSON.parse(row.steps_template ?? '[]')), id: row.id, workerId: row.worker_id ?? null, worker, title: row.title, instruction: row.instruction, provider: worker?.provider ?? row.provider, cwd: row.cwd, ultracode: readFlag(row.ultracode), timeLimitMinutes: validateTimeLimitMinutes(row.time_limit_minutes),
      priority: row.priority ?? DEFAULT_TASK_PRIORITY, schedule: row.schedule, intervalMinutes: row.interval_minutes, firstRunAt: row.first_run_at,
      nextRunAt: row.next_run_at, paused: !!row.paused, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at ?? null,
      status: latestRun?.integration ? integrationStatuses[latestRun.integration.status] ?? latestRun.status : latest?.status ?? 'ready', latestRun,
      runCount: (this.db.query('SELECT count(*) AS n FROM runs WHERE task_id = ?').get(row.id) as Row).n };
  }
  listTasks(tagId?: string): Task[] {
    const rows = tagId === undefined
      ? this.db.query('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all()
      : this.db.query('SELECT * FROM tasks WHERE id IN (SELECT task_id FROM task_tags WHERE tag_id=?) ORDER BY created_at DESC, rowid DESC').all(validateTagIds([tagId])[0]!);
    return (rows as Row[]).map(row => this.mapTask(row)).map(task => ({ ...task, latestRun: withoutCheckOutput(task.latestRun) }));
  }
  getTask(id: string): Task {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Row | null;
    if (!row) throw new AppError('Задача не найдена', 404);
    return this.mapTask(row);
  }
  resolveTaskReference(reference: string): Task {
    // Task cards show six hex characters; the task drawer shows eight. Longer
    // references must remain a prefix of the canonical, hyphenated UUID.
    if (typeof reference !== 'string' || reference.length < 6 || reference.length > 36 ||
        !/^[a-f0-9-]+$/i.test(reference) || [...reference].some((character, index) =>
          [8, 13, 18, 23].includes(index) ? character !== '-' : character === '-')) {
      throw new AppError('Укажите ID задачи или его префикс длиной от 6 символов');
    }
    const exact = this.db.query('SELECT id FROM tasks WHERE id=? COLLATE NOCASE LIMIT 2').all(reference) as Row[];
    const matches = exact.length ? exact : this.db.query('SELECT id FROM tasks WHERE id LIKE ? LIMIT 2').all(`${reference}%`) as Row[];
    if (!matches.length) throw new AppError('Задача не найдена', 404);
    if (matches.length > 1) throw new AppError('Префикс задачи неоднозначен. Укажите полный ID задачи.', 409);
    return this.getTask(matches[0]!.id);
  }
  /** Archived tasks are read-only until restored; history and attachments stay readable. */
  private assertNotArchived(task: Task) {
    if (task.archivedAt !== null) throw new AppError('Задача в архиве. Восстановите её, чтобы продолжить работу.', 409);
  }
  archiveTask(id: string, now = clock()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (task.archivedAt !== null) return task;
      if (this.activeRun(id)) throw new AppError('Сначала завершите или отмените текущий запуск, затем перенесите задачу в архив.', 409);
      this.db.query('UPDATE tasks SET archived_at=?,updated_at=? WHERE id=?').run(now, now, id);
      return this.getTask(id);
    }).immediate();
  }
  /** Occurrences that fell due while archived are skipped, never replayed on restore; an auto card rejoins the end of the queue. */
  restoreTask(id: string, now = clock()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (task.archivedAt === null) return task;
      const next = task.schedule === 'interval' && task.nextRunAt !== null && task.nextRunAt <= now ? nextOccurrence(task.nextRunAt, task.intervalMinutes!, now).next : task.nextRunAt;
      this.db.query('UPDATE tasks SET archived_at=NULL,next_run_at=?,updated_at=?,autopilot_position=? WHERE id=?').run(next, now, task.schedule === 'auto' ? this.nextAutopilotPosition() : null, id);
      return this.getTask(id);
    }).immediate();
  }
  /** Removes a card for good with its runs, discussion, logs and files. Worktree records stay, so storage clean-up
   * can still recognise and reclaim the folders; Git branches in the project are never touched here. */
  deleteTask(id: string): void {
    this.db.transaction(() => {
      if (!this.db.query('SELECT 1 FROM tasks WHERE id=?').get(id)) throw new AppError('Задача не найдена', 404);
      if (this.activeRun(id)) throw new AppError('Сначала завершите или отмените текущий запуск, затем удалите задачу.', 409);
      this.purgeTask(id);
      this.pruneDeletedWorkers();
    }).immediate();
  }
  /** Deletes the cards that were already in the archive at `archivedBefore`; a card archived later or still busy stays. */
  deleteArchivedTasks(archivedBefore: number, keep: readonly string[] = []): { deleted: number; skipped: number } {
    return this.db.transaction(() => {
      const ids = (this.db.query('SELECT id FROM tasks WHERE archived_at IS NOT NULL AND archived_at<=? ORDER BY archived_at, rowid').all(archivedBefore) as Row[]).map(row => row.id as string);
      let deleted = 0;
      for (const id of ids) {
        if (keep.includes(id) || this.activeRun(id)) continue;
        this.purgeTask(id);
        deleted++;
      }
      if (deleted) this.pruneDeletedWorkers();
      return { deleted, skipped: ids.length - deleted };
    }).immediate();
  }
  private purgeTask(id: string) {
    const runs = 'SELECT id FROM runs WHERE task_id=?1';
    const files = 'SELECT id FROM attachments WHERE task_id=?1';
    for (const statement of [
      `DELETE FROM comment_attachment_links WHERE comment_id IN (SELECT id FROM comments WHERE task_id=?1) OR attachment_id IN (${files})`,
      `DELETE FROM task_attachment_links WHERE task_id=?1 OR attachment_id IN (${files})`,
      `DELETE FROM run_attachment_inputs WHERE run_id IN (${runs}) OR attachment_id IN (${files})`,
      `DELETE FROM attachment_publications WHERE run_id IN (${runs})`,
      `DELETE FROM task_tool_operations WHERE run_id IN (${runs})`,
      'DELETE FROM attachments WHERE task_id=?1',
      `DELETE FROM followup_requests WHERE task_id=?1 OR run_id IN (${runs})`,
      `DELETE FROM execution_requests WHERE run_id IN (${runs})`,
      `DELETE FROM integrations WHERE run_id IN (${runs})`,
      `DELETE FROM run_code_diffs WHERE run_id IN (${runs})`,
      `DELETE FROM task_logs WHERE task_id=?1 OR run_id IN (${runs})`,
      `DELETE FROM comments WHERE task_id=?1 OR run_id IN (${runs})`,
      'DELETE FROM runs WHERE task_id=?1',
      'DELETE FROM tasks WHERE id=?1',
    ]) this.db.query(statement).run(id);
  }
  getRun(id: string): Run {
    const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as Row | null;
    if (!row) throw new AppError('Запуск не найден', 404);
    return this.mapRun(row);
  }
  activeRun(taskId: string): Run | null {
    const row = this.db.query(`SELECT * FROM runs WHERE task_id = ? AND (${OCCUPIED} OR EXISTS
      (SELECT 1 FROM integrations i WHERE i.run_id=runs.id AND i.state IN ('queued','checking','merging','cancelling','interrupted')))`).get(taskId) as Row | null;
    return row ? this.mapRun(row) : null;
  }
  detail(id: string): TaskDetail {
    return { task: this.getTask(id), attachments: this.listTaskAttachments(id), runs: (this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(id) as Row[]).map(r => this.mapRun(r)),
      logs: (this.db.query('SELECT * FROM task_logs WHERE task_id = ? ORDER BY seq').all(id) as Row[]).map(row => ({
        id: row.id, taskId: row.task_id, runId: row.run_id, stepIndex: row.step_index, kind: row.kind,
        summary: row.summary, details: JSON.parse(row.details), ...(row.error ? { error: row.error } : {}), createdAt: row.created_at,
      })),
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
  createTask(input: TaskInput, now = clock()): Task {
    return this.db.transaction(() => {
      const id = crypto.randomUUID();
      const steps = this.taskSteps(input.steps);
      const worker = steps.length ? null : this.assignedWorker(input.workerId);
      const provider = steps.length ? this.getWorker(steps[0]!.workerId).provider : worker?.provider ?? input.provider;
      const ultracode = validatedTaskUltracode(input.ultracode);
      const priority = validatedTaskPriority(input.priority === undefined ? DEFAULT_TASK_PRIORITY : input.priority);
      this.db.query(`INSERT INTO tasks (id,title,instruction,provider,cwd,schedule,interval_minutes,first_run_at,next_run_at,paused,created_at,updated_at,worker_id,steps_template,ultracode,autopilot_position,priority,time_limit_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title, input.instruction, provider,
        input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt,
        input.schedule === 'interval' ? (input.firstRunAt ?? now) : null, +input.paused, now, now, worker?.id ?? null, JSON.stringify(steps), storedFlag(ultracode),
        input.schedule === 'auto' ? this.nextAutopilotPosition() : null, priority, validateTimeLimitMinutes(input.timeLimitMinutes));
      this.replaceTaskAttachments(id, input.attachmentIds, now);
      this.replaceTaskTags(id, input.tagIds === undefined ? [] : input.tagIds);
      return this.getTask(id);
    }).immediate();
  }
  updateTask(id: string, input: TaskInput, now = clock()): Task {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      this.assertNotArchived(task);
      const steps = this.taskSteps(input.steps === undefined ? task.steps : input.steps, task.steps);
      const worker = steps.length ? null : this.assignedWorker(input.workerId === undefined ? task.workerId : input.workerId, task.workerId);
      const provider = steps.length ? this.getWorker(steps[0]!.workerId).provider : worker?.provider ?? input.provider;
      const changedSchedule = input.schedule !== task.schedule || input.intervalMinutes !== task.intervalMinutes || input.firstRunAt !== task.firstRunAt;
      let next = task.nextRunAt;
      if (changedSchedule) next = input.schedule === 'interval' ? (input.firstRunAt ?? now) : null;
      const ultracode = validatedTaskUltracode(input.ultracode === undefined ? task.ultracode : input.ultracode);
      const priority = validatedTaskPriority(input.priority === undefined ? task.priority : input.priority);
      // A card switched to the autopilot, or moved to another priority, queues at the end of its priority; leaving it gives up its place.
      const position = input.schedule !== 'auto' ? null : task.schedule === 'auto' && priority === task.priority
        ? (this.db.query('SELECT autopilot_position FROM tasks WHERE id=?').get(id) as Row).autopilot_position : this.nextAutopilotPosition();
      this.db.query(`UPDATE tasks SET title=?,instruction=?,provider=?,cwd=?,schedule=?,interval_minutes=?,first_run_at=?,next_run_at=?,paused=?,updated_at=?,worker_id=?,steps_template=?,ultracode=?,autopilot_position=?,priority=?,time_limit_minutes=? WHERE id=?`)
        .run(input.title, input.instruction, provider, input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt, next, +input.paused, now, worker?.id ?? null, JSON.stringify(steps), storedFlag(ultracode), position, priority, validateTimeLimitMinutes(input.timeLimitMinutes === undefined ? task.timeLimitMinutes : input.timeLimitMinutes), id);
      this.replaceTaskAttachments(id, input.attachmentIds, now);
      if (input.tagIds !== undefined) this.replaceTaskTags(id, input.tagIds);
      return this.getTask(id);
    }).immediate();
  }
  commentCursor(taskId: string): number {
    return (this.db.query('SELECT COALESCE(MAX(seq),0) AS seq FROM comments WHERE task_id=?').get(taskId) as Row).seq;
  }
  listTaskComments(taskId: string, options: { offset: number; limit: number; throughSequence: number }): Comment[] {
    const { offset, limit, throughSequence } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 21 ||
        !Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new AppError('Некорректные параметры истории комментариев');
    this.getTask(taskId);
    return (this.db.query('SELECT * FROM comments WHERE task_id=? AND seq<=? ORDER BY seq LIMIT ? OFFSET ?')
      .all(taskId, throughSequence, limit, offset) as Row[]).map(row => this.mapComment(row));
  }
  recordAgentSummary(taskId: string, runId: string, kind: 'agent' | 'result', body: string, afterSequence: number, now = clock(), stepIndex: number | null = null): Comment {
    return this.db.transaction(() => {
      // The CLI may publish its answer through MCP or a callback before returning
      // the same summary. Only reuse this invocation's answer; an earlier turn or
      // attempt can legitimately return identical text. Preserve publication IDs
      // and attachment links by promoting the existing row in place.
      const existing = (this.db.query("SELECT * FROM comments WHERE task_id=? AND run_id=? AND step_index IS ? AND seq>? AND kind='agent' ORDER BY seq DESC")
        .all(taskId, runId, stepIndex, afterSequence) as Row[]).find(row => row.body.trim() === body.trim());
      if (!existing) return this.comment(taskId, runId, kind, body, now, stepIndex);
      this.db.query('UPDATE comments SET kind=? WHERE id=?').run(kind, existing.id);
      return this.mapComment({ ...existing, kind });
    }).immediate();
  }
  comment(taskId: string, runId: string | null, kind: Comment['kind'], body: string, now = clock(), stepIndex?: number | null, ids?: string[]): Comment {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (kind === 'user') this.assertNotArchived(task);
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
  log(taskId: string, runId: string | null, entry: TaskLogInput, now = clock(), stepIndex?: number | null): TaskLog {
    this.getTask(taskId);
    const run = runId ? this.getRun(runId) : null;
    if (run && run.taskId !== taskId) throw new AppError('Запуск относится к другой задаче', 409);
    const error = sanitizeLogError(entry.error);
    const log: TaskLog = { id: crypto.randomUUID(), taskId, runId, stepIndex: stepIndex === undefined && run ? run.currentStepIndex : stepIndex ?? null,
      kind: entry.kind.slice(0, 40), summary: entry.summary.slice(0, 500), details: entry.details.slice(0, 40).map(line => line.slice(0, 1000)), ...(error ? { error } : {}), createdAt: now };
    this.db.query('INSERT INTO task_logs(id,task_id,run_id,step_index,kind,summary,details,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(log.id, taskId, runId, log.stepIndex, log.kind, log.summary, JSON.stringify(log.details), error ?? null, now);
    return log;
  }
  private insertRun(task: Task, trigger: Run['trigger'], scheduledFor: number | null, mock: boolean, now: number): Run {
    this.assertNotArchived(task);
    if (this.activeRun(task.id)) throw new AppError('У задачи уже есть активный запуск. Ответьте агенту, повторите текущий этап или отмените запуск.', 409);
    const id = crypto.randomUUID();
    const steps: RunStep[] = task.steps.map(step => ({ ...step, worker: workerSnapshot(this.getWorker(step.workerId)), status: 'pending',
      sessionId: null, startedAt: null, updatedAt: now, finishedAt: null, summary: null, error: null, attempts: [] }));
    if (steps.length) beginAttempt(steps[0]!, 1, now);
    const worker = steps.length ? steps[0]!.worker : task.worker ? workerSnapshot(task.worker) : null;
    const instructions = this.enabledInstructions();
    // The task's ultra choice is frozen beside the worker snapshots: later card edits never change this run's mode.
    this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,scheduled_for,status,started_at,updated_at,mock,worker_id,worker_snapshot,instructions_snapshot,steps_snapshot,current_step_index,workflow_version,ultracode) VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?)`)
      .run(id, task.id, worker?.provider ?? task.provider, task.cwd, task.instruction, trigger, scheduledFor, now, now, +mock, worker?.id ?? null,
        worker ? JSON.stringify(worker) : null, JSON.stringify(instructions), JSON.stringify(steps), steps.length ? 0 : null, steps.length ? 1 : 0, storedFlag(task.ultracode));
    this.snapshotTimeLimit(id, task.id);
    for (const attachment of this.listTaskAttachments(task.id)) this.db.query('INSERT INTO run_attachment_inputs(run_id,turn,attachment_id) VALUES (?,1,?)').run(id, attachment.id);
    this.comment(task.id, id, 'system', mock ? 'Демо-запуск: используется тестовый агент, реальные CLI не вызываются.' : `Запуск ${worker?.provider === 'claude' || (!worker && task.provider === 'claude') ? 'Claude Code' : 'Codex'} через CLI.`, now);
    return this.getRun(id);
  }
  startManual(taskId: string, mock: boolean, now = clock()): Run {
    return this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (task.hasCompletedRun) throw new AppError('Задача уже выполнялась успешно. Отправьте продолжение в сохранённую сессию завершённого запуска.', 409);
      return this.insertRun(task, 'manual', null, mock, now);
    }).immediate();
  }
  /** A replay lookup must precede attachment binding, occupancy, and process checks. */
  getFollowupRequest(taskId: string, value: FollowupInput): Run | null {
    const input = validateFollowup(value);
    const prior = this.db.query('SELECT fingerprint,run_id FROM followup_requests WHERE task_id=? AND request_id=?').get(taskId, input.requestId) as Row | null;
    if (!prior) return null;
    if (prior.fingerprint !== this.followupFingerprint(input)) throw new AppError('Этот ID запроса уже использован с другим содержимым', 409);
    const run = this.getRun(prior.run_id);
    if (run.taskId !== taskId || !run.followup || run.followup.sourceRunId !== input.sourceRunId ||
        run.followup.sourceStepIndex !== input.sourceStepIndex || run.followup.request !== followupRequestText(input.body)) invalidSnapshot();
    return run;
  }
  private followupFingerprint(input: FollowupInput): string {
    return createHash('sha256').update(JSON.stringify([input.sourceRunId, input.sourceStepIndex, input.body, input.attachmentIds])).digest('hex');
  }
  startFollowup(taskId: string, value: FollowupInput, now = clock()): { run: Run; created: boolean } {
    return this.insertFollowup(taskId, value, now);
  }
  /** A hand-back is brigd's own request: the card shows it as a system note and the agent receives the failure as data. */
  private insertFollowup(taskId: string, value: FollowupInput, now: number, checkFailure?: RunCheckFailure): { run: Run; created: boolean } {
    const input = validateFollowup(value);
    return this.db.transaction(() => {
      const prior = this.getFollowupRequest(taskId, input);
      if (prior) return { run: prior, created: false };
      this.assertNotArchived(this.getTask(taskId));
      const source = this.getRun(input.sourceRunId);
      if (source.taskId !== taskId) throw new AppError('Исходный запуск относится к другой задаче', 409);
      // Blocked or timed-out scalar agents can continue their saved session.
      // Workflow stages use resume after a timeout, or retry/cancel.
      if (source.status !== 'completed' && !((source.status === 'blocked' || source.timeLimitExceeded) && !source.steps.length)) throw new AppError('Продолжить можно только завершённый или заблокированный агентом запуск', 409);
      if (source.workerId !== storedWorkerId(source.worker) || (source.worker && source.worker.provider !== source.provider)) invalidSnapshot();
      if (this.activeRun(taskId)) throw new AppError('У задачи уже есть активный запуск. Сначала завершите или отмените его.', 409);
      let selected: RunStep | null = null;
      if (source.steps.length) {
        if (input.sourceStepIndex === null || input.sourceStepIndex >= source.steps.length) throw new AppError('Выберите завершённый этап исходного запуска', 409);
        selected = source.steps[input.sourceStepIndex]!;
        if (selected.status !== 'completed') throw new AppError('Исходный этап не завершён', 409);
      } else if (input.sourceStepIndex !== null) throw new AppError('У этого запуска нет отдельных этапов; укажите null', 409);
      const sessionId = selected ? selected.sessionId : source.sessionId;
      if (!sessionId) throw new AppError('В исходном запуске нет сохранённого ID сессии. Продолжение в прежнем контексте невозможно.', 409);
      try { validateSessionId(sessionId); validateInstructionSnapshots(source.instructions); }
      catch { invalidSnapshot(); }
      const worker = selected ? selected.worker : source.worker;
      const followup: RunFollowup = { sourceRunId: source.id, sourceStepIndex: input.sourceStepIndex, request: followupRequestText(input.body),
        workflow: selected ? { steps: source.steps, currentStepIndex: input.sourceStepIndex! } : source.followup?.workflow ?? null, ...(checkFailure ? { checkFailure } : {}) };
      if (followup.workflow) completedWorkflowSnapshot(followup.workflow);
      const id = crypto.randomUUID();
      this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,status,session_id,started_at,updated_at,mock,worker_id,worker_snapshot,instructions_snapshot,followup_snapshot,ultracode)
        VALUES (?,?,?,?,?,'followup','running',?,?,?,?,?,?,?,?,?)`)
        .run(id, taskId, worker?.provider ?? source.provider, source.cwd, source.instruction, sessionId, now, now, +source.mock,
          storedWorkerId(worker), worker ? JSON.stringify(worker) : null, JSON.stringify(source.instructions), JSON.stringify(followup), storedFlag(source.ultracode));
      this.snapshotTimeLimit(id, taskId);
      this.db.query('UPDATE runs SET workspace_id=(SELECT workspace_id FROM runs WHERE id=?) WHERE id=?').run(source.id, id);
      // Freeze only the selected saved turn's inputs. No current task edits or
      // later workflow stages may leak into an earlier stage's continuation.
      const sourceTurn = selected ? selected.attempts.at(-1)!.turn : source.turn;
      this.db.query(`INSERT INTO run_attachment_inputs(run_id,turn,attachment_id)
        SELECT ?,1,attachment_id FROM run_attachment_inputs WHERE run_id=? AND turn=?`).run(id, source.id, sourceTurn);
      this.db.query(`INSERT OR IGNORE INTO run_attachment_inputs(run_id,turn,attachment_id)
        SELECT ?,1,id FROM attachments WHERE task_id=? AND run_id=? AND created_turn<=? AND (step_index IS ? OR ? IS NULL)`)
        .run(id, taskId, source.id, sourceTurn, input.sourceStepIndex, input.sourceStepIndex);
      this.comment(taskId, id, checkFailure ? 'system' : 'user', followup.request, now, null, input.attachmentIds);
      for (const attachmentId of input.attachmentIds) this.db.query('INSERT OR IGNORE INTO run_attachment_inputs(run_id,turn,attachment_id) VALUES (?,1,?)').run(id, attachmentId);
      this.db.query('INSERT INTO followup_requests(task_id,request_id,fingerprint,run_id) VALUES (?,?,?,?)').run(taskId, input.requestId, this.followupFingerprint(input), id);
      return { run: this.getRun(id), created: true };
    }).immediate();
  }
  /** Hands the newest conflicted result of a worktree to the built-in integrator in a fresh session. */
  startReconcile(sourceRunId: string, now = clock()): Run {
    return this.db.transaction(() => {
      const source = this.getRun(sourceRunId);
      const task = this.getTask(source.taskId);
      this.assertNotArchived(task);
      const integration = source.integration;
      if (source.status !== 'completed' || source.workspace?.mode !== 'worktree' || !integration) throw new AppError('Интегратор работает только с завершённым запуском в отдельном worktree', 409);
      if (integration.status !== 'conflict') throw new AppError('Интегратору нужен конфликт слияния. Сейчас слияние в другом состоянии.', 409);
      if (!source.workspace.targetBranch) throw new AppError('Запуск создан из detached HEAD. Для объединения нужна именованная целевая ветка.', 409);
      if (this.activeRun(task.id)) throw new AppError('У задачи уже есть активный запуск. Сначала завершите или отмените его.', 409);
      // Only the newest result of a worktree can be reconciled; a failed earlier attempt may be repeated.
      const newest = this.db.query('SELECT id FROM runs WHERE workspace_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(source.workspace.id) as Row | null;
      if (newest && newest.id !== source.id) {
        const later = this.getRun(newest.id);
        if (later.reconcile?.sourceRunId !== source.id || later.status === 'completed') throw new AppError('Результат уже заменён более новым запуском этой рабочей папки. Интегратору можно поручить только последний результат.', 409);
      }
      const depth = (source.reconcile?.depth ?? 0) + 1;
      if (depth > RECONCILE_DEPTH_LIMIT) throw new AppError(`Интегратор уже ${RECONCILE_DEPTH_LIMIT} раза объединял этот результат, а целевая ветка снова конфликтует. Разрешите конфликт вручную в исходном worktree и повторите проверку.`, 409);
      const worker = integratorSnapshot(this.getIntegratorProfile(), { provider: source.worker?.provider ?? source.provider, model: source.worker?.model ?? null, effort: source.worker?.effort ?? 'default' });
      const reconcile: RunReconcile = { sourceRunId: source.id, integrationId: integration.id, targetBranch: source.workspace.targetBranch,
        targetCommit: integration.targetCommit, conflicts: integration.conflicts ?? [], depth };
      const id = crypto.randomUUID();
      this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,status,started_at,updated_at,mock,worker_id,worker_snapshot,instructions_snapshot,reconcile_snapshot,workspace_id)
        VALUES (?,?,?,?,?,'reconcile','running',?,?,?,NULL,?,?,?,?)`)
        .run(id, task.id, worker.provider, source.cwd, source.instruction, now, now, +source.mock, JSON.stringify(worker), JSON.stringify(this.enabledInstructions()), JSON.stringify(reconcile), source.workspace.id);
      this.snapshotTimeLimit(id, task.id);
      this.comment(task.id, id, 'system', `Интегратор разрешает конфликт слияния с веткой ${reconcile.targetBranch}${reconcile.conflicts.length ? `: ${reconcile.conflicts.slice(0, 10).join(', ')}` : ''}. Результат задачи остаётся в её worktree.`, now);
      return this.getRun(id);
    }).immediate();
  }
  /** Records what the prepared merge actually left to resolve, before the integrator is invoked. */
  attachReconciliation(runId: string, fence: RunFence, patch: Pick<RunReconcile, 'targetCommit' | 'conflicts'>) {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'preparing' || !matchesFence(run, fence) || !run.reconcile) return;
      this.db.query('UPDATE runs SET reconcile_snapshot=? WHERE id=?').run(JSON.stringify({ ...run.reconcile, ...patch }), runId);
    }).immediate();
  }
  /** The run whose saved session a hand-back continues: an integrator run passes the failure on to the result it merged. */
  private handbackSource(run: Run): Run {
    let current = run;
    for (let hops = 0; current.reconcile && hops < 100; hops++) current = this.getRun(current.reconcile.sourceRunId);
    return current;
  }
  /** Automatic hand-backs already made for this result. A person's own follow-up starts a new result with a fresh count. */
  private handbackReturns(run: Run): number {
    return this.handbackSource(run).followup?.checkFailure?.round ?? 0;
  }
  /** The run that started the chain of follow-ups and integrator runs, e.g. the autopilot's own attempt. */
  private chainRoot(run: Run): Run {
    let current = run;
    for (let hops = 0; hops < 100; hops++) {
      const parent = current.reconcile?.sourceRunId ?? current.followup?.sourceRunId;
      if (!parent) break;
      current = this.getRun(parent);
    }
    return current;
  }
  /**
   * A result whose check failed in its candidate, failed again on the rerun and passes on the target goes back to the worker's
   * saved session, or the card says why not. Called in the transaction that stores the failed attempt, so a restart never
   * leaves a decided result without its hand-back.
   */
  handBackFailedCheck(id: string, attempt: number, enabled: boolean, now = clock()): Integration | null {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT snapshot FROM integrations WHERE id=?').get(id) as Row | null;
      if (!row) return null;
      const job = JSON.parse(row.snapshot) as Integration;
      if (job.attempt !== attempt || !awaitsHandback(job)) return job;
      const run = this.getRun(job.runId);
      const source = this.handbackSource(run);
      const returns = this.handbackReturns(run);
      const [outcome, note, runId] = ((): [CheckTriageOutcome, string, string | null] => {
        if (!enabled) return ['disabled', 'Автоматический возврат выключен в настройках → Автопилот. Отправьте дополнительный запрос работнику вручную.', null];
        if (source.steps.length) return ['workflow', 'Задача с этапами не возвращается автоматически: по коду возврата не видно, какой этап внёс ошибку. Выберите этап и отправьте дополнительный запрос.', null];
        if (returns >= CHECK_HANDBACK_LIMIT) return ['limit', `Лимит автоматических возвратов исчерпан: ${returns} из ${CHECK_HANDBACK_LIMIT}. Нужно решение человека: отправьте дополнительный запрос или исправьте результат вручную.`, null];
        if (!source.sessionId) return ['no_session', 'Автоматический возврат не выполнен: CLI не сохранил ID сессии работника, а продолжить можно только её. Исправьте результат вручную или поставьте задачу заново.', null];
        try {
          const followup = this.startHandback(source, run, job, returns + 1, now);
          return ['returned', `Задача возвращена работнику в его сохранённую сессию: возврат ${returns + 1} из ${CHECK_HANDBACK_LIMIT}.`, followup.id];
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return ['error', `Автоматический возврат не выполнен: ${error.message}`, null];
        }
      })();
      const triage: CheckTriage = { ...job.triage!, outcome, handback: { returns: outcome === 'returned' ? returns + 1 : returns, limit: CHECK_HANDBACK_LIMIT, runId } };
      const next: Integration = { ...job, triage, error: [job.error, note].filter(Boolean).join(' ').slice(0, 4_000), updatedAt: now };
      this.writeIntegration(next);
      this.recordTriage(triage);
      this.log(run.taskId, run.id, { kind: 'integration', summary: outcome === 'returned' ? 'Задача возвращена работнику после упавшей проверки' : 'Автоматический возврат после упавшей проверки не выполнен', details: [note] }, now);
      if (outcome !== 'returned') this.comment(run.taskId, run.id, 'system', note, now);
      // Exhausted hand-backs leave a result for a person: the circuit breaker counts it like a failed run.
      if (outcome === 'limit') { const root = this.chainRoot(run); if (root.trigger === 'autopilot') this.noteAutopilotOutcome(root, 'failed', now); }
      return next;
    }).immediate();
  }
  private startHandback(source: Run, failed: Run, job: Integration, round: number, now: number): Run {
    return this.db.transaction(() => {
      const retry = job.triage!.retries.at(-1)!;
      const check = job.checks[retry.check];
      const targetBranch = failed.workspace?.targetBranch;
      if (!check || retry.exitCode === null || !targetBranch || !job.targetCommit) throw new AppError('в записи слияния нет данных упавшей проверки.', 409);
      const output = handbackOutput(retry.output ?? '', !!retry.outputTruncated);
      const checkFailure: RunCheckFailure = { integrationId: job.id, round, targetBranch, targetCommit: job.targetCommit, argv: check.argv, exitCode: retry.exitCode, ...output };
      const request = `Проверка слияния ${check.argv.join(' ').slice(0, 2_000)} не прошла и при повторе (код ${retry.exitCode}), а на целевой ветке ${targetBranch} проходит. brigd возвращает задачу работнику: возврат ${round} из ${CHECK_HANDBACK_LIMIT}.`;
      const { run } = this.insertFollowup(source.taskId, { sourceRunId: source.id, sourceStepIndex: null, body: request, attachmentIds: [], requestId: `check-${job.id}-${job.attempt}` }, now, checkFailure);
      const workspace = run.workspace;
      if (!workspace) throw new AppError('у результата нет сохранённой рабочей папки.', 409);
      return this.enqueueExecution(run, { repositoryId: workspace.repositoryId, repositoryRoot: workspace.repositoryRoot, projectCwd: workspace.projectCwd });
    }).immediate();
  }
  claimDue(mock: boolean, now = clock(), settlingTaskIds: readonly string[] = []): Run[] {
    return this.db.transaction(() => {
      const due = this.db.query("SELECT * FROM tasks WHERE paused=0 AND archived_at IS NULL AND schedule='interval' AND next_run_at<=?").all(now) as Row[];
      const claimed: Run[] = [];
      for (const row of due) {
        const task = this.mapTask(row);
        const occurrence = nextOccurrence(task.nextRunAt!, task.intervalMinutes!, now);
        // Consume this occurrence even while waiting. Never accumulate a missed backlog.
        this.db.query('UPDATE tasks SET next_run_at=? WHERE id=?').run(occurrence.next, task.id);
        const active = this.activeRun(task.id);
        if (active || settlingTaskIds.includes(task.id)) {
          // Coalesce an unstarted scheduled request to the newest occurrence.
          if (active?.status === 'queued' && active.trigger === 'schedule') {
            this.db.query('UPDATE runs SET scheduled_for=? WHERE id=?').run(occurrence.latest, active.id);
          }
          continue;
        }
        if (this.db.query('SELECT id FROM runs WHERE task_id=? AND scheduled_for=?').get(task.id, occurrence.latest)) continue;
        claimed.push(this.insertRun(task, 'schedule', occurrence.latest, mock, now));
      }
      return claimed;
    }).immediate();
  }
  getWorkspace(id: string): WorkspaceSnapshot {
    const row = this.db.query('SELECT snapshot FROM workspaces WHERE id=?').get(id) as Row | null;
    if (!row) invalidSnapshot();
    const value = JSON.parse(row.snapshot) as WorkspaceSnapshot;
    if (value.id !== id || !['worktree', 'direct'].includes(value.mode) || typeof value.prepared !== 'boolean' ||
        ![value.repositoryId, value.repositoryRoot, value.projectCwd, value.path, value.cwd].every(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')) ||
        (value.mode === 'worktree' && (typeof value.branch !== 'string' || !/^brigd\/run-[a-zA-Z0-9-]+$/.test(value.branch) || typeof value.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.baseCommit))) ||
        [value.removedAt, value.recreatedAt].some(stamp => stamp != null && (!Number.isSafeInteger(stamp) || stamp <= 0)) ||
        (value.removedBy != null && !['merge', 'cleanup'].includes(value.removedBy))) invalidSnapshot();
    return value;
  }
  /** Every saved worktree with its task and the chronological statuses of the runs sharing it; unreadable snapshots are skipped. */
  listWorkspaceRecords(): WorkspaceRecord[] {
    return this.workspaceRecords(this.db.query(`${WORKSPACE_RECORD_SQL} ORDER BY w.rowid, r.started_at, r.rowid`).all() as Row[]);
  }
  workspaceRecord(id: string): WorkspaceRecord | null {
    return this.workspaceRecords(this.db.query(`${WORKSPACE_RECORD_SQL} WHERE w.id=? ORDER BY r.started_at, r.rowid`).all(id) as Row[])[0] ?? null;
  }
  private workspaceRecords(rows: Row[]): WorkspaceRecord[] {
    const records = new Map<string, WorkspaceRecord>();
    for (const row of rows) {
      let record = records.get(row.id);
      if (!record) {
        let snapshot: WorkspaceSnapshot;
        try { snapshot = this.getWorkspace(row.id); } catch { continue; }
        record = { snapshot, taskId: null, taskTitle: null, runs: [] };
        records.set(row.id, record);
      }
      if (!row.run_id) continue;
      record.taskId ??= row.task_id; record.taskTitle ??= row.title ?? null;
      record.runs.push({ id: row.run_id, status: row.status, integrationStatus: row.integration_state ?? null, integrationUpdatedAt: row.integration_updated_at ?? null, startedAt: row.started_at });
    }
    return [...records.values()];
  }
  listIntegrationRecords(): IntegrationRecord[] {
    return (this.db.query('SELECT snapshot FROM integrations ORDER BY seq').all() as Row[]).map(row => {
      const job = JSON.parse(row.snapshot) as Integration;
      return { id: job.id, runId: job.runId, status: job.status, attempt: job.attempt, candidatePath: job.candidatePath ?? null, updatedAt: job.updatedAt };
    });
  }
  /** Records that brigd removed (or is removing) the folder on purpose, so a later continuation may recreate it from the branch.
   * The merged commit is stored in the same write, so a crash between the two never recreates an older tree. */
  markWorkspaceRemoved(id: string, now = clock(), lastIntegratedCommit: string | null = null, removedBy: 'merge' | 'cleanup' = 'merge'): void {
    this.db.transaction(() => {
      let workspace: WorkspaceSnapshot;
      try { workspace = this.getWorkspace(id); } catch { return; }
      this.db.query('UPDATE workspaces SET snapshot=? WHERE id=?').run(JSON.stringify({ ...workspace, removedAt: now, removedBy, ...(lastIntegratedCommit ? { lastIntegratedCommit } : {}) }), id);
    }).immediate();
  }
  enqueueExecution(run: Run, location: RepositoryLocation, answer?: string): Run {
    return this.db.transaction(() => {
      const current = this.getRun(run.id);
      if (current.status !== 'running' || !matchesFence(current, runFence(run))) throw new AppError('Этот ход уже завершён или заменён', 409);
      this.db.query("UPDATE execution_requests SET state='settled' WHERE run_id=? AND state IN ('held','interrupted')").run(run.id);
      this.db.query("INSERT INTO execution_requests (run_id,turn,repository_id,location,answer,state) VALUES (?,?,?,?,?,'queued')")
        .run(run.id, run.turn, location.repositoryId, JSON.stringify(location), answer ?? null);
      this.executionStatus(current, 'queued');
      return this.getRun(run.id);
    }).immediate();
  }
  /** The integrator takes the first free place: merges of its repository wait for it, so a conflict must not queue behind new tasks. */
  pendingExecutions(): ExecutionRequest[] {
    return (this.db.query(`SELECT e.* FROM execution_requests e JOIN runs r ON r.id=e.run_id AND r.turn=e.turn
      WHERE e.state='queued' AND r.status='queued' ORDER BY ${INTEGRATOR_WORK} DESC, e.seq`).all() as Row[])
      .map(row => ({ runId: row.run_id, turn: row.turn, answer: row.answer ?? undefined, location: JSON.parse(row.location) }));
  }
  claimExecution(request: ExecutionRequest, maximum: number, perRepository = 1): Run | null {
    return this.db.transaction(() => {
      const run = this.getRun(request.runId);
      if (run.status !== 'queued' || run.turn !== request.turn) return null;
      // Demo runs share the folder too, but never write to it, so they follow the per-repository limit like worktrees.
      const direct = !run.mock && (run.workspace?.mode === 'direct' || !run.workspace && !!run.sessionId);
      if (this.repositoryBusy(request.location.repositoryId, perRepository, direct) || this.occupiedSlots() >= maximum) return null;
      const result = this.db.query("UPDATE execution_requests SET state='preparing' WHERE run_id=? AND turn=? AND state='queued'").run(run.id, run.turn);
      if (!result.changes) return null;
      this.executionStatus(run, 'preparing');
      return this.getRun(run.id);
    }).immediate();
  }
  /** Shared by the queue and the autopilot: an uncertain, integrating, exclusively held or full repository takes no new work. */
  private repositoryBusy(repositoryId: string, perRepository: number, exclusive: boolean): boolean {
    const uncertain = this.db.query("SELECT seq FROM execution_requests WHERE repository_id=? AND state IN ('interrupted','held')").get(repositoryId);
    const occupied = (this.db.query("SELECT COUNT(*) AS n FROM execution_requests WHERE repository_id=? AND state IN ('preparing','running')").get(repositoryId) as { n: number }).n;
    const shared = this.db.query(`SELECT r.id FROM execution_requests e JOIN runs r ON r.id=e.run_id
      LEFT JOIN workspaces w ON w.id=r.workspace_id WHERE e.repository_id=? AND e.state IN ('preparing','running') AND r.mock=0
      AND (json_extract(w.snapshot,'$.mode')='direct' OR (r.workspace_id IS NULL AND r.session_id IS NOT NULL))`).get(repositoryId);
    const integration = this.db.query("SELECT seq FROM integrations WHERE repository_id=? AND state IN ('queued','checking','merging','cancelling','interrupted')").get(repositoryId);
    return !!uncertain || !!integration || !!shared || exclusive && occupied > 0 || occupied >= perRepository;
  }
  private executionStatus(run: Run, status: RunStatus, now = clock()) {
    this.db.query('UPDATE runs SET status=?,updated_at=? WHERE id=?').run(status, now, run.id);
    if (run.currentStepIndex !== null) {
      updateStep(run.steps[run.currentStepIndex]!, { status, updatedAt: now });
      this.persistSteps(run);
    }
  }
  attachWorkspace(runId: string, fence: RunFence, workspace: WorkspaceSnapshot) {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'preparing' || !matchesFence(run, fence)) return;
      this.db.query('INSERT OR IGNORE INTO workspaces (id,snapshot) VALUES (?,?)').run(workspace.id, JSON.stringify(workspace));
      this.db.query('UPDATE runs SET workspace_id=? WHERE id=?').run(workspace.id, runId);
    }).immediate();
  }
  beginExecution(runId: string, fence: RunFence): Run | null {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'preparing' || !matchesFence(run, fence)) return null;
      if (run.workspace) {
        // A folder that was reclaimed is back now; remember when, so the agent and the card can tell what is missing in it.
        const recreated = run.workspace.removedAt ? { recreatedAt: clock() } : {};
        this.db.query('UPDATE workspaces SET snapshot=? WHERE id=?').run(JSON.stringify({ ...run.workspace, prepared: true, removedAt: null, removedBy: null, ...recreated }), run.workspace.id);
      }
      this.db.query("UPDATE execution_requests SET state='running' WHERE run_id=? AND turn=? AND state='preparing'").run(runId, fence.turn);
      this.executionStatus(run, 'running');
      return this.getRun(runId);
    }).immediate();
  }
  failPreparation(runId: string, fence: RunFence, message: string, blocked: boolean) {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!['queued', 'preparing'].includes(run.status) || !matchesFence(run, fence)) return;
      this.executionStatus(run, 'running');
      this.finish(runId, blocked ? 'blocked' : 'failed', null, message, clock(), fence);
      this.log(run.taskId, runId, { kind: 'lifecycle', summary: 'Подготовка запуска остановлена', details: [message] }, clock(), run.currentStepIndex);
    }).immediate();
  }
  settleExecution(runId: string, turn: number, hold = false) {
    this.db.query("UPDATE execution_requests SET state=? WHERE run_id=? AND turn=? AND state IN ('queued','preparing','running')")
      .run(hold ? 'held' : 'settled', runId, turn);
  }
  executionNeedsAcknowledgement(runId: string): boolean {
    return !!this.db.query("SELECT seq FROM execution_requests WHERE run_id=? AND state='interrupted'").get(runId);
  }
  private occupiedSlots(): number {
    return (this.db.query(`SELECT (SELECT COUNT(*) FROM execution_requests WHERE state IN ('preparing','running','interrupted')) +
      (SELECT COUNT(*) FROM integrations WHERE state IN ('checking','merging','cancelling','interrupted')) AS n`).get() as { n: number }).n;
  }
  integrationForRun(runId: string): Integration | null {
    const row = this.db.query('SELECT snapshot FROM integrations WHERE run_id=?').get(runId) as Row | null;
    return row ? JSON.parse(row.snapshot) as Integration : null;
  }
  queueIntegration(runId: string, retry = false, acknowledgement = false): Integration | null {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (run.status !== 'completed' || run.workspace?.mode !== 'worktree') return null;
      this.assertNotArchived(this.getTask(run.taskId));
      const prior = this.integrationForRun(runId);
      if (prior) {
        if (!retry || ['queued', 'checking', 'merging', 'cancelling', 'merged'].includes(prior.status)) return prior;
        if (prior.status === 'interrupted' && !acknowledgement) throw new AppError('Сначала подтвердите, что прежние процессы проверки и слияния остановлены.', 409);
        // A follow-up sharing this workspace must finish before an older result
        // can be captured again; completed historical snapshots stay intact.
        const active = this.db.query(`SELECT id FROM runs WHERE workspace_id=? AND status IN (${OPEN})`).get(run.workspace.id);
        if (active) throw new AppError('Сначала завершите активное продолжение этой рабочей папки.', 409);
        const next = { ...prior, status: 'queued' as const, rechecks: 0, error: null, checks: [], triage: null, updatedAt: clock() };
        this.writeIntegration(next); return next;
      }
      const job: Integration = { id: crypto.randomUUID(), runId, repositoryId: run.workspace.repositoryId, status: 'queued', attempt: 0,
        sourceCommit: null, targetCommit: null, resultCommit: null, candidatePath: null, checks: [], error: null, updatedAt: clock() };
      this.db.query('INSERT INTO integrations (id,run_id,repository_id,state,attempt,snapshot) VALUES (?,?,?,?,?,?)')
        .run(job.id, runId, job.repositoryId, job.status, job.attempt, JSON.stringify(job));
      return job;
    }).immediate();
  }
  private writeIntegration(job: Integration) {
    this.db.query('UPDATE integrations SET state=?,attempt=?,snapshot=? WHERE id=?').run(job.status, job.attempt, JSON.stringify(job), job.id);
  }
  /** A result the integrator has just reconciled is checked first, before another merge moves the target it was resolved against. */
  claimIntegrations(maximum: number): Integration[] {
    return this.db.transaction(() => {
      const claimed: Integration[] = [];
      const rows = this.db.query(`SELECT i.snapshot, r.workspace_id FROM integrations i JOIN runs r ON r.id=i.run_id
        WHERE i.state='queued' ORDER BY ${INTEGRATOR_WORK} DESC, i.seq`).all() as Row[];
      for (const row of rows) {
        const job = JSON.parse(row.snapshot) as Integration;
        if (this.occupiedSlots() >= maximum) break;
        if (this.integrationWaits(job.repositoryId, row.workspace_id)) continue;
        const next = { ...job, status: 'checking' as const, attempt: job.attempt + 1, error: null, sourceCommit: null, targetCommit: null, resultCommit: null, candidatePath: null, checks: [], triage: null, updatedAt: clock() };
        this.writeIntegration(next); claimed.push(next);
      }
      return claimed;
    }).immediate();
  }
  /** One merge per repository at a time. Agents in their own worktrees keep working while it runs; it waits for work it could disturb
   * or invalidate: the shared project folder, unconfirmed or held processes, a run still writing this result's worktree, and the
   * integrator, which resolves a conflict against the current target. */
  private integrationWaits(repositoryId: string, workspaceId: string | null): boolean {
    return !!this.db.query("SELECT seq FROM integrations WHERE repository_id=? AND state IN ('checking','merging','cancelling','interrupted')").get(repositoryId) ||
      !!this.db.query("SELECT seq FROM execution_requests WHERE repository_id=? AND state IN ('interrupted','held')").get(repositoryId) ||
      !!this.db.query(`SELECT e.seq FROM execution_requests e JOIN runs r ON r.id=e.run_id LEFT JOIN workspaces w ON w.id=r.workspace_id
        WHERE e.repository_id=? AND e.state IN ('preparing','running') AND (r.workspace_id IS NULL OR json_extract(w.snapshot,'$.mode') IS NOT 'worktree'
          OR r.workspace_id=? OR ${INTEGRATOR_WORK})`).get(repositoryId, workspaceId);
  }
  updateIntegration(id: string, attempt: number, patch: Partial<Integration>, finish = false): Integration | null {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT snapshot FROM integrations WHERE id=?').get(id) as Row | null;
      if (!row) return null;
      const job = JSON.parse(row.snapshot) as Integration;
      if (job.attempt !== attempt || !['checking', 'merging', 'cancelling'].includes(job.status)) return job;
      if (job.status === 'cancelling' && !finish) return job;
      // A cancellation that arrives after the target was already updated cannot undo the merge, so the merge wins.
      const next: Integration = { ...job, ...patch, id: job.id, runId: job.runId, repositoryId: job.repositoryId, attempt: job.attempt, updatedAt: clock(),
        ...(job.status === 'cancelling' && patch.status !== 'merged' ? { status: 'cancelled', error: 'Слияние отменено. Уже выполненные Git-операции не откатываются.' } : {}) };
      if (next.status === 'queued') {
        next.rechecks = (job.rechecks ?? 0) + 1;
        if (next.rechecks >= INTEGRATION_RECHECK_LIMIT) Object.assign(next, { status: 'blocked', error: 'Целевая ветка неоднократно изменялась во время проверки. Повторите слияние после завершения изменений.' });
      }
      // A triage overtaken by a cancellation, a block or a moved target ends without a decision.
      if (finish && next.triage && (next.triage.stage !== 'done' || next.triage.outcome === null && next.triage.target?.passed && next.status !== 'failed')) {
        next.triage = { ...next.triage, stage: 'done', outcome: next.triage.outcome ?? 'stopped' };
      }
      this.writeIntegration(next);
      if (finish && next.status !== 'queued' && !awaitsHandback(next)) this.recordTriage(next.triage);
      if (finish) {
        const run = this.getRun(job.runId);
        if (next.status === 'merged' && run.workspace && next.sourceCommit) {
          this.db.query('UPDATE workspaces SET snapshot=? WHERE id=?').run(JSON.stringify({ ...run.workspace, lastIntegratedCommit: next.sourceCommit }), run.workspace.id);
        }
        this.log(run.taskId, run.id, { kind: 'integration', summary: next.status === 'merged' ? 'Проверенный результат принят в целевую ветку' : 'Проверка и слияние завершены',
          details: [`Статус: ${next.status}.`, ...(next.error ? [next.error] : []), ...(next.conflicts?.length ? [`Конфликтующие файлы: ${next.conflicts.join(', ')}.`] : []),
            ...next.checks.map((check, index) => `Проверка ${index + 1}: код ${check.exitCode}.`),
            ...(next.triage?.retries ?? []).map(retry => retry.exitCode === null ? `Повтор проверки ${retry.check + 1} остановлен.` : `Повтор проверки ${retry.check + 1}: код ${retry.exitCode}.`),
            ...(next.triage?.target ? [`Целевая ветка на коммите ${next.triage.target.commit.slice(0, 12)}: ${next.triage.target.passed ? 'проверка проходит' : next.triage.target.passed === false ? 'проверка не проходит' : 'проверка остановлена'}.`] : [])] });
      }
      return next;
    }).immediate();
  }
  /** Appends what happened to a finished conflict, such as the integrator being started or declined. */
  noteIntegration(id: string, attempt: number, note: string): void {
    this.db.transaction(() => {
      const row = this.db.query('SELECT snapshot FROM integrations WHERE id=?').get(id) as Row | null;
      if (!row) return;
      const job = JSON.parse(row.snapshot) as Integration;
      if (job.attempt !== attempt || job.status !== 'conflict') return;
      this.writeIntegration({ ...job, error: [job.error, note].filter(Boolean).join(' ').slice(0, 4_000), updatedAt: clock() });
    }).immediate();
  }
  cancelIntegration(runId: string, pending: boolean, acknowledgement = false): Integration {
    return this.db.transaction(() => {
      const job = this.integrationForRun(runId);
      if (!job) throw new AppError('У запуска нет слияния', 409);
      if (job.status === 'interrupted' && !acknowledgement) throw new AppError('Сначала подтвердите, что прежние процессы проверки и слияния остановлены.', 409);
      if (!['queued', 'checking', 'merging', 'interrupted'].includes(job.status)) throw new AppError('Слияние уже завершено', 409);
      const next = { ...job, status: pending ? 'cancelling' as const : 'cancelled' as const, updatedAt: clock() };
      this.writeIntegration(next); return next;
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
      const now = clock();
      this.db.query('UPDATE runs SET session_id=?,updated_at=? WHERE id=?').run(sessionId, now, id);
      if (run.currentStepIndex !== null) {
        updateStep(run.steps[run.currentStepIndex]!, { sessionId, updatedAt: now });
        this.persistSteps(run);
      }
    }).immediate();
  }
  finish(id: string, status: Exclude<RunStatus, 'running'>, summary: string | null, error: string | null, now = clock(), fence?: RunFence): Run {
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
          this.snapshotTimeLimit(id, run.taskId);
          return this.getRun(id);
        }
        this.persistSteps(run);
      }
      const final: RunStatus = run.steps.length && status === 'completed' && cancelRequested ? 'cancelled' : status;
      this.db.query(`UPDATE runs SET status=?,summary=?,error=?,updated_at=?,finished_at=? WHERE id=?`)
        .run(final, summary, error, now, status === 'waiting_input' ? null : now, id);
      if (run.trigger === 'autopilot') this.noteAutopilotOutcome(run, final, now);
      return this.getRun(id);
    }).immediate();
  }
  /** The circuit breaker: consecutive failed or blocked autopilot runs switch the autopilot off; a result or a question resets the count. */
  private noteAutopilotOutcome(run: Run, status: RunStatus, now: number) {
    const state = this.getAutopilot();
    if (!state.enabled || state.startedAt === null || run.startedAt < state.startedAt) return;
    if (status === 'completed' || status === 'waiting_input') {
      if (state.failures) this.db.query('UPDATE autopilot SET failures=0,updated_at=? WHERE singleton=1').run(now);
      return;
    }
    if (status !== 'failed' && status !== 'blocked') return;
    const failures = state.failures + 1;
    if (failures < AUTOPILOT_FAILURE_LIMIT) { this.db.query('UPDATE autopilot SET failures=?,updated_at=? WHERE singleton=1').run(failures, now); return; }
    this.db.query("UPDATE autopilot SET enabled=0,failures=?,stopped_at=?,stop_reason='failures',updated_at=? WHERE singleton=1").run(failures, now, now);
    this.comment(run.taskId, run.id, 'system', `Автопилот выключен: ${AUTOPILOT_FAILURE_LIMIT} запуска подряд завершились ошибкой или блокировкой. Проверьте причину и включите его снова.`, now, run.currentStepIndex);
  }
  resume(id: string, answer: string, acknowledgeInterruption = false, now = clock(), ids?: string[]): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (!['waiting_input', 'interrupted'].includes(run.status) && !(run.timeLimitExceeded && run.steps.length && run.sessionId)) throw new AppError('Этот запуск нельзя продолжить', 409);
      if (!run.sessionId) throw new AppError('CLI не сохранил ID сессии. Для сложной задачи повторите текущий этап с подтверждением; иначе отмените запуск и создайте новый.', 409);
      if (run.status === 'interrupted' && !acknowledgeInterruption) throw new AppError('Сначала подтвердите, что предыдущий CLI-процесс остановлен. Повторный запуск может продублировать действия.', 409);
      this.db.query("UPDATE runs SET status='running',turn=turn+1,updated_at=?,finished_at=NULL,error=NULL WHERE id=?").run(now, id);
      if (run.currentStepIndex !== null) {
        updateStep(run.steps[run.currentStepIndex]!, { status: 'running', turn: run.turn + 1, updatedAt: now, finishedAt: null, error: null });
        this.persistSteps(run);
      }
      this.comment(run.taskId, id, 'user', answer, now, undefined, ids);
      this.advanceAttachmentInputs(run, run.turn + 1, attachmentIds(ids));
      this.snapshotTimeLimit(id, run.taskId);
      return this.getRun(id);
    }).immediate();
  }
  retry(id: string, acknowledgeInterruption = false, now = clock()): Run {
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
      this.snapshotTimeLimit(id, run.taskId);
      this.comment(run.taskId, id, 'system', 'Повтор текущего этапа в новой сессии. Предыдущие попытки сохранены; выполненные действия не откатываются. Разрешения CLI не изменены.', now);
      return this.getRun(id);
    }).immediate();
  }
  cancel(id: string, now = clock(), pending = false, acknowledgeInterruption = false): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if ((run.steps.length || run.followup || this.executionNeedsAcknowledgement(id)) && run.status === 'interrupted' && !acknowledgeInterruption) throw new AppError('Сначала подтвердите, что предыдущий CLI-процесс остановлен. Отмена освобождает задачу для новых запусков.', 409);
      const cancellable = ['queued', 'preparing', 'running', 'waiting_input', 'interrupted', ...(run.steps.length ? ['failed', 'blocked'] : [])];
      if (!cancellable.includes(run.status)) throw new AppError('Запуск уже завершён', 409);
      this.db.query('UPDATE runs SET status=?,updated_at=?,finished_at=?,cancel_requested=1 WHERE id=?').run(pending ? 'cancelling' : 'cancelled', now, pending ? null : now, id);
      if (!pending) this.db.query("UPDATE execution_requests SET state='settled' WHERE run_id=? AND state IN ('queued','held','interrupted')").run(id);
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
  completeCancellation(id: string, now = clock(), fence?: RunFence) {
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
  reconcile(now = clock()): number {
    return this.db.transaction(() => {
      // Unattended work never resumes on its own: interrupted runs need a human check first.
      this.db.query("UPDATE autopilot SET enabled=0,stopped_at=?,stop_reason='restart',updated_at=? WHERE singleton=1 AND enabled=1").run(now, now);
      const rows = this.db.query("SELECT * FROM runs WHERE status IN ('preparing','running','cancelling')").all() as Row[];
      this.db.query("UPDATE execution_requests SET state='interrupted' WHERE state IN ('preparing','running')").run();
      for (const row of this.db.query("SELECT snapshot FROM integrations WHERE state IN ('checking','merging','cancelling')").all() as Row[]) {
        const job = JSON.parse(row.snapshot) as Integration;
        // The triage does not resume on its own either: its rerun or target check may still be running.
        const triage = job.triage && job.triage.stage !== 'done' ? { ...job.triage, stage: 'done' as const, outcome: 'interrupted' as const } : job.triage;
        if (triage !== job.triage) this.recordTriage(triage);
        this.writeIntegration({ ...job, ...(triage ? { triage } : {}), status: 'interrupted', updatedAt: now, error: 'Сервис остановился во время проверки или слияния. Проверьте прежние процессы перед повтором.' });
      }
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
