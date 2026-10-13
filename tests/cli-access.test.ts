import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInput, AgentOutcome } from '../server/adapter';
import { readConfig } from '../server/config';
import { Engine, type AgentFactory } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import type { Envelope, Provider, TaskInput } from '../src/lib/types';

const ORIGIN = 'http://127.0.0.1:4310';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
interface Invocation { input: AgentInput; resolve: (outcome: AgentOutcome) => void; reject: (error: Error) => void; }
let folder: string;
let store: Store;
let engine: Engine;
let calls: Invocation[];
const factory: AgentFactory = input => {
  let resolve!: Invocation['resolve'];
  let reject!: Invocation['reject'];
  const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
  calls.push({ input, resolve, reject });
  return { result, cancel: () => reject(new Error('Synthetic cancellation')) };
};
const taskInput = (patch: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Read repository', instruction: 'Inspect local files.', provider: 'codex', cwd: folder,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch,
});
const outcome = (status: Envelope['status'] = 'completed', sessionId = 'exact-session'): AgentOutcome => ({
  sessionId, envelope: { status, summary: 'Read repository.', questions: status === 'needs_input' ? ['Which file?'] : [] },
});
function request(method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
  return createHandler(engine, { port: 4310, root: folder, cliHome: folder })(new Request(`${ORIGIN}/api/settings/permissions`, {
    method, headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(value ?? {}),
  }));
}
function expectStatus(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected AppError'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).status).toBe(status); }
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-cli-access-'));
  store = new Store(join(folder, 'tasks.sqlite'));
  calls = [];
  // The injected factory and DirectWorkspaces never start a real provider.
  engine = new Engine(store, false, factory, undefined, { cliAccess: readConfig(folder, {}).cliAccess });
});
afterEach(async () => {
  for (const call of calls) call.reject(new Error('Test cleanup'));
  await flush();
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('persistent CLI access settings', () => {
  test('application defaults to full; saved standard overrides configured full after reopening', async () => {
    expect(store.getCliAccessMode()).toBeUndefined();
    expect(engine.getCliAccessSettings()).toEqual({ mode: 'full' });
    expect(engine.setCliAccessSettings({ mode: 'standard' })).toEqual({ mode: 'standard' });
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'tasks.sqlite'));
    engine = new Engine(store, false, factory, undefined, { cliAccess: 'full' });
    expect(store.getCliAccessMode()).toBe('standard');
    expect(engine.getCliAccessSettings()).toEqual({ mode: 'standard' });
    engine.setCliAccessSettings({ mode: 'full' });
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'tasks.sqlite'));
    engine = new Engine(store, false, factory, undefined, { cliAccess: 'standard' });
    expect(engine.getCliAccessSettings()).toEqual({ mode: 'full' });
  });

  test('configured standard remains available and direct Engine users retain the standard default', () => {
    engine = new Engine(store, false, factory, undefined, { cliAccess: readConfig(folder, { BRIGD_CLI_ACCESS: 'standard' }).cliAccess });
    expect(engine.getCliAccessSettings()).toEqual({ mode: 'standard' });
    expect(new Engine(store, false, factory).getCliAccessSettings()).toEqual({ mode: 'standard' });
    engine.setCliAccessSettings({ mode: 'full' });
    expect(engine.getCliAccessSettings()).toEqual({ mode: 'full' });
  });

  test('invalid settings fail without changing the stored value', () => {
    store.setCliAccessMode('standard');
    for (const value of [undefined, null, true, 1, '', 'unsafe', 'FULL', ' full ', {}, [], ['full']]) {
      expectStatus(() => store.setCliAccessMode(value), 400);
      expectStatus(() => engine.setCliAccessSettings({ mode: value }), 400);
      expect(store.getCliAccessMode()).toBe('standard');
    }
  });

  test('changes preserve sessions, worker profiles and frozen run snapshots', () => {
    const worker = store.createWorker({ name: 'Reader', provider: 'claude', effort: 'default', communicationStyle: '', avatarUrl: null });
    const task = store.createTask(taskInput({ provider: 'claude', workerId: worker.id }));
    const run = store.startManual(task.id, false);
    store.setSession(run.id, 'existing-session');
    const before = store.getRun(run.id);
    engine.setCliAccessSettings({ mode: 'standard' });
    engine.setCliAccessSettings({ mode: 'full' });
    expect(store.getRun(run.id)).toEqual(before);
    expect(store.getWorker(worker.id)).toEqual(worker);
    expect(calls).toHaveLength(0);
  });

  test('changing settings while stopping returns 503', async () => {
    await engine.shutdown();
    expectStatus(() => engine.setCliAccessSettings({ mode: 'standard' }), 503);
    expect(store.getCliAccessMode()).toBeUndefined();
  });
});

describe('CLI access settings HTTP contract', () => {
  test('GET returns the effective setting and PATCH saves both modes', async () => {
    expect(await (await request()).json()).toEqual({ mode: 'full' });
    for (const mode of ['standard', 'full'] as const) {
      const response = await request('PATCH', { mode });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode });
      expect(store.getCliAccessMode()).toBe(mode);
      expect(await (await request()).json()).toEqual({ mode });
    }
  });

  test('PATCH requires exactly one valid mode field', async () => {
    for (const value of [{}, { mode: null }, { mode: 'unsafe' }, { mode: 'full', extra: true }, { cliAccess: 'full' }, [], true]) {
      expect((await request('PATCH', value)).status).toBe(400);
      expect(store.getCliAccessMode()).toBeUndefined();
    }
  });

  test('PATCH keeps origin, host, fetch-site and content-type guards', async () => {
    const invalidHeaders: Record<string, string>[] = [{ origin: '' }, { origin: 'https://attacker.example' }, { host: 'attacker.example' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of invalidHeaders) {
      expect((await request('PATCH', { mode: 'full' }, headers)).status).toBe(403);
    }
    expect((await request('PATCH', { mode: 'full' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(store.getCliAccessMode()).toBeUndefined();
  });
});

describe('CLI access is resolved for every provider invocation', () => {
  test.each(['codex', 'claude'] as Provider[])('%s new turn uses full and resumed turns follow settings without losing the session', async provider => {
    const task = store.createTask(taskInput({ provider }));
    const run = engine.start(task.id);
    expect(calls[0]!.input).toMatchObject({ provider, cliAccess: 'full', mock: false });
    calls[0]!.resolve(outcome('needs_input'));
    await flush();
    engine.setCliAccessSettings({ mode: 'standard' });
    engine.resume(run.id, 'Read README.', false);
    expect(calls[1]!.input).toMatchObject({ provider, sessionId: 'exact-session', answer: 'Read README.' });
    expect(calls[1]!.input.cliAccess).toBeUndefined();
    calls[1]!.resolve(outcome('needs_input'));
    await flush();
    engine.setCliAccessSettings({ mode: 'full' });
    engine.resume(run.id, 'Continue.', false);
    expect(calls[2]!.input).toMatchObject({ provider, sessionId: 'exact-session', cliAccess: 'full' });
  });

  test.each(['codex', 'claude'] as Provider[])('%s follow-up uses the current full setting and exact source session', async provider => {
    engine.setCliAccessSettings({ mode: 'standard' });
    const task = store.createTask(taskInput({ provider }));
    const run = engine.start(task.id);
    expect(calls[0]!.input.cliAccess).toBeUndefined();
    calls[0]!.resolve(outcome());
    await flush();
    engine.setCliAccessSettings({ mode: 'full' });
    engine.followup(task.id, { sourceRunId: run.id, sourceStepIndex: null, body: 'Explain the result.', attachmentIds: [], requestId: crypto.randomUUID() });
    expect(calls[1]!.input).toMatchObject({ provider, sessionId: 'exact-session', cliAccess: 'full', followup: { sourceRunId: run.id } });
  });

  test('subsequent workflow stages resolve changed settings independently', async () => {
    const workers = (['codex', 'claude'] as Provider[]).map(provider => store.createWorker({
      name: provider, provider, effort: 'default', communicationStyle: '', avatarUrl: null,
    }));
    const task = store.createTask(taskInput({ steps: workers.map((worker, index) => ({ workerId: worker.id, title: `Stage ${index + 1}`, instruction: 'Read the files.' })) }));
    engine.start(task.id);
    expect(calls[0]!.input).toMatchObject({ provider: 'codex', cliAccess: 'full', workflow: { stepIndex: 0 } });
    engine.setCliAccessSettings({ mode: 'standard' });
    calls[0]!.resolve(outcome());
    await flush();
    expect(calls[1]!.input).toMatchObject({ provider: 'claude', workflow: { stepIndex: 1 } });
    expect(calls[1]!.input.cliAccess).toBeUndefined();
  });
});
