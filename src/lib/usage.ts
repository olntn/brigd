import { durationParts, formatCompactNumber, formatUsd } from './format';
import { localeTag, plural, t } from './i18n';
import type { Run, TokenUsage, TurnUsage } from './types';

/** One turn or a sum of turns: what the CLI reported and the duration brigd measured. */
type Measured = TokenUsage & { durationMs: number; turns?: number; pricedTurns?: number };

export function formatDuration(ms: number): string {
  const { hours, minutes, seconds } = durationParts(ms);
  if (hours) return minutes ? t('{hours} ч {minutes} мин', { hours, minutes }) : t('{hours} ч', { hours });
  return minutes ? t('{minutes} мин', { minutes }) : t('{seconds} сек.', { seconds });
}

/** «980 токенов», «12,3 тыс. токенов»: a shortened count takes the genitive plural in Russian. */
export function formatTokens(count: number): string {
  return `${formatCompactNumber(count, localeTag())} ${plural(count < 1000 ? count : 5, 'токен', 'токена', 'токенов')}`;
}

const tokenTotal = (usage: TokenUsage): number | null =>
  usage.inputTokens === null && usage.outputTokens === null ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

/** «12,3 тыс. токенов · $0,42 · 7 мин». Tokens and cost appear only when the CLI reported them; the duration always does. */
export function usageLine(usage: Measured): string {
  const tokens = tokenTotal(usage);
  return [tokens === null ? '' : formatTokens(tokens), usage.costUsd === null ? '' : formatUsd(usage.costUsd, localeTag()), formatDuration(usage.durationMs)]
    .filter(Boolean).join(' · ');
}

/** The breakdown behind usageLine for a tooltip, including what the CLI left out. */
export function usageDetails(usage: Measured): string {
  const count = (value: number) => formatCompactNumber(value, localeTag());
  const lines: string[] = [];
  if (usage.inputTokens !== null) {
    lines.push(usage.cachedTokens ? t('Входных токенов: {input}, из них из кэша: {cached}', { input: count(usage.inputTokens), cached: count(usage.cachedTokens) })
      : t('Входных токенов: {input}', { input: count(usage.inputTokens) }));
  }
  if (usage.outputTokens !== null) lines.push(t('Выходных токенов: {output}', { output: count(usage.outputTokens) }));
  if (tokenTotal(usage) === null) lines.push(t('CLI не сообщил токены.'));
  if (usage.costUsd === null) lines.push(t('Стоимость неизвестна: CLI её не сообщил. Codex стоимость не передаёт.'));
  else if (usage.turns !== undefined && usage.pricedTurns !== undefined && usage.pricedTurns < usage.turns) {
    lines.push(t('Стоимость сообщили не все ходы: {priced} из {turns}.', { priced: usage.pricedTurns, turns: usage.turns }));
  }
  lines.push(t('Длительность измеряет brigd: от запуска CLI до конца хода.'));
  return lines.join('\n');
}

/** «Ход 2», with the workflow step and its attempt when the turn belongs to one. */
export function turnLabel(run: Run, turn: TurnUsage): string {
  const label = t('Ход {turn}', { turn: turn.turn });
  if (turn.stepIndex === null) return label;
  const attempt = run.steps[turn.stepIndex]?.attempts.find(item => item.id === turn.attemptId)?.number;
  const step = t('Этап {number}', { number: turn.stepIndex + 1 });
  return attempt && attempt > 1 ? `${label} · ${step}, ${t('попытка {number}', { number: attempt })}` : `${label} · ${step}`;
}
