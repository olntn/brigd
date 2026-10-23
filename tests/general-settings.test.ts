import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine';
import { createHandler } from '../server/http';
import { AppError, Store } from '../server/store';

const ORIGIN = 'http://127.0.0.1:4310';
let folder: string, store: Store, engine: Engine;
let handler: ReturnType<typeof createHandler>;

function request(path = '/api/settings/general', method = 'GET', value?: unknown) {
  return handler(new Request(ORIGIN + path, {
    method, headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(value),
  }));
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'brigd-general-settings-'));
  store = new Store(join(folder, 'settings.sqlite'));
  engine = new Engine(store, true);
  handler = createHandler(engine, { port: 4310, root: folder });
});

afterEach(async () => {
  await engine.shutdown();
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('general settings', () => {
  test('the effective default folder falls back to configured cwd, then process cwd', async () => {
    expect(store.getDefaultCwd()).toBeNull();
    expect(store.getDefaultSchedule()).toBe('manual');
    expect(await (await request()).json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: process.cwd(), defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd: process.cwd() });

    handler = createHandler(engine, { port: 4310, root: folder, defaultCwd: folder });
    expect(await (await request()).json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: folder, defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd: folder });
  });

  test('a trimmed canonical directory persists after reopening the database', async () => {
    const project = join(folder, 'проект с пробелами');
    const alias = join(folder, 'project-link');
    mkdirSync(project);
    symlinkSync(project, alias, 'dir');
    const cwd = realpathSync(project);
    expect(store.setDefaultCwd(`  ${alias}  `)).toBe(cwd);
    expect(store.getDefaultCwd()).toBe(cwd);

    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: 4310, root: folder, defaultCwd: folder });
    expect(store.getDefaultCwd()).toBe(cwd);
    expect(await (await request()).json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: cwd, defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd });
  });

  test('saving immediately updates settings and api info without changing existing tasks', async () => {
    handler = createHandler(engine, { port: 4310, root: folder, defaultCwd: folder });
    const task = store.createTask({ title: 'Existing task', instruction: 'Review code.', provider: 'codex',
      cwd: folder, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false });
    const project = join(folder, 'next-project');
    mkdirSync(project);
    const cwd = realpathSync(project);

    const saved = await request('/api/settings/general', 'PATCH', { defaultCwd: ` ${project} ` });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: cwd, defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request()).json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: cwd, defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd });
    expect(store.getTask(task.id).cwd).toBe(folder);

    const missingCwd = await request('/api/tasks', 'POST', { ...task, cwd: undefined });
    expect(missingCwd.status).toBe(400);
    expect(store.listTasks()).toHaveLength(1);
  });

  test('invalid folder values leave the stored directory intact', async () => {
    store.setDefaultCwd(folder);
    const file = join(folder, 'file.txt');
    writeFileSync(file, 'not a directory');
    const invalid = [null, 12, true, {}, [], '', '   ', '.', 'relative/folder', '/'.repeat(4_097),
      `${folder}\0`, join(folder, 'missing'), file];
    for (const value of invalid) {
      expect(() => store.setDefaultCwd(value)).toThrow(AppError);
      const response = await request('/api/settings/general', 'PATCH', { defaultCwd: value });
      expect(response.status).toBe(400);
      expect(store.getDefaultCwd()).toBe(realpathSync(folder));
    }
  });

  test('PATCH requires a nonempty subset of supported settings in a JSON object', async () => {
    store.setDefaultCwd(folder);
    for (const value of [{}, { cwd: folder }, { defaultCwd: folder, extra: true }, { defaultSchedule: 'auto', extra: true }, null, [], folder]) {
      const response = await request('/api/settings/general', 'PATCH', value);
      expect(response.status).toBe(400);
      expect(store.getDefaultCwd()).toBe(realpathSync(folder));
      expect(store.getDefaultSchedule()).toBe('manual');
    }
  });

  test.each(['auto', 'manual', 'interval'] as const)('the %s default launch type persists after reopening', async schedule => {
    const saved = await request('/api/settings/general', 'PATCH', { defaultSchedule: schedule });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: process.cwd(), defaultSchedule: schedule, defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
    expect(store.getDefaultSchedule()).toBe(schedule);
    expect(store.getDefaultCwd()).toBeNull();

    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: 4310, root: folder });
    expect(store.getDefaultSchedule()).toBe(schedule);
    expect(await (await request()).json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: process.cwd(), defaultSchedule: schedule, defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
  });

  test('the daily schedule is not a default launch type: its time is chosen per card', async () => {
    store.setDefaultSchedule('interval');
    const response = await request('/api/settings/general', 'PATCH', { defaultSchedule: 'daily' });
    expect(response.status).toBe(400);
    expect(store.getDefaultSchedule()).toBe('interval');
    expect(() => store.db.exec("UPDATE general_settings SET default_schedule='daily' WHERE singleton=1")).toThrow();
  });

  test('partial writes preserve the other setting and combined writes save both', async () => {
    const project = join(folder, 'next-project');
    mkdirSync(project);
    const cwd = realpathSync(project);
    store.setDefaultCwd(folder);

    const scheduleOnly = await request('/api/settings/general', 'PATCH', { defaultSchedule: 'auto' });
    expect(scheduleOnly.status).toBe(200);
    expect(await scheduleOnly.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: realpathSync(folder), defaultSchedule: 'auto', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });

    const cwdOnly = await request('/api/settings/general', 'PATCH', { defaultCwd: project });
    expect(cwdOnly.status).toBe(200);
    expect(await cwdOnly.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: cwd, defaultSchedule: 'auto', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });

    const combined = await request('/api/settings/general', 'PATCH', { defaultCwd: folder, defaultSchedule: 'interval' });
    expect(combined.status).toBe(200);
    expect(await combined.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: realpathSync(folder), defaultSchedule: 'interval', defaultWorkerId: null, fallbackWorkers: { codex: null, claude: null } });
  });

  test('invalid launch types leave both settings intact, including combined patches', async () => {
    store.setDefaultCwd(folder);
    store.setDefaultSchedule('interval');
    const project = join(folder, 'next-project');
    mkdirSync(project);
    for (const value of [null, 12, true, {}, [], '', ' ', 'Auto', ' auto ', 'schedule', 'unknown']) {
      expect(() => store.setDefaultSchedule(value)).toThrow(AppError);
      for (const patch of [{ defaultSchedule: value }, { defaultCwd: project, defaultSchedule: value }]) {
        const response = await request('/api/settings/general', 'PATCH', patch);
        expect(response.status).toBe(400);
        expect(store.getDefaultCwd()).toBe(realpathSync(folder));
        expect(store.getDefaultSchedule()).toBe('interval');
      }
    }

    const invalidCwd = await request('/api/settings/general', 'PATCH', { defaultCwd: join(folder, 'missing'), defaultSchedule: 'auto' });
    expect(invalidCwd.status).toBe(400);
    expect(store.getDefaultCwd()).toBe(realpathSync(folder));
    expect(store.getDefaultSchedule()).toBe('interval');
  });

  test('the launch default does not change existing tasks or task API validation', async () => {
    const task = store.createTask({ title: 'Existing task', instruction: 'Review code.', provider: 'codex',
      cwd: folder, schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false });
    const saved = await request('/api/settings/general', 'PATCH', { defaultSchedule: 'auto' });
    expect(saved.status).toBe(200);
    expect(store.getTask(task.id).schedule).toBe('manual');
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd: process.cwd() });

    for (const schedule of [undefined, 'invalid']) {
      const invalidTask = await request('/api/tasks', 'POST', { ...task, schedule });
      expect(invalidTask.status).toBe(400);
    }
    expect(store.listTasks()).toHaveLength(1);
  });

  test('additive migration preserves the saved folder and is idempotent', () => {
    const path = join(folder, 'legacy.sqlite');
    const cwd = realpathSync(folder);
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE general_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), default_cwd TEXT)');
    legacy.query('INSERT INTO general_settings (singleton,default_cwd) VALUES (1,?)').run(cwd);
    legacy.close();

    for (let pass = 0; pass < 2; pass++) {
      const migrated = new Store(path);
      try {
        expect(migrated.getDefaultCwd()).toBe(cwd);
        expect(migrated.getDefaultSchedule()).toBe(pass === 0 ? 'manual' : 'auto');
        expect((migrated.db.query('PRAGMA table_info(general_settings)').all() as { name: string; notnull: number; dflt_value: string }[])
          .filter(column => column.name === 'default_schedule')).toEqual([
            expect.objectContaining({ name: 'default_schedule', notnull: 1, dflt_value: "'manual'" }),
          ]);
        expect(() => migrated.db.query('UPDATE general_settings SET default_schedule=? WHERE singleton=1').run('invalid')).toThrow();
        migrated.setDefaultSchedule('auto');
      } finally { migrated.close(); }
    }
  });
});

describe('replacement workers for exhausted limits', () => {
  const profile = (name: string, provider: 'codex' | 'claude') => store.createWorker({ name, provider, effort: 'default', communicationStyle: '', avatarUrl: null });
  test('per-provider replacements are validated, partially updatable and persisted', async () => {
    const claude = profile('Opus', 'claude');
    const codex = profile('Sol', 'codex');
    expect(store.getFallbackWorkers()).toEqual({ codex: null, claude: null });
    const saved = await request('/api/settings/general', 'PATCH', { fallbackWorkers: { codex: claude.id } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: process.cwd(), defaultSchedule: 'manual', defaultWorkerId: null, fallbackWorkers: { codex: claude.id, claude: null } });
    const both = await request('/api/settings/general', 'PATCH', { defaultSchedule: 'auto', fallbackWorkers: { claude: codex.id } });
    expect(both.status).toBe(200);
    expect(await both.json()).toMatchObject({ defaultSchedule: 'auto', fallbackWorkers: { codex: claude.id, claude: codex.id } });
    for (const value of [null, [], {}, 'x', 12, { openai: codex.id }, { codex: 12 }, { codex: 'bad id!' }, { codex: '' }, { codex: codex.id, extra: true }]) {
      const response = await request('/api/settings/general', 'PATCH', { fallbackWorkers: value });
      expect(response.status).toBe(400);
    }
    expect((await request('/api/settings/general', 'PATCH', { fallbackWorkers: { codex: 'missing-worker' } })).status).toBe(404);
    store.archiveWorker(codex.id);
    expect((await request('/api/settings/general', 'PATCH', { fallbackWorkers: { codex: codex.id } })).status).toBe(409);
    expect(store.getFallbackWorkers()).toEqual({ codex: claude.id, claude: codex.id });
    // The archived saved choice survives unrelated writes; a failed combined patch changes nothing.
    expect(await (await request('/api/settings/general', 'PATCH', { defaultSchedule: 'manual' })).json()).toMatchObject({ defaultSchedule: 'manual', fallbackWorkers: { codex: claude.id, claude: codex.id } });
    expect((await request('/api/settings/general', 'PATCH', { defaultSchedule: 'interval', fallbackWorkers: { codex: 'missing-worker' } })).status).toBe(404);
    expect(store.getDefaultSchedule()).toBe('manual');
    expect(store.getFallbackWorkers()).toEqual({ codex: claude.id, claude: codex.id });

    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: 4310, root: folder });
    expect(store.getFallbackWorkers()).toEqual({ codex: claude.id, claude: codex.id });
    expect(await (await request()).json()).toMatchObject({ fallbackWorkers: { codex: claude.id, claude: codex.id } });
    expect(await (await request('/api/settings/general', 'PATCH', { fallbackWorkers: { codex: null, claude: null } })).json()).toMatchObject({ fallbackWorkers: { codex: null, claude: null } });
    expect(store.getFallbackWorkers()).toEqual({ codex: null, claude: null });
  });
});

describe('default worker for new cards', () => {
  const profile = (name: string, provider: 'codex' | 'claude') => store.createWorker({ name, provider, effort: 'default', communicationStyle: '', avatarUrl: null });
  test('an active worker is validated, kept across other writes and persisted; null clears it', async () => {
    const sol = profile('Sol', 'codex');
    const opus = profile('Opus', 'claude');
    expect(store.getDefaultWorkerId()).toBeNull();
    const saved = await request('/api/settings/general', 'PATCH', { defaultWorkerId: sol.id });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null, defaultCwd: process.cwd(), defaultSchedule: 'manual', defaultWorkerId: sol.id, fallbackWorkers: { codex: null, claude: null } });
    expect(await (await request('/api/settings/general', 'PATCH', { defaultSchedule: 'auto', fallbackWorkers: { codex: opus.id } })).json())
      .toMatchObject({ defaultSchedule: 'auto', defaultWorkerId: sol.id, fallbackWorkers: { codex: opus.id } });

    for (const value of [12, true, {}, [], '', 'bad id!', 'x'.repeat(101)]) {
      expect((await request('/api/settings/general', 'PATCH', { defaultWorkerId: value })).status).toBe(400);
    }
    expect((await request('/api/settings/general', 'PATCH', { defaultWorkerId: 'missing-worker' })).status).toBe(404);
    // A failed combined patch changes nothing.
    expect((await request('/api/settings/general', 'PATCH', { defaultSchedule: 'interval', defaultWorkerId: 'missing-worker' })).status).toBe(404);
    expect(store.getDefaultSchedule()).toBe('auto');
    expect(store.getDefaultWorkerId()).toBe(sol.id);

    // A newly archived profile cannot become the default; the saved one survives archiving and unrelated writes.
    store.archiveWorker(opus.id);
    expect((await request('/api/settings/general', 'PATCH', { defaultWorkerId: opus.id })).status).toBe(409);
    store.archiveWorker(sol.id);
    expect(store.getDefaultWorkerId()).toBe(sol.id);
    expect((await request('/api/settings/general', 'PATCH', { defaultWorkerId: sol.id, defaultSchedule: 'manual' })).status).toBe(200);
    expect(store.getDefaultWorkerId()).toBe(sol.id);

    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: 4310, root: folder });
    expect(await (await request()).json()).toMatchObject({ defaultSchedule: 'manual', defaultWorkerId: sol.id });
    expect(await (await request('/api/settings/general', 'PATCH', { defaultWorkerId: null })).json()).toMatchObject({ defaultWorkerId: null });
    expect(store.getDefaultWorkerId()).toBeNull();
  });

  test('the default only prefills the form: existing cards and API-created cards keep their own worker', async () => {
    const sol = profile('Sol', 'codex');
    const input = { title: 'Existing task', instruction: 'Review code.', provider: 'claude' as const,
      cwd: folder, schedule: 'manual' as const, intervalMinutes: null, firstRunAt: null, paused: false };
    const task = store.createTask(input);
    expect((await request('/api/settings/general', 'PATCH', { defaultWorkerId: sol.id })).status).toBe(200);
    expect(store.getTask(task.id).workerId).toBeNull();
    const created = await request('/api/tasks', 'POST', { ...input, title: 'API task' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ title: 'API task', provider: 'claude', workerId: null });
  });

  test('the column is added to a legacy settings table and the migration is idempotent', () => {
    const path = join(folder, 'legacy-worker.sqlite');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE general_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), default_cwd TEXT)');
    legacy.query('INSERT INTO general_settings (singleton,default_cwd) VALUES (1,NULL)').run();
    legacy.close();
    let id = '';
    for (let pass = 0; pass < 2; pass++) {
      const migrated = new Store(path);
      try {
        expect(migrated.getDefaultWorkerId()).toBe(pass === 0 ? null : id);
        if (!pass) {
          id = migrated.createWorker({ name: 'Sol', provider: 'codex', effort: 'default', communicationStyle: '', avatarUrl: null }).id;
          migrated.updateGeneralSettings({ defaultWorkerId: id });
        }
      } finally { migrated.close(); }
    }
  });
});

describe('time limit settings', () => {
  test('both limits persist, accept inclusive boundaries and can be cleared independently', async () => {
    expect(store.getTimeLimits()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: null });
    expect((await request('/api/settings/general', 'PATCH', { agentTimeLimitMinutes: 1, integrationCheckTimeLimitMinutes: 1440 })).status).toBe(200);
    await engine.shutdown();
    store.close();
    store = new Store(join(folder, 'settings.sqlite'));
    engine = new Engine(store, true);
    handler = createHandler(engine, { port: 4310, root: folder });
    expect(await (await request()).json()).toMatchObject({ agentTimeLimitMinutes: 1, integrationCheckTimeLimitMinutes: 1440 });
    expect((await request('/api/settings/general', 'PATCH', { agentTimeLimitMinutes: null })).status).toBe(200);
    expect(store.getTimeLimits()).toEqual({ agentTimeLimitMinutes: null, integrationCheckTimeLimitMinutes: 1440 });
    expect((await request('/api/settings/general', 'PATCH', { integrationCheckTimeLimitMinutes: null })).status).toBe(200);
  });

  test.each(['agentTimeLimitMinutes', 'integrationCheckTimeLimitMinutes'])('%s rejects invalid limits atomically', async field => {
    store.updateGeneralSettings({ agentTimeLimitMinutes: 5, integrationCheckTimeLimitMinutes: 6 });
    for (const value of [0, -1, 1441, 1.5, '1', '', true, [], {}]) {
      const result = await request('/api/settings/general', 'PATCH', { defaultSchedule: 'auto', [field]: value });
      expect(result.status).toBe(400);
      expect(store.getDefaultSchedule()).toBe('manual');
      expect(store.getTimeLimits()).toEqual({ agentTimeLimitMinutes: 5, integrationCheckTimeLimitMinutes: 6 });
    }
  });

  test('task API validates boundaries and distinguishes inheritance from an omitted update', async () => {
    const taskInput = { title: 'Timed', instruction: 'Work.', provider: 'codex', cwd: folder, schedule: 'manual', paused: false };
    for (const timeLimitMinutes of [0, -1, 1441, 1.5, '1', '', true, [], {}]) {
      expect((await request('/api/tasks', 'POST', { ...taskInput, timeLimitMinutes })).status).toBe(400);
    }
    for (const timeLimitMinutes of [null, 1, 1440]) {
      const created = await request('/api/tasks', 'POST', { ...taskInput, timeLimitMinutes });
      expect(created.status).toBe(201);
      const task = await created.json();
      expect(task.timeLimitMinutes).toBe(timeLimitMinutes);
      expect(await (await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Edited' })).json()).toMatchObject({ timeLimitMinutes });
      expect(await (await request(`/api/tasks/${task.id}`, 'PATCH', { timeLimitMinutes: null })).json()).toMatchObject({ timeLimitMinutes: null });
    }
  });
});
