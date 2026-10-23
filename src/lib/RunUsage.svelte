<script lang="ts">
  import { t } from './i18n';
  import { turnLabel, usageDetails, usageLine } from './usage';
  import type { Run } from './types';

  let { run }: { run: Run } = $props();
  let turns = $derived(run.turnUsage ?? []);
</script>

{#if run.usage}
  <div class="run-usage" aria-label={t('Расход запуска')}>
    {#each turns as turn (`${turn.turn}:${turn.attemptId ?? ''}:${turn.startedAt}`)}
      <p title={usageDetails(turn)}><span>{turnLabel(run, turn)}:</span> {usageLine(turn)}</p>
    {/each}
    {#if turns.length !== 1}
      <p class="run-usage-total" title={usageDetails(run.usage)}><span>{t('Всего за запуск')}:</span> {usageLine(run.usage)}</p>
    {/if}
  </div>
{/if}
