import { afterEach, describe, expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { contextKey, DEFAULT_LOCALE, localeStorageKey, readLocale, saveLocale, translate, translateServer } from '../src/lib/i18n';
import { dictionaries, en } from '../src/lib/i18n/en';
import { INTEGRATOR_WORKER } from '../src/lib/workers';
import { callArguments, commentRanges, cyrillic, read, readLiteral, root, sourceFiles, translationKeys, untranslatedLines } from './i18n-scan';

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

const interfaceFiles = sourceFiles(join(root, 'src'), /\.(svelte|ts)$/).filter(path => !path.startsWith(join(root, 'src/lib/i18n/')));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

describe('interface language', () => {
  test('defaults to Russian and keeps a saved choice', () => {
    storage();
    expect(readLocale()).toBe(DEFAULT_LOCALE);
    expect(DEFAULT_LOCALE).toBe('ru');
    const data = storage({ [localeStorageKey]: 'en' });
    expect(readLocale()).toBe('en');
    expect(saveLocale('ru')).toBe(true);
    expect(data.get(localeStorageKey)).toBe('ru');
    storage({ [localeStorageKey]: 'de' });
    expect(readLocale()).toBe('ru');
  });

  test('reports a choice the browser refused to store', () => {
    storage({}, true);
    expect(saveLocale('en')).toBe(false);
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(readLocale()).toBe('ru');
  });

  test('translates with placeholders and falls back to the Russian text', () => {
    expect(translate('en', 'Язык')).toBe('Language');
    expect(translate('ru', 'Язык')).toBe('Язык');
    expect(translate('en', 'Текст без перевода {name}', { name: 'x' })).toBe('Текст без перевода x');
    expect(translate('ru', 'Файл {name}: {name}', { name: 'a.txt' })).toBe('Файл a.txt: a.txt');
    expect(translate('en', '{missing} остаётся', {})).toBe('{missing} остаётся');
  });

  test('leaves server text untouched in Russian and unknown text in English', () => {
    expect(translateServer('ru', 'Маршрут не найден')).toBe('Маршрут не найден');
    expect(translateServer('en', 'Agent wrote this')).toBe('Agent wrote this');
    expect(translateServer('en', '')).toBe('');
  });
});

describe('English dictionary', () => {
  test('has English values with the same placeholders as the Russian keys', () => {
    const problems = Object.entries(en).flatMap(([key, value]) => [
      ...(cyrillic.test(value) ? [`Russian left in the translation of «${key}»: ${value}`] : []),
      ...(placeholders(key).join() !== placeholders(value).join() ? [`Placeholders differ for «${key}»: ${value}`] : []),
      ...(!value.trim() ? [`Empty translation for «${key}»`] : []),
    ]);
    expect(problems).toEqual([]);
  });

  test('translates a text shared between areas the same way', () => {
    const seen = new Map<string, { area: string; value: string }>();
    const conflicts: string[] = [];
    for (const [area, dictionary] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dictionary)) {
        const previous = seen.get(key);
        if (previous && previous.value !== value) conflicts.push(`«${key}»: ${previous.area} → ${previous.value}; ${area} → ${value}`);
        else seen.set(key, { area, value });
      }
    }
    expect(conflicts).toEqual([]);
  });

  test('covers every literal passed to t(), tk(), tc() and plural()', () => {
    const missing = interfaceFiles.flatMap(path => translationKeys(read(path), relative(root, path), contextKey).keys)
      .filter(use => cyrillic.test(use.key) && en[use.key] === undefined && en[use.key.split('::').slice(1).join('::')] === undefined)
      .map(use => `${use.file}:${use.line} ${use.key}`);
    expect(missing).toEqual([]);
  });

  test('leaves no Russian interface text outside translation calls', () => {
    const leftovers = interfaceFiles.flatMap(path => {
      const source = read(path);
      const { ranges } = translationKeys(source, path, contextKey);
      return untranslatedLines(source, [...ranges, ...commentRanges(source)]).map(line => `${relative(root, path)}:${line.line} ${line.text}`);
    });
    expect(leftovers).toEqual([]);
  });
});

// Agent-facing MCP servers answer in Russian; everything else can reach the interface.
const agentOnly = new Set(['mcp.ts', 'mcp-reading.ts', 'task-mcp.ts', 'task-mcp-app.ts', 'task-mcp-app-protocol.ts', 'task-mcp-protocol.ts', 'task-mcp-stdio.ts']);

/** Russian literals that form an AppError message; embedded values become `1`. */
function appErrorMessages(source: string): string[] {
  const messages: string[] = [];
  for (const match of source.matchAll(/new AppError\(/g)) {
    const { args } = callArguments(source, match.index! + match[0].length);
    const [from, to] = args[0] ?? [0, 0];
    for (let index = from; index < to; index++) {
      const literal = readLiteral(source, index, '1');
      if (!literal) continue;
      if (cyrillic.test(literal.value)) messages.push(literal.value);
      index = literal.end - 1;
    }
  }
  return messages;
}

describe('server messages in English', () => {
  test('translates configurable timeout errors', () => {
    expect(translateServer('en', 'Превышен лимит времени 5 мин; CLI остановлен')).toBe('The time limit of 5 min was exceeded; CLI stopped');
    expect(translateServer('en', 'Превышен лимит времени проверки слияния 1 мин; команда остановлена. Целевая ветка сохранена.')).toBe('The merge check time limit of 1 min was exceeded; command stopped. Target branch preserved.');
  });
  test('cover every API error the interface can show', () => {
    const files = sourceFiles(join(root, 'server'), /\.ts$/).filter(path => !agentOnly.has(relative(join(root, 'server'), path)));
    const untranslated = files.flatMap(path => appErrorMessages(read(path)).map(message => ({ file: relative(root, path), message })))
      .filter(({ message }) => cyrillic.test(translateServer('en', message)))
      .map(({ file, message }) => `${file}: ${message}`);
    expect(untranslated).toEqual([]);
  });
});

describe('built-in worker labels', () => {
  test('the Integrator name and description have English', () => {
    expect(translate('en', INTEGRATOR_WORKER.name)).toBe('Integrator');
    expect(cyrillic.test(translate('en', INTEGRATOR_WORKER.description))).toBe(false);
  });
});
