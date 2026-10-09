import { Database } from 'bun:sqlite';
import { readFileSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Comment, Instruction, InstructionInput, InstructionSnapshot, Run, RunStatus, Task, TaskDetail, TaskInput, Worker, WorkerInput, WorkerSnapshot } from '../src/lib/types';
import { INSTRUCTION_COUNT_LIMIT } from '../src/lib/instructions';
import { validateInstruction, validateInstructionPatch, validateInstructionSnapshots } from './instructions';
import { AppError } from './errors';
export { AppError } from './errors';
type Row = Record<string, any>;
const OPEN = "'running','cancelling','waiting_input','interrupted'";
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
        ['tasks', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_id', 'TEXT REFERENCES workers(id)'],
        ['runs', 'worker_snapshot', 'TEXT'],
        ['runs', 'instructions_snapshot', "TEXT NOT NULL DEFAULT '[]'"],
      ]) {
        if (!(this.db.query(`PRAGMA table_info(${table})`).all() as Row[]).some(row => row.name === column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    }).immediate();
    // Upgrade the occupancy index without leaving an unguarded migration window.
    this.db.transaction(() => {
      this.db.exec(`DROP INDEX IF EXISTS one_open_run; CREATE UNIQUE INDEX one_open_run ON runs(task_id) WHERE status IN (${OPEN})`);
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
    return { id: row.id, name: row.name, provider: row.provider, effort: row.effort,
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
    this.assertAvatar(input.avatarUrl);
    const id = crypto.randomUUID();
    this.db.query(`INSERT INTO workers (id,name,provider,effort,communication_style,avatar_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, input.name, input.provider, input.effort, input.communicationStyle, input.avatarUrl, now, now);
    return this.getWorker(id);
  }
  updateWorker(id: string, input: WorkerInput & { archived?: boolean }, now = Date.now()): Worker {
    const current = this.getWorker(id);
    this.assertAvatar(input.avatarUrl);
    this.db.query('UPDATE workers SET name=?,provider=?,effort=?,communication_style=?,avatar_url=?,archived=?,updated_at=? WHERE id=?')
      .run(input.name, input.provider, input.effort, input.communicationStyle, input.avatarUrl, +(input.archived ?? current.archived), now, id);
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
  private assignedWorker(id: string | null | undefined, currentId?: string | null): Worker | null {
    if (id == null) return null;
    const worker = this.getWorker(id);
    if (worker.archived && worker.id !== currentId) throw new AppError('Работник в архиве. Восстановите его или выберите другого.', 409);
    return worker;
  }
  private mapRun(row: Row): Run {
    return { id: row.id, taskId: row.task_id, instructions: JSON.parse(row.instructions_snapshot ?? '[]') as InstructionSnapshot[], workerId: row.worker_id ?? null, worker: row.worker_snapshot ? JSON.parse(row.worker_snapshot) as WorkerSnapshot : null, provider: row.provider, cwd: row.cwd, instruction: row.instruction,
      trigger: row.trigger, scheduledFor: row.scheduled_for, status: row.status, sessionId: row.session_id,
      startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, summary: row.summary,
      error: row.error, turn: row.turn, mock: !!row.mock };
  }
  private mapTask(row: Row): Task {
    const latest = this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(row.id) as Row | null;
    const worker = row.worker_id ? this.getWorker(row.worker_id) : null;
    return { id: row.id, workerId: row.worker_id ?? null, worker, title: row.title, instruction: row.instruction, provider: worker?.provider ?? row.provider, cwd: row.cwd,
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
    const row = this.db.query(`SELECT * FROM runs WHERE task_id = ? AND status IN (${OPEN})`).get(taskId) as Row | null;
    return row ? this.mapRun(row) : null;
  }
  detail(id: string): TaskDetail {
    return { task: this.getTask(id), runs: (this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC').all(id) as Row[]).map(r => this.mapRun(r)),
      comments: (this.db.query('SELECT * FROM comments WHERE task_id = ? ORDER BY seq').all(id) as Row[]).map(r => ({ id: r.id, taskId: r.task_id, runId: r.run_id, kind: r.kind, body: r.body, createdAt: r.created_at })) };
  }
  createTask(input: TaskInput, now = Date.now()): Task {
    const id = crypto.randomUUID();
    const worker = this.assignedWorker(input.workerId);
    this.db.query(`INSERT INTO tasks (id,title,instruction,provider,cwd,schedule,interval_minutes,first_run_at,next_run_at,paused,created_at,updated_at,worker_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title, input.instruction, worker?.provider ?? input.provider,
      input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt,
      input.schedule === 'interval' ? (input.firstRunAt ?? now) : null, +input.paused, now, now, worker?.id ?? null);
    return this.getTask(id);
  }
  updateTask(id: string, input: TaskInput, now = Date.now()): Task {
    const task = this.getTask(id);
    const worker = this.assignedWorker(input.workerId === undefined ? task.workerId : input.workerId, task.workerId);
    const changedSchedule = input.schedule !== task.schedule || input.intervalMinutes !== task.intervalMinutes || input.firstRunAt !== task.firstRunAt;
    let next = task.nextRunAt;
    if (changedSchedule) next = input.schedule === 'interval' ? (input.firstRunAt ?? now) : null;
    this.db.query(`UPDATE tasks SET title=?,instruction=?,provider=?,cwd=?,schedule=?,interval_minutes=?,first_run_at=?,next_run_at=?,paused=?,updated_at=?,worker_id=? WHERE id=?`)
      .run(input.title, input.instruction, worker?.provider ?? input.provider, input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt, next, +input.paused, now, worker?.id ?? null, id);
    return this.getTask(id);
  }
  comment(taskId: string, runId: string | null, kind: Comment['kind'], body: string, now = Date.now()): Comment {
    this.getTask(taskId);
    const result = { id: crypto.randomUUID(), taskId, runId, kind, body, createdAt: now };
    this.db.query('INSERT INTO comments (id,task_id,run_id,kind,body,created_at) VALUES (?,?,?,?,?,?)').run(result.id, taskId, runId, kind, body, now);
    return result;
  }
  private insertRun(task: Task, trigger: Run['trigger'], scheduledFor: number | null, mock: boolean, now: number): Run {
    if (this.activeRun(task.id)) throw new AppError('У задачи уже есть активный запуск. Ответьте агенту или отмените запуск.', 409);
    const id = crypto.randomUUID();
    const worker: WorkerSnapshot | null = task.worker ? {
      id: task.worker.id, name: task.worker.name, avatarUrl: task.worker.avatarUrl, provider: task.worker.provider,
      effort: task.worker.effort, communicationStyle: task.worker.communicationStyle,
    } : null;
    const instructions = this.enabledInstructions();
    this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,scheduled_for,status,started_at,updated_at,mock,worker_id,worker_snapshot,instructions_snapshot) VALUES (?,?,?,?,?,?,?,'running',?,?,?,?,?,?)`)
      .run(id, task.id, task.provider, task.cwd, task.instruction, trigger, scheduledFor, now, now, +mock, worker?.id ?? null, worker ? JSON.stringify(worker) : null, JSON.stringify(instructions));
    this.comment(task.id, id, 'system', mock ? 'Демо-запуск: используется тестовый агент, реальные CLI не вызываются.' : `Запуск ${task.provider === 'codex' ? 'Codex' : 'Claude Code'} через CLI.`, now);
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
  setSession(id: string, sessionId: string) {
    const run = this.getRun(id);
    if (run.sessionId && run.sessionId !== sessionId) throw new AppError('CLI вернул другую сессию; запуск остановлен.', 409);
    this.db.query('UPDATE runs SET session_id=?,updated_at=? WHERE id=?').run(sessionId, Date.now(), id);
  }
  finish(id: string, status: Exclude<RunStatus, 'running'>, summary: string | null, error: string | null, now = Date.now()): Run {
    // Late subprocess completion must never overwrite cancellation or reconciliation.
    this.db.query(`UPDATE runs SET status=?,summary=?,error=?,updated_at=?,finished_at=? WHERE id=? AND status='running'`)
      .run(status, summary, error, now, status === 'waiting_input' ? null : now, id);
    return this.getRun(id);
  }
  resume(id: string, answer: string, acknowledgeInterruption = false, now = Date.now()): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (!['waiting_input', 'interrupted'].includes(run.status)) throw new AppError('Этот запуск нельзя продолжить', 409);
      if (!run.sessionId) throw new AppError('CLI не сохранил ID сессии. Отмените запуск и создайте новый.', 409);
      if (run.status === 'interrupted' && !acknowledgeInterruption) throw new AppError('Сначала подтвердите, что предыдущий CLI-процесс остановлен. Повторный запуск может продублировать действия.', 409);
      this.db.query("UPDATE runs SET status='running',turn=turn+1,updated_at=?,finished_at=NULL,error=NULL WHERE id=?").run(now, id);
      this.comment(run.taskId, id, 'user', answer, now);
      return this.getRun(id);
    }).immediate();
  }
  cancel(id: string, now = Date.now(), pending = false): Run {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (!['running', 'waiting_input', 'interrupted'].includes(run.status)) throw new AppError('Запуск уже завершён', 409);
      this.db.query('UPDATE runs SET status=?,updated_at=?,finished_at=? WHERE id=?').run(pending ? 'cancelling' : 'cancelled', now, pending ? null : now, id);
      this.comment(run.taskId, id, 'system', pending ? 'Останавливаем CLI. Задача остаётся занята до завершения процесса. Уже выполненные действия не откатываются.' : 'Запуск отменён. Уже выполненные агентом действия не откатываются.', now);
      return this.getRun(id);
    }).immediate();
  }
  completeCancellation(id: string, now = Date.now()) {
    this.db.query("UPDATE runs SET status='cancelled',updated_at=?,finished_at=? WHERE id=? AND status='cancelling'").run(now, now, id);
  }
  reconcile(now = Date.now()): number {
    return this.db.transaction(() => {
      const runs = this.db.query("SELECT * FROM runs WHERE status IN ('running','cancelling')").all() as Row[];
      for (const row of runs) {
        this.db.query("UPDATE runs SET status='interrupted',updated_at=?,error=? WHERE id=?")
          .run(now, 'Сервис остановился во время запуска. Автоматический повтор отключён; проверьте предыдущий CLI-процесс перед продолжением.', row.id);
        this.comment(row.task_id, row.id, 'system', 'Запуск прерван перезапуском сервиса. Сессия сохранена, если CLI успел вернуть её ID. Автоматического повтора не будет.', now);
      }
      return runs.length;
    }).immediate();
  }
}
