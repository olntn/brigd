<script lang="ts">
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import { effortLabel, modelLabel } from './workers';
  import type { Run, RunStepStatus } from './types';
  let { run }: { run: Run } = $props();
  const labels: Record<RunStepStatus, string> = {
    pending: 'Ожидает очереди', running: 'В работе', cancelling: 'Останавливается', waiting_input: 'Нужен ответ',
    completed: 'Завершено', blocked: 'Заблокировано', failed: 'Ошибка', interrupted: 'Прервано', cancelled: 'Отменено',
  };
  let completed = $derived(run.steps.filter(step => step.status === 'completed').length);
  function time(value: number | null) { return value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(value) : '—'; }
</script>

<section class="workflow-checklist" aria-label="Этапы запуска">
  <div class="workflow-section-heading"><h3>Этапы запуска</h3><span class="workflow-progress" role="status">{completed} из {run.steps.length} этапов завершено</span></div>
  <p class="workflow-help">План и работники сохранены на момент старта. Галочка появляется только после успешного завершения этапа.</p>
  <ol class="workflow-run-list">
    {#each run.steps as step, index (index)}
      <li class="workflow-run-step step-{step.status}" class:current-step={run.currentStepIndex === index && !['completed', 'cancelled'].includes(run.status)} aria-current={run.currentStepIndex === index && !['completed', 'cancelled'].includes(run.status) ? 'step' : undefined} data-status={step.status}>
        <span class="workflow-step-mark" aria-hidden="true">{#if step.status === 'completed'}<Icon name="check" size={17} />{:else}{index + 1}{/if}</span>
        <div class="workflow-step-content">
          <div class="workflow-step-heading"><h4>{step.title}</h4><span class="workflow-step-status">{labels[step.status]}</span></div>
          <div class="workflow-step-worker"><WorkerAvatar name={step.worker.name} avatarUrl={step.worker.avatarUrl} size={24} /><span class="workflow-assignment-copy"><span>{step.worker.name}</span>{#if step.worker.description?.trim()}<small class="worker-description">{step.worker.description}</small>{/if}<small class="worker-model-label" title={step.worker.model ?? undefined}>{step.worker.provider === 'codex' ? 'Codex' : 'Claude Code'} · {modelLabel(step.worker.model)}</small></span></div>
          {#if step.summary}<p class="workflow-step-summary">{step.summary}</p>{/if}
          {#if step.error}<p class="workflow-step-error">{step.error}</p>{/if}
          <details class="workflow-step-snapshot"><summary>Задание и история этапа</summary>
            <p class="workflow-step-instruction">{step.instruction}</p>
            <dl><div><dt>Работник</dt><dd>{step.worker.name}{#if step.worker.description?.trim()}<small class="worker-description">{step.worker.description}</small>{/if}</dd></div><div><dt>Провайдер</dt><dd>{step.worker.provider === 'codex' ? 'Codex' : 'Claude Code'}</dd></div><div><dt>Модель</dt><dd>{modelLabel(step.worker.model)}{#if step.worker.model && modelLabel(step.worker.model) !== step.worker.model} ({step.worker.model}){/if}</dd></div><div><dt>Усилия</dt><dd>{effortLabel(step.worker.effort)}</dd></div><div><dt>Начало / завершение</dt><dd>{time(step.startedAt)} / {time(step.finishedAt)}</dd></div></dl>
            {#if step.attempts.length}<ol class="workflow-attempts" aria-label={`Попытки этапа ${index + 1}`}>
              {#each step.attempts as attempt (attempt.id)}<li><strong>Попытка {attempt.number} · {labels[attempt.status]}</strong><p>{time(attempt.startedAt)} · Ход {attempt.turn}</p>{#if attempt.sessionId}<p class="workflow-session">Сессия: {attempt.sessionId}</p>{/if}{#if attempt.summary}<p>{attempt.summary}</p>{/if}{#if attempt.error}<p class="workflow-step-error">{attempt.error}</p>{/if}</li>{/each}
            </ol>{:else}<p class="workflow-help">Этот этап ещё не запускался.</p>{/if}
          </details>
        </div>
      </li>
    {/each}
  </ol>
</section>
