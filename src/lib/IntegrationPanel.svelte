<script lang="ts">
  import type { Integration, IntegrationStatus } from './types';
  import Icon from './Icon.svelte';
  import { formatSize, serverText, t, tk } from './i18n';
  import { CHECK_OUTPUT_LIMIT } from './integration-checks';
  let { integration, busy = false, launchBlocked = false, historical = false, onaction }: {
    integration: Integration;
    busy?: boolean;
    launchBlocked?: boolean;
    historical?: boolean;
    onaction?: (action: 'integrate' | 'cancel-integration' | 'reconcile', acknowledgement: boolean) => void;
  } = $props();
  let acknowledged = $state(false);
  let acknowledgementKey = $state('');
  const labels: Record<IntegrationStatus, string> = {
    queued: tk('Ожидает слияния'), checking: tk('Проверка объединённого кода'), merging: tk('Перенос проверенного результата'),
    cancelling: tk('Остановка проверки'), merged: tk('Изменения перенесены'), conflict: tk('Конфликт слияния'),
    failed: tk('Проверка не прошла'), blocked: tk('Перенос заблокирован'), interrupted: tk('Слияние прервано'), cancelled: tk('Слияние отменено'),
  };
  const active = $derived(['queued', 'checking', 'merging', 'cancelling'].includes(integration.status));
  const interrupted = $derived(integration.status === 'interrupted');
  /** The candidate folder exists only while its attempt is unfinished or kept for inspection; merged, rechecked and cancelled attempts drop it. */
  const candidateKept = $derived(['checking', 'merging', 'cancelling', 'interrupted', 'conflict', 'failed', 'blocked'].includes(integration.status));
  $effect(() => {
    const next = `${integration.id}:${integration.attempt}:${integration.status}`;
    if (next !== acknowledgementKey) { acknowledgementKey = next; acknowledged = false; }
  });
</script>

<section class="integration-panel" aria-label={t('Слияние результата')}>
  <h3><Icon name={integration.status === 'merged' ? 'circlecheck' : active ? 'refresh' : 'alert'} size={17} />{t(labels[integration.status])}</h3>
  {#if integration.error}<p class="integration-error">{serverText(integration.error)}</p>{/if}
  {#if integration.conflicts?.length}<p>{t('Конфликтующие файлы:')}</p><ul class="integration-conflicts">{#each integration.conflicts as path}<li><code>{path}</code></li>{/each}</ul>{/if}
  {#if integration.checks.length}<ul class="integration-checks">{#each integration.checks as check, index}<li>{check.exitCode === 0 ? t('Проверка {number}: пройдена', { number: index + 1 }) : t('Проверка {number}: код {code}', { number: index + 1, code: String(check.exitCode) })}<code>{check.argv.join(' ')}</code>{#if check.output}<details class="integration-output"><summary>{check.outputTruncated ? t('Вывод проверки: последние {size}', { size: formatSize(CHECK_OUTPUT_LIMIT) }) : t('Вывод проверки')}</summary><pre>{check.output}</pre></details>{/if}</li>{/each}</ul>{/if}
  {#if integration.resultCommit}<p>{t('Коммит результата:')} <code>{integration.resultCommit.slice(0, 12)}</code></p>{/if}
  {#if integration.candidatePath && candidateKept}<details><summary>{t('Рабочая папка объединённого кода')}</summary><code class="integration-path">{integration.candidatePath}</code><p class="integration-note">{t('Папка остаётся до следующей попытки или очистки хранилища.')}</p></details>
  {:else if integration.status === 'merged'}<p class="integration-note">{t('После переноса brigd очищает ненужные рабочие папки и ветку запуска. Папки с подмодулями, используемые worktree и ветки с новыми коммитами сохраняются. История задачи остаётся.')}</p>
  {:else if integration.candidatePath}<p class="integration-note">{t('Кандидат удалён.')}</p>{/if}
  {#if !historical && onaction && integration.status !== 'merged'}
    {#if interrupted}<p>{t('После перезапуска процесс проверки мог остаться запущенным. Остановите его перед повтором или отменой.')}</p><label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledged} disabled={busy} /><span>{t('Я проверил(а), что предыдущие процессы проверки и слияния остановлены')}</span></label>{/if}
    <div class="integration-actions">
      {#if integration.status === 'conflict'}<button class="button primary" disabled={busy || launchBlocked} title={t('Встроенный Интегратор объединит целевую ветку с результатом в worktree задачи, разрешит конфликты и повторит проверку.')} onclick={() => onaction?.('reconcile', acknowledged)}>{t('Поручить интегратору')}</button>{/if}
      {#if !active}<button class="button {integration.status === 'conflict' ? 'secondary' : 'primary'}" disabled={busy || launchBlocked || (interrupted && !acknowledged)} onclick={() => onaction?.('integrate', acknowledged)}>{t('Повторить проверку и слияние')}</button>{/if}
      {#if active || interrupted}<button class="button secondary" disabled={busy || integration.status === 'cancelling' || (interrupted && !acknowledged)} onclick={() => onaction?.('cancel-integration', acknowledged)}>{integration.status === 'cancelling' ? t('Останавливаем…') : t('Отменить слияние')}</button>{/if}
    </div>
  {/if}
</section>
