<script lang="ts">
  import { t } from './i18n';
  import type { Task } from './types';

  let { tasks, taskId, selected = $bindable([]), disabled = false }: {
    tasks: Task[]; taskId: string | null; selected?: string[]; disabled?: boolean;
  } = $props();
  let search = $state('');
  let matches = $derived(tasks.filter(task => task.id !== taskId && task.archivedAt === null
    && task.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const toggle = (id: string, checked: boolean) => {
    if (checked && selected.length < 10 && !selected.includes(id)) selected = [...selected, id];
    else if (!checked) selected = selected.filter(value => value !== id);
  };
</script>

<fieldset class="dependency-picker" {disabled}>
  <legend>{t('После задач…')}</legend>
  <input type="search" bind:value={search} aria-label={t('Поиск задач по названию')} placeholder={t('Найти задачу…')} onkeydown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />
  <small>{t('До 10 зависимостей. Автоматический запуск ждёт успешного результата и слияния.')}</small>
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
</fieldset>

<style>
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { margin-bottom: 8px; color: var(--secondary); }
  input[type='search'] { width: 100%; }
  small { display: block; color: var(--muted); margin: 6px 0; }
  .dependency-options { display: grid; gap: 8px; max-height: 12rem; overflow-y: auto; }
  label { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
</style>
