<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import DocsTree from './DocsTree.svelte';
  import DocEditor from './DocEditor.svelte';
  import { buildDocTree, docPageTitle, DOC_PAGE_LIMIT, DOC_UNTITLED, type DocHeading } from './docs';
  import { docsFailureMessage, docsRequest } from './docs-client';
  import { t } from './i18n';
  import type { DocPage, DocPageMoveInput, DocPageSummary, DocSearchHit } from './types';

  let { notify, onopentask }: { notify: (message: string, type?: 'success' | 'error') => void; onopentask?: (id: string) => void } = $props();
  let pages = $state<DocPageSummary[]>([]);
  let trash = $state<DocPageSummary[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selectedId = $state<string | null>(readHash());
  let headings = $state<DocHeading[]>([]);
  let pending = $state(false);
  let trashOpen = $state(false);
  let createdId = $state<string | null>(null);
  let search = $state('');
  let results = $state<DocSearchHit[] | null>(null);
  let searching = $state(false);
  let searchSequence = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let deleting = $state<{ page: DocPageSummary; permanent: boolean } | null>(null);
  let deleteError = $state('');
  let removing = $state(false);
  let confirmation: HTMLDialogElement;
  let sequence = 0;
  let alive = true;
  let tree = $derived(buildDocTree(pages));
  let total = $derived(pages.length + trash.length);
  let selectedTrashed = $derived(selectedId !== null && !loading && !pages.some(page => page.id === selectedId));
  /** Trash lists only the pages deleted on their own; a subpage deleted with its parent is restored or purged through it. */
  let selectedLive = $derived(pages.some(page => page.id === selectedId));
  let selectedInTrash = $derived(trash.some(page => page.id === selectedId));
  const pageTitle = (page: { title: string }) => docPageTitle(page, t(DOC_UNTITLED));
  // Search runs a moment after typing stops; stale answers are dropped.
  $effect(() => {
    const query = search.trim();
    clearTimeout(searchTimer);
    const sequence = ++searchSequence;
    if (!query) { results = null; searching = false; return; }
    searching = true;
    searchTimer = setTimeout(async () => {
      try {
        const hits = await docsRequest<DocSearchHit[]>(`/api/docs/search?q=${encodeURIComponent(query)}`);
        if (alive && sequence === searchSequence) results = hits;
      } catch (failure) {
        if (alive && sequence === searchSequence) { results = []; notify(docsFailureMessage(failure), 'error'); }
      } finally { if (alive && sequence === searchSequence) searching = false; }
    }, 250);
  });
  /** Snippets wrap hits in square brackets; render those as highlights without trusting the text as HTML. */
  function snippetParts(snippet: string): { text: string; hit: boolean }[] {
    return snippet.split(/(\[[^\[\]]*\])/).filter(Boolean).map(part => part.startsWith('[') && part.endsWith(']') ? { text: part.slice(1, -1), hit: true } : { text: part, hit: false });
  }
  function pickResult(id: string) {
    search = '';
    select(id);
  }

  function readHash(): string | null {
    return location.hash.match(/^#\/docs\/([a-zA-Z0-9-]+)$/)?.[1] ?? null;
  }
  /** The open page lives in the URL hash so links to it survive reloads and can be shared. */
  function select(id: string | null) {
    selectedId = id;
    headings = [];
    const hash = id ? `#/docs/${id}` : '#/docs';
    if (location.hash !== hash) location.hash = hash;
  }
  async function load() {
    const readSequence = ++sequence;
    try {
      const [list, bin] = await Promise.all([docsRequest<DocPageSummary[]>('/api/docs'), docsRequest<DocPageSummary[]>('/api/docs/trash')]);
      if (!alive || readSequence !== sequence) return;
      if (!Array.isArray(list) || !Array.isArray(bin)) throw new Error(t('Не удалось прочитать список страниц. Попробуйте ещё раз.'));
      pages = list;
      trash = bin;
      error = '';
    } catch (failure) {
      if (alive && readSequence === sequence) error = docsFailureMessage(failure);
    } finally {
      if (alive && readSequence === sequence) loading = false;
    }
  }
  onMount(() => {
    if (!location.hash.startsWith('#/docs')) history.replaceState(null, '', '#/docs');
    void load();
    const onHash = () => { const id = readHash(); if (id !== selectedId) { selectedId = id; headings = []; } };
    window.addEventListener('hashchange', onHash);
    const interval = setInterval(() => { if (document.visibilityState === 'visible' && !pending) void load(); }, 5000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; sequence++; clearInterval(interval); window.removeEventListener('hashchange', onHash); document.removeEventListener('visibilitychange', onVisible); };
  });

  async function mutate<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
    if (pending) return undefined;
    pending = true;
    sequence++;
    try {
      const result = await action();
      if (!alive) return undefined;
      await load();
      if (success) notify(success);
      return result;
    } catch (failure) {
      if (alive) notify(docsFailureMessage(failure), 'error');
      return undefined;
    } finally {
      if (alive) pending = false;
    }
  }
  async function create(parentId: string | null) {
    const page = await mutate(() => docsRequest<DocPage>('/api/docs', { method: 'POST', body: JSON.stringify({ parentId }) }));
    if (page) { createdId = page.id; select(page.id); }
  }
  function move(id: string, input: DocPageMoveInput) {
    void mutate(() => docsRequest<DocPageSummary>(`/api/docs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }));
  }
  async function restore(id: string) {
    const page = await mutate(() => docsRequest<DocPageSummary>(`/api/docs/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' }), t('Страница восстановлена'));
    if (page) select(page.id);
  }
  async function askDelete(id: string, permanent: boolean) {
    const page = pages.find(item => item.id === id) ?? trash.find(item => item.id === id);
    if (!page || pending) return;
    deleting = { page, permanent };
    deleteError = '';
    await tick();
    if (!alive) return;
    confirmation.showModal();
    confirmation.querySelector<HTMLButtonElement>('[data-cancel-delete]')?.focus();
  }
  function closeDelete() {
    if (removing) return;
    confirmation.close();
    deleting = null;
  }
  async function remove(event: SubmitEvent) {
    event.preventDefault();
    if (!deleting || removing) return;
    const { page, permanent } = deleting;
    removing = true;
    pending = true;
    sequence++;
    deleteError = '';
    try {
      if (permanent) await docsRequest<{ ok: true }>(`/api/docs/${encodeURIComponent(page.id)}/purge`, { method: 'POST', body: '{}' });
      else await docsRequest<{ ok: true }>(`/api/docs/${encodeURIComponent(page.id)}`, { method: 'DELETE' });
      if (!alive) return;
      await load();
      notify(permanent ? t('Страница удалена без возможности восстановления') : t('Страница перенесена в корзину'));
      removing = false;
      closeDelete();
      if (permanent && selectedId === page.id) select(null);
    } catch (failure) {
      if (alive) deleteError = docsFailureMessage(failure);
    } finally {
      if (alive) { removing = false; pending = false; }
    }
  }
  function pageChanged(saved: DocPageSummary) {
    pages = pages.map(page => page.id === saved.id ? { ...page, title: saved.title, updatedAt: saved.updatedAt } : page);
  }
  function scrollToHeading(id: string) {
    const block = document.getElementById(`doc-block-${id}`);
    block?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    block?.querySelector<HTMLElement>('.doc-block-view, .doc-block-text')?.focus({ preventScroll: true });
  }
  function backdropClick(event: MouseEvent) {
    if (event.target !== confirmation) return;
    const rect = confirmation.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDelete();
  }
</script>

<section class="page-heading">
  <div><h1>{t('Документация')}</h1><p>{t('Страницы с блоками и оглавлением: описания проектов, договорённости и заметки, которые удобно держать рядом с задачами.')}</p></div>
  <button class="button primary create-button" disabled={pending || loading || total >= DOC_PAGE_LIMIT} onclick={() => { void create(null); }}><Icon name="plus" size={17} />{t('Новая страница')}</button>
</section>
{#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(); }}>{t('Повторить')}</button></div>{/if}
{#if total >= DOC_PAGE_LIMIT}<p class="field-warning" role="status">{t('Достигнут лимит: {limit} страниц вместе с корзиной. Удалите ненужные страницы, чтобы создать новую.', { limit: DOC_PAGE_LIMIT })}</p>{/if}
<div class="docs-layout">
  <aside class="docs-nav" aria-label={t('Оглавление документации')}>
    <div class="docs-nav-inner">
    <p class="docs-nav-heading">{t('ОГЛАВЛЕНИЕ')}</p>
    <div class="docs-search"><Icon name="search" size={15} /><input type="search" aria-label={t('Поиск по документации')} placeholder={t('Поиск по страницам…')} bind:value={search} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); search = ''; } }} />{#if search}<button type="button" aria-label={t('Очистить поиск')} onclick={() => search = ''}><Icon name="close" size={14} /></button>{/if}</div>
    {#if search.trim()}
      {#if searching && !results}<div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Ищем…')}</div>
      {:else if results?.length}
        <ul class="docs-search-results" aria-label={t('Результаты поиска')}>
          {#each results as hit (hit.id)}<li><button type="button" aria-current={hit.id === selectedId ? 'page' : undefined} onclick={() => pickResult(hit.id)}><strong>{pageTitle(hit)}</strong><small>{#each snippetParts(hit.snippet) as part, index (index)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</small></button></li>{/each}
        </ul>
      {:else}<p class="docs-search-empty" role="status">{t('Ничего не найдено. Ищутся названия и текст блоков.')}</p>{/if}
    {:else if loading}
      <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Загружаем страницы…')}</div>
    {:else}
      <DocsTree nodes={tree} {selectedId} {headings} disabled={pending} onselect={select} oncreate={(id) => { void create(id); }} onmove={move} ondelete={(id) => { void askDelete(id, false); }} onheading={scrollToHeading} />
    {/if}
    {#if trash.length}
      <section class="docs-trash" aria-label={t('Корзина')}>
        <button class="archive-toggle" aria-expanded={trashOpen} onclick={() => trashOpen = !trashOpen}><Icon name={trashOpen ? 'down' : 'chevron'} size={14} /><Icon name="trash" size={14} /><strong>{t('Корзина')}</strong><small>{trash.length}</small></button>
        {#if trashOpen}
          <ul class="docs-trash-list">
            {#each trash as page (page.id)}
              <li class="docs-trash-item" class:selected={page.id === selectedId}>
                <button type="button" class="docs-tree-title" aria-current={page.id === selectedId ? 'page' : undefined} onclick={() => select(page.id)}>{pageTitle(page)}</button>
                <button type="button" class="icon-button" aria-label={t('Восстановить: {title}', { title: pageTitle(page) })} title={t('Восстановить')} disabled={pending} onclick={() => { void restore(page.id); }}><Icon name="restore" size={14} /></button>
                <button type="button" class="icon-button" aria-label={t('Удалить навсегда: {title}', { title: pageTitle(page) })} title={t('Удалить навсегда')} disabled={pending} onclick={() => { void askDelete(page.id, true); }}><Icon name="close" size={14} /></button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
    </div>
  </aside>
  <div class="docs-panel">
    {#if selectedId}
      {#key selectedId}<DocEditor pageId={selectedId} autofocusTitle={createdId === selectedId} trashed={selectedTrashed} {notify} {onopentask} onchanged={pageChanged} onheadings={(items) => headings = items}
        ondelete={selectedLive || selectedInTrash ? (permanent) => { if (selectedId) void askDelete(selectedId, permanent); } : undefined}
        onrestore={selectedInTrash ? () => { if (selectedId) void restore(selectedId); } : undefined} />{/key}
    {:else if !loading && !pages.length}
      <div class="no-results docs-empty"><span class="empty-icon"><Icon name="book" size={27} /></span><h2>{t('Документация рядом с задачами')}</h2><p>{t('Опишите проект, соглашения и процессы. Страницы вкладываются друг в друга, а тип блока меняется через «/».')}</p><button class="button primary" disabled={pending || loading} onclick={() => { void create(null); }}><Icon name="plus" size={16} />{t('Создать первую страницу')}</button></div>
    {:else if !loading}
      <div class="no-results docs-empty"><span class="empty-icon"><Icon name="book" size={27} /></span><h2>{t('Выберите страницу')}</h2><p>{t('Откройте страницу в оглавлении слева или создайте новую.')}</p></div>
    {/if}
  </div>
</div>

<dialog bind:this={confirmation} class="editor-dialog instruction-delete-dialog" aria-labelledby="doc-delete-title" aria-describedby="doc-delete-description" oncancel={(event) => { event.preventDefault(); closeDelete(); }} onclick={backdropClick}>
  {#if deleting}
    <form class="editor-form" onsubmit={remove} aria-busy={removing}>
      <header class="editor-header"><h2 id="doc-delete-title">{deleting.permanent ? t('Удалить страницу навсегда?') : t('Переместить страницу в корзину?')}</h2><button type="button" class="icon-button" aria-label={t('Закрыть удаление')} disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}
        <p id="doc-delete-description">{deleting.permanent ? t('«{title}» и все её подстраницы будут удалены без возможности восстановления.', { title: pageTitle(deleting.page) }) : t('«{title}» вместе с подстраницами попадёт в корзину. Оттуда страницу можно восстановить или удалить навсегда.', { title: pageTitle(deleting.page) })}</p>
      </div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>{t('Отмена')}</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? t('Удаляем…') : deleting.permanent ? t('Удалить навсегда') : t('В корзину')}</button></footer>
    </form>
  {/if}
</dialog>
