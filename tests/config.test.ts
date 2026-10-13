import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { readConfig } from '../server/config';

const root = '/workspace/.trackt';
const settings = {
  MODE: 'mock', DB: '/existing/tasks.sqlite', HOST: '0.0.0.0',
  ALLOWED_HOSTS: '127.0.0.1:4310, localhost:4310',
  ALLOWED_ORIGINS: 'http://127.0.0.1:4310, http://localhost:4310',
  DEFAULT_CWD: '/workspace', DEV: '1',
};
const prefixed = (prefix: string, values = settings) => Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}_${key}`, value]));

describe('brigd configuration compatibility', () => {
  test('defaults preserve existing database path and port', () => {
    const config = readConfig(root, {});
    expect(config).toMatchObject({ mode: 'cli', cliAccess: 'full', port: 4310, hostname: '127.0.0.1', dbPath: resolve(root, 'data/trackt.sqlite'), dev: false });
    expect(config.defaultCwd).toBeUndefined();
    expect(readConfig(root, { BRIGD_MODE: 'mock' }).dbPath).toBe(resolve(root, 'data/demo.sqlite'));
    expect(readConfig(root, { TRACKT_MODE: 'mock' }).dbPath).toBe(resolve(root, 'data/demo.sqlite'));
    expect(config.updateBackupDir).toBe(resolve(root, '.brigd-updates/backup'));
  });

  test('updater backup storage resolves against the installation and accepts the managed child path', () => {
    const original = '/original/brigd/.brigd-updates/backup';
    expect(readConfig('/original/brigd/.brigd-updates/releases/version', { BRIGD_UPDATE_BACKUP_DIR: original }).updateBackupDir).toBe(original);
    expect(readConfig(root, { TRACKT_UPDATE_BACKUP_DIR: 'old', BRIGD_UPDATE_BACKUP_DIR: 'new' }).updateBackupDir).toBe(resolve(root, 'new'));
  });

  test('CLI access supports both prefixes and validates the explicit new value', () => {
    for (const prefix of ['BRIGD', 'TRACKT']) {
      for (const mode of ['standard', 'full'] as const) expect(readConfig(root, { [`${prefix}_CLI_ACCESS`]: mode }).cliAccess).toBe(mode);
      for (const value of ['', 'unsafe', 'FULL', ' full ']) expect(() => readConfig(root, { [`${prefix}_CLI_ACCESS`]: value })).toThrow('CLI_ACCESS');
    }
    expect(readConfig(root, { TRACKT_CLI_ACCESS: 'standard', BRIGD_CLI_ACCESS: 'full' }).cliAccess).toBe('full');
    expect(() => readConfig(root, { TRACKT_CLI_ACCESS: 'full', BRIGD_CLI_ACCESS: '' })).toThrow('CLI_ACCESS');
  });

  test('old launch commands and new aliases produce identical configuration', () => {
    const legacy = readConfig(root, prefixed('TRACKT'));
    expect(readConfig(root, prefixed('BRIGD'))).toEqual(legacy);
    expect(legacy).toMatchObject({ mode: 'mock', dbPath: '/existing/tasks.sqlite', defaultCwd: '/workspace', dev: true });
    expect(legacy.allowedHosts).toEqual(['127.0.0.1:4310', 'localhost:4310']);
    expect(legacy.allowedOrigins).toEqual(['http://127.0.0.1:4310', 'http://localhost:4310']);
  });

  test('new aliases win per setting when both prefixes are supplied', () => {
    const old = prefixed('TRACKT', { ...settings, MODE: 'cli', DB: '/old.sqlite', HOST: '127.0.0.1', ALLOWED_HOSTS: 'old.test', ALLOWED_ORIGINS: 'http://old.test', DEFAULT_CWD: '/old', DEV: '0' });
    expect(readConfig(root, { ...old, ...prefixed('BRIGD'), PORT: '4320' })).toEqual({ ...readConfig(root, prefixed('BRIGD')), port: 4320 });
    expect(readConfig(root, { TRACKT_DB: 'data/existing.sqlite', BRIGD_MODE: 'mock' }).dbPath).toBe(resolve(root, 'data/existing.sqlite'));
  });

  for (const prefix of ['BRIGD', 'TRACKT']) {
    test(`${prefix} configuration keeps validation and network safeguards`, () => {
      expect(() => readConfig(root, { [`${prefix}_MODE`]: '' })).toThrow('MODE');
      expect(() => readConfig(root, { [`${prefix}_HOST`]: '192.168.1.10' })).toThrow('HOST');
      expect(() => readConfig(root, { [`${prefix}_HOST`]: '0.0.0.0' })).toThrow('ALLOWED_HOSTS');
      expect(() => readConfig(root, { [`${prefix}_ALLOWED_HOSTS`]: '*.example.com' })).toThrow('ALLOWED_HOSTS');
      expect(() => readConfig(root, { [`${prefix}_ALLOWED_ORIGINS`]: 'https://example.com/path' })).toThrow('ALLOWED_ORIGINS');
      expect(() => readConfig(root, { PORT: '80' })).toThrow('PORT');
    });
  }

  test('an invalid new value is not hidden by a valid legacy value', () => {
    expect(() => readConfig(root, { TRACKT_MODE: 'mock', BRIGD_MODE: '' })).toThrow('MODE');
    expect(() => readConfig(root, { TRACKT_HOST: '127.0.0.1', BRIGD_HOST: 'invalid' })).toThrow('HOST');
    expect(() => readConfig(root, { ...prefixed('TRACKT'), BRIGD_ALLOWED_HOSTS: '' })).toThrow();
  });
  test('workspace storage and total process limit support both configuration prefixes', () => {
    expect(readConfig(root, {})).toMatchObject({ workspacesDir: resolve(root, 'data/workspaces'), maxParallel: 4 });
    expect(readConfig(root, { TRACKT_WORKSPACES_DIR: '/tmp/old', BRIGD_WORKSPACES_DIR: '/tmp/new', TRACKT_MAX_PARALLEL: '2' }))
      .toMatchObject({ workspacesDir: '/tmp/new', maxParallel: 2 });
    for (const value of ['0', '33', '1.5', 'NaN', '']) expect(() => readConfig(root, { BRIGD_MAX_PARALLEL: value })).toThrow('MAX_PARALLEL');
  });
  test('per-repository concurrency and explicit argv checks are validated without shell parsing', () => {
    expect(readConfig(root, {})).toMatchObject({ maxPerRepository: 1 });
    const checks = [['bun', 'test', '--timeout', '10000'], ['bun', 'run', 'build']];
    expect(readConfig(root, { TRACKT_MAX_PER_REPOSITORY: '2', BRIGD_INTEGRATION_CHECKS: JSON.stringify(checks) }))
      .toMatchObject({ maxPerRepository: 2, integrationChecks: checks });
    for (const value of ['0', '33', '1.5', 'NaN', '']) expect(() => readConfig(root, { BRIGD_MAX_PER_REPOSITORY: value })).toThrow('MAX_PER_REPOSITORY');
    for (const value of ['no json', '[]', '["bun test"]', '[[]]', '[["bun",null]]', '[["bun",""]]', '[["bun","\\u0000"]]']) {
      expect(() => readConfig(root, { BRIGD_INTEGRATION_CHECKS: value })).toThrow('INTEGRATION_CHECKS');
    }
  });
});
