import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
    expect(await (await request()).json()).toEqual({ defaultCwd: process.cwd() });
    expect(await (await request('/api/info')).json()).toMatchObject({ cwd: process.cwd() });

    handler = createHandler(engine, { port: 4310, root: folder, defaultCwd: folder });
    expect(await (await request()).json()).toEqual({ defaultCwd: folder });
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
    expect(await (await request()).json()).toEqual({ defaultCwd: cwd });
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
    expect(await saved.json()).toEqual({ defaultCwd: cwd });
    expect(await (await request()).json()).toEqual({ defaultCwd: cwd });
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

  test('PATCH requires exactly the defaultCwd field in a JSON object', async () => {
    store.setDefaultCwd(folder);
    for (const value of [{}, { cwd: folder }, { defaultCwd: folder, extra: true }, null, [], folder]) {
      const response = await request('/api/settings/general', 'PATCH', value);
      expect(response.status).toBe(400);
      expect(store.getDefaultCwd()).toBe(realpathSync(folder));
    }
  });
});
