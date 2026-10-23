import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAttachment } from '../server/attachments';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import type { TaskInput, WorkerInput } from '../src/lib/types';

const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = 1_700_000_000_000;
const input = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Inspect repository', instruction: 'Review the local code and report findings.',
  provider: 'codex', cwd: '/tmp', schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const workerInput = (patch: Partial<WorkerInput> = {}): WorkerInput => ({
  name: 'Ada', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null, ...patch,
});
const expectAppError = (action: () => unknown, status: number, text?: string) => {
  try { action(); throw new Error('Expected an AppError'); }
  catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(status);
    if (text) expect((error as AppError).message).toContain(text);
  }
};
const stage = async (body: string) => store.stageAttachment(await prepareAttachment(Buffer.from(body), 'text/plain', `${body}.txt`), BASE);

let folder: string;
let store: Store;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-deletion-'));
  store = new Store(join(folder, 'data.sqlite'));
});
afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });

/** A finished card with every kind of history: run, session, follow-up, comments, logs, files, tags and a worktree record. */
async function populated(title: string) {
  const tag = store.createTag({ name: `${title} tag` }, BASE);
  const file = await stage(`${title}-task`);
  const task = store.createTask(input({ title, tagIds: [tag.id], attachmentIds: [file.id] }), BASE);
  const run = store.startManual(task.id, true, BASE + 1);
  store.setSession(run.id, `${title}-session`);
  store.log(task.id, run.id, { kind: 'command', summary: 'Run tests', details: ['bun test'] }, BASE + 2);
  const path = `/tmp/brigd-deletion/${run.id}`;
  store.db.query('INSERT INTO workspaces (id,snapshot) VALUES (?,?)').run(run.id, JSON.stringify({ id: run.id, repositoryId: '/tmp/brigd-deletion/.git', projectCwd: '/tmp',
    repositoryRoot: '/tmp', path, cwd: path, branch: null, baseCommit: null, targetBranch: null, mode: 'direct', prepared: true }));
  store.db.query('UPDATE runs SET workspace_id=? WHERE id=?').run(run.id, run.id);
  store.db.query("INSERT INTO run_code_diffs(run_id,baseline,result) VALUES (?,NULL,'{}')").run(run.id);
  store.finish(run.id, 'completed', 'Done', null, BASE + 3);
  const note = await stage(`${title}-note`);
  store.comment(task.id, null, 'user', 'Note with a file', BASE + 4, undefined, [note.id]);
  const followup = store.startFollowup(task.id, { sourceRunId: run.id, sourceStepIndex: null, body: 'Continue', attachmentIds: [], requestId: crypto.randomUUID() }, BASE + 5).run;
  store.finish(followup.id, 'completed', 'Done again', null, BASE + 6);
  return { task, run, followup, tag };
}
const rows = (sql: string, ...params: string[]) => (store.db.query(sql).get(...params) as { n: number }).n;
function leftovers(taskId: string, runIds: string[]) {
  const runs = runIds.map(id => `'${id}'`).join(',');
  return {
    tasks: rows('SELECT count(*) AS n FROM tasks WHERE id=?', taskId),
    runs: rows('SELECT count(*) AS n FROM runs WHERE task_id=?', taskId),
    comments: rows('SELECT count(*) AS n FROM comments WHERE task_id=?', taskId),
    logs: rows('SELECT count(*) AS n FROM task_logs WHERE task_id=?', taskId),
    attachments: rows('SELECT count(*) AS n FROM attachments WHERE task_id=?', taskId),
    taskLinks: rows('SELECT count(*) AS n FROM task_attachment_links WHERE task_id=?', taskId),
    tags: rows('SELECT count(*) AS n FROM task_tags WHERE task_id=?', taskId),
    followups: rows('SELECT count(*) AS n FROM followup_requests WHERE task_id=?', taskId),
    inputs: rows(`SELECT count(*) AS n FROM run_attachment_inputs WHERE run_id IN (${runs})`),
    diffs: rows(`SELECT count(*) AS n FROM run_code_diffs WHERE run_id IN (${runs})`),
    executions: rows(`SELECT count(*) AS n FROM execution_requests WHERE run_id IN (${runs})`),
  };
}
const nothing = { tasks: 0, runs: 0, comments: 0, logs: 0, attachments: 0, taskLinks: 0, tags: 0, followups: 0, inputs: 0, diffs: 0, executions: 0 };

describe('task deletion', () => {
  test('removes a card with its whole history and leaves other cards, tags and worktree records alone', async () => {
    const doomed = await populated('Doomed');
    const kept = await populated('Kept');
    const before = store.detail(kept.task.id);
    const page = store.createDocPage({ title: 'Links' }, BASE);
    store.saveDocPage(page.id, { title: 'Links', version: page.version, blocks: [{ id: 'b1', type: 'task', text: '', taskId: doomed.task.id }] } as never, BASE + 1);

    store.deleteTask(doomed.task.id);

    expect(leftovers(doomed.task.id, [doomed.run.id, doomed.followup.id])).toEqual(nothing);
    expectAppError(() => store.getTask(doomed.task.id), 404);
    expectAppError(() => store.getRun(doomed.run.id), 404);
    expect(store.listTasks().map(task => task.id)).toEqual([kept.task.id]);
    expect(store.detail(kept.task.id)).toEqual(before);
    expect(store.listTags().map(tag => tag.id).sort()).toEqual([doomed.tag.id, kept.tag.id].sort());
    // Storage clean-up still recognises the deleted card's folder through its record.
    expect(store.workspaceRecord(doomed.run.id)).toMatchObject({ taskId: null, runs: [] });
    expect(store.getDocPage(page.id).blocks[0]).toMatchObject({ type: 'task', taskId: doomed.task.id });
    expectAppError(() => store.deleteTask(doomed.task.id), 404);
  });

  test('a card with an active run is kept until the run is settled', () => {
    const task = store.createTask(input(), BASE);
    const run = store.startManual(task.id, true, BASE + 1);
    expectAppError(() => store.deleteTask(task.id), 409, 'завершите или отмените');
    expect(store.getTask(task.id).runCount).toBe(1);
    store.finish(run.id, 'failed', null, 'Broken', BASE + 2);
    store.deleteTask(task.id);
    expect(store.listTasks()).toEqual([]);
  });

  test('clearing the archive deletes only cards archived up to the shown moment', async () => {
    const first = await populated('First');
    const second = store.createTask(input({ title: 'Second' }), BASE);
    const later = store.createTask(input({ title: 'Archived later' }), BASE);
    const active = store.createTask(input({ title: 'On the board' }), BASE);
    const busy = store.createTask(input({ title: 'Busy elsewhere' }), BASE);
    store.archiveTask(first.task.id, BASE + 10);
    store.archiveTask(second.id, BASE + 20);
    store.archiveTask(busy.id, BASE + 20);
    store.archiveTask(later.id, BASE + 30);

    expect(store.deleteArchivedTasks(BASE + 20, [busy.id])).toEqual({ deleted: 2, skipped: 1 });
    expect(store.listTasks().map(task => task.title).sort()).toEqual(['Archived later', 'Busy elsewhere', 'On the board']);
    expect(leftovers(first.task.id, [first.run.id, first.followup.id])).toEqual(nothing);
    expect(store.getTask(active.id).archivedAt).toBeNull();
    expect(store.deleteArchivedTasks(BASE + 30)).toEqual({ deleted: 2, skipped: 0 });
    expect(store.listTasks().map(task => task.title)).toEqual(['On the board']);
    expect(store.deleteArchivedTasks(BASE + 30)).toEqual({ deleted: 0, skipped: 0 });
  });
});

describe('worker deletion', () => {
  test('an unused profile disappears and every choice that pointed at it is cleared', () => {
    const doomed = store.createWorker(workerInput({ name: 'Doomed', provider: 'claude' }), BASE);
    const other = store.createWorker(workerInput({ name: 'Other', fallbackWorkerId: doomed.id }), BASE);
    store.updateGeneralSettings({ defaultWorkerId: doomed.id, fallbackWorkers: { claude: doomed.id, codex: other.id } });

    store.deleteWorker(doomed.id);

    expect(rows('SELECT count(*) AS n FROM workers WHERE id=?', doomed.id)).toBe(0);
    expect(store.listWorkers().map(worker => worker.id)).toEqual([other.id]);
    expect(store.getWorker(other.id).fallbackWorkerId).toBeNull();
    expect(store.getDefaultWorkerId()).toBeNull();
    expect(store.getFallbackWorkers()).toEqual({ codex: other.id, claude: null });
    expectAppError(() => store.getWorker(doomed.id), 404);
    expectAppError(() => store.deleteWorker(doomed.id), 404);
  });

  test('a profile still named on a card, active or archived, single or as a stage, must be replaced first', () => {
    const worker = store.createWorker(workerInput({ name: 'Assigned' }), BASE);
    const helper = store.createWorker(workerInput({ name: 'Helper' }), BASE);
    const single = store.createTask(input({ workerId: worker.id }), BASE);
    const staged = store.createTask(input({ steps: [{ workerId: helper.id, title: 'One', instruction: 'Do one' }, { workerId: worker.id, title: 'Two', instruction: 'Do two' }] }), BASE);
    store.archiveTask(staged.id, BASE + 1);
    expectAppError(() => store.deleteWorker(worker.id), 409, 'назначен в задачах: 2, из них в архиве: 1');
    store.updateTask(single.id, input({ workerId: helper.id }));
    expectAppError(() => store.deleteWorker(worker.id), 409, 'назначен в задачах: 1, из них в архиве: 1');
    store.deleteTask(staged.id);
    store.deleteWorker(worker.id);
    expect(store.listWorkers().map(item => item.name)).toEqual(['Helper']);
  });

  test('a profile with run history stays hidden behind its snapshots until that history is deleted', () => {
    const worker = store.createWorker(workerInput({ name: 'Veteran' }), BASE);
    const replacement = store.createWorker(workerInput({ name: 'Replacement' }), BASE);
    const task = store.createTask(input({ workerId: worker.id }), BASE);
    const run = store.startManual(task.id, true, BASE + 1);
    store.setSession(run.id, 'veteran-session');
    store.finish(run.id, 'completed', 'Done', null, BASE + 2);
    store.updateTask(task.id, input({ workerId: replacement.id }));

    store.deleteWorker(worker.id);

    expect(store.listWorkers().map(item => item.name)).toEqual(['Replacement']);
    expectAppError(() => store.getWorker(worker.id), 404);
    expectAppError(() => store.createTask(input({ workerId: worker.id })), 404);
    expectAppError(() => store.updateGeneralSettings({ defaultWorkerId: worker.id }), 404);
    expect(store.getRun(run.id)).toMatchObject({ workerId: worker.id, worker: { id: worker.id, name: 'Veteran' } });
    // The saved session can still be continued under the snapshot it was started with.
    const followup = store.startFollowup(task.id, { sourceRunId: run.id, sourceStepIndex: null, body: 'Continue', attachmentIds: [], requestId: crypto.randomUUID() }, BASE + 3).run;
    expect(followup.worker).toMatchObject({ id: worker.id, name: 'Veteran' });
    store.finish(followup.id, 'completed', 'Done again', null, BASE + 4);
    expect(rows('SELECT count(*) AS n FROM workers WHERE id=?', worker.id)).toBe(1);

    store.deleteTask(task.id);
    expect(rows('SELECT count(*) AS n FROM workers WHERE id=?', worker.id)).toBe(0);
    expect(store.listWorkers().map(item => item.name)).toEqual(['Replacement']);
  });

  test('reopening an older database adds the column without hiding anyone', () => {
    const worker = store.createWorker(workerInput(), BASE);
    store.db.exec('ALTER TABLE workers DROP COLUMN deleted_at');
    store.close();
    store = new Store(join(folder, 'data.sqlite'));
    expect(store.listWorkers().map(item => item.id)).toEqual([worker.id]);
  });
});

describe('deletion over HTTP', () => {
  let engine: Engine;
  let handler: ReturnType<typeof createHandler>;
  beforeEach(() => {
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: PORT, root: folder });
  });
  afterEach(async () => { await engine.shutdown(); });
  const request = (path: string, method = 'POST', value: unknown = {}) => handler(new Request(ORIGIN + path, {
    method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(value),
  }));

  test('cards, the archive and workers are deleted through their purge routes', async () => {
    const card = store.createTask(input({ title: 'Single' }), BASE);
    expect(await (await request(`/api/tasks/${card.id}/purge`)).json()).toEqual({ ok: true });
    expect((await request(`/api/tasks/${card.id}/purge`)).status).toBe(404);

    const archived = store.createTask(input({ title: 'Archived' }), BASE);
    const fresh = store.createTask(input({ title: 'Fresh' }), BASE);
    store.archiveTask(archived.id, BASE + 1);
    for (const value of [{}, { archivedBefore: 0 }, { archivedBefore: 'now' }, { archivedBefore: 1.5 }, { archivedBefore: BASE, extra: true }]) {
      expect((await request('/api/archive/purge', 'POST', value)).status).toBe(400);
    }
    expect(await (await request('/api/archive/purge', 'POST', { archivedBefore: BASE + 1 })).json()).toEqual({ deleted: 1, skipped: 0 });
    expect(store.listTasks().map(task => task.id)).toEqual([fresh.id]);

    const worker = store.createWorker(workerInput(), BASE);
    expect(await (await request(`/api/workers/${worker.id}/purge`)).json()).toEqual({ ok: true });
    expect((await request(`/api/workers/${worker.id}`, 'GET')).status).toBe(404);
    expect(await (await request('/api/workers', 'GET')).json()).toEqual([]);
  });

  test('a running card is refused with a clear message', async () => {
    const card = store.createTask(input(), BASE);
    engine.start(card.id);
    const response = await request(`/api/tasks/${card.id}/purge`);
    expect(response.status).toBe(409);
    expect(store.getTask(card.id).runCount).toBe(1);
  });
});
