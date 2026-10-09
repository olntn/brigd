<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import { WORKFLOW_MIN_STEPS, WORKFLOW_MAX_STEPS, WORKFLOW_STEP_TITLE_LIMIT, WORKFLOW_STEP_INSTRUCTION_LIMIT } from './workflows';
  import { effortLabel } from './workers';
  import type { Worker } from './types';

  type DraftStep = { key: string; workerId: string; title: string; instruction: string };
  let { steps = $bindable<DraftStep[]>([]), workers, originalWorkerIds = [], disabled = false, loading = false, unavailableProviders = [] }: {
    steps: DraftStep[]; workers: Worker[]; originalWorkerIds?: string[]; disabled?: boolean; loading?: boolean; unavailableProviders?: string[];
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
    announcement = `«${next[target].title || 'Этап'}» перемещён на позицию ${target + 1}.`;
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${next[target].key}`)?.focus();
  }
  async function add() {
    if (disabled || steps.length >= WORKFLOW_MAX_STEPS) return;
    const step = { key: crypto.randomUUID(), workerId: '', title: `Этап ${steps.length + 1}`, instruction: '' };
    steps = [...steps, step];
    announcement = `Добавлен этап ${steps.length}.`;
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${step.key}`)?.focus();
  }
  async function remove(index: number) {
    if (disabled || steps.length <= WORKFLOW_MIN_STEPS) return;
    steps = steps.filter((_, i) => i !== index);
    announcement = `Этап удалён. Осталось ${steps.length}.`;
    await tick();
    container.querySelector<HTMLInputElement>(`#step-title-${steps[Math.min(index, steps.length - 1)].key}`)?.focus();
  }
</script>

<div class="workflow-editor" bind:this={container}>
  <div class="workflow-section-heading"><div><h3>Последовательность этапов</h3><p>От 2 до 20 этапов. Следующий работник начнёт только после успешного завершения предыдущего.</p></div><span class="workflow-count">{steps.length}/{WORKFLOW_MAX_STEPS}</span></div>
  <p class="sr-only" role="status">{announcement}</p>
  <ol class="workflow-draft-list">
    {#each steps as step, index (step.key)}
      {@const worker = workers.find(item => item.id === step.workerId)}
      <li class="workflow-draft-step" aria-label={`Этап ${index + 1}`}>
        <div class="workflow-draft-heading"><strong>Этап {index + 1}</strong><div class="workflow-reorder">
          <button type="button" class="icon-button" aria-label={`Поднять этап ${index + 1}`} title="Поднять этап" disabled={disabled || index === 0} onclick={() => move(index, -1)}>↑</button>
          <button type="button" class="icon-button" aria-label={`Опустить этап ${index + 1}`} title="Опустить этап" disabled={disabled || index === steps.length - 1} onclick={() => move(index, 1)}>↓</button>
          <button type="button" class="icon-button danger-hover" aria-label={`Удалить этап ${index + 1}`} title={steps.length <= WORKFLOW_MIN_STEPS ? 'В сложной задаче минимум два этапа' : 'Удалить этап'} disabled={disabled || steps.length <= WORKFLOW_MIN_STEPS} onclick={() => remove(index)}><Icon name="close" size={16} /></button>
        </div></div>
        <label class="form-field" for={`step-title-${step.key}`}><span>Название этапа <span class="required">*</span></span><input id={`step-title-${step.key}`} name={`step-title-${index}`} bind:value={step.title} maxlength={WORKFLOW_STEP_TITLE_LIMIT} required disabled={disabled} /></label>
        <label class="form-field"><span>Работник этапа <span class="required">*</span></span><select name={`step-worker-${index}`} bind:value={step.workerId} required disabled={disabled || loading}><option value="">Выберите работника</option>{#each workers.filter(item => canAssign(item, step)) as item (item.id)}<option value={item.id}>{item.name} · {item.provider === 'codex' ? 'Codex' : 'Claude Code'}{item.archived ? ' (в архиве)' : ''}</option>{/each}{#if step.workerId && !worker}<option value={step.workerId}>Недоступный работник</option>{/if}</select></label>
        {#if worker}<div class="workflow-assignment"><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={24} /><span>{worker.name} · Усилия: {effortLabel(worker.effort)}</span></div>{/if}
        {#if worker?.archived}<p class="field-warning">Работник в архиве. Прежнее назначение можно сохранить; новые назначения требуют восстановления профиля.</p>{/if}
        {#if worker && unavailableProviders.includes(worker.provider)}<p class="field-warning">CLI этого работника не найден. До запуска установите и авторизуйте {worker.provider === 'codex' ? 'Codex' : 'Claude Code'}.</p>{/if}
        <label class="form-field"><span>Задание этапа <span class="required">*</span></span><textarea name={`step-instruction-${index}`} bind:value={step.instruction} maxlength={WORKFLOW_STEP_INSTRUCTION_LIMIT} rows="3" placeholder="Какой результат должен передать этот работник следующему?" required disabled={disabled}></textarea></label>
      </li>
    {/each}
  </ol>
  <button type="button" class="button secondary workflow-add" disabled={disabled || steps.length >= WORKFLOW_MAX_STEPS} onclick={add}><Icon name="plus" size={16} />Добавить этап</button>
  {#if !loading && !workers.some(worker => !worker.archived)}<p class="field-warning">Создайте хотя бы одного работника в разделе «Работники», чтобы назначить его на этапы.</p>{/if}
</div>
