<script lang="ts">
  import type { CheckTriage, Integration, IntegrationStatus, TriageCommand } from './types';
  import Icon from './Icon.svelte';
  import { formatSize, serverText, t, tk } from './i18n';
  import { CHECK_OUTPUT_LIMIT } from './integration-checks';
  import { CHECK_HANDBACK_LIMIT, passedOnRetry } from './check-triage';
  let { integration, busy = false, launchBlocked = false, historical = false, onaction }: {
    integration: Integration;
    busy?: boolean;
    launchBlocked?: boolean;
    historical?: boolean;
    onaction?: (action: 'integrate' | 'skip-integration' | 'cancel-integration' | 'reconcile', acknowledgement: boolean) => void;
  } = $props();
  let acknowledged = $state(false);
  let acknowledgementKey = $state('');
  const labels: Record<IntegrationStatus, string> = {
    awaiting_manual: tk('Ожидает ручного переноса'), skipped: tk('Перенос отложен'),
    queued: tk('Ожидает слияния'), checking: tk('Проверка объединённого кода'), merging: tk('Перенос проверенного результата'),
    cancelling: tk('Остановка проверки'), merged: tk('Изменения перенесены'), conflict: tk('Конфликт слияния'),
    failed: tk('Проверка не прошла'), blocked: tk('Перенос заблокирован'), interrupted: tk('Слияние прервано'), cancelled: tk('Слияние отменено'),
  };
  const active = $derived(['queued', 'checking', 'merging', 'cancelling'].includes(integration.status));
  const manual = $derived(['awaiting_manual', 'skipped'].includes(integration.status));
  const interrupted = $derived(integration.status === 'interrupted');
  /** The candidate folder exists only while its attempt is unfinished or kept for inspection; merged, rechecked and cancelled attempts drop it. */
  const candidateKept = $derived(['checking', 'merging', 'cancelling', 'interrupted', 'conflict', 'failed', 'blocked'].includes(integration.status));
  $effect(() => {
    const next = `${integration.id}:${integration.attempt}:${integration.status}`;
    if (next !== acknowledgementKey) { acknowledgementKey = next; acknowledged = false; }
  });
  type StageState = 'passed' | 'failed' | 'running' | 'skipped';
  const triage = $derived(integration.triage ?? null);
  const flaky = $derived(passedOnRetry(triage));
  const retryOf = (index: number) => triage?.retries.find(retry => retry.check === index);
  const commandLine = (argv: string[]) => argv.join(' ');
  const shortCommit = (commit: string) => commit.slice(0, 12);
  /** A command still running has no exit code; one without it after the triage ended was stopped. */
  const commandState = (command: Pick<TriageCommand, 'exitCode'>, running: boolean): StageState =>
    command.exitCode === 0 ? 'passed' : command.exitCode !== null ? 'failed' : running ? 'running' : 'skipped';
  function retryText(triage: CheckTriage, retry: CheckTriage['retries'][number]) {
    const number = retry.check + 1;
    if (retry.exitCode === 0) return t('Проверка {number}: прошла со второй попытки', { number });
    if (retry.exitCode !== null) return t('Проверка {number}: снова код {code}', { number, code: String(retry.exitCode) });
    return triage.stage === 'retry' ? t('Проверка {number}: повтор выполняется…', { number }) : t('Проверка {number}: повтор остановлен', { number });
  }
  function targetStage(triage: CheckTriage): { state: StageState; text: string } {
    const target = triage.target;
    if (!target) {
      if (triage.stage === 'retry') return { state: 'skipped', text: t('Ожидает итога повтора.') };
      return { state: 'skipped', text: triage.outcome === null ? t('Не понадобилась: проверка прошла со второй попытки.') : t('Не выполнялась.') };
    }
    const commit = shortCommit(target.commit);
    if (target.passed) return { state: 'passed', text: t('Проходит на коммите {commit}: ошибка в результате задачи.', { commit }) };
    const last = target.checks.at(-1);
    if (target.passed === false && last) return { state: 'failed', text: t('Не проходит на коммите {commit}: {command}, код {code}. Целевая ветка сломана, задача не возвращается.', { commit, command: commandLine(last.argv), code: String(last.exitCode) }) };
    if (triage.stage === 'target') return { state: 'running', text: t('Выполняется на коммите {commit}…', { commit }) };
    return { state: 'skipped', text: t('Остановлена на коммите {commit}.', { commit }) };
  }
  const handbackTexts: Record<NonNullable<CheckTriage['outcome']>, string> = {
    returned: tk('Отправлен в сохранённую сессию работника.'), limit: tk('Лимит исчерпан: нужно решение человека.'),
    no_session: tk('Не выполнен: нет сохранённой сессии работника.'), workflow: tk('Не выполнен: у задачи с этапами возврат только вручную.'),
    disabled: tk('Не выполнен: выключен в настройках.'), error: tk('Не выполнен: дополнительный запрос не создан.'),
    target_failed: tk('Не нужен: проверка не проходит и на целевой ветке.'), timeout: tk('Не выполнен: превышен лимит времени разбора.'),
    interrupted: tk('Не выполнен: разбор прерван перезапуском сервиса.'), stopped: tk('Не выполнен: слияние остановлено до решения.'),
  };
  function handbackStage(triage: CheckTriage): { state: StageState; text: string } {
    if (triage.outcome === 'returned') return { state: 'passed', text: t(handbackTexts.returned) };
    if (triage.outcome) return { state: triage.outcome === 'limit' || triage.outcome === 'no_session' || triage.outcome === 'error' ? 'failed' : 'skipped', text: t(handbackTexts[triage.outcome]) };
    if (triage.stage !== 'done') return { state: 'skipped', text: t('Ожидает итога проверки целевой ветки.') };
    return { state: 'skipped', text: triage.target?.passed ? t('Решение сохраняется…') : t('Не нужен: проверка прошла со второй попытки.') };
  }
  const stateLabels: Record<StageState, string> = { passed: tk('пройдено'), failed: tk('не пройдено'), running: tk('выполняется'), skipped: tk('пропущено') };
</script>

{#snippet output(item: { output?: string; outputTruncated?: boolean }, label: string)}
  {#if item.output}<details class="integration-output"><summary>{item.outputTruncated ? t('{label}: последние {size}', { label, size: formatSize(CHECK_OUTPUT_LIMIT) }) : label}</summary><pre>{item.output}</pre></details>{/if}
{/snippet}

<section class="integration-panel" aria-label={t('Слияние результата')}>
  <h3><Icon name={integration.status === 'merged' ? 'circlecheck' : active ? 'refresh' : 'alert'} size={17} />{t(labels[integration.status])}</h3>
  {#if integration.error}<p class="integration-error">{serverText(integration.error)}</p>{/if}
  {#if integration.conflicts?.length}<p>{t('Конфликтующие файлы:')}</p><ul class="integration-conflicts">{#each integration.conflicts as path}<li><code>{path}</code></li>{/each}</ul>{/if}
  {#if flaky}<div class="integration-flaky" role="note"><Icon name="alert" size={16} /><div><strong>{t('Проверка прошла со второй попытки')}</strong><p>{t('Повтор мог скрыть гонку, которую внесла сама задача. Сравните выводы обеих попыток.')}</p></div></div>{/if}
  {#if integration.checks.length}<ul class="integration-checks">{#each integration.checks as check, index}{@const retry = retryOf(index)}<li>{retry?.exitCode === 0 ? t('Проверка {number}: прошла со второй попытки', { number: index + 1 }) : check.exitCode === 0 ? t('Проверка {number}: пройдена', { number: index + 1 }) : t('Проверка {number}: код {code}', { number: index + 1, code: String(check.exitCode) })}<code>{check.argv.join(' ')}</code>{#if retry}{@render output(check, t('Вывод первой попытки'))}<p class="integration-retry">{retry.exitCode === 0 ? t('Повтор: пройдена') : retry.exitCode !== null ? t('Повтор: код {code}', { code: String(retry.exitCode) }) : triage?.stage === 'retry' ? t('Повтор выполняется…') : t('Повтор остановлен')}</p>{@render output(retry, t('Вывод повтора'))}{:else}{@render output(check, t('Вывод проверки'))}{/if}</li>{/each}</ul>{/if}
  {#if triage}
    {@const target = targetStage(triage)}
    {@const handback = handbackStage(triage)}
    <section class="integration-triage" aria-label={t('Разбор упавшей проверки')}>
      <h4>{t('Разбор упавшей проверки')}</h4>
      <ol class="triage-stages">
        {#each triage.retries as retry}{@const state = commandState(retry, triage.stage === 'retry')}<li class="triage-stage triage-{state}"><span class="triage-stage-title">{t('Повтор')}<span class="triage-state">{t(stateLabels[state])}</span></span><span>{retryText(triage, retry)}</span></li>{/each}
        <li class="triage-stage triage-{target.state}"><span class="triage-stage-title">{t('Проверка целевой ветки')}<span class="triage-state">{t(stateLabels[target.state])}</span></span><span>{target.text}</span>
          {#if triage.target?.checks.length}<ul class="integration-checks">{#each triage.target.checks as check}<li>{check.exitCode === 0 ? t('Пройдена') : check.exitCode !== null ? t('Код {code}', { code: String(check.exitCode) }) : triage.stage === 'target' ? t('Выполняется…') : t('Остановлена')}<code>{commandLine(check.argv)}</code>{@render output(check, t('Вывод на целевой ветке'))}</li>{/each}</ul>{/if}
        </li>
        <li class="triage-stage triage-{handback.state}"><span class="triage-stage-title">{t('Возврат работнику {returns} из {limit}', { returns: triage.handback?.returns ?? 0, limit: triage.handback?.limit ?? CHECK_HANDBACK_LIMIT })}<span class="triage-state">{t(stateLabels[handback.state])}</span></span><span>{handback.text}</span></li>
      </ol>
      <p class="integration-note">{t('Решения принимаются по кодам возврата, без модели. Повторы и проверка целевой ветки вместе длятся не дольше {minutes} мин.', { minutes: Math.round(triage.limitMs / 60_000) || 1 })}</p>
    </section>
  {/if}
  {#if manual}<p class="integration-note">{t('Результат сохранён в ветке запуска. Проверка и перенос начнутся по кнопке; «Не переносить» освобождает репозиторий и сохраняет ветку.')}</p>{#if integration.sourceCommit}<p>{t('Коммит результата:')} <code>{integration.sourceCommit.slice(0, 12)}</code></p>{/if}{/if}
  {#if integration.resultCommit}<p>{t('Коммит результата:')} <code>{integration.resultCommit.slice(0, 12)}</code></p>{/if}
  {#if integration.candidatePath && candidateKept}<details><summary>{t('Рабочая папка объединённого кода')}</summary><code class="integration-path">{integration.candidatePath}</code><p class="integration-note">{t('Папка остаётся до следующей попытки или очистки хранилища.')}</p></details>
  {:else if integration.status === 'merged'}<p class="integration-note">{t('После переноса brigd очищает ненужные рабочие папки и ветку запуска. Папки с подмодулями, используемые worktree и ветки с новыми коммитами сохраняются. История задачи остаётся.')}</p>
  {:else if integration.candidatePath}<p class="integration-note">{t('Кандидат удалён.')}</p>{/if}
  {#if !historical && onaction && integration.status !== 'merged'}
    {#if interrupted}<p>{t('После перезапуска процесс проверки мог остаться запущенным. Остановите его перед повтором или отменой.')}</p><label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledged} disabled={busy} /><span>{t('Я проверил(а), что предыдущие процессы проверки и слияния остановлены')}</span></label>{/if}
    <div class="integration-actions">
      {#if integration.status === 'conflict'}<button class="button primary" disabled={busy || launchBlocked} title={t('Встроенный Интегратор объединит целевую ветку с результатом в worktree задачи, разрешит конфликты и повторит проверку.')} onclick={() => onaction?.('reconcile', acknowledged)}>{t('Поручить интегратору')}</button>{/if}
      {#if !active}
        <button class="button {integration.status === 'conflict' ? 'secondary' : 'primary'}" disabled={busy || launchBlocked || (interrupted && !acknowledged)} onclick={() => onaction?.('integrate', acknowledged)}>{manual ? t('Проверить и перенести') : t('Повторить проверку и слияние')}</button>
        {#if integration.status === 'awaiting_manual'}<button class="button secondary" disabled={busy} onclick={() => onaction?.('skip-integration', false)}>{t('Не переносить')}</button>{/if}
      {/if}
      {#if active || interrupted}<button class="button secondary" disabled={busy || integration.status === 'cancelling' || (interrupted && !acknowledged)} onclick={() => onaction?.('cancel-integration', acknowledged)}>{integration.status === 'cancelling' ? t('Останавливаем…') : t('Отменить слияние')}</button>{/if}
    </div>
  {/if}
</section>
