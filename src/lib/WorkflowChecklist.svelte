<script lang="ts">
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import { effortLabel, modelLabel } from './workers';
  import { formatDate, serverText, t, tk } from './i18n';
  import type { Run, RunStepStatus } from './types';
  let { run, historical = false }: { run: Run; historical?: boolean } = $props();
  let steps = $derived(historical ? run.followup?.workflow?.steps ?? [] : run.steps);
  const labels: Record<RunStepStatus, string> = {
    queued: tk('В очереди'), preparing: tk('Подготовка'),
    pending: tk('Ожидает очереди'), running: tk('В работе'), cancelling: tk('Останавливается'), waiting_input: tk('Нужен ответ'),
    completed: tk('Завершено'), blocked: tk('Заблокировано'), failed: tk('Ошибка'), interrupted: tk('Прервано'), cancelled: tk('Отменено'),
  };
  let completed = $derived(steps.filter(step => step.status === 'completed').length);
  function time(value: number | null) { return value ? formatDate(value, { dateStyle: 'short', timeStyle: 'short' }) : '—'; }
</script>

<section class="workflow-checklist" aria-label={historical ? t('Завершённые этапы исходного запуска') : t('Этапы запуска')}>
  <div class="workflow-section-heading"><h3>{historical ? t('Завершённые этапы исходного запуска') : t('Этапы запуска')}</h3><span class="workflow-progress" role="status">{t('{completed} из {total} этапов завершено', { completed, total: steps.length })}</span></div>
  <p class="workflow-help">{historical ? t('Сохранённая история исходного запуска. Дополнительный запрос не меняет эти отметки.') : t('План и работники сохранены на момент старта. Галочка появляется только после успешного завершения этапа.')}</p>
  <ol class="workflow-run-list">
    {#each steps as step, index (index)}
      <li class="workflow-run-step step-{step.status}" class:current-step={!historical && run.currentStepIndex === index && !['completed', 'cancelled'].includes(run.status)} aria-current={!historical && run.currentStepIndex === index && !['completed', 'cancelled'].includes(run.status) ? 'step' : undefined} data-status={step.status}>
        <span class="workflow-step-mark" aria-hidden="true">{#if step.status === 'completed'}<Icon name="check" size={17} />{:else}{index + 1}{/if}</span>
        <div class="workflow-step-content">
          <div class="workflow-step-heading"><h4>{step.title}</h4><span class="workflow-step-status">{t(labels[step.status])}</span></div>
          <div class="workflow-step-worker"><WorkerAvatar name={step.worker.name} avatarUrl={step.worker.avatarUrl} size={36} /><span class="workflow-assignment-copy"><span>{step.worker.name}</span>{#if step.worker.description?.trim()}<small class="worker-description">{step.worker.description}</small>{/if}<small class="worker-model-label" title={step.worker.model ?? undefined}>{step.worker.provider === 'codex' ? 'Codex' : 'Claude Code'} · {t(modelLabel(step.worker.model))}</small></span></div>
          {#if step.summary}<p class="workflow-step-summary">{step.summary}</p>{/if}
          {#if step.error}<p class="workflow-step-error">{serverText(step.error)}</p>{/if}
          <details class="workflow-step-snapshot"><summary>{t('Задание и история этапа')}</summary>
            <p class="workflow-step-instruction">{step.instruction}</p>
            <dl><div><dt>{t('Работник')}</dt><dd>{step.worker.name}{#if step.worker.description?.trim()}<small class="worker-description">{step.worker.description}</small>{/if}</dd></div><div><dt>{t('Провайдер')}</dt><dd>{step.worker.provider === 'codex' ? 'Codex' : 'Claude Code'}</dd></div><div><dt>{t('Модель')}</dt><dd>{t(modelLabel(step.worker.model))}{#if step.worker.model && modelLabel(step.worker.model) !== step.worker.model} ({step.worker.model}){/if}</dd></div><div><dt>{t('Усилия')}</dt><dd>{t(effortLabel(step.worker.effort))}</dd></div><div><dt>{t('Начало / завершение')}</dt><dd>{time(step.startedAt)} / {time(step.finishedAt)}</dd></div></dl>
            {#if step.attempts.length}<ol class="workflow-attempts" aria-label={t('Попытки этапа {number}', { number: index + 1 })}>
              {#each step.attempts as attempt (attempt.id)}<li><strong>{t('Попытка {number}', { number: attempt.number })} · {t(labels[attempt.status])}</strong><p>{time(attempt.startedAt)} · {t('Ход {turn}', { turn: attempt.turn })}</p>{#if attempt.sessionId}<p class="workflow-session">{t('Сессия: {id}', { id: attempt.sessionId })}</p>{/if}{#if attempt.summary}<p>{attempt.summary}</p>{/if}{#if attempt.error}<p class="workflow-step-error">{serverText(attempt.error)}</p>{/if}</li>{/each}
            </ol>{:else}<p class="workflow-help">{t('Этот этап ещё не запускался.')}</p>{/if}
          </details>
        </div>
      </li>
    {/each}
  </ol>
</section>
