<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { t } from './i18n';
  import type { Task } from './types';

  let { tasks, taskId, selected = $bindable([]), disabled = false }: {
    tasks: Task[]; taskId: string | null; selected?: string[]; disabled?: boolean;
  } = $props();
  const id = $props.id();
  let open = $state(false);
  let picker: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let searchInput = $state<HTMLInputElement>();
  let search = $state('');
  let summary = $derived(selected.map(id => tasks.find(task => task.id === id)?.title ?? id).join(', '));
  let matches = $derived(tasks.filter(task => task.id !== taskId && task.archivedAt === null
    && task.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));

  $effect(() => { if (disabled) open = false; });

  async function toggleOpen() {
    open = !open;
    if (open) {
      search = '';
      await tick();
      searchInput?.focus();
    }
  }

  function closeOutside(event: Event) {
    if (open && event.target instanceof Node && !picker.contains(event.target)) open = false;
  }

  function keydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      trigger.focus();
    }
  }

  const toggle = (id: string, checked: boolean) => {
    if (checked && selected.length < 10 && !selected.includes(id)) selected = [...selected, id];
    else if (!checked) selected = selected.filter(value => value !== id);
  };
</script>

<svelte:window onclick={closeOutside} onfocusin={closeOutside} onkeydown={keydown} />

<div class="dependency-picker" bind:this={picker}>
  <button type="button" class="dependency-trigger" bind:this={trigger} {disabled} aria-expanded={open} aria-controls="{id}-options" onclick={toggleOpen}>
    <span class="dependency-label">{t('Запуск после')}</span>
    <span class="dependency-value" title={summary || undefined}>{summary || t('Без зависимостей')}</span>
    {#if selected.length}<small>{selected.length}</small>{/if}
    <span class="dependency-chevron" class:open><Icon name="down" size={16} /></span>
  </button>
  {#if open}
    <fieldset id="{id}-options" class="dependency-dropdown" {disabled} aria-label={t('Запуск после')}>
      <input type="search" bind:this={searchInput} bind:value={search} aria-label={t('Поиск задач по названию')} placeholder={t('Найти задачу…')} onkeydown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
      <small class="dependency-help">{t('До 10 зависимостей. Автоматический запуск ждёт успешного результата и слияния.')}</small>
      <div class="dependency-options">
        {#each selected as id (id)}
          {@const task = tasks.find(task => task.id === id)}
          <label><input type="checkbox" checked onchange={() => toggle(id, false)} /><span>{task?.title ?? id}{#if task?.archivedAt != null} · {t('в архиве')}{/if}</span></label>
        {/each}
        {#each matches.filter(task => !selected.includes(task.id)) as task (task.id)}
          <label><input type="checkbox" disabled={disabled || selected.length >= 10} onchange={(event) => toggle(task.id, event.currentTarget.checked)} /><span>{task.title}</span></label>
        {/each}
        {#if !matches.length}<p>{t('Задачи не найдены')}</p>{/if}
      </div>
      {#if selected.length}<p class="dependency-warning">{t('Ручной запуск разрешён и может начаться до выполнения зависимостей.')}</p>{/if}
    </fieldset>
  {/if}
</div>

<style>
  .dependency-picker { position: relative; min-width: 0; }
  .dependency-trigger { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); text-align: left; font-size: .92rem; line-height: 1.5; }
  .dependency-trigger:hover:not(:disabled) { border-color: var(--focus); }
  .dependency-label { flex-shrink: 0; color: var(--secondary); font-weight: 500; }
  .dependency-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .dependency-trigger small { flex-shrink: 0; color: var(--muted); }
  .dependency-chevron { display: flex; flex-shrink: 0; }
  .dependency-chevron.open { transform: rotate(180deg); }
  .dependency-dropdown { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; right: 0; min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); box-shadow: 0 8px 24px #0002; }
  input[type='search'] { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font-size: .85rem; }
  .dependency-help { display: block; color: var(--muted); margin: 8px 0; font-size: .77rem; line-height: 1.7; }
  .dependency-options { display: grid; gap: 8px; max-height: min(12rem, 28dvh); overflow-y: auto; overscroll-behavior: contain; }
  label { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; color: var(--secondary); font-size: .85rem; cursor: pointer; }
  input[type='checkbox'] { width: 15px; height: 15px; margin: 0; }
  p { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.7; }
  .dependency-warning { margin-top: 10px; color: var(--warning); }
  @media (max-width: 700px) { input[type='search'] { font-size: 16px; } }
</style>
