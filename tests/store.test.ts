import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError, nextOccurrence, Store } from '../server/store';
import type { RunStatus, TaskInput } from '../src/lib/types';

const MINUTE = 60_000;
const BASE = 1_700_000_000_000;
const input = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Inspect repository', instruction: 'Review the local code and report findings.',
  provider: 'codex', cwd: '/tmp', schedule: 'manual', intervalMinutes: null,
  firstRunAt: null, paused: false, ...patch,
});
const expectAppError = (action: () => unknown, status: number) => {
  try { action(); throw new Error('Expected an AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
};

let store: Store;
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'trackt-store-test-'));
  store = new Store(join(folder, 'trackt.sqlite'));
});
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });

test('worker logs survive reopening in insertion order and cannot refer to another task run', () => {
  const task = store.createTask(input(), BASE);
  const run = store.startManual(task.id, true, BASE);
  const before = store.detail(task.id).comments;
  const first = store.log(task.id, run.id, { kind: 'command', summary: 'Run tests', details: ['bun test', 'tests/engine.test.ts'] }, BASE + 2);
  const second = store.log(task.id, run.id, { kind: 'file', summary: 'Saved source', details: ['src/App.svelte'] }, BASE + 1);
  const another = store.createTask(input(), BASE);
  expectAppError(() => store.log(another.id, run.id, { kind: 'command', summary: 'Wrong task', details: [] }), 409);
  store.close();
  store = new Store(join(folder, 'trackt.sqlite'));
  expect(store.detail(task.id).logs).toEqual([first, second]);
  expect(store.detail(task.id).comments).toEqual(before);
  expect(store.detail(another.id).logs).toEqual([]);
});

describe('recurrence and durable scheduling', () => {
  test.each([
    [BASE, 5, BASE, BASE, BASE + 5 * MINUTE],
    [BASE, 5, BASE + 4 * MINUTE, BASE, BASE + 5 * MINUTE],
    [BASE, 5, BASE + 5 * MINUTE, BASE + 5 * MINUTE, BASE + 10 * MINUTE],
    [BASE, 5, BASE + 62 * MINUTE, BASE + 60 * MINUTE, BASE + 65 * MINUTE],
  ])('selects the latest aligned occurrence at %d / %d / %d', (due, interval, now, latest, next) => {
    expect(nextOccurrence(due, interval, now)).toEqual({ latest, next });
  });

  test('manual tasks never become due; future interval starts are respected', () => {
    const manual = store.createTask(input(), BASE);
    const future = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE + MINUTE }), BASE);
    expect(manual.nextRunAt).toBeNull();
    expect(future.nextRunAt).toBe(BASE + MINUTE);
    expect(store.claimDue(true, BASE + MINUTE - 1)).toEqual([]);
    expect(store.claimDue(true, BASE + MINUTE).map(run => run.taskId)).toEqual([future.id]);
  });

  test('an omitted first occurrence starts at creation time', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5 }), BASE);
    expect(task.nextRunAt).toBe(BASE);
    expect(store.claimDue(true, BASE)[0]?.scheduledFor).toBe(BASE);
  });

  test('missed intervals produce one latest run and no backlog replay', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const runs = store.claimDue(true, BASE + 62 * MINUTE);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: task.id, trigger: 'schedule', scheduledFor: BASE + 60 * MINUTE, mock: true });
    expect(store.getTask(task.id).nextRunAt).toBe(BASE + 65 * MINUTE);
    store.finish(runs[0]!.id, 'completed', 'Done', null, BASE + 62 * MINUTE);
    expect(store.claimDue(true, BASE + 62 * MINUTE)).toEqual([]);
    expect(store.detail(task.id).runs).toHaveLength(1);
    expect(store.claimDue(true, BASE + 65 * MINUTE)[0]?.scheduledFor).toBe(BASE + 65 * MINUTE);
  });

  test('an already consumed exact occurrence is never claimed twice, even if schedule is rewound', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const run = store.claimDue(true, BASE)[0]!;
    store.finish(run.id, 'completed', 'Done', null, BASE + 1);
    store.db.query('UPDATE tasks SET next_run_at=? WHERE id=?').run(BASE, task.id);
    expect(store.claimDue(true, BASE)).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(BASE + 5 * MINUTE);
    expect(store.detail(task.id).runs).toHaveLength(1);
    // The database itself also enforces occurrence identity, independently of scheduler checks.
    expect(() => store.db.query(`INSERT INTO runs
      (id,task_id,provider,cwd,instruction,trigger,scheduled_for,status,started_at,updated_at,mock)
      VALUES (?,?,?,?,?,?,?,'completed',?,?,?)`).run('duplicate', task.id, 'codex', '/tmp', 'x', 'schedule', BASE, BASE, BASE, 1)).toThrow();
  });

  test('pause stops automatic claims, preserves next time, and permits explicit manual runs', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE, paused: true }), BASE);
    expect(store.claimDue(true, BASE + 30 * MINUTE)).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(BASE);
    const manual = store.startManual(task.id, true, BASE + MINUTE);
    expect(manual.trigger).toBe('manual');
    store.finish(manual.id, 'completed', 'Done', null);
    store.updateTask(task.id, input({ ...task, paused: false }), BASE + 31 * MINUTE);
    expect(store.claimDue(true, BASE + 31 * MINUTE)[0]?.scheduledFor).toBe(BASE + 30 * MINUTE);
  });

  test.each(['running', 'waiting_input', 'interrupted'] as const)('%s reserves the task and consumes skipped scheduled occurrences', status => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const run = store.startManual(task.id, true, BASE);
    if (status !== 'running') store.finish(run.id, status, 'Awaiting action', null, BASE + 1);
    expect(store.activeRun(task.id)?.id).toBe(run.id);
    expectAppError(() => store.startManual(task.id, true, BASE + 2), 409);
    expect(store.claimDue(true, BASE + 31 * MINUTE)).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(BASE + 35 * MINUTE);
    store.cancel(run.id, BASE + 32 * MINUTE);
    expect(store.claimDue(true, BASE + 34 * MINUTE)).toEqual([]);
    expect(store.claimDue(true, BASE + 35 * MINUTE)).toHaveLength(1);
  });

  test('separate database connections see the same claim', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 1, firstRunAt: BASE }), BASE);
    const other = new Store(join(folder, 'trackt.sqlite'));
    try {
      expect(store.claimDue(true, BASE)).toHaveLength(1);
      expect(other.claimDue(true, BASE)).toEqual([]);
      expectAppError(() => other.startManual(task.id, true, BASE), 409);
      expect(other.detail(task.id).runs).toHaveLength(1);
    } finally { other.close(); }
  });

  test('simultaneous claimers in independent Bun processes create exactly one run per task', async () => {
    const tasks = Array.from({ length: 8 }, () => store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE));
    const modulePath = resolve(import.meta.dir, '../server/store.ts');
    const gate = join(folder, 'go');
    const children = Array.from({ length: 4 }, (_, index) => {
      const ready = join(folder, `ready-${index}`);
      const code = `import { Store } from ${JSON.stringify(modulePath)};
        import { existsSync, writeFileSync } from 'node:fs';
        const store = new Store(${JSON.stringify(join(folder, 'trackt.sqlite'))});
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(2);
        console.log(JSON.stringify(store.claimDue(true, ${BASE + 62 * MINUTE}).map(run => run.id)));
        store.close();`;
      return { ready, child: Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' }) };
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!children.every(({ ready }) => existsSync(ready))) {
        if (Date.now() > deadline) throw new Error('Concurrent test workers did not become ready');
        await Bun.sleep(5);
      }
      writeFileSync(gate, 'claim');
      const results = await Promise.all(children.map(async ({ child }) => ({
        code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(),
      })));
      for (const result of results) { expect(result.err).toBe(''); expect(result.code).toBe(0); }
      const ids: string[] = results.flatMap(result => JSON.parse(result.out));
      expect(ids).toHaveLength(tasks.length);
      expect(new Set(ids).size).toBe(tasks.length);
      for (const task of tasks) {
        expect(store.detail(task.id).runs).toHaveLength(1);
        expect(store.getTask(task.id).nextRunAt).toBe(BASE + 65 * MINUTE);
      }
    } finally {
      for (const { child } of children) child.kill();
      await Promise.all(children.map(({ child }) => child.exited));
    }
  }, 10_000);
});

describe('run lifecycle and persistence', () => {
  test('execution parameters are immutable snapshots when a task is edited', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, false, BASE);
    const changed = input({ title: 'Changed', instruction: 'New instructions', provider: 'claude', cwd: '/var/tmp' });
    store.updateTask(task.id, changed, BASE + 1);
    expect(store.getTask(task.id)).toMatchObject(changed);
    expect(store.getRun(run.id)).toMatchObject({ provider: 'codex', cwd: '/tmp', instruction: task.instruction, mock: false });
    store.finish(run.id, 'completed', 'Done', null);
    expectAppError(() => store.startManual(task.id, false, BASE + 2), 409);
    const fresh = store.createTask(changed, BASE + 2);
    expect(store.startManual(fresh.id, false, BASE + 3)).toMatchObject({ provider: 'claude', cwd: '/var/tmp', instruction: 'New instructions' });
  });

  test('non-schedule edits preserve next time; changing or removing schedule recalculates it', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    store.claimDue(true, BASE + 12 * MINUTE);
    const edited = store.updateTask(task.id, input({ ...task, title: 'Renamed' }), BASE + 13 * MINUTE);
    expect(edited.nextRunAt).toBe(BASE + 15 * MINUTE);
    expect(store.updateTask(task.id, input({ ...edited, intervalMinutes: 10, firstRunAt: BASE + 20 * MINUTE }), BASE).nextRunAt).toBe(BASE + 20 * MINUTE);
    expect(store.updateTask(task.id, input(), BASE).nextRunAt).toBeNull();
  });

  test.each(['completed', 'blocked', 'failed', 'cancelled'] as const)('%s releases occupancy; completed tasks continue only through follow-ups or their schedule', (status: Exclude<RunStatus, 'running'>) => {
    const task = store.createTask(input(), BASE);
    const first = store.startManual(task.id, true, BASE);
    store.finish(first.id, status, 'Outcome', null, BASE + 1);
    expect(store.activeRun(task.id)).toBeNull();
    let second: ReturnType<Store['startManual']>;
    if (status === 'completed') {
      expectAppError(() => store.startManual(task.id, true, BASE + 2), 409);
      store.updateTask(task.id, input({ ...task, schedule: 'interval', intervalMinutes: 1, firstRunAt: BASE + 2 }), BASE + 2);
      second = store.claimDue(true, BASE + 2)[0]!;
    } else second = store.startManual(task.id, true, BASE + 2);
    expect(second.id).not.toBe(first.id);
    expect(store.getTask(task.id).runCount).toBe(2);
  });

  test('waiting resumes the exact run/session and keeps ordered comments', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'codex-session-exact');
    store.finish(run.id, 'waiting_input', 'Choose a target', null, BASE + 1);
    expect(store.getRun(run.id).finishedAt).toBeNull();
    store.comment(task.id, run.id, 'question', 'Which target?', BASE + 1);
    const resumed = store.resume(run.id, 'The backend', false, BASE + 2);
    expect(resumed).toMatchObject({ id: run.id, sessionId: 'codex-session-exact', status: 'running', turn: 2, finishedAt: null, error: null });
    expect(store.detail(task.id).comments.map(comment => comment.kind)).toEqual(['system', 'question', 'user']);
    expect(store.detail(task.id).comments.at(-1)?.body).toBe('The backend');
    expect(store.getTask(task.id).runCount).toBe(1);
  });

  test('resume without a session fails without mutating status, turn, or comments', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.finish(run.id, 'waiting_input', 'Question', null, BASE + 1);
    const before = store.detail(task.id);
    expectAppError(() => store.resume(run.id, 'Answer'), 409);
    expect(store.detail(task.id)).toEqual(before);
  });

  test('session identity cannot be replaced', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'same-session');
    store.setSession(run.id, 'same-session');
    expectAppError(() => store.setSession(run.id, 'other-session'), 409);
    expect(store.getRun(run.id).sessionId).toBe('same-session');
  });

  test('restart retains waiting/session/comments and reconciles only running without replay', () => {
    const waitingTask = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const runningTask = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const waiting = store.startManual(waitingTask.id, true, BASE);
    store.setSession(waiting.id, 'waiting-session');
    store.finish(waiting.id, 'waiting_input', 'Need detail', null, BASE + 1);
    store.comment(waitingTask.id, waiting.id, 'question', 'Which file?', BASE + 1);
    const running = store.startManual(runningTask.id, true, BASE);
    store.setSession(running.id, 'running-session');
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.reconcile(BASE + 20 * MINUTE)).toBe(1);
    expect(store.reconcile(BASE + 21 * MINUTE)).toBe(0);
    expect(store.getRun(waiting.id)).toMatchObject({ status: 'waiting_input', sessionId: 'waiting-session', summary: 'Need detail', turn: 1 });
    expect(store.detail(waitingTask.id).comments.at(-1)?.body).toBe('Which file?');
    expect(store.getRun(running.id)).toMatchObject({ status: 'interrupted', sessionId: 'running-session', turn: 1 });
    expect(store.getRun(running.id).error).toBeTruthy();
    expect(store.claimDue(true, BASE + 22 * MINUTE)).toEqual([]);
    expect(store.getTask(waitingTask.id).runCount).toBe(1);
    expect(store.getTask(runningTask.id).runCount).toBe(1);
    expectAppError(() => store.resume(running.id, 'Continue', false), 409);
    expect(store.resume(running.id, 'Continue', true)).toMatchObject({ id: running.id, status: 'running', sessionId: 'running-session', turn: 2 });
  });

  test('cancellation and reconciliation cannot be overwritten by late completion', () => {
    for (const terminal of ['cancelled', 'interrupted'] as const) {
      const task = store.createTask(input(), BASE);
      const run = store.startManual(task.id, true, BASE);
      if (terminal === 'cancelled') store.cancel(run.id, BASE + 1);
      else store.reconcile(BASE + 1);
      const before = store.getRun(run.id);
      store.finish(run.id, 'completed', 'Late false success', null, BASE + 2);
      expect(store.getRun(run.id)).toEqual(before);
    }
  });

  test('pending cancellation reserves occupancy until explicit process settlement', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
    const run = store.startManual(task.id, true, BASE);
    const cancelling = store.cancel(run.id, BASE + 1, true);
    expect(cancelling).toMatchObject({ status: 'cancelling', finishedAt: null });
    expect(store.activeRun(task.id)?.id).toBe(run.id);
    expectAppError(() => store.startManual(task.id, true, BASE + 2), 409);
    expectAppError(() => store.cancel(run.id, BASE + 2), 409);
    expectAppError(() => store.resume(run.id, 'Too soon', true, BASE + 2), 409);
    expect(store.claimDue(true, BASE + 31 * MINUTE)).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(BASE + 35 * MINUTE);
    store.finish(run.id, 'completed', 'Late success', null, BASE + 2);
    expect(store.getRun(run.id)).toEqual(cancelling);
    store.completeCancellation(run.id, BASE + 32 * MINUTE);
    expect(store.getRun(run.id)).toMatchObject({ status: 'cancelled', finishedAt: BASE + 32 * MINUTE, summary: null });
    expect(store.activeRun(task.id)).toBeNull();
    expect(store.startManual(task.id, true, BASE + 33 * MINUTE).id).not.toBe(run.id);
  });

  test('occupancy index migration enforces cancelling independently of application checks', () => {
    // Reproduce an old database whose partial index did not yet include cancelling.
    store.db.exec(`DROP INDEX one_open_run; CREATE UNIQUE INDEX one_open_run ON runs(task_id) WHERE status IN ('running','waiting_input','interrupted')`);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.cancel(run.id, BASE + 1, true);
    expect(() => store.db.query(`INSERT INTO runs
      (id,task_id,provider,cwd,instruction,trigger,status,started_at,updated_at,mock)
      VALUES (?,?,?,?,?,?,'running',?,?,?)`).run('overlap', task.id, 'codex', '/tmp', 'x', 'manual', BASE + 2, BASE + 2, 1)).toThrow();
    expect(store.detail(task.id).runs).toHaveLength(1);
  });

  test('restart preserves uncertain cancellation as interrupted even if settlement arrives late', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'cancelled-process-session');
    store.cancel(run.id, BASE + 1, true);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.reconcile(BASE + 2)).toBe(1);
    const interrupted = store.getRun(run.id);
    expect(interrupted).toMatchObject({ status: 'interrupted', sessionId: 'cancelled-process-session' });
    store.completeCancellation(run.id, BASE + 3);
    expect(store.getRun(run.id)).toEqual(interrupted);
    expect(store.reconcile(BASE + 4)).toBe(0);
    expectAppError(() => store.startManual(task.id, true), 409);
  });

  test('finished runs cannot be resumed or cancelled', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'complete-session');
    store.finish(run.id, 'completed', 'Done', null, BASE + 1);
    expectAppError(() => store.resume(run.id, 'Again', true), 409);
    expectAppError(() => store.cancel(run.id), 409);
  });

  test('missing task/run returns an explicit not-found error', () => {
    expectAppError(() => store.getTask('missing'), 404);
    expectAppError(() => store.getRun('missing'), 404);
  });
});

describe('exclusive service ownership', () => {
  test('an active lease rejects another connection and only its exact owner can release it', () => {
    const owner = store.acquireLease();
    const other = new Store(join(folder, 'trackt.sqlite'));
    try {
      expectAppError(() => other.acquireLease(), 409);
      other.releaseLease('not-the-owner');
      expectAppError(() => other.acquireLease(), 409);
      store.releaseLease(owner);
      const nextOwner = other.acquireLease();
      expect(nextOwner).not.toBe(owner);
      store.releaseLease(owner);
      expectAppError(() => store.acquireLease(), 409);
      other.releaseLease(nextOwner);
      expect(store.acquireLease()).toBeTypeOf('string');
    } finally { other.close(); }
  });

  test.skipIf(process.platform !== 'linux')('recovers a reused PID with a different stored boot/namespace/start identity', () => {
    const staleOwner = store.acquireLease();
    const original = store.db.query('SELECT pid, identity FROM service_lease WHERE singleton=1').get() as { pid: number; identity: string };
    expect(original.pid).toBe(process.pid);
    expect(original.identity).toBeTypeOf('string');
    expect(original.identity.length).toBeGreaterThan(0);
    expectAppError(() => store.acquireLease(), 409);
    store.db.query('UPDATE service_lease SET identity=? WHERE singleton=1').run('previous-boot:pid:[previous-namespace]:previous-start');
    const recoveredOwner = store.acquireLease();
    expect(recoveredOwner).not.toBe(staleOwner);
    expect(store.db.query('SELECT pid, identity FROM service_lease WHERE singleton=1').get()).toEqual(original);
    store.releaseLease(staleOwner);
    expectAppError(() => store.acquireLease(), 409);
    store.releaseLease(recoveredOwner);
  });

  test('a live legacy lease with unknown identity fails closed', () => {
    const owner = store.acquireLease();
    store.db.query('UPDATE service_lease SET identity=NULL WHERE singleton=1').run();
    expectAppError(() => store.acquireLease(), 409);
    store.releaseLease(owner);
    expect(store.acquireLease()).toBeTypeOf('string');
  });

  test('an old service lease table is upgraded while retaining its current owner', () => {
    store.db.exec('DROP TABLE service_lease; CREATE TABLE service_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, owner TEXT NOT NULL)');
    store.db.query('INSERT INTO service_lease VALUES (1,?,?)').run(process.pid, 'legacy-owner');
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expectAppError(() => store.acquireLease(), 409);
    expect(store.db.query('SELECT identity FROM service_lease WHERE singleton=1').get()).toEqual({ identity: null });
    store.releaseLease('legacy-owner');
    expect(store.acquireLease()).toBeTypeOf('string');
  });

  test('closing a connection does not discard a live owner lease', () => {
    const owner = store.acquireLease();
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expectAppError(() => store.acquireLease(), 409);
    store.releaseLease(owner);
    expect(store.acquireLease()).toBeTypeOf('string');
  });

  test('a confirmed exited process lease can be recovered without its stale owner releasing a new lease', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' });
    expect(await child.exited).toBe(0);
    // Use a real reaped PID rather than assuming some arbitrary large PID is unused.
    expect(() => process.kill(child.pid, 0)).toThrow();
    const staleOwner = store.acquireLease(child.pid);
    const currentOwner = store.acquireLease();
    expect(currentOwner).not.toBe(staleOwner);
    store.releaseLease(staleOwner);
    expectAppError(() => store.acquireLease(), 409);
    store.releaseLease(currentOwner);
  });
});

describe('task archive', () => {
  const finished = (status: Exclude<RunStatus, 'running'> = 'completed') => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.setSession(run.id, 'archived-session');
    store.finish(run.id, status, 'Done', null, BASE + 1);
    return { task, run };
  };

  const expectArchived = (action: () => unknown) => {
    try { action(); throw new Error('Expected an archive error'); }
    catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(409); expect((error as AppError).message).toContain('в архиве'); }
  };

  test('an archived task stays readable but rejects edits, runs, followups and notes until restored', () => {
    const { task, run } = finished();
    const archived = store.archiveTask(task.id, BASE + 10);
    expect(archived.archivedAt).toBe(BASE + 10);
    expect(store.archiveTask(task.id, BASE + 20).archivedAt).toBe(BASE + 10);
    expect(store.listTasks().map(item => [item.id, item.archivedAt])).toEqual([[task.id, BASE + 10]]);
    const before = store.detail(task.id);
    expect(before.runs.map(item => item.id)).toEqual([run.id]);
    expectArchived(() => store.updateTask(task.id, input({ title: 'Edited in archive' })));
    expectArchived(() => store.comment(task.id, null, 'user', 'Note in archive'));
    expectArchived(() => store.startFollowup(task.id, { sourceRunId: run.id, sourceStepIndex: null, body: 'Continue', attachmentIds: [], requestId: crypto.randomUUID() }));
    expect(store.detail(task.id).comments).toEqual(before.comments);
    expect(store.detail(task.id).task.title).toBe(task.title);

    const restored = store.restoreTask(task.id, BASE + 30);
    expect(restored.archivedAt).toBeNull();
    expect(store.restoreTask(task.id, BASE + 40).updatedAt).toBe(BASE + 30);
    expect(store.updateTask(task.id, input({ title: 'Edited after restore' })).title).toBe('Edited after restore');
    expect(store.comment(task.id, null, 'user', 'Note after restore').body).toBe('Note after restore');
  });

  test('an occupied task cannot be archived until its run is settled, then cannot start again', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    expectAppError(() => store.archiveTask(task.id), 409);
    store.finish(run.id, 'failed', null, 'Broken', BASE + 1);
    expect(store.archiveTask(task.id, BASE + 2).archivedAt).toBe(BASE + 2);
    expectArchived(() => store.startManual(task.id, true));
    expect(store.getTask(task.id).runCount).toBe(1);
    store.restoreTask(task.id, BASE + 3);
    expect(store.startManual(task.id, true, BASE + 4).taskId).toBe(task.id);
  });

  test('archived schedules are never claimed and restoring skips occurrences missed while archived', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 60, firstRunAt: BASE + MINUTE }), BASE);
    store.archiveTask(task.id, BASE);
    expect(store.claimDue(true, BASE + 301 * MINUTE)).toEqual([]);
    const restored = store.restoreTask(task.id, BASE + 301 * MINUTE);
    expect(restored.nextRunAt).toBe(BASE + 361 * MINUTE);
    expect(store.claimDue(true, BASE + 301 * MINUTE)).toEqual([]);
    expect(store.claimDue(true, BASE + 361 * MINUTE).map(run => run.taskId)).toEqual([task.id]);
  });

  test('restoring before the next occurrence keeps the planned time', () => {
    const task = store.createTask(input({ schedule: 'interval', intervalMinutes: 60, firstRunAt: BASE + 60 * MINUTE }), BASE);
    store.archiveTask(task.id, BASE + MINUTE);
    expect(store.restoreTask(task.id, BASE + 2 * MINUTE).nextRunAt).toBe(BASE + 60 * MINUTE);
  });

  test('archive state survives reopening the database', () => {
    const { task } = finished('cancelled');
    store.archiveTask(task.id, BASE + 5);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.getTask(task.id).archivedAt).toBe(BASE + 5);
    expect(store.createTask(input(), BASE).archivedAt).toBeNull();
  });
});

describe('autopilot', () => {
  const auto = (patch: Partial<TaskInput> = {}) => input({ schedule: 'auto', ...patch });

  test('is off by default; enabling starts a session, enabling again only moves the stop time, disabling records the reason', () => {
    expect(store.getAutopilot()).toMatchObject({ enabled: false, until: null, startedAt: null, stoppedAt: null, stopReason: null, failures: 0 });
    expect(store.setAutopilot({ enabled: true, until: BASE + 8 * 60 * MINUTE }, BASE)).toMatchObject({ enabled: true, until: BASE + 8 * 60 * MINUTE, startedAt: BASE, failures: 0 });
    expect(store.setAutopilot({ enabled: true, until: null }, BASE + MINUTE)).toMatchObject({ enabled: true, until: null, startedAt: BASE });
    expect(store.setAutopilot({ enabled: false, until: null }, BASE + 2 * MINUTE)).toMatchObject({ enabled: false, startedAt: BASE, stoppedAt: BASE + 2 * MINUTE, stopReason: 'manual' });
    // Self-stops apply only while enabled.
    expect(store.stopAutopilot('until', BASE + 3 * MINUTE)).toMatchObject({ stoppedAt: BASE + 2 * MINUTE, stopReason: 'manual' });
    store.setAutopilot({ enabled: true, until: null }, BASE + 4 * MINUTE);
    expect(store.stopAutopilot('until', BASE + 5 * MINUTE)).toMatchObject({ enabled: false, startedAt: BASE + 4 * MINUTE, stoppedAt: BASE + 5 * MINUTE, stopReason: 'until' });
  });

  test('pool lists eligible auto tasks oldest first and leaves out paused, archived, manual, completed, occupied and attempted tasks', () => {
    const later = store.createTask(auto({ title: 'later' }), BASE + 1);
    const earlier = store.createTask(auto({ title: 'earlier' }), BASE);
    store.createTask(auto({ title: 'paused', paused: true }), BASE);
    store.createTask(input({ title: 'manual' }), BASE);
    store.archiveTask(store.createTask(auto({ title: 'archived' }), BASE).id, BASE);
    const done = store.createTask(auto({ title: 'done' }), BASE);
    store.finish(store.startManual(done.id, true, BASE).id, 'completed', 'Outcome', null, BASE + 1);
    const busy = store.createTask(auto({ title: 'busy' }), BASE);
    store.startManual(busy.id, true, BASE);
    expect(store.autopilotPool(null).map(task => task.title)).toEqual(['earlier', 'later']);
    store.setAutopilot({ enabled: true, until: null }, BASE + 2);
    const run = store.startAutopilot(earlier.id, true, BASE + 3)!;
    store.finish(run.id, 'failed', null, 'Broken', BASE + 4);
    // A failed attempt waits for a person: this session never retries it, the next one may.
    expect(store.autopilotPool(BASE + 2).map(task => task.title)).toEqual(['later']);
    expect(store.autopilotPool(null).map(task => task.title)).toEqual(['earlier', 'later']);
    expect(store.autopilotOverview()).toMatchObject({ enabled: true, pool: [{ id: later.id }], attempts: [{ id: run.id, trigger: 'autopilot', status: 'failed' }] });
    expect(store.autopilotCandidates(BASE + 2)).toEqual([{ id: later.id, cwd: later.cwd }]);
  });

  test('startAutopilot refuses while off, at the stop time and for tasks outside the pool; it records the trigger and a log', () => {
    const task = store.createTask(auto(), BASE);
    expect(store.startAutopilot(task.id, true, BASE)).toBeNull();
    store.setAutopilot({ enabled: true, until: BASE + 60 * MINUTE }, BASE);
    expect(store.startAutopilot(task.id, true, BASE + 60 * MINUTE)).toBeNull();
    expect(store.startAutopilot(store.createTask(input(), BASE).id, true, BASE + MINUTE)).toBeNull();
    const run = store.startAutopilot(task.id, true, BASE + MINUTE);
    expect(run).toMatchObject({ taskId: task.id, trigger: 'autopilot', status: 'running', scheduledFor: null, mock: true });
    expect(store.startAutopilot(task.id, true, BASE + 2 * MINUTE)).toBeNull();
    expect(store.detail(task.id).logs?.map(log => log.summary)).toContain('Запуск автопилотом');
    expect(store.getTask(task.id).status).toBe('running');
  });

  test('three failed or blocked autopilot runs in a row switch the autopilot off; results and questions reset the count, other triggers never count', () => {
    store.setAutopilot({ enabled: true, until: null }, BASE);
    const attempt = (status: Exclude<RunStatus, 'running'>, at: number) => {
      const run = store.startAutopilot(store.createTask(auto(), at).id, true, at)!;
      return store.finish(run.id, status, status === 'completed' ? 'Outcome' : null, status === 'failed' ? 'Broken' : null, at + 1);
    };
    attempt('failed', BASE + 10); attempt('blocked', BASE + 20);
    expect(store.getAutopilot()).toMatchObject({ enabled: true, failures: 2 });
    attempt('waiting_input', BASE + 30);
    expect(store.getAutopilot().failures).toBe(0);
    attempt('failed', BASE + 40); attempt('failed', BASE + 50);
    store.finish(store.startManual(store.createTask(auto(), BASE + 60).id, true, BASE + 60).id, 'failed', null, 'Manual', BASE + 61);
    expect(store.getAutopilot()).toMatchObject({ enabled: true, failures: 2 });
    const last = attempt('failed', BASE + 70);
    expect(store.getAutopilot()).toMatchObject({ enabled: false, failures: 3, stopReason: 'failures', stoppedAt: BASE + 71, startedAt: BASE });
    expect(store.detail(last.taskId).comments.some(comment => comment.kind === 'system' && comment.body.startsWith('Автопилот выключен'))).toBe(true);
    // A new session starts clean, and cancellations are nobody's failure.
    expect(store.setAutopilot({ enabled: true, until: null }, BASE + 80)).toMatchObject({ failures: 0, startedAt: BASE + 80, stopReason: null, stoppedAt: null });
    attempt('cancelled', BASE + 90);
    expect(store.getAutopilot().failures).toBe(0);
  });

  test('a service restart switches the autopilot off until a person enables it again', () => {
    store.setAutopilot({ enabled: true, until: null }, BASE);
    expect(store.reconcile(BASE + MINUTE)).toBe(0);
    expect(store.getAutopilot()).toMatchObject({ enabled: false, startedAt: BASE, stoppedAt: BASE + MINUTE, stopReason: 'restart' });
    store.reconcile(BASE + 2 * MINUTE);
    expect(store.getAutopilot().stoppedAt).toBe(BASE + MINUTE);
  });

  test('the auto schedule keeps no interval and is never claimed by time', () => {
    const task = store.createTask(auto(), BASE);
    expect(task).toMatchObject({ schedule: 'auto', intervalMinutes: null, firstRunAt: null, nextRunAt: null, paused: false });
    expect(store.claimDue(true, BASE + 60 * MINUTE)).toEqual([]);
    expect(store.updateTask(task.id, input({ ...task, schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE + MINUTE }), BASE).nextRunAt).toBe(BASE + MINUTE);
    expect(store.updateTask(task.id, auto(), BASE).nextRunAt).toBeNull();
  });
});
