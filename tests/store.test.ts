import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError, firstDailyRun, nextDailyOccurrence, nextOccurrence, Store } from '../server/store';
import { TABLE_SCOPES, writeScopes } from '../server/changes';
import type { ChangeScope } from '../src/lib/change-scopes';
import type { RunStatus, TaskInput, TaskPriority } from '../src/lib/types';

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

test('error logs migrate an older database and preserve redacted multiline diagnostics after reopening', () => {
  const task = store.createTask(input(), BASE);
  const run = store.startManual(task.id, true, BASE);
  const legacy = store.log(task.id, run.id, { kind: 'tool', summary: 'Ошибка инструмента: Bash', details: [] }, BASE + 1);
  store.db.exec('ALTER TABLE task_logs DROP COLUMN error');
  store.close();
  store = new Store(join(folder, 'trackt.sqlite'));
  expect(store.detail(task.id).logs).toEqual([legacy]);
  const error = store.log(task.id, run.id, {
    kind: 'tool', summary: 'Ошибка инструмента: Bash', details: [],
    error: '\u001b[31mPermission denied\u001b[0m\napi_key=private-value\nTry /permissions.',
  }, BASE + 2);
  expect(error.error).toBe('Permission denied\napi_key=[скрыто]\nTry /permissions.');
  store.close();
  store = new Store(join(folder, 'trackt.sqlite'));
  expect(store.detail(task.id).logs).toEqual([legacy, error]);
  expect(store.detail(task.id).comments.some(comment => comment.body.includes('private-value'))).toBe(false);
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

describe('daily schedules', () => {
  const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  const WORKDAYS = [1, 2, 3, 4, 5];
  // Saturday 24 October 2026, 12:00 in Moscow (UTC+3 all year).
  const SATURDAY = Date.UTC(2026, 9, 24, 9);
  const moscow = (day: number, hour: number) => Date.UTC(2026, 9, day, hour - 3);
  const daily = (patch: Partial<TaskInput> = {}) => input({ schedule: 'daily', timeOfDay: '02:00', weekdays: WORKDAYS, timeZone: 'Europe/Moscow', ...patch });

  test.each([
    ['Europe/Moscow', '02:00', WORKDAYS, SATURDAY, moscow(23, 2), moscow(26, 2)],
    ['UTC', '09:00', EVERY_DAY, Date.UTC(2026, 9, 23, 9), Date.UTC(2026, 9, 23, 9), Date.UTC(2026, 9, 24, 9)],
    ['Asia/Kathmandu', '00:00', EVERY_DAY, Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 2, 18, 15), Date.UTC(2026, 9, 3, 18, 15)],
    ['America/New_York', '09:00', [7], Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 9, 25, 13), Date.UTC(2026, 10, 1, 14)],
    ['Asia/Tokyo', '10:00', [1, 4], SATURDAY, Date.UTC(2026, 9, 22, 1), Date.UTC(2026, 9, 26, 1)],
  ])('%s at %s on %j: the latest occurrence up to now and the next one', (timeZone, timeOfDay, weekdays, now, latest, next) => {
    expect(nextDailyOccurrence(0, { timeOfDay, weekdays, timeZone }, now)).toEqual({ latest, next });
  });

  test.each([
    ['a time skipped by spring-forward runs as late as the jump', 'Europe/Berlin', '02:30', Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 29, 1, 30)],
    ['the day after the jump keeps the local time', 'Europe/Berlin', '02:30', Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 2, 30, 0, 30)],
    ['a time repeated by fall-back runs at its first occurrence', 'Europe/Berlin', '02:30', Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 25, 0, 30)],
    ['the repeated hour does not run a second time', 'Europe/Berlin', '02:30', Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 26, 1, 30)],
    ['a New York spring-forward gap', 'America/New_York', '02:30', Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 8, 7, 30)],
    ['a New York repeated hour, first pass', 'America/New_York', '01:30', Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 10, 1, 5, 30)],
    ['a New York repeated hour, then standard time', 'America/New_York', '01:30', Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 2, 6, 30)],
    ['a half-hour daylight saving shift', 'Australia/Lord_Howe', '02:15', Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 3, 15, 45)],
    ['a local date the zone skipped altogether', 'Pacific/Apia', '10:00', Date.UTC(2011, 11, 29, 21), Date.UTC(2011, 11, 30, 20)],
  ])('%s (%s %s)', (_name, timeZone, timeOfDay, now, next) => {
    expect(firstDailyRun({ timeOfDay, weekdays: EVERY_DAY, timeZone }, now)).toBe(next);
  });

  test('a long sleep still yields one latest occurrence; an unaligned due time is never moved back', () => {
    const rule = { timeOfDay: '02:00', weekdays: WORKDAYS, timeZone: 'Europe/Moscow' };
    expect(nextDailyOccurrence(Date.UTC(2020, 0, 1), rule, SATURDAY)).toEqual({ latest: moscow(23, 2), next: moscow(26, 2) });
    expect(nextDailyOccurrence(moscow(23, 3), rule, SATURDAY)).toEqual({ latest: moscow(23, 3), next: moscow(26, 2) });
  });

  test('a weekday 02:00 Moscow card created on Saturday first runs on Monday, then on Tuesday', () => {
    const task = store.createTask(daily(), SATURDAY);
    expect(task).toMatchObject({ schedule: 'daily', timeOfDay: '02:00', weekdays: WORKDAYS, timeZone: 'Europe/Moscow', nextRunAt: moscow(26, 2) });
    expect(store.createTask(input(), SATURDAY)).toMatchObject({ timeOfDay: null, weekdays: null, timeZone: null });
    expect(store.claimDue(true, moscow(26, 2) - 1)).toEqual([]);
    const [run] = store.claimDue(true, moscow(26, 2));
    expect(run).toMatchObject({ taskId: task.id, trigger: 'schedule', scheduledFor: moscow(26, 2) });
    expect(store.getTask(task.id).nextRunAt).toBe(moscow(27, 2));
  });

  test('the local time holds across daylight saving changes', () => {
    const task = store.createTask(daily({ timeOfDay: '02:30', weekdays: EVERY_DAY, timeZone: 'Europe/Berlin' }), Date.UTC(2026, 2, 27, 12));
    expect(task.nextRunAt).toBe(Date.UTC(2026, 2, 28, 1, 30));
    for (const [due, next] of [[Date.UTC(2026, 2, 28, 1, 30), Date.UTC(2026, 2, 29, 1, 30)], [Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 2, 30, 0, 30)]]) {
      const [run] = store.claimDue(true, due!);
      expect(run?.scheduledFor).toBe(due!);
      expect(store.getTask(task.id).nextRunAt).toBe(next!);
      store.finish(run!.id, 'blocked', 'Done', null, due! + 1);
    }
  });

  test('occurrences missed while the service slept produce one late run and no backlog', () => {
    const task = store.createTask(daily(), SATURDAY);
    const runs = store.claimDue(true, moscow(29, 15));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scheduledFor).toBe(moscow(29, 2));
    expect(store.getTask(task.id).nextRunAt).toBe(moscow(30, 2));
    store.finish(runs[0]!.id, 'completed', 'Done', null, moscow(29, 16));
    expect(store.claimDue(true, moscow(29, 16))).toEqual([]);
    expect(store.claimDue(true, moscow(30, 2))[0]?.scheduledFor).toBe(moscow(30, 2));
    expect(store.detail(task.id).runs).toHaveLength(2);
  });

  test('a busy or waiting card consumes its occurrences without queueing them', () => {
    const task = store.createTask(daily(), SATURDAY);
    const run = store.startManual(task.id, true, SATURDAY);
    store.finish(run.id, 'waiting_input', 'Which branch?', null, SATURDAY + 1);
    expect(store.claimDue(true, moscow(26, 2))).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(moscow(27, 2));
    store.cancel(run.id, moscow(26, 3));
    expect(store.claimDue(true, moscow(26, 4))).toEqual([]);
    expect(store.claimDue(true, moscow(27, 2))).toHaveLength(1);
  });

  test('pause keeps the next time; resuming runs at most the latest missed occurrence', () => {
    const task = store.createTask(daily({ paused: true }), SATURDAY);
    expect(store.claimDue(true, moscow(28, 12))).toEqual([]);
    expect(store.getTask(task.id).nextRunAt).toBe(moscow(26, 2));
    store.updateTask(task.id, { ...store.getTask(task.id), paused: false }, moscow(28, 12));
    expect(store.claimDue(true, moscow(28, 12)).map(run => run.scheduledFor)).toEqual([moscow(28, 2)]);
    expect(store.getTask(task.id).nextRunAt).toBe(moscow(29, 2));
  });

  test('editing the time, days or zone recalculates the next run; other edits keep it; another schedule clears the fields', () => {
    const task = store.createTask(daily(), SATURDAY);
    expect(store.updateTask(task.id, { ...task, title: 'Renamed' }, SATURDAY + MINUTE).nextRunAt).toBe(moscow(26, 2));
    expect(store.updateTask(task.id, { ...task, timeOfDay: '13:30' }, SATURDAY).nextRunAt).toBe(moscow(26, 13) + 30 * MINUTE);
    expect(store.updateTask(task.id, { ...task, timeOfDay: '13:30', weekdays: [6] }, SATURDAY).nextRunAt).toBe(moscow(24, 13) + 30 * MINUTE);
    expect(store.updateTask(task.id, { ...task, timeOfDay: '13:30', weekdays: [6], timeZone: 'Asia/Tokyo' }, SATURDAY).nextRunAt).toBe(Date.UTC(2026, 9, 31, 4, 30));
    const manual = store.updateTask(task.id, input(), SATURDAY);
    expect(manual).toMatchObject({ schedule: 'manual', timeOfDay: null, weekdays: null, timeZone: null, nextRunAt: null });
    expectAppError(() => store.updateTask(task.id, daily({ timeOfDay: '25:00' }), SATURDAY), 400);
    expectAppError(() => store.createTask(daily({ weekdays: [] }), SATURDAY), 400);
    expectAppError(() => store.createTask(daily({ timeZone: 'Mars/Olympus_Mons' }), SATURDAY), 400);
  });

  test('restoring from the archive skips occurrences missed there', () => {
    const task = store.createTask(daily(), SATURDAY);
    store.archiveTask(task.id, SATURDAY);
    expect(store.claimDue(true, moscow(28, 12))).toEqual([]);
    expect(store.restoreTask(task.id, moscow(28, 12)).nextRunAt).toBe(moscow(29, 2));
    expect(store.claimDue(true, moscow(28, 12))).toEqual([]);
  });

  test('daily fields survive reopening; an older database gains them and keeps interval cards unchanged', () => {
    const scheduled = store.createTask(daily(), SATURDAY);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.getTask(scheduled.id)).toEqual(scheduled);
    store.close();
    const legacyFolder = mkdtempSync(join(tmpdir(), 'trackt-store-legacy-'));
    try {
      let legacy = new Store(join(legacyFolder, 'trackt.sqlite'));
      const interval = legacy.createTask(input({ schedule: 'interval', intervalMinutes: 5, firstRunAt: BASE }), BASE);
      for (const column of ['time_of_day', 'weekdays', 'time_zone']) legacy.db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
      legacy.close();
      legacy = new Store(join(legacyFolder, 'trackt.sqlite'));
      expect(legacy.getTask(interval.id)).toEqual(interval);
      expect(legacy.claimDue(true, BASE + 62 * MINUTE)[0]?.scheduledFor).toBe(BASE + 60 * MINUTE);
      expect(legacy.createTask(daily(), SATURDAY).nextRunAt).toBe(moscow(26, 2));
      legacy.close();
    } finally { rmSync(legacyFolder, { recursive: true, force: true }); }
    store = new Store(join(folder, 'trackt.sqlite'));
  });
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

  test('pool lists eligible auto tasks in queue order and leaves out paused, archived, manual, completed, occupied and attempted tasks', () => {
    const earlier = store.createTask(auto({ title: 'earlier' }), BASE);
    const later = store.createTask(auto({ title: 'later' }), BASE + 1);
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

  test('the queue keeps the order tasks joined it, and a move changes the claim order without losing deferred tasks\' places', () => {
    const [first, second, third] = ['first', 'second', 'third'].map((title, index) => store.createTask(auto({ title }), BASE + index));
    const titles = () => store.autopilotPool(null).map(task => task.title);
    expect(titles()).toEqual(['first', 'second', 'third']);
    expect(store.moveAutopilotTask(third!.id, first!.id).pool.map(task => task.title)).toEqual(['third', 'first', 'second']);
    expect(store.autopilotCandidates(null).map(task => task.id)).toEqual([third!.id, first!.id, second!.id]);
    store.moveAutopilotTask(third!.id, null);
    expect(titles()).toEqual(['first', 'second', 'third']);
    // A deferred task keeps its place and resumes its turn when it returns.
    store.updateTask(second!.id, { ...second!, paused: true }, BASE + 10);
    store.moveAutopilotTask(third!.id, first!.id);
    expect(titles()).toEqual(['third', 'first']);
    store.updateTask(second!.id, { ...second!, paused: false }, BASE + 11);
    expect(titles()).toEqual(['third', 'first', 'second']);
    // New tasks and tasks switched back to the autopilot join the end; edits keep the place.
    store.createTask(auto({ title: 'fourth' }), BASE - MINUTE);
    store.updateTask(first!.id, input({ title: 'first' }), BASE + 12);
    store.updateTask(first!.id, auto({ title: 'first' }), BASE + 13);
    store.updateTask(third!.id, auto({ title: 'third', instruction: 'Edited instruction.' }), BASE + 14);
    expect(titles()).toEqual(['third', 'second', 'fourth', 'first']);
    // Only active auto tasks move, and only before another one.
    const manual = store.createTask(input(), BASE);
    expectAppError(() => store.moveAutopilotTask(manual.id, null), 409);
    expectAppError(() => store.moveAutopilotTask(third!.id, manual.id), 409);
    expectAppError(() => store.moveAutopilotTask('00000000-0000-4000-8000-000000000000', null), 404);
    store.archiveTask(second!.id, BASE + 20);
    expectAppError(() => store.moveAutopilotTask(second!.id, null), 409);
    expectAppError(() => store.moveAutopilotTask(third!.id, second!.id), 409);
    expect(titles()).toEqual(['third', 'fourth', 'first']);
    store.restoreTask(second!.id, BASE + 21);
    expect(titles()).toEqual(['third', 'fourth', 'first', 'second']);
  });

  test('auto tasks saved before the queue order join its end in creation order when the database opens', () => {
    const [first, second, third] = ['first', 'second', 'third'].map((title, index) => store.createTask(auto({ title }), BASE + index));
    store.moveAutopilotTask(third!.id, first!.id);
    store.db.query('UPDATE tasks SET autopilot_position=NULL WHERE id IN (?,?)').run(second!.id, first!.id);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.autopilotPool(null).map(task => task.title)).toEqual(['third', 'first', 'second']);
    store.createTask(auto({ title: 'fourth' }), BASE);
    expect(store.autopilotPool(null).map(task => task.title)).toEqual(['third', 'first', 'second', 'fourth']);
  });

  test('priority defaults to normal, survives edits that omit it and reopening, and cards saved before it become normal', () => {
    const plain = store.createTask(input(), BASE);
    expect(plain.priority).toBe('normal');
    const urgent = store.createTask(input({ priority: 'critical' }), BASE + 1);
    expect(store.updateTask(urgent.id, input({ title: 'Edited' }), BASE + 2).priority).toBe('critical');
    expect(store.updateTask(plain.id, input({ priority: 'low' }), BASE + 3).priority).toBe('low');
    expectAppError(() => store.createTask(input({ priority: 'urgent' as TaskPriority }), BASE), 400);
    expectAppError(() => store.updateTask(plain.id, input({ priority: null as unknown as TaskPriority }), BASE + 4), 400);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect([store.getTask(plain.id).priority, store.getTask(urgent.id).priority]).toEqual(['low', 'critical']);
    store.db.exec('ALTER TABLE tasks DROP COLUMN priority');
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.listTasks().map(task => task.priority)).toEqual(['normal', 'normal']);
  });

  test('a higher priority is claimed first; moves stay within one priority and a changed priority joins the end of the new one', () => {
    const create = (title: string, priority: TaskPriority, at: number) => store.createTask(auto({ title, priority }), at);
    const raised = create('raised', 'low', BASE);
    const first = create('first', 'normal', BASE + 1);
    const high = create('high', 'high', BASE + 2);
    const second = create('second', 'normal', BASE + 3);
    const critical = create('critical', 'critical', BASE + 4);
    const titles = () => store.autopilotPool(null).map(task => task.title);
    expect(titles()).toEqual(['critical', 'high', 'first', 'second', 'raised']);
    expect(store.autopilotCandidates(null).map(task => task.id)).toEqual([critical.id, high.id, first.id, second.id, raised.id]);
    expect(store.moveAutopilotTask(second.id, first.id).pool.map(task => task.title)).toEqual(['critical', 'high', 'second', 'first', 'raised']);
    // null places a task last among its own priority, not after less urgent tasks.
    store.moveAutopilotTask(second.id, null);
    expect(titles()).toEqual(['critical', 'high', 'first', 'second', 'raised']);
    expectAppError(() => store.moveAutopilotTask(raised.id, critical.id), 409);
    expectAppError(() => store.moveAutopilotTask(critical.id, high.id), 409);
    expect(titles()).toEqual(['critical', 'high', 'first', 'second', 'raised']);
    store.updateTask(raised.id, auto({ title: 'raised', priority: 'high' }), BASE + 10);
    expect(titles()).toEqual(['critical', 'high', 'raised', 'first', 'second']);
    store.updateTask(critical.id, auto({ title: 'critical', priority: 'normal' }), BASE + 11);
    expect(titles()).toEqual(['high', 'raised', 'first', 'second', 'critical']);
    store.updateTask(first.id, auto({ title: 'first', instruction: 'Edited instruction.' }), BASE + 12);
    expect(titles()).toEqual(['high', 'raised', 'first', 'second', 'critical']);
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

describe('change revision', () => {
  const record = () => {
    const seen: ChangeScope[][] = [];
    const stop = store.onChange(scopes => { seen.push([...scopes]); });
    return { stop, scopes: () => [...new Set(seen.splice(0).flat())].sort() };
  };

  test('every table has an explicit scope mapping', () => {
    const rows = store.db.query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
    const virtual = rows.filter(row => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map(row => row.name);
    // Full-text search keeps its own shadow tables beside the virtual one.
    const tables = rows.map(row => row.name).filter(name => !virtual.some(table => name.startsWith(`${table}_`)));
    expect(tables.filter(table => !Object.hasOwn(TABLE_SCOPES, table))).toEqual([]);
  });

  test('statements are classified by the tables they write', () => {
    expect(writeScopes('SELECT * FROM tasks WHERE updated_at > ?')).toEqual([]);
    expect(writeScopes('UPDATE runs SET status=? WHERE id=?')).toEqual(['tasks']);
    expect(writeScopes('INSERT OR REPLACE INTO general_settings (singleton,default_cwd) VALUES (1,?)')).toEqual(['settings']);
    expect(writeScopes('INSERT INTO tags(id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')).toEqual(['tags']);
    expect(writeScopes('DELETE FROM mcp_tool_operations WHERE key=?')).toEqual([]);
    expect(writeScopes('CREATE TABLE x (a TEXT REFERENCES tasks(id) ON UPDATE CASCADE)')).toEqual([]);
  });

  test('mutations report their scope and advance the revision; reads and writes that change no row stay silent', () => {
    const events = record();
    const start = store.revision;
    const task = store.createTask(input(), BASE);
    expect(events.scopes()).toEqual(['tasks']);
    expect(store.revision).toBeGreaterThan(start);
    const worker = store.createWorker({ name: 'Анна', provider: 'codex', model: null, effort: 'default', communicationStyle: '', avatarUrl: null } as never, BASE);
    expect(events.scopes()).toEqual(['workers']);
    store.createTag({ name: 'Срочно' } as never, BASE);
    expect(events.scopes()).toEqual(['tags']);
    store.updateGeneralSettings({ defaultSchedule: 'interval' });
    expect(events.scopes()).toEqual(['settings']);
    store.createInstruction({ title: 'Стиль', body: 'Кратко.', enabled: true }, BASE);
    expect(events.scopes()).toEqual(['instructions']);
    store.createDocPage({ parentId: null } as never, BASE);
    expect(events.scopes()).toEqual(['docs']);
    store.setAutopilot({ enabled: true, until: null }, BASE);
    expect(events.scopes()).toEqual(['autopilot']);
    const run = store.startManual(task.id, true, BASE);
    store.setRunProgress(run.id, { turn: run.turn, currentStepIndex: run.currentStepIndex, attemptId: null }, 'Чтение кода', BASE + 1);
    expect(events.scopes()).toContain('tasks');
    const revision = store.revision;
    store.listTasks();
    store.detail(task.id);
    store.listWorkers();
    store.autopilotOverview();
    store.db.query('UPDATE tasks SET title=? WHERE id=?').run('Missing', 'no-such-task');
    expect(store.revision).toBe(revision);
    expect(events.scopes()).toEqual([]);
    expect(worker.id).toBeString();
    events.stop();
    store.createTask(input(), BASE);
    expect(events.scopes()).toEqual([]);
  });

  test('a failing listener never rolls back the write that reported it', () => {
    const stop = store.onChange(() => { throw new Error('Listener failure'); });
    const error = console.error;
    console.error = () => {};
    try {
      const task = store.createTask(input(), BASE);
      expect(store.getTask(task.id).title).toBe('Inspect repository');
    } finally { console.error = error; stop(); }
  });

  test('each opened Store is a separate instance whose revision starts again', () => {
    store.createTask(input(), BASE);
    expect(store.revision).toBeGreaterThan(0);
    const other = new Store(join(folder, 'trackt.sqlite'));
    try {
      expect(other.instance).not.toBe(store.instance);
      expect(other.revision).toBe(0);
    } finally { other.close(); }
  });
});

describe('frozen turn time limits', () => {
  test('defaults are unlimited, task override wins, snapshots survive edits and reopening', () => {
    const inherited = store.createTask(input());
    const unlimited = store.startManual(inherited.id, true);
    expect(unlimited.timeLimitMinutes).toBeNull();
    store.finish(unlimited.id, 'failed', null, 'Synthetic failure');
    store.updateGeneralSettings({ agentTimeLimitMinutes: 5 });
    const run = store.startManual(inherited.id, true);
    const own = store.createTask(input({ timeLimitMinutes: 2 }));
    const ownRun = store.startManual(own.id, true);
    store.updateGeneralSettings({ agentTimeLimitMinutes: 10 });
    store.updateTask(own.id, { ...own, timeLimitMinutes: 3 });
    expect(store.getRun(run.id).timeLimitMinutes).toBe(5);
    expect(store.getRun(ownRun.id).timeLimitMinutes).toBe(2);
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    expect(store.getTask(own.id).timeLimitMinutes).toBe(3);
    expect(store.getRun(ownRun.id).timeLimitMinutes).toBe(2);
    expect(store.getRun(run.id).timeLimitMinutes).toBe(5);
  });

  test('answers and follow-ups snapshot current settings for each new turn', () => {
    store.updateGeneralSettings({ agentTimeLimitMinutes: 2 });
    const task = store.createTask(input());
    const first = store.startManual(task.id, true);
    store.setSession(first.id, 'saved-session');
    store.finish(first.id, 'waiting_input', 'Which?', null);
    store.updateGeneralSettings({ agentTimeLimitMinutes: 3 });
    expect(store.getRun(first.id).timeLimitMinutes).toBe(2);
    expect(store.resume(first.id, 'Answer').timeLimitMinutes).toBe(3);
    store.finish(first.id, 'completed', 'Done', null);
    store.updateTask(task.id, { ...task, timeLimitMinutes: 4 });
    const next = store.startFollowup(task.id, { sourceRunId: first.id, sourceStepIndex: null, body: 'More work', attachmentIds: [], requestId: 'timed-followup' }).run;
    expect(next).toMatchObject({ timeLimitMinutes: 4, sessionId: 'saved-session' });
    expect(store.getRun(first.id).timeLimitMinutes).toBe(3);
  });

  test('workflow transitions and retries snapshot the new turn limit', () => {
    const worker = store.createWorker({ name: 'Worker', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
    const task = store.createTask(input({ steps: [1, 2].map(n => ({ workerId: worker.id, title: `Step ${n}`, instruction: 'Work.' })) }));
    store.updateGeneralSettings({ agentTimeLimitMinutes: 2 });
    const run = store.startManual(task.id, true);
    store.updateGeneralSettings({ agentTimeLimitMinutes: 3 });
    expect(store.finish(run.id, 'completed', 'Done', null)).toMatchObject({ turn: 2, timeLimitMinutes: 3 });
    store.finish(run.id, 'failed', null, 'Failure');
    store.updateGeneralSettings({ agentTimeLimitMinutes: 4 });
    expect(store.retry(run.id)).toMatchObject({ turn: 3, timeLimitMinutes: 4 });
  });
});

test('a timed-out workflow stage resumes its saved session with a fresh deadline', () => {
  store.updateGeneralSettings({ agentTimeLimitMinutes: 1 });
  const worker = store.createWorker({ name: 'Worker', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null });
  const task = store.createTask(input({ steps: [1, 2].map(n => ({ workerId: worker.id, title: `Step ${n}`, instruction: 'Work.' })) }));
  const run = store.startManual(task.id, true);
  store.setSession(run.id, 'timeout-stage-session');
  store.finish(run.id, 'failed', null, 'Превышен лимит времени 1 мин; CLI остановлен');
  store.updateGeneralSettings({ agentTimeLimitMinutes: 2 });
  const resumed = store.resume(run.id, 'Continue');
  expect(resumed).toMatchObject({ status: 'running', sessionId: 'timeout-stage-session', turn: 2, timeLimitMinutes: 2 });
  expect(resumed.steps[0]).toMatchObject({ status: 'running', sessionId: 'timeout-stage-session' });
  expect(store.finish(run.id, 'completed', 'Done', null)).toMatchObject({ currentStepIndex: 1 });
});

describe('turn usage', () => {
  const DAY = 24 * 60 * MINUTE;
  const turn = (runId: string, patch: Partial<Parameters<Store['recordRunUsage']>[0]> = {}) => store.recordRunUsage({
    runId, turn: 1, stepIndex: null, attemptId: null, provider: 'claude', workerId: null, trigger: 'manual',
    usage: { inputTokens: 1_000, outputTokens: 200, cachedTokens: 600, costUsd: 0.1 }, durationMs: 60_000, startedAt: BASE, finishedAt: BASE + MINUTE, ...patch,
  });

  test('a run sums its turns; a token or cost sum stays null until some turn reports it', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    expect(store.getRun(run.id).usage).toBeUndefined();
    expect(turn(run.id, { usage: null, durationMs: 5_000 })).toBe(true);
    expect(store.getRun(run.id).usage).toEqual({ turns: 1, pricedTurns: 0, inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, durationMs: 5_000 });
    turn(run.id, { turn: 2, provider: 'codex', usage: { inputTokens: 3_000, outputTokens: 50, cachedTokens: null, costUsd: null }, durationMs: 10_000 });
    turn(run.id, { turn: 3, usage: { inputTokens: 1_000, outputTokens: 200, cachedTokens: 600, costUsd: 0.1 } });
    turn(run.id, { turn: 4, usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 0, costUsd: 0.2 } });
    expect(store.getRun(run.id).usage).toEqual({ turns: 4, pricedTurns: 2, inputTokens: 4_010, outputTokens: 270, cachedTokens: 600, costUsd: 0.3, durationMs: 135_000 });
    expect(store.turnUsage(run.id).map(entry => [entry.turn, entry.provider, entry.costUsd])).toEqual([[1, 'claude', null], [2, 'codex', null], [3, 'claude', 0.1], [4, 'claude', 0.2]]);
    // The board's list carries the sum only; the details also list every turn.
    expect(store.listTasks()[0]!.latestRun).toMatchObject({ usage: { turns: 4 } });
    expect(store.listTasks()[0]!.latestRun!.turnUsage).toBeUndefined();
    expect(store.detail(task.id).runs[0]!.turnUsage).toEqual(store.turnUsage(run.id));
  });

  test('implausible values are dropped, a missing run records nothing, and an invalid entry throws', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    turn(run.id, { usage: { inputTokens: -1, outputTokens: 1.5, cachedTokens: Number.NaN, costUsd: Number.POSITIVE_INFINITY }, durationMs: -20 });
    expect(store.turnUsage(run.id)[0]).toMatchObject({ inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, durationMs: 0 });
    expect(turn('missing-run')).toBe(false);
    expect(() => turn(run.id, { turn: 0 })).toThrow('Invalid turn usage record');
    expect(() => turn(run.id, { trigger: 'other' as never })).toThrow('Invalid turn usage record');
  });

  test('worker totals cover the last 30 days and all time, and survive deleting the task', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE);
    store.finish(run.id, 'completed', 'Done', null, BASE + 1);
    const now = BASE + 40 * DAY;
    turn(run.id, { workerId: 'worker-a', startedAt: BASE, finishedAt: BASE + MINUTE });
    turn(run.id, { turn: 2, workerId: 'worker-a', startedAt: now - DAY, finishedAt: now - DAY + MINUTE, usage: { inputTokens: 5, outputTokens: 5, cachedTokens: 0, costUsd: 0.05 } });
    turn(run.id, { turn: 3, workerId: 'worker-b', startedAt: BASE, finishedAt: BASE + MINUTE });
    turn(run.id, { turn: 4, workerId: null });
    const before = store.workerUsage(now);
    expect(before.recentSince).toBe(now - 30 * DAY);
    expect(before.workers.find(entry => entry.workerId === 'worker-a')).toMatchObject({ recent: { turns: 1, inputTokens: 5, costUsd: 0.05 }, total: { turns: 2, inputTokens: 1_005, costUsd: 0.15 } });
    expect(before.workers.find(entry => entry.workerId === 'worker-b')).toMatchObject({ recent: null, total: { turns: 1 } });
    expect(before.workers).toHaveLength(2);
    store.deleteTask(task.id);
    expect(store.workerUsage(now)).toEqual(before);
    expect(store.db.query('SELECT count(*) AS n FROM run_usage WHERE run_id IS NULL').get()).toEqual({ n: 4 });
  });

  test('an autopilot session sums the turns of its tasks that started before it stopped', () => {
    const auto = (title: string) => store.createTask(input({ title, schedule: 'auto' }), BASE);
    const first = auto('first'), second = auto('second'), other = store.createTask(input({ title: 'manual' }), BASE);
    expect(store.autopilotOverview().usage).toBeNull();
    const earlier = store.startManual(first.id, true, BASE - 10 * MINUTE);
    turn(earlier.id, { startedAt: BASE - 10 * MINUTE });
    store.finish(earlier.id, 'failed', null, 'Broken', BASE - 9 * MINUTE);
    store.setAutopilot({ enabled: true, until: null }, BASE);
    const runA = store.startAutopilot(first.id, true, BASE + 1)!;
    turn(runA.id, { trigger: 'autopilot', startedAt: BASE + 1, durationMs: 1_000 });
    store.finish(runA.id, 'completed', 'Done', null, BASE + 2);
    const runB = store.startAutopilot(second.id, true, BASE + 3)!;
    turn(runB.id, { trigger: 'autopilot', provider: 'codex', startedAt: BASE + 3, durationMs: 2_000, usage: { inputTokens: 50, outputTokens: 5, cachedTokens: 10, costUsd: null } });
    // A hand-back of a session task counts; unrelated work and earlier runs do not.
    store.setSession(runB.id, 'session-b');
    store.finish(runB.id, 'completed', 'Done', null, BASE + 4);
    const followup = store.startFollowup(second.id, { sourceRunId: runB.id, sourceStepIndex: null, body: 'One more check', attachmentIds: [], requestId: 'request-1' }).run;
    turn(followup.id, { trigger: 'followup', startedAt: BASE + 5 * MINUTE, durationMs: 4_000 });
    const manual = store.startManual(other.id, true, BASE + 5);
    turn(manual.id, { startedAt: BASE + 6, durationMs: 8_000 });
    expect(store.autopilotOverview().usage).toEqual({ turns: 3, pricedTurns: 2, inputTokens: 2_050, outputTokens: 405, cachedTokens: 1_210, costUsd: 0.2, durationMs: 7_000 });
    store.setAutopilot({ enabled: false, until: null }, BASE + 2 * MINUTE);
    expect(store.autopilotOverview().usage).toMatchObject({ turns: 2, durationMs: 3_000 });
  });

  test('the table comes from a recorded migration and is added to an older database on open', () => {
    expect(store.db.query("SELECT name FROM app_migrations WHERE name='run_usage_v1'").get()).toEqual({ name: 'run_usage_v1' });
    store.db.exec("DROP TABLE run_usage; DELETE FROM app_migrations WHERE name='run_usage_v1'");
    store.close();
    store = new Store(join(folder, 'trackt.sqlite'));
    const task = store.createTask(input(), BASE);
    expect(turn(store.startManual(task.id, true, BASE).id)).toBe(true);
    expect(store.db.query("SELECT name FROM app_migrations WHERE name='run_usage_v1'").get()).toEqual({ name: 'run_usage_v1' });
  });
});
