<script lang="ts">
  import Icon from './Icon.svelte';
  import { buildDocTree, docPageTitle, DOC_TASK_PAGE_LIMIT, flattenDocTree } from './docs';
  import type { DocPageSummary } from './types';

  let { pages, selected = $bindable([]), disabled = false, loading = false, error = '', onreload }:
    { pages: DocPageSummary[]; selected?: string[]; disabled?: boolean; loading?: boolean; error?: string; onreload: () => void | Promise<void> } = $props();
  let search = $state('');
  let query = $derived(search.trim().toLocaleLowerCase('ru-RU'));
  let flat = $derived(flattenDocTree(buildDocTree(pages), () => true));
  let visible = $derived(flat.filter(node => !query || docPageTitle(node.page).toLocaleLowerCase('ru-RU').includes(query)));
  let missing = $derived(selected.filter(id => !pages.some(page => page.id === id)));
  let full = $derived(selected.length >= DOC_TASK_PAGE_LIMIT);

  function toggle(id: string, checked: boolean) {
    if (checked) { if (!selected.includes(id) && !full) selected = [...selected, id]; }
    else selected = selected.filter(value => value !== id);
  }
</script>

<fieldset class="doc-picker" {disabled} aria-label="Документация для задачи">
  <legend>Документация</legend>
  <p class="doc-picker-help">Агент получит список выбранных страниц и прочитает их через MCP, когда они понадобятся.</p>
  {#if loading}<p role="status"><Icon name="refresh" size={14} class="spin" />Загружаем страницы…</p>{/if}
  {#if error}<div class="doc-picker-error" role="status"><span>{error}</span><button type="button" onclick={() => { void onreload(); }}>Повторить загрузку страниц</button></div>{/if}
  {#if pages.length || missing.length}
    <div class="doc-picker-toolbar">
      <div class="doc-picker-search"><Icon name="search" size={15} /><input type="search" bind:value={search} aria-label="Поиск страниц документации" placeholder="Найти страницу…" onkeydown={(event) => { if (event.key === 'Enter') event.preventDefault(); }} /></div>
      <small aria-live="polite">Выбрано: {selected.length} / {DOC_TASK_PAGE_LIMIT}</small>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable regions need keyboard focus for native scrolling.) -->
    <div class="doc-picker-options" role="region" aria-label="Список страниц" tabindex="0">
      {#each visible as node (node.page.id)}
        <label class="doc-picker-option" class:selected={selected.includes(node.page.id)} style:--depth={query ? 0 : node.depth}><input type="checkbox" checked={selected.includes(node.page.id)} value={node.page.id} disabled={disabled || (full && !selected.includes(node.page.id))} onchange={(event) => toggle(node.page.id, event.currentTarget.checked)} /><Icon name="file" size={13} /><span>{docPageTitle(node.page)}</span></label>
      {/each}
      {#if !loading && !query}
        {#each missing as id (id)}<label class="doc-picker-option missing"><input type="checkbox" checked={selected.includes(id)} value={id} onchange={(event) => toggle(id, event.currentTarget.checked)} /><span>Страница недоступна</span></label>{/each}
      {/if}
      {#if query && !visible.length}<p class="doc-picker-empty" role="status">Страницы не найдены. Попробуйте другое название.</p>{/if}
    </div>
  {/if}
  {#if !loading && !error && pages.length === 0 && missing.length === 0}<p>Создайте страницы в разделе «Документация», чтобы прикреплять их к задачам.</p>{/if}
</fieldset>

<style>
  .doc-picker { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { padding: 0; margin-bottom: 8px; color: var(--secondary); font-size: .92rem; font-weight: 500; }
  p { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.7; display: flex; align-items: center; gap: 7px; }
  .doc-picker-help { margin-bottom: 10px; }
  .doc-picker-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .doc-picker-toolbar small { color: var(--muted); font-size: .77rem; white-space: nowrap; }
  .doc-picker-search { display: flex; align-items: center; gap: 7px; flex: 1 1 12rem; min-width: 0; padding: 8px 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--muted); background: var(--surface); }
  .doc-picker-search:focus-within { outline: 2px solid var(--focus); outline-offset: 1px; }
  .doc-picker-search input { flex: 1; min-width: 0; width: 100%; height: auto; margin: 0; padding: 0; border: 0; outline: 0; font-size: .85rem; color: var(--text); background: transparent; }
  .doc-picker-search input::placeholder { color: var(--muted); }
  .doc-picker-search input::-webkit-search-cancel-button { display: none; }
  .doc-picker-options { display: flex; flex-direction: column; gap: 2px; max-height: min(12rem, 28dvh); overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--subtle); }
  .doc-picker-option { display: flex; align-items: center; gap: 7px; padding: 6px 8px 6px calc(var(--depth, 0) * 16px + 8px); border-radius: var(--radius-sm); color: var(--secondary); font-size: .85rem; cursor: pointer; max-width: 100%; }
  .doc-picker-option:hover { background: var(--soft); }
  .doc-picker-option.selected { color: var(--accent-text); background: var(--selected); }
  .doc-picker-option:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
  .doc-picker-option span { min-width: 0; overflow-wrap: anywhere; }
  .doc-picker-option input { flex-shrink: 0; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
  .missing { color: var(--error); }
  .doc-picker-empty { padding: 4px; }
  .doc-picker-error { color: var(--error); background: var(--error-bg); border: 1px solid var(--error-line); border-radius: var(--radius-sm); padding: 10px; margin-bottom: 10px; font-size: .85rem; overflow-wrap: anywhere; }
  .doc-picker-error button { display: block; margin-top: 8px; text-decoration: underline; }
  fieldset:disabled label { cursor: default; opacity: .65; }
  @media (max-width: 700px) { .doc-picker-search input { font-size: max(16px, .85rem); } }
</style>
