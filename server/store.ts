import { Database } from 'bun:sqlite';
import { readFileSync, readlinkSync } from 'node:fs';
import type { Comment, Run, RunStatus, Task, TaskDetail, TaskInput } from '../src/lib/types';

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
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
  private mapRun(row: Row): Run {
    return { id: row.id, taskId: row.task_id, provider: row.provider, cwd: row.cwd, instruction: row.instruction,
      trigger: row.trigger, scheduledFor: row.scheduled_for, status: row.status, sessionId: row.session_id,
      startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, summary: row.summary,
      error: row.error, turn: row.turn, mock: !!row.mock };
  }
  private mapTask(row: Row): Task {
    const latest = this.db.query('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(row.id) as Row | null;
    return { id: row.id, title: row.title, instruction: row.instruction, provider: row.provider, cwd: row.cwd,
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
    this.db.query(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.title, input.instruction, input.provider,
      input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt,
      input.schedule === 'interval' ? (input.firstRunAt ?? now) : null, +input.paused, now, now);
    return this.getTask(id);
  }
  updateTask(id: string, input: TaskInput, now = Date.now()): Task {
    const task = this.getTask(id);
    const changedSchedule = input.schedule !== task.schedule || input.intervalMinutes !== task.intervalMinutes || input.firstRunAt !== task.firstRunAt;
    let next = task.nextRunAt;
    if (changedSchedule) next = input.schedule === 'interval' ? (input.firstRunAt ?? now) : null;
    this.db.query(`UPDATE tasks SET title=?,instruction=?,provider=?,cwd=?,schedule=?,interval_minutes=?,first_run_at=?,next_run_at=?,paused=?,updated_at=? WHERE id=?`)
      .run(input.title, input.instruction, input.provider, input.cwd, input.schedule, input.intervalMinutes, input.firstRunAt, next, +input.paused, now, id);
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
    this.db.query(`INSERT INTO runs (id,task_id,provider,cwd,instruction,trigger,scheduled_for,status,started_at,updated_at,mock) VALUES (?,?,?,?,?,?,?,'running',?,?,?)`)
      .run(id, task.id, task.provider, task.cwd, task.instruction, trigger, scheduledFor, now, now, +mock);
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
