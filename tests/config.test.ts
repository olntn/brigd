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
    expect(config).toMatchObject({ mode: 'cli', port: 4310, hostname: '127.0.0.1', dbPath: resolve(root, 'data/trackt.sqlite'), dev: false });
    expect(config.defaultCwd).toBeUndefined();
    expect(readConfig(root, { BRIGD_MODE: 'mock' }).dbPath).toBe(resolve(root, 'data/demo.sqlite'));
    expect(readConfig(root, { TRACKT_MODE: 'mock' }).dbPath).toBe(resolve(root, 'data/demo.sqlite'));
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
});
