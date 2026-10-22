<script lang="ts">
  import type { Integration, IntegrationStatus } from './types';
  import Icon from './Icon.svelte';
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
    queued: 'Ожидает слияния', checking: 'Проверка объединённого кода', merging: 'Перенос проверенного результата',
    cancelling: 'Остановка проверки', merged: 'Изменения перенесены', conflict: 'Конфликт слияния',
    failed: 'Проверка не прошла', blocked: 'Перенос заблокирован', interrupted: 'Слияние прервано', cancelled: 'Слияние отменено',
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

<section class="integration-panel" aria-label="Слияние результата">
  <h3><Icon name={integration.status === 'merged' ? 'circlecheck' : active ? 'refresh' : 'alert'} size={17} />{labels[integration.status]}</h3>
  {#if integration.error}<p class="integration-error">{integration.error}</p>{/if}
  {#if integration.conflicts?.length}<p>Конфликтующие файлы:</p><ul class="integration-conflicts">{#each integration.conflicts as path}<li><code>{path}</code></li>{/each}</ul>{/if}
  {#if integration.checks.length}<ul class="integration-checks">{#each integration.checks as check, index}<li>Проверка {index + 1}: {check.exitCode === 0 ? 'пройдена' : `код ${check.exitCode}`}<code>{check.argv.join(' ')}</code></li>{/each}</ul>{/if}
  {#if integration.resultCommit}<p>Коммит результата: <code>{integration.resultCommit.slice(0, 12)}</code></p>{/if}
  {#if integration.candidatePath && candidateKept}<details><summary>Рабочая папка объединённого кода</summary><code class="integration-path">{integration.candidatePath}</code><p class="integration-note">Папка остаётся до следующей попытки или очистки хранилища.</p></details>
  {:else if integration.status === 'merged'}<p class="integration-note">После переноса brigd очищает ненужные рабочие папки и ветку запуска. Папки с подмодулями, используемые worktree и ветки с новыми коммитами сохраняются. История задачи остаётся.</p>
  {:else if integration.candidatePath}<p class="integration-note">Кандидат удалён.</p>{/if}
  {#if !historical && onaction && integration.status !== 'merged'}
    {#if interrupted}<p>После перезапуска процесс проверки мог остаться запущенным. Остановите его перед повтором или отменой.</p><label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledged} disabled={busy} /><span>Я проверил(а), что предыдущие процессы проверки и слияния остановлены</span></label>{/if}
    <div class="integration-actions">
      {#if integration.status === 'conflict'}<button class="button primary" disabled={busy || launchBlocked} title="Встроенный Интегратор объединит целевую ветку с результатом в worktree задачи, разрешит конфликты и повторит проверку." onclick={() => onaction?.('reconcile', acknowledged)}>Поручить интегратору</button>{/if}
      {#if !active}<button class="button {integration.status === 'conflict' ? 'secondary' : 'primary'}" disabled={busy || launchBlocked || (interrupted && !acknowledged)} onclick={() => onaction?.('integrate', acknowledged)}>Повторить проверку и слияние</button>{/if}
      {#if active || interrupted}<button class="button secondary" disabled={busy || integration.status === 'cancelling' || (interrupted && !acknowledged)} onclick={() => onaction?.('cancel-integration', acknowledged)}>{integration.status === 'cancelling' ? 'Останавливаем…' : 'Отменить слияние'}</button>{/if}
    </div>
  {/if}
</section>
