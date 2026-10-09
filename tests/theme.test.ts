import { afterEach, describe, expect, test } from 'bun:test';
import { legacyThemeStorageKey, readTheme, saveTheme, themeStorageKey } from '../src/lib/theme';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function storage(values: Record<string, string> = {}, writesFail = false) {
  const data = new Map(Object.entries(values));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { if (writesFail) throw new Error('Storage full'); data.set(key, value); },
    },
  });
  return data;
}

describe('brigd theme migration', () => {
  test.each(['light', 'dark'] as const)('copies legacy %s without removing it and is idempotent', theme => {
    const data = storage({ [legacyThemeStorageKey]: theme });
    expect(readTheme()).toBe(theme);
    expect(data.get(themeStorageKey)).toBe(theme);
    expect(data.get(legacyThemeStorageKey)).toBe(theme);
    expect(readTheme()).toBe(theme);
    expect(data.size).toBe(2);
  });

  test('a valid new preference wins and subsequent changes save to the new key', () => {
    const data = storage({ [legacyThemeStorageKey]: 'dark', [themeStorageKey]: 'light' });
    expect(readTheme()).toBe('light');
    expect(saveTheme('dark')).toBe(true);
    expect(readTheme()).toBe('dark');
    expect(saveTheme('light')).toBe(true);
    expect(data.get(legacyThemeStorageKey)).toBe('dark');
    expect(data.get(themeStorageKey)).toBe('light');
  });

  test('invalid or absent settings fall back to legacy, then light', () => {
    storage({ [themeStorageKey]: 'invalid', [legacyThemeStorageKey]: 'dark' });
    expect(readTheme()).toBe('dark');
    storage({ [themeStorageKey]: 'invalid', [legacyThemeStorageKey]: 'invalid' });
    expect(readTheme()).toBe('light');
    storage();
    expect(readTheme()).toBe('light');
  });

  test('a failed migration write does not lose a readable legacy theme', () => {
    const data = storage({ [legacyThemeStorageKey]: 'dark' }, true);
    expect(readTheme()).toBe('dark');
    expect(data.get(themeStorageKey)).toBeUndefined();
    expect(saveTheme('light')).toBe(false);
    expect(readTheme()).toBe('dark');
  });

  test('blocked storage access does not prevent startup', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
    expect(readTheme()).toBe('light');
    expect(saveTheme('dark')).toBe(false);
  });
});
