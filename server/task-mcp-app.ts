import { createHash } from 'node:crypto';
import type { Integration, Run } from '../src/lib/types';
import { AppError, type RunFence, type Store } from './store';
import { TASK_APP_OPERATIONS } from './task-mcp-app-protocol';
import { MAX_TASK_RESULT_BYTES, type TaskToolResult } from './task-mcp-protocol';

export interface AppAccess<Invocation = { runId?: string; taskId?: string; isCurrent: () => boolean }> {
  request(method: string, path: string, body: Record<string, unknown> | undefined,
    invocation: Invocation): Promise<Response | { response: Response; afterResponse?: () => void }>;
}
export type TaskAppAccess = AppAccess<{ runId: string; taskId: string; isCurrent: () => boolean }>;
export interface AppToolContext {
  runId?: string;
  taskId?: string;
  taskDefaults(): { cwd: string; provider: Run['provider'] };
  beginOperation(key: string, fingerprint: string): { key: string; result: string | null; fresh: boolean };
  finishOperation(key: string, result: string): void;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): TaskToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const errorResult = (message: string): TaskToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });
const wireSize = (v: unknown) => Buffer.byteLength(JSON.stringify(text(v))) + 1;

/** Enforce the same advertised schema even when a caller bypasses the SDK. */
export function validateToolArguments(value: unknown, schema: Record<string, unknown>, path = 'arguments'): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
    type === 'object' ? record(value) : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) :
    type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type);
  if (!matches || (Array.isArray(schema.enum) && !schema.enum.includes(value))) throw new AppError(`Invalid ${path}.`);
  if (value === null) return;
  if (typeof value === 'string' && (value.includes('\0') ||
      typeof schema.minLength === 'number' && value.length < schema.minLength ||
      typeof schema.maxLength === 'number' && value.length > schema.maxLength ||
      typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))) throw new AppError(`Invalid ${path}.`);
  if (typeof value === 'number' && (typeof schema.minimum === 'number' && value < schema.minimum ||
      typeof schema.maximum === 'number' && value > schema.maximum)) throw new AppError(`Invalid ${path}.`);
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems ||
        typeof schema.maxItems === 'number' && value.length > schema.maxItems ||
        schema.uniqueItems === true && new Set(value.map(v => JSON.stringify(v))).size !== value.length) throw new AppError(`Invalid ${path}.`);
    if (record(schema.items)) value.forEach((v, i) => validateToolArguments(v, schema.items as Record<string, unknown>, `${path}[${i}]`));
  } else if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) throw new AppError(`Empty ${path}.`);
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) throw new AppError(`Missing required ${path} fields.`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) throw new AppError(`Unknown ${path}.${key}.`);
      } else if (record(properties[key])) validateToolArguments(value[key], properties[key], `${path}.${key}`);
    }
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
/** Keep write receipts small enough to reserve before performing the mutation. */
function summary(value: unknown): unknown {
  if (!record(value)) return value;
  const fields = ['id', 'taskId', 'runId', 'title', 'name', 'provider', 'modelId', 'model', 'label', 'enabled', 'archived', 'archivedAt',
    'dependsOnTaskIds', 'dependencies', 'timeLimitMinutes', 'agentTimeLimitMinutes', 'integrationCheckTimeLimitMinutes', 'timeLimitExceeded', 'status', 'progress', 'usage', 'trigger', 'schedule', 'paused', 'ultracode', 'priority', 'nextRunAt', 'startedAt', 'finishedAt', 'workerId', 'kind', 'createdAt', 'updatedAt',
    'selected', 'autoUpdate', 'size', 'source', 'color', 'mode', 'defaultSchedule', 'defaultWorkerId', 'ok', 'accepted', 'action', 'parentId', 'position', 'snippet'];
  const result = Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  return Object.keys(result).length ? result : { updated: true };
}
/** A merge as get_run reports it: commits, conflicts, the reason it stopped, each check with the end of its output and the failed-check triage. */
function integrationDetails(job: Integration, output: boolean) {
  const tail = <T extends { output?: string; outputTruncated?: boolean }>(item: T) =>
    output && item.output !== undefined ? { output: item.output, ...(item.outputTruncated ? { outputTruncated: true } : {}) } : {};
  const triage = job.triage;
  return { ...summary(job) as object, attempt: job.attempt, error: job.error, conflicts: job.conflicts ?? [],
    sourceCommit: job.sourceCommit, targetCommit: job.targetCommit, resultCommit: job.resultCommit,
    checks: job.checks.map(check => ({ argv: check.argv, exitCode: check.exitCode, ...tail(check) })),
    ...(triage ? { triage: { stage: triage.stage, outcome: triage.outcome, spentMs: triage.spentMs, limitMs: triage.limitMs, handback: triage.handback,
      retries: triage.retries.map(retry => ({ check: retry.check, exitCode: retry.exitCode, ...tail(retry) })),
      target: triage.target && { commit: triage.target.commit, passed: triage.target.passed, checks: triage.target.checks.map(check => ({ argv: check.argv, exitCode: check.exitCode, ...tail(check) })) } } } : {}) };
}
function page(values: unknown[], args: Record<string, unknown>, total = values.length, extra: Record<string, unknown> = {}): unknown {
  const offset = args.offset as number | undefined ?? 0, limit = args.limit as number | undefined ?? 20;
  const items: unknown[] = [];
  for (const value of values.slice(0, limit)) {
    const item = summary(value);
    if (wireSize({ ...extra, items: [...items, item], total, next_offset: Number.MAX_SAFE_INTEGER }) > MAX_TASK_RESULT_BYTES) break;
    items.push(item);
  }
  if (values.length && !items.length) throw new AppError('One list item exceeds the MCP response limit.');
  return { ...extra, items, total, next_offset: offset + items.length < total ? offset + items.length : null };
}

export function createTaskAppController(store: Store, run: Run, fence: RunFence, access: TaskAppAccess | undefined,
  isCurrent: () => boolean, afterResponse: (action: () => void) => void) {
  return createAppController(store, {
    runId: run.id, taskId: run.taskId,
    taskDefaults: () => ({ cwd: run.workspace?.projectCwd ?? run.cwd, provider: run.provider }),
    beginOperation: (key, fingerprint) => store.beginTaskToolOperation(run.id, fence, key, fingerprint),
    finishOperation: (key, result) => store.finishTaskToolOperation(key, result),
  }, access ? { request: (method, path, body, invocation) => access.request(method, path, body,
    { runId: run.id, taskId: run.taskId, isCurrent: invocation.isCurrent }) } : undefined, isCurrent, afterResponse);
}

/** Shared app operations; the caller supplies its identity and durable receipts. */
export function createAppController(store: Store, context: AppToolContext, access: AppAccess | undefined,
  isCurrent: () => boolean, afterResponse: (action: () => void) => void) {
  const operations = new Map(TASK_APP_OPERATIONS.map(operation => [operation.name, operation]));
  return {
    has: (name: string) => operations.has(name),
    mutates: (name: string) => operations.get(name)?.method !== 'GET',
    async execute(name: string, raw: unknown): Promise<TaskToolResult> {
      if (!isCurrent()) throw new AppError('MCP caller is no longer available.', 409);
      const operation = operations.get(name);
      if (!operation) throw new AppError('Unknown app management tool.');
      validateToolArguments(raw, operation.inputSchema);
      const args = raw as Record<string, unknown>;
      let path = operation.path;
      if (operation.target) {
        const id = operation.target === 'task_id' ? store.resolveTaskReference(args.task_id as string).id : args[operation.target] as string;
        path = path.replace('{id}', encodeURIComponent(id));
      }
      if (operation.query) {
        const params = new URLSearchParams();
        for (const [argument, parameter] of Object.entries(operation.query)) if (args[argument] !== undefined) params.set(parameter, String(args[argument]));
        if ([...params].length) path += `?${params}`;
      }
      const offset = args.offset as number | undefined ?? 0, limit = args.limit as number | undefined ?? 20;
      // Page SQL first: do not load every card, run, attachment or frozen worker
      // snapshot into an agent's context just to discover a handful of IDs.
      if (name === 'list_tasks') {
        const query = args.query as string | undefined ?? '', archived = args.archived ?? 'all', tag = args.tag_id ?? null;
        const where = `(?='all' OR (?='active' AND archived_at IS NULL) OR (?='archived' AND archived_at IS NOT NULL))
          AND (?='' OR instr(lower(title),lower(?))>0 OR instr(lower(instruction),lower(?))>0)
          AND (? IS NULL OR EXISTS(SELECT 1 FROM task_tags tt WHERE tt.task_id=tasks.id AND tt.tag_id=?))`;
        const params = [archived, archived, archived, query, query, query, tag, tag] as (string | null)[];
        const total = (store.db.query(`SELECT count(*) AS n FROM tasks WHERE ${where}`).get(...params) as { n: number }).n;
        const rows = store.db.query(`SELECT id FROM tasks WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as { id: string }[];
        return text(page(rows.map(row => store.getTask(row.id)), args, total));
      }
      if (name === 'list_runs') {
        const task = store.resolveTaskReference(args.task_id as string);
        const total = (store.db.query('SELECT count(*) AS n FROM runs WHERE task_id=?').get(task.id) as { n: number }).n;
        const rows = store.db.query('SELECT id FROM runs WHERE task_id=? ORDER BY started_at DESC,rowid DESC LIMIT ? OFFSET ?').all(task.id, limit, offset) as { id: string }[];
        return text(page(rows.map(row => store.getRun(row.id)), args, total));
      }
      if (name === 'get_run') {
        const value = store.getRun(args.run_id as string);
        const details = (output: boolean) => ({ ...summary(value) as object, summary: value.summary, error: value.error, sessionId: value.sessionId,
          currentStepIndex: value.currentStepIndex, step_count: value.steps.length, usage: value.usage ?? null, turns: store.turnUsage(value.id),
          steps: value.steps.map(step => ({ title: step.title, workerId: step.workerId, status: step.status, summary: step.summary, error: step.error })),
          integration: value.integration ? integrationDetails(value.integration, output) : null });
        let result: object = details(true);
        // Up to ten check tails rarely matter together; without them the run itself still fits.
        if (wireSize(result) > MAX_TASK_RESULT_BYTES) result = { ...details(false), check_output_omitted: true };
        if (wireSize(result) > MAX_TASK_RESULT_BYTES) throw new AppError('Run details exceed the MCP response limit. Read its discussion with list_comments.');
        return text(result);
      }
      if (!access) throw new AppError('App management is unavailable in this standalone broker. Use the MCP server started by brigd.', 503);
      let body = record(args.data) ? { ...args.data } : undefined;
      if (name === 'create_task') body = { ...context.taskDefaults(),
        schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...body };
      if (name === 'create_worker') body = { effort: 'default', communicationStyle: '', avatarUrl: null, ...body };
      const mutation = operation.method !== 'GET';
      let receipt: ReturnType<Store['beginTaskToolOperation']> | undefined;
      if (mutation) {
        const fingerprint = createHash('sha256').update(JSON.stringify(canonical([name, args]))).digest('hex');
        receipt = context.beginOperation(args.idempotency_key as string, fingerprint);
        if (!receipt.fresh) {
          if (receipt.result !== null) return JSON.parse(receipt.result) as TaskToolResult;
          throw new AppError('This operation was already accepted but its result is unavailable. Inspect the app state before issuing a different action; do not repeat it with a new key.', 409);
        }
      }
      let result: TaskToolResult;
      let deferred: (() => void) | undefined;
      try {
        if (!isCurrent()) throw new AppError('Task invocation is no longer current.', 409);
        const response = await access.request(operation.method, path, body, { runId: context.runId, taskId: context.taskId, isCurrent });
        const wrapper = response instanceof Response ? { response } : response;
        const value: unknown = await wrapper.response.json();
        if (!wrapper.response.ok) {
          const message = record(value) && typeof value.error === 'string' ? value.error : `App operation failed (HTTP ${wrapper.response.status}).`;
          // 500 UTF-16 code units also fit the receipt reservation after UTF-8
          // and JSON escaping, including control characters and non-ASCII text.
          result = errorResult(message.slice(0, 500));
        } else if (mutation) {
          const compact = summary(value);
          result = wireSize(compact) <= 4096 ? text(compact) : text({ applied: true, id: record(value) ? value.id : undefined });
          deferred = wrapper.afterResponse;
        } else if (name === 'get_autopilot' && record(value)) {
          const pool = Array.isArray(value.pool) ? value.pool : [], attempts = Array.isArray(value.attempts) ? value.attempts : [];
          const state = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'pool' && key !== 'attempts'));
          result = text({ ...state, pool: pool.slice(offset, offset + limit).map(summary), attempts: attempts.slice(offset, offset + limit).map(summary),
            pool_count: pool.length, attempt_count: attempts.length,
            pool_next_offset: offset + limit < pool.length ? offset + limit : null,
            attempts_next_offset: offset + limit < attempts.length ? offset + limit : null });
        } else if (operation.collection) {
          const values = Array.isArray(value) ? value : record(value) && Array.isArray(value[operation.collection]) ? value[operation.collection] as unknown[] : [];
          result = text(page(values.slice(offset), args, values.length,
            name === 'list_backups' && record(value) ? { selectedId: value.selectedId } : {}));
        } else {
          if (wireSize(value) > MAX_TASK_RESULT_BYTES) throw new AppError('App response exceeds the MCP output limit. Narrow the query or use a paged tool.');
          result = text(value);
        }
      } catch (error) {
        result = errorResult((error instanceof AppError ? error.message : 'App operation did not complete. Inspect the app state before retrying.').slice(0, 500));
      }
      if (receipt) context.finishOperation(receipt.key, JSON.stringify(result));
      if (deferred && !result.isError) afterResponse(deferred);
      return result;
    },
  };
}
