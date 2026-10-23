<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import { WORKFLOW_MIN_STEPS, WORKFLOW_MAX_STEPS, WORKFLOW_STEP_TITLE_LIMIT, WORKFLOW_STEP_INSTRUCTION_LIMIT } from './workflows';
  import { effortLabel, modelLabel } from './workers';
  import { t } from './i18n';
  import type { Worker } from './types';

  type DraftStep = { key: string; workerId: string; title: string; instruction: string };
  let { steps = $bindable<DraftStep[]>([]), workers, originalWorkerIds = [], disabled = false, loading = false, unavailableProviders = [], onworkerchange }: {
    steps: DraftStep[]; workers: Worker[]; originalWorkerIds?: string[]; disabled?: boolean; loading?: boolean; unavailableProviders?: string[];
    /** Called when a person picks a different worker for a stage. */
    onworkerchange?: () => void;
  } = $props();
  let announcement = $state('');
  let container: HTMLDivElement;

  function canAssign(worker: Worker, step: DraftStep) {
    if (!worker.archived || step.workerId === worker.id) return true;
    return steps.filter(item => item.workerId === worker.id).length < originalWorkerIds.filter(id => id === worker.id).length;
  }

  async function move(index: number, direction: number) {
    const target = index + direction;
    if (disabled || target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    steps = next;
    announcement = t('«{title}» перемещён на позицию {position}.', { title: next[target].title || t('Этап'), position: target + 1 });
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${next[target].key}`)?.focus();
  }
  async function add() {
    if (disabled || steps.length >= WORKFLOW_MAX_STEPS) return;
    const step = { key: crypto.randomUUID(), workerId: '', title: t('Этап {number}', { number: steps.length + 1 }), instruction: '' };
    steps = [...steps, step];
    announcement = t('Добавлен этап {number}.', { number: steps.length });
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${step.key}`)?.focus();
  }
  async function remove(index: number) {
    if (disabled || steps.length <= WORKFLOW_MIN_STEPS) return;
    steps = steps.filter((_, i) => i !== index);
    announcement = t('Этап удалён. Осталось {count}.', { count: steps.length });
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${steps[Math.min(index, steps.length - 1)].key}`)?.focus();
  }
</script>

<div class="workflow-editor" bind:this={container}>
  <div class="workflow-section-heading"><div><h3>{t('Последовательность этапов')}</h3><p>{t('От {min} до {max} этапов. Следующий работник начнёт только после успешного завершения предыдущего.', { min: WORKFLOW_MIN_STEPS, max: WORKFLOW_MAX_STEPS })}</p></div></div>
  <p class="sr-only" role="status">{announcement}</p>
  <ol class="workflow-draft-list">
    {#each steps as step, index (step.key)}
      {@const worker = workers.find(item => item.id === step.workerId)}
      <li class="workflow-draft-step" aria-label={t('Этап {number}', { number: index + 1 })}>
        <div class="workflow-draft-heading"><strong>{t('Этап {number}', { number: index + 1 })}</strong><div class="workflow-reorder">
          <button type="button" class="icon-button" aria-label={t('Поднять этап {number}', { number: index + 1 })} title={t('Поднять этап')} disabled={disabled || index === 0} onclick={() => move(index, -1)}>↑</button>
          <button type="button" class="icon-button" aria-label={t('Опустить этап {number}', { number: index + 1 })} title={t('Опустить этап')} disabled={disabled || index === steps.length - 1} onclick={() => move(index, 1)}>↓</button>
          <button type="button" class="icon-button danger-hover" aria-label={t('Удалить этап {number}', { number: index + 1 })} title={steps.length <= WORKFLOW_MIN_STEPS ? t('В сложной задаче минимум два этапа') : t('Удалить этап')} disabled={disabled || steps.length <= WORKFLOW_MIN_STEPS} onclick={() => remove(index)}><Icon name="close" size={16} /></button>
        </div></div>
        <label class="form-field" for={`step-title-${step.key}`}><span>{t('Название этапа')} <span class="required">*</span></span><input id={`step-title-${step.key}`} name={`step-title-${index}`} bind:value={step.title} maxlength={WORKFLOW_STEP_TITLE_LIMIT} required disabled={disabled} /></label>
        <label class="form-field"><span>{t('Работник этапа')} <span class="required">*</span></span><select name={`step-worker-${index}`} bind:value={step.workerId} onchange={() => onworkerchange?.()} required disabled={disabled || loading}><option value="">{t('Выберите работника')}</option>{#each workers.filter(item => canAssign(item, step)) as item (item.id)}<option value={item.id}>{item.name} · {item.provider === 'codex' ? 'Codex' : 'Claude Code'}{item.archived ? ` ${t('(в архиве)')}` : ''}</option>{/each}{#if step.workerId && !worker}<option value={step.workerId}>{t('Недоступный работник')}</option>{/if}</select></label>
        {#if worker}<div class="workflow-assignment"><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={36} /><span class="workflow-assignment-copy">{worker.name}{#if worker.description?.trim()}<small class="worker-description">{worker.description}</small>{/if}<small class="worker-model-label" title={worker.model ?? undefined}>{worker.provider === 'codex' ? 'Codex' : 'Claude Code'} · {t(modelLabel(worker.model))}</small><small>{t('Усилия: {effort}', { effort: t(effortLabel(worker.effort)) })}</small></span></div>{/if}
        {#if worker?.archived}<p class="field-warning">{t('Работник в архиве. Прежнее назначение можно сохранить; новые назначения требуют восстановления профиля.')}</p>{/if}
        {#if worker && unavailableProviders.includes(worker.provider)}<p class="field-warning">{t('CLI этого работника не найден. До запуска установите и авторизуйте {provider}.', { provider: worker.provider === 'codex' ? 'Codex' : 'Claude Code' })}</p>{/if}
        <label class="form-field"><span>{t('Задание этапа')} <span class="required">*</span></span><textarea name={`step-instruction-${index}`} bind:value={step.instruction} maxlength={WORKFLOW_STEP_INSTRUCTION_LIMIT} rows="3" placeholder={t('Какой результат должен передать этот работник следующему?')} required disabled={disabled}></textarea></label>
      </li>
    {/each}
  </ol>
  <button type="button" class="button secondary workflow-add" disabled={disabled || steps.length >= WORKFLOW_MAX_STEPS} onclick={add}><Icon name="plus" size={16} />{t('Добавить этап')}</button>
  {#if !loading && !workers.some(worker => !worker.archived)}<p class="field-warning">{t('Создайте хотя бы одного работника в разделе «Работники», чтобы назначить его на этапы.')}</p>{/if}
</div>
