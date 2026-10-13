import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { GitIntegrator } from '../server/integration';
import { AppError, Store } from '../server/store';
import { GitWorkspaces } from '../server/workspaces';
import { parseIntegrationChecks, validateIntegrationChecks } from '../src/lib/integration-checks';
import type { Integration } from '../src/lib/types';
import { git, repository, taskInput } from './repository-helpers';

const ORIGIN = 'http://127.0.0.1:4310';
const checks = [['bun', 'run', 'verify']];
let folder: string, store: Store, engine: Engine | undefined;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-autopilot-settings-'));
  store = new Store(join(folder, 'settings.sqlite'));
  engine = undefined;
});
afterEach(async () => {
  await engine?.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('integration check settings', () => {
  test('validation preserves literal arguments and returns an independent copy', () => {
    const value = [['bun', 'test', '--test-name-pattern', 'name with spaces; $literal']];
    const validated = validateIntegrationChecks(value);
    expect(validated).toEqual(value);
    value[0]![0] = 'changed';
    expect(validated[0]![0]).toBe('bun');
    expect(parseIntegrationChecks(JSON.stringify(checks))).toEqual(checks);
    expect(() => parseIntegrationChecks('')).toThrow('BRIGD_INTEGRATION_CHECKS');
    expect(() => parseIntegrationChecks('bun test')).toThrow('BRIGD_INTEGRATION_CHECKS');
  });

  test('validation applies command, argument and total JSON limits', () => {
    const invalid: unknown[] = [null, {}, [], ['bun test'], [[]], [[null]], [['']], [['a\0b']],
      Array.from({ length: 11 }, () => ['bun']), [Array.from({ length: 31 }, () => 'x')],
      [['x'.repeat(4097)]], [Array.from({ length: 8 }, () => 'x'.repeat(4096))], new Array(1), [new Array(1)]];
    for (const value of invalid) expect(() => validateIntegrationChecks(value)).toThrow('BRIGD_INTEGRATION_CHECKS');
    expect(validateIntegrationChecks(Array.from({ length: 10 }, () => ['bun']))).toHaveLength(10);
    expect(validateIntegrationChecks([Array.from({ length: 30 }, () => 'x')])[0]).toHaveLength(30);
    expect(validateIntegrationChecks([['x'.repeat(4096)]])[0]?.[0]).toHaveLength(4096);
  });

  test('commands persist across database opens, invalid writes leave them intact and null clears them', () => {
    expect(store.getIntegrationChecks()).toBeNull();
    store.setIntegrationChecks(checks);
    expect(() => store.setIntegrationChecks([])).toThrow(AppError);
    expect(store.getIntegrationChecks()).toEqual(checks);
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    expect(store.getIntegrationChecks()).toEqual(checks);
    const read = store.getIntegrationChecks()!;
    read[0]![0] = 'changed';
    expect(store.getIntegrationChecks()).toEqual(checks);
    store.setIntegrationChecks(null);
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    expect(store.getIntegrationChecks()).toBeNull();
  });

  test('corrupted stored commands produce an actionable error', () => {
    store.db.query('UPDATE autopilot_settings SET integration_checks=? WHERE singleton=1').run('[]');
    expect(() => store.getIntegrationChecks()).toThrow('настройках → Автопилот');
    store.setIntegrationChecks(checks);
    expect(store.getIntegrationChecks()).toEqual(checks);
  });

  test('HTTP settings show their source, override the environment and can reset to it', async () => {
    engine = new Engine(store, true, undefined, undefined, { integrationChecks: checks });
    const handler = createHandler(engine, { port: 4310, root: folder });
    const request = (method: string, value?: unknown) => handler(new Request(ORIGIN + '/api/settings/autopilot', {
      method, headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(value),
    }));
    expect(await (await request('GET')).json()).toEqual({ integrationChecks: checks, source: 'environment' });
    const saved = [['npm', 'run', 'check']];
    const response = await request('PATCH', { integrationChecks: saved });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ integrationChecks: saved, source: 'settings' });
    for (const value of [{}, { checks: saved }, { integrationChecks: saved, extra: true }, { integrationChecks: [] }, { integrationChecks: 'bun test' }]) {
      expect((await request('PATCH', value)).status).toBe(400);
      expect(store.getIntegrationChecks()).toEqual(saved);
    }
    expect(await (await request('PATCH', { integrationChecks: null })).json()).toEqual({ integrationChecks: checks, source: 'environment' });
    expect(store.getIntegrationChecks()).toBeNull();
  });

  test('HTTP accepts valid Unicode arguments within the shared character limit', async () => {
    engine = new Engine(store, true);
    const handler = createHandler(engine, { port: 4310, root: folder });
    const commands = Array.from({ length: 4 }, () => ['bun', ...Array.from({ length: 4 }, () => 'я'.repeat(1400))]);
    const response = await handler(new Request(ORIGIN + '/api/settings/autopilot', {
      method: 'PATCH', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ integrationChecks: commands }),
    }));
    expect(response.status).toBe(200);
    expect(store.getIntegrationChecks()).toEqual(commands);
  });

  test('HTTP returns an unconfigured state after clearing the only value', async () => {
    store.setIntegrationChecks(checks);
    engine = new Engine(store, true);
    const handler = createHandler(engine, { port: 4310, root: folder });
    const response = await handler(new Request(ORIGIN + '/api/settings/autopilot', {
      method: 'PATCH', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ integrationChecks: null }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ integrationChecks: null, source: null });
  });

  test('new workspace plans read current settings while saved plans keep their commands', () => {
    const root = repository(folder);
    let current = checks;
    const workspaces = new GitWorkspaces(join(folder, 'workspaces'), () => current);
    const first = store.startManual(store.createTask(taskInput(root)).id, false);
    const firstPlan = workspaces.plan(first, workspaces.locate(first));
    current = [['npm', 'run', 'check']];
    const second = store.startManual(store.createTask(taskInput(root)).id, false);
    expect(workspaces.plan(second, workspaces.locate(second)).checkCommands).toEqual(current);
    expect(workspaces.plan({ ...first, workspace: firstPlan }, workspaces.locate(first)).checkCommands).toEqual(checks);
  });

  test('the integrator reads changed commands on the next attempt without restarting', async () => {
    const root = repository(folder);
    const failing = [[process.execPath, '-e', 'process.exit(7)']];
    const passing = [[process.execPath, '-e', 'process.exit(0)']];
    const workspaces = new GitWorkspaces(join(folder, 'workspaces'), failing);
    const run = store.startManual(store.createTask(taskInput(root)).id, false);
    run.workspace = workspaces.plan(run, workspaces.locate(run));
    await workspaces.prepare(run.workspace);
    writeFileSync(join(run.workspace.path, 'src/value.txt'), 'saved result\n');
    const target = git(root, 'rev-parse', 'HEAD');
    let current = failing;
    const integrator = new GitIntegrator(() => current);
    const job: Integration = { id: crypto.randomUUID(), runId: run.id, repositoryId: run.workspace.repositoryId,
      status: 'checking', attempt: 1, sourceCommit: null, targetCommit: null, resultCommit: null, candidatePath: null,
      checks: [], error: null, updatedAt: Date.now() };
    const first = await integrator.execute(run, job, new AbortController().signal, () => {});
    expect(first.status).toBe('failed');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
    current = passing;
    const next = await integrator.execute(run, { ...job, attempt: 2 }, new AbortController().signal, () => {});
    expect(next.status).toBe('merged');
    expect(next.checks).toEqual([{ argv: passing[0], exitCode: 0 }]);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(next.resultCommit!);
  });
});
