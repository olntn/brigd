<script lang="ts">
  import Icon from './Icon.svelte';
  import { tagColorStyle } from './tags';
  import type { Tag } from './types';

  let { tags, selected = $bindable([]), disabled = false, loading = false, error = '', onreload }:
    { tags: Tag[]; selected?: string[]; disabled?: boolean; loading?: boolean; error?: string; onreload: () => void | Promise<void> } = $props();
  let search = $state('');
  let searchInput = $state<HTMLInputElement>();
  let query = $derived(search.trim().toLocaleLowerCase('ru-RU'));
  let visibleTags = $derived(tags.filter(tag => !query || tag.name.toLocaleLowerCase('ru-RU').includes(query)));
  let missing = $derived(selected.filter(id => !tags.some(tag => tag.id === id)));

  function toggleTag(id: string, checked: boolean) {
    if (checked) {
      if (!selected.includes(id)) selected = [...selected, id];
    } else {
      selected = selected.filter(value => value !== id);
    }
  }

  function clearSearch() {
    search = '';
    searchInput?.focus();
  }
</script>

<fieldset class="tag-picker" {disabled} aria-label="Теги задачи">
  <legend>Теги задачи</legend>
  {#if loading}<p role="status"><Icon name="refresh" size={14} class="spin" />Загружаем теги…</p>{/if}
  {#if error}<div class="tag-picker-error" role="alert"><span>{error}</span><button type="button" onclick={() => { void onreload(); }}>Повторить загрузку тегов</button></div>{/if}
  {#if tags.length || missing.length || search}
    <div class="tag-picker-toolbar">
      <div class="tag-search"><Icon name="search" size={15} /><input type="search" bind:this={searchInput} bind:value={search} aria-label="Поиск тегов" placeholder="Найти тег…" onkeydown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} />{#if search}<button type="button" aria-label="Очистить поиск тегов" onclick={clearSearch}><Icon name="close" size={14} /></button>{/if}</div>
      <small class="tag-selection-count" aria-live="polite">Выбрано: {selected.length}</small>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable regions need keyboard focus for native scrolling.) -->
    <div class="tag-options" role="region" aria-label="Список тегов" tabindex="0">
      {#each visibleTags as tag (tag.id)}
        <label class="tag-option" class:selected={selected.includes(tag.id)} style={tagColorStyle(tag.color)}><input type="checkbox" checked={selected.includes(tag.id)} value={tag.id} onchange={(event) => toggleTag(tag.id, event.currentTarget.checked)} /><span>{tag.name}</span></label>
      {/each}
      {#if !loading && !query}
        {#each missing as id (id)}<label class="missing"><input type="checkbox" checked={selected.includes(id)} value={id} onchange={(event) => toggleTag(id, event.currentTarget.checked)} /><span>Недоступный тег</span></label>{/each}
      {/if}
      {#if query && !visibleTags.length}<p class="tag-search-empty" role="status">Теги не найдены. Попробуйте другое название.</p>{/if}
    </div>
  {/if}
  {#if !loading && !error && tags.length === 0 && missing.length === 0}<p>Создайте теги во вкладке «Теги», чтобы назначать их задачам.</p>{/if}
</fieldset>

<style>
  .tag-picker { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { padding: 0; margin-bottom: 10px; color: var(--secondary); font-size: .92rem; font-weight: 500; }
  p { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.7; display: flex; align-items: center; gap: 7px; }
  .tag-picker-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .tag-search { display: flex; align-items: center; gap: 7px; flex: 1 1 12rem; min-width: 0; padding: 8px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: var(--surface); }
  .tag-search:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
  .tag-search input { flex: 1; min-width: 0; width: 100%; height: auto; margin: 0; padding: 0; border: 0; outline: 0; font-size: .85rem; color: var(--text); background: transparent; }
  .tag-search input::placeholder { color: var(--muted); }
  .tag-search input::-webkit-search-cancel-button { display: none; }
  .tag-search button { display: grid; place-items: center; padding: 1px; flex-shrink: 0; color: var(--muted); }
  .tag-selection-count { color: var(--muted); font-size: .77rem; white-space: nowrap; }
  .tag-options { display: flex; flex-wrap: wrap; align-content: flex-start; align-items: flex-start; gap: 8px; max-height: min(12rem, 28dvh); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scroll-padding: 7px; padding: 7px; border: 1px solid var(--line); border-radius: 7px; background: var(--subtle); }
  .tag-search-empty { width: 100%; padding: 4px; }
  label { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; padding: 7px 9px; color: var(--secondary); font-size: .85rem; cursor: pointer; max-width: 100%; }
  .tag-option { background: var(--tag-background); border-color: var(--tag-border-color); color: var(--tag-text-color); }
  .tag-option.selected { outline: 1px solid var(--tag-border-color); outline-offset: 2px; }
  .tag-option:has(input:focus-visible) { outline: 3px solid var(--focus); outline-offset: 2px; }
  label span { min-width: 0; overflow-wrap: anywhere; }
  input[type='checkbox'] { flex-shrink: 0; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
  .tag-option input { accent-color: var(--tag-text-color); }
  .missing { color: var(--error); }
  .tag-picker-error { color: var(--error); background: var(--error-bg); border: 1px solid var(--error-line); border-radius: 6px; padding: 10px; margin-bottom: 10px; font-size: .85rem; overflow-wrap: anywhere; }
  .tag-picker-error button { display: block; margin-top: 8px; text-decoration: underline; }
  fieldset:disabled label { cursor: default; opacity: .65; }
  @media (max-width: 700px) { .tag-search input { font-size: max(16px, .85rem); } }
</style>
