import { afterEach, describe, expect, test } from 'bun:test';
import { durationParts, formatCompactNumber, formatUsd } from '../src/lib/format';
import { setLocale } from '../src/lib/i18n';
import { formatDuration, turnLabel, usageDetails, usageLine } from '../src/lib/usage';
import type { Run, TurnUsage } from '../src/lib/types';

afterEach(() => setLocale('ru'));
// Intl keeps a number and its unit together with no-break spaces.
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('usage formatting', () => {
  test('numbers, dollars and durations follow the locale', () => {
    expect(formatCompactNumber(980, 'ru-RU')).toBe('980');
    expect(plain(formatCompactNumber(12_345, 'ru-RU'))).toBe('12,3 тыс.');
    expect(formatCompactNumber(4_200_000, 'en-US')).toBe('4.2M');
    expect(formatUsd(0.42, 'ru-RU')).toBe('$0,42');
    expect(formatUsd(1234.5, 'en-US')).toBe('$1,234.50');
    expect(formatUsd(0, 'en-US')).toBe('$0.00');
    expect(formatUsd(0.004, 'ru-RU')).toBe('<$0,01');
    expect(durationParts(800)).toEqual({ hours: 0, minutes: 0, seconds: 1 });
    expect(durationParts(7 * 60_000 + 20_000)).toEqual({ hours: 0, minutes: 7, seconds: 0 });
    expect(durationParts(2 * 3_600_000 + 5 * 60_000)).toEqual({ hours: 2, minutes: 5, seconds: 0 });
    expect(formatDuration(300)).toBe('0 сек.');
    expect(formatDuration(59_400)).toBe('59 сек.');
    expect(formatDuration(3_600_000)).toBe('1 ч');
  });

  test('the compact line shows only what the CLI reported, plus the measured time', () => {
    const claude = { inputTokens: 12_000, outputTokens: 345, cachedTokens: 9_000, costUsd: 0.42, durationMs: 7 * 60_000 };
    expect(plain(usageLine(claude))).toBe('12,3 тыс. токенов · $0,42 · 7 мин');
    expect(usageLine({ ...claude, inputTokens: 900, outputTokens: 1, costUsd: null })).toBe('901 токен · 7 мин');
    expect(usageLine({ inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null, durationMs: 90_000 })).toBe('2 мин');
    setLocale('en');
    expect(usageLine(claude)).toBe('12.3K tokens · $0.42 · 7 min');
    expect(usageDetails({ ...claude, costUsd: 0.42, turns: 3, pricedTurns: 1 })).toContain('Not every turn reported its cost: 1 of 3.');
    expect(usageDetails({ ...claude, costUsd: null })).toContain('Codex never reports cost.');
  });

  test('a turn names its workflow stage and a repeated attempt', () => {
    const turn = { turn: 3, stepIndex: 1, attemptId: 'attempt-2' } as TurnUsage;
    const run = { steps: [{ attempts: [] }, { attempts: [{ id: 'attempt-1', number: 1 }, { id: 'attempt-2', number: 2 }] }] } as unknown as Run;
    expect(turnLabel(run, turn)).toBe('Ход 3 · Этап 2, попытка 2');
    expect(turnLabel(run, { ...turn, attemptId: 'attempt-1' })).toBe('Ход 3 · Этап 2');
    expect(turnLabel(run, { ...turn, stepIndex: null, attemptId: null })).toBe('Ход 3');
  });
});
