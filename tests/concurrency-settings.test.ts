import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { controlledAgent, outcome, repository, taskInput, until } from './repository-helpers';

const ORIGIN = 'http://127.0.0.1:4310';
const checks = [[process.execPath, '-e', 'process.exit(0)']];
let folder: string, store: Store, engine: Engine | undefined, agent: ReturnType<typeof controlledAgent>;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-concurrency-'));
  store = new Store(join(folder, 'data.sqlite'));
  agent = controlledAgent();
  engine = undefined;
});
afterEach(async () => {
  for (const call of agent.calls) call.reject(new Error('cleanup'));
  await engine?.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('concurrency settings', () => {
  test('limits persist across database opens; invalid writes leave them intact and null returns to the default', () => {
    expect(store.getConcurrencyLimits()).toEqual({ maxParallel: null, maxPerRepository: null });
    expect(store.setConcurrencyLimits({ maxPerRepository: 3 })).toEqual({ maxParallel: null, maxPerRepository: 3 });
    expect(store.setConcurrencyLimits({ maxParallel: 6 })).toEqual({ maxParallel: 6, maxPerRepository: 3 });
    for (const value of [{}, { other: 2 }, { maxParallel: 2, extra: true }, { maxParallel: 0 }, { maxParallel: 33 }, { maxPerRepository: 1.5 },
      { maxPerRepository: '2' }, { maxPerRepository: true }, { maxParallel: undefined }]) {
      expect(() => store.setConcurrencyLimits(value as Record<string, unknown>)).toThrow(AppError);
    }
    expect(store.getConcurrencyLimits()).toEqual({ maxParallel: 6, maxPerRepository: 3 });
    store.close();
    store = new Store(join(folder, 'data.sqlite'));
    expect(store.getConcurrencyLimits()).toEqual({ maxParallel: 6, maxPerRepository: 3 });
    expect(store.setConcurrencyLimits({ maxParallel: null })).toEqual({ maxParallel: null, maxPerRepository: 3 });
  });

  test('HTTP shows the effective limits, the saved values and the start-up defaults', async () => {
    engine = new Engine(store, true, undefined, undefined, { maxParallel: 3, maxPerRepository: 1 });
    const handler = createHandler(engine, { port: 4310, root: folder });
    const request = (method: string, value?: unknown) => handler(new Request(ORIGIN + '/api/settings/concurrency', {
      method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(value),
    }));
    const defaults = { maxParallel: 3, maxPerRepository: 1 };
    expect(await (await request('GET')).json()).toEqual({ ...defaults, saved: { maxParallel: null, maxPerRepository: null }, defaults });
    const saved = await request('PATCH', { maxPerRepository: 4 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ maxParallel: 3, maxPerRepository: 4, saved: { maxParallel: null, maxPerRepository: 4 }, defaults });
    for (const value of [{}, { maxPerRepository: 0 }, { maxParallel: 'many' }, { maxParallel: 2, unknown: 1 }]) {
      expect((await request('PATCH', value)).status).toBe(400);
    }
    expect(engine.getConcurrencySettings().maxPerRepository).toBe(4);
    expect(await (await request('PATCH', { maxParallel: null, maxPerRepository: null })).json()).toEqual({ ...defaults, saved: { maxParallel: null, maxPerRepository: null }, defaults });
  });

  test('a saved limit applies to waiting work without a restart and lowering it never stops running agents', async () => {
    const root = repository(folder);
    engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks, maxParallel: 4 });
    const first = engine.start(store.createTask(taskInput(root)).id);
    const second = engine.start(store.createTask(taskInput(root)).id);
    await until(() => agent.calls.length === 1);
    expect(store.getRun(second.id).status).toBe('queued');
    engine.setConcurrencySettings({ maxPerRepository: 3 });
    await until(() => agent.calls.length === 2);
    expect(store.getRun(second.id).status).toBe('running');
    expect(agent.calls[0]!.input.cwd).not.toBe(agent.calls[1]!.input.cwd);
    engine.setConcurrencySettings({ maxPerRepository: 1 });
    const third = engine.start(store.createTask(taskInput(root)).id);
    await Bun.sleep(40);
    expect([store.getRun(first.id).status, store.getRun(second.id).status, store.getRun(third.id).status]).toEqual(['running', 'running', 'queued']);
    agent.calls[0]!.resolve(outcome('first'));
    await until(() => store.integrationForRun(first.id)?.status === 'merged');
    // One agent of the repository is still working, which already fills the lowered limit.
    await Bun.sleep(40);
    expect(store.getRun(third.id).status).toBe('queued');
    agent.calls[1]!.resolve(outcome('second'));
    await until(() => agent.calls.length === 3);
    expect(store.getRun(third.id).status).toBe('running');
  });

  test('demo runs follow the per-repository limit, since they never write to the shared folder', async () => {
    engine = new Engine(store, true, agent.factory);
    engine.setConcurrencySettings({ maxPerRepository: 2 });
    const runs = [0, 1, 2].map(() => engine!.start(store.createTask(taskInput(folder)).id));
    await until(() => agent.calls.length === 2);
    await Bun.sleep(40);
    expect(runs.map(run => store.getRun(run.id).status)).toEqual(['running', 'running', 'queued']);
    agent.calls[0]!.resolve(outcome('mock-codex-first'));
    await until(() => agent.calls.length === 3);
    expect(store.getRun(runs[2]!.id).status).toBe('running');
  });

  test('the global limit counts merge checks, and the saved value wins over the start-up one', async () => {
    const one = repository(folder, 'one'), two = repository(folder, 'two');
    engine = new Engine(store, false, agent.factory, undefined, { workspaces: new GitWorkspaces(join(folder, 'workspaces')), integrationChecks: checks, maxParallel: 4 });
    engine.setConcurrencySettings({ maxParallel: 1 });
    const first = engine.start(store.createTask(taskInput(one)).id);
    const second = engine.start(store.createTask(taskInput(two)).id);
    await until(() => agent.calls.length === 1);
    await Bun.sleep(40);
    expect(store.getRun(second.id).status).toBe('queued');
    agent.calls[0]!.resolve(outcome('first'));
    await until(() => agent.calls.length === 2);
    // The merge check took the only place first; the other repository waited for it.
    expect(store.integrationForRun(first.id)!.status).toBe('merged');
    expect(store.getRun(second.id).status).toBe('running');
  });
});
