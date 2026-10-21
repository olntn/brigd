<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { renderInlineMarkdown } from './markdown';
  import { createDocBlock, DOC_BLOCK_KINDS, DOC_BLOCK_LIMIT, DOC_BLOCK_TEXT_LIMIT, DOC_INDENT_LIMIT, DOC_LANGUAGE_LIMIT, DOC_TITLE_LIMIT, DOC_UNTITLED, docBlockKind, docHeadings, docListNumbers, docRawOffset, docShortcut, isDocListType, retypeDocBlock, type DocHeading, type DocShortcut } from './docs';
  import { docsFailureMessage, docsRequest, DocsRequestError } from './docs-client';
  import type { DocBlock, DocBlockType, DocPage, DocPageSummary } from './types';

  let { pageId, autofocusTitle = false, trashed = false, notify, onchanged, onheadings }: {
    pageId: string;
    autofocusTitle?: boolean;
    /** The sidebar no longer lists the page as live: reload so the editor shows the trash state or the restored page. */
    trashed?: boolean;
    notify: (message: string, type?: 'success' | 'error') => void;
    onchanged: (page: DocPageSummary) => void;
    onheadings: (headings: DocHeading[]) => void;
  } = $props();

  type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
  type Menu = { kind: 'slash' | 'block'; id: string; query: string; active: number };
  const STATUS: Record<SaveState, string> = { saved: 'Сохранено', dirty: 'Есть несохранённые изменения', saving: 'Сохраняем…', error: 'Не удалось сохранить', conflict: 'Страница изменена в другом окне' };
  const SAVE_DELAY = 800;
  let page = $state<DocPage | null>(null);
  let title = $state('');
  let blocks = $state<DocBlock[]>([]);
  let version = 1;
  let loading = $state(true);
  let error = $state('');
  let saveState = $state<SaveState>('saved');
  let saveError = $state('');
  let dirtyWhileSaving = false;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let focused = $state<string | null>(null);
  let menu = $state<Menu | null>(null);
  let dragging = $state<string | null>(null);
  let dropTarget = $state<{ id: string; after: boolean } | null>(null);
  let titleField = $state<HTMLTextAreaElement>();
  let root = $state<HTMLElement>();
  let alive = true;
  const textareas = new Map<string, HTMLTextAreaElement>();
  let readonly = $derived(page?.deletedAt != null);
  let numbers = $derived(docListNumbers(blocks));
  let slashItems = $derived(menu?.kind === 'slash' ? DOC_BLOCK_KINDS.filter(kind => matches(kind.label, kind.keywords, menu!.query)) : []);
  const convertible = DOC_BLOCK_KINDS.filter(kind => kind.type !== 'divider');
  const dateTime = (value: number) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const index = (id: string) => blocks.findIndex(block => block.id === id);
  const placeholders: Record<DocBlockType, string> = {
    paragraph: 'Введите текст. Символ «/» открывает меню блоков', heading1: 'Заголовок 1', heading2: 'Заголовок 2', heading3: 'Заголовок 3',
    bulleted: 'Пункт списка', numbered: 'Пункт списка', todo: 'Задача', quote: 'Цитата', code: 'Код', divider: '',
  };

  function matches(label: string, keywords: string[], query: string): boolean {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return !needle || label.toLocaleLowerCase('ru-RU').includes(needle) || keywords.some(keyword => keyword.startsWith(needle));
  }
  $effect(() => { onheadings(docHeadings(blocks)); });
  let knownTrashed: boolean | null = null;
  $effect(() => {
    const current = trashed;
    if (knownTrashed === null) { knownTrashed = current; return; }
    if (current === knownTrashed) return;
    knownTrashed = current;
    untrack(() => { if (page && !loading) void load(); });
  });

  onMount(() => {
    void load();
    const unload = (event: BeforeUnloadEvent) => { if (saveState === 'dirty' || saveState === 'saving' || dirtyWhileSaving) event.preventDefault(); };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  });
  onDestroy(() => {
    alive = false;
    clearTimeout(timer);
    if (page && !readonly && (saveState === 'dirty' || dirtyWhileSaving)) void flush();
  });

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await docsRequest<DocPage>(`/api/docs/${encodeURIComponent(pageId)}`);
      if (!alive) return;
      page = result;
      title = result.title;
      blocks = result.blocks.length ? result.blocks : [createDocBlock()];
      version = result.version;
      saveState = 'saved';
      saveError = '';
      dirtyWhileSaving = false;
      focused = null;
      menu = null;
      loading = false;
      if (autofocusTitle && !readonly) { await tick(); if (alive) titleField?.focus(); }
    } catch (failure) {
      if (!alive) return;
      error = docsFailureMessage(failure);
      loading = false;
    }
  }
  const payload = () => ({ title, blocks: $state.snapshot(blocks), version });
  function markDirty() {
    if (!page || readonly) return;
    if (saveState === 'saving') { dirtyWhileSaving = true; return; }
    if (saveState === 'conflict') return;
    saveState = 'dirty';
    clearTimeout(timer);
    timer = setTimeout(() => { void save(); }, SAVE_DELAY);
  }
  async function save() {
    if (!page || readonly || saveState === 'saving' || saveState === 'conflict') return;
    clearTimeout(timer);
    saveState = 'saving';
    dirtyWhileSaving = false;
    const body = JSON.stringify(payload());
    inflight = (async () => {
      try {
        const saved = await docsRequest<DocPage>(`/api/docs/${encodeURIComponent(pageId)}`, { method: 'PUT', body });
        version = saved.version;
        if (!alive) return;
        page = saved;
        saveError = '';
        saveState = 'saved';
        onchanged(saved);
        if (dirtyWhileSaving) markDirty();
      } catch (failure) {
        if (!alive) return;
        saveError = docsFailureMessage(failure);
        saveState = failure instanceof DocsRequestError && failure.status === 409 ? 'conflict' : 'error';
      } finally { inflight = null; }
    })();
    await inflight;
  }
  /** Final save when the editor closes: waits for an in-flight save so the version stays current. */
  function flush() {
    const send = () => fetch(`/api/docs/${encodeURIComponent(pageId)}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
      .then(response => response.json().then((result: DocPage) => { if (response.ok) onchanged(result); }))
      .catch(() => { /* The page is gone; the next visit shows what was saved. */ });
    return inflight ? inflight.then(send) : send();
  }

  function autosize(node: HTMLTextAreaElement) {
    node.style.height = '0';
    node.style.height = `${node.scrollHeight}px`;
  }
  function field(node: HTMLTextAreaElement, id: string) {
    textareas.set(id, node);
    autosize(node);
    return { destroy() { if (textareas.get(id) === node) textareas.delete(id); } };
  }
  function grow(node: HTMLTextAreaElement) { autosize(node); }
  async function focusBlock(id: string, caret: number | 'start' | 'end' = 'end') {
    if (readonly) return;
    focused = id;
    await tick();
    if (!alive) return;
    const node = textareas.get(id);
    if (!node) { root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(id)} .doc-divider-line`)?.focus(); return; }
    node.focus();
    const position = caret === 'end' ? node.value.length : caret === 'start' ? 0 : Math.min(caret, node.value.length);
    node.setSelectionRange(position, position);
    autosize(node);
  }
  function blur(id: string) {
    if (focused !== id) return;
    focused = null;
    if (menu?.kind === 'slash' && menu.id === id) menu = null;
  }

  function insertAt(position: number, block: DocBlock): boolean {
    if (blocks.length >= DOC_BLOCK_LIMIT) { notify(`На странице допустимо не больше ${DOC_BLOCK_LIMIT} блоков. Вынесите часть на подстраницу.`, 'error'); return false; }
    blocks.splice(position, 0, block);
    markDirty();
    return true;
  }
  function removeAt(position: number) {
    blocks.splice(position, 1);
    if (!blocks.length) blocks.push(createDocBlock());
    markDirty();
  }
  function retype(position: number, type: DocBlockType): DocBlock {
    blocks[position] = retypeDocBlock(blocks[position]!, type);
    markDirty();
    return blocks[position]!;
  }
  function moveBlock(from: number, to: number) {
    if (to < 0 || to >= blocks.length || from === to) return;
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, block!);
    markDirty();
  }
  function appendBlock() {
    const last = blocks.at(-1);
    if (last && last.type === 'paragraph' && !last.text) { void focusBlock(last.id, 'end'); return; }
    const block = createDocBlock();
    if (insertAt(blocks.length, block)) void focusBlock(block.id, 'start');
  }
  /** Divider blocks are followed by a text block so the caret always has somewhere to go. */
  function afterDivider(position: number) {
    const next = blocks[position + 1];
    if (next && next.type !== 'divider') { void focusBlock(next.id, 'start'); return; }
    const block = createDocBlock();
    if (insertAt(position + 1, block)) void focusBlock(block.id, 'start');
    else focused = null;
  }
  function applyShortcut(position: number, shortcut: DocShortcut) {
    const block = retype(position, shortcut.type);
    block.text = shortcut.rest;
    if (shortcut.type === 'todo') block.checked = shortcut.checked ?? false;
    if (shortcut.type === 'divider') afterDivider(position);
    else void focusBlock(block.id, 'start');
  }
  function applyKind(position: number, type: DocBlockType) {
    const fromSlash = menu?.kind === 'slash';
    closeMenu(!fromSlash);
    const block = retype(position, type);
    if (fromSlash) block.text = '';
    if (type === 'divider') afterDivider(position);
    else void focusBlock(block.id, 'end');
  }

  function keydown(event: KeyboardEvent, block: DocBlock) {
    const node = event.currentTarget as HTMLTextAreaElement;
    const { selectionStart: start, selectionEnd: end, value } = node;
    const position = index(block.id);
    const mod = event.ctrlKey || event.metaKey;
    if (menu?.kind === 'slash' && menu.id === block.id) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = slashItems.length;
        if (count) menu.active = (menu.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const kind = slashItems[menu.active];
        if (kind) applyKind(position, kind.type); else closeMenu(false);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(false); return; }
    }
    if (event.key === 'Escape') { event.preventDefault(); node.blur(); return; }
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const marker = !event.shiftKey && key === 'b' ? '**' : !event.shiftKey && key === 'i' ? '*' : !event.shiftKey && key === 'e' ? '`' : event.shiftKey && key === 's' ? '~~' : null;
      if (marker && block.type !== 'code') { event.preventDefault(); wrap(node, block, marker); return; }
    }
    if (event.altKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      moveBlock(position, position + (event.key === 'ArrowUp' ? -1 : 1));
      void focusBlock(block.id, start);
      return;
    }
    if (event.key === 'Enter') {
      if (block.type === 'code') {
        if (!mod) return;
        event.preventDefault();
        const next = createDocBlock();
        if (insertAt(position + 1, next)) void focusBlock(next.id, 'start');
        return;
      }
      if (event.shiftKey) return;
      event.preventDefault();
      if (value === '' && (isDocListType(block.type) || block.type === 'quote')) {
        if (isDocListType(block.type) && (block.indent ?? 0) > 0) { block.indent = (block.indent ?? 0) - 1; markDirty(); }
        else retype(position, 'paragraph');
        void focusBlock(block.id, 'start');
        return;
      }
      block.text = value.slice(0, start);
      const type = isDocListType(block.type) || block.type === 'quote' ? block.type : 'paragraph';
      const next = createDocBlock(type, value.slice(end));
      if (isDocListType(type)) next.indent = block.indent ?? 0;
      if (insertAt(position + 1, next)) void focusBlock(next.id, 'start');
      else markDirty();
      return;
    }
    if (event.key === 'Backspace' && start === 0 && end === 0) {
      if (block.type !== 'paragraph' && (block.type !== 'code' || value === '')) {
        event.preventDefault();
        retype(position, 'paragraph');
        void focusBlock(block.id, 'start');
        return;
      }
      if (position === 0 || block.type === 'code') return;
      const previous = blocks[position - 1]!;
      event.preventDefault();
      if (previous.type === 'divider') { blocks.splice(position - 1, 1); markDirty(); void focusBlock(block.id, 'start'); return; }
      if (previous.type === 'code') { if (value === '') { removeAt(position); void focusBlock(previous.id, 'end'); } return; }
      if (previous.text.length + value.length > DOC_BLOCK_TEXT_LIMIT) { notify(`Вместе блоки превысят ${DOC_BLOCK_TEXT_LIMIT} символов. Сократите текст перед объединением.`, 'error'); return; }
      const caret = previous.text.length;
      previous.text += value;
      blocks.splice(position, 1);
      markDirty();
      void focusBlock(previous.id, caret);
      return;
    }
    if (event.key === 'Delete' && start === value.length && end === value.length && position < blocks.length - 1) {
      const next = blocks[position + 1]!;
      if (next.type === 'divider') { event.preventDefault(); blocks.splice(position + 1, 1); markDirty(); return; }
      if (next.type === 'code' || block.type === 'code') return;
      event.preventDefault();
      if (value.length + next.text.length > DOC_BLOCK_TEXT_LIMIT) { notify(`Вместе блоки превысят ${DOC_BLOCK_TEXT_LIMIT} символов. Сократите текст перед объединением.`, 'error'); return; }
      block.text += next.text;
      blocks.splice(position + 1, 1);
      markDirty();
      void focusBlock(block.id, start);
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !mod && value.lastIndexOf('\n', start - 1) === -1) {
      if (position > 0) { event.preventDefault(); void focusBlock(blocks[position - 1]!.id, 'end'); }
      else { event.preventDefault(); titleField?.focus(); }
      return;
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && !mod && value.indexOf('\n', end) === -1) {
      if (position < blocks.length - 1) { event.preventDefault(); void focusBlock(blocks[position + 1]!.id, 'start'); }
      return;
    }
    if (event.key === 'Tab') {
      if (isDocListType(block.type)) {
        event.preventDefault();
        const indent = Math.max(0, Math.min(DOC_INDENT_LIMIT, (block.indent ?? 0) + (event.shiftKey ? -1 : 1)));
        if (indent !== (block.indent ?? 0)) { block.indent = indent; markDirty(); }
      } else if (block.type === 'code' && !event.shiftKey) {
        event.preventDefault();
        node.setRangeText('  ', start, end, 'end');
        block.text = node.value;
        autosize(node);
        markDirty();
      }
    }
  }
  function wrap(node: HTMLTextAreaElement, block: DocBlock, marker: string) {
    const { selectionStart: start, selectionEnd: end, value } = node;
    const selected = value.slice(start, end);
    if (!selected) {
      node.setRangeText(marker + marker, start, end, 'end');
      node.setSelectionRange(start + marker.length, start + marker.length);
    } else {
      const unwrapped = selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker) ? selected.slice(marker.length, -marker.length) : null;
      node.setRangeText(unwrapped ?? marker + selected + marker, start, end, 'select');
    }
    block.text = node.value;
    autosize(node);
    markDirty();
  }
  function input(event: Event, block: DocBlock) {
    const node = event.currentTarget as HTMLTextAreaElement;
    autosize(node);
    const value = node.value;
    block.text = value;
    if (menu?.kind === 'slash' && menu.id === block.id) {
      if (!value.startsWith('/') || value.length > 30 || value.includes('\n')) closeMenu(false);
      else { menu.query = value.slice(1); menu.active = 0; }
    } else if (value === '/' && block.type !== 'code' && node.selectionStart === 1) {
      menu = { kind: 'slash', id: block.id, query: '', active: 0 };
    } else if (block.type !== 'code') {
      const shortcut = docShortcut(value);
      if (shortcut && node.selectionStart === value.length - shortcut.rest.length) { applyShortcut(index(block.id), shortcut); return; }
    }
    markDirty();
  }
  function languageInput(event: Event, block: DocBlock) {
    const node = event.currentTarget as HTMLInputElement;
    const clean = node.value.replace(/[^A-Za-z0-9+#._-]/g, '').slice(0, DOC_LANGUAGE_LIMIT);
    if (clean !== node.value) node.value = clean;
    block.language = clean;
    markDirty();
  }
  function titleInput(event: Event) {
    const node = event.currentTarget as HTMLTextAreaElement;
    if (node.value.includes('\n')) node.value = node.value.replace(/\n+/g, ' ');
    title = node.value;
    autosize(node);
    markDirty();
  }
  function titleKey(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const first = blocks[0];
    if (first) void focusBlock(first.id, 'start');
  }
  function dividerKey(event: KeyboardEvent, block: DocBlock) {
    const position = index(block.id);
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      removeAt(position);
      const target = blocks[Math.min(position, blocks.length - 1)];
      if (target) void focusBlock(target.id, event.key === 'Backspace' ? 'end' : 'start');
    } else if (event.key === 'ArrowUp' && position > 0) { event.preventDefault(); void focusBlock(blocks[position - 1]!.id, 'end'); }
    else if (event.key === 'ArrowDown' && position < blocks.length - 1) { event.preventDefault(); void focusBlock(blocks[position + 1]!.id, 'start'); }
    else if (event.key === 'Enter') { event.preventDefault(); const next = createDocBlock(); if (insertAt(position + 1, next)) void focusBlock(next.id, 'start'); }
  }
  /** Clicking rendered text opens the raw Markdown with the caret near the clicked character. */
  function viewClick(event: MouseEvent, block: DocBlock) {
    if (readonly) return;
    if (event.target instanceof HTMLAnchorElement) return;
    const node = event.currentTarget as HTMLElement;
    let visible = block.text.length;
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const caret = !range && 'caretPositionFromPoint' in document ? (document as Document & { caretPositionFromPoint(x: number, y: number): { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(event.clientX, event.clientY) : null;
    const anchor = range ? { node: range.startContainer, offset: range.startOffset } : caret ? { node: caret.offsetNode, offset: caret.offset } : null;
    if (anchor && node.contains(anchor.node)) {
      const measure = document.createRange();
      measure.setStart(node, 0);
      measure.setEnd(anchor.node, anchor.offset);
      visible = measure.toString().length;
    }
    void focusBlock(block.id, block.type === 'code' ? visible : docRawOffset(block.text, visible));
  }
  function viewKey(event: KeyboardEvent, block: DocBlock) {
    if (readonly) return;
    if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); void focusBlock(block.id, 'end'); }
  }

  async function openBlockMenu(id: string) {
    menu = menu?.kind === 'block' && menu.id === id ? null : { kind: 'block', id, query: '', active: 0 };
    await tick();
    root?.querySelector<HTMLButtonElement>('.doc-block-menu button:not(:disabled)')?.focus();
  }
  function closeMenu(restoreFocus: boolean) {
    const id = menu?.id;
    const kind = menu?.kind;
    menu = null;
    if (restoreFocus && kind === 'block' && id) root?.querySelector<HTMLButtonElement>(`[data-doc-handle="${CSS.escape(id)}"]`)?.focus();
  }
  function menuKey(event: KeyboardEvent) {
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); items[(current + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
    else if (event.key === 'Tab') closeMenu(false);
  }
  function outside(event: PointerEvent) {
    if (menu?.kind !== 'block' || !(event.target instanceof Element)) return;
    if (!root?.querySelector('.doc-block-menu')?.contains(event.target) && !event.target.closest('[data-doc-handle]')) closeMenu(false);
  }

  function dragStart(event: DragEvent, id: string) {
    dragging = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(event: DragEvent, id: string) {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (dragging === id) { dropTarget = null; return; }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropTarget = { id, after: event.clientY > rect.top + rect.height / 2 };
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    if (dragging && dropTarget) {
      const from = index(dragging);
      let to = index(dropTarget.id) + (dropTarget.after ? 1 : 0);
      if (from < to) to--;
      moveBlock(from, to);
    }
    dragEnd();
  }
  function dragEnd() { dragging = null; dropTarget = null; }
  const viewPlaceholder = (position: number) => blocks.length === 1 && position === 0 && !readonly ? 'Нажмите сюда и начните писать. Символ «/» открывает меню блоков.' : '';
</script>

<svelte:window onpointerdown={outside} />

{#if loading}
  <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />Загружаем страницу…</div>
{:else if error}
  <div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(); }}>Повторить</button></div>
{:else if page}
  <article bind:this={root} class="doc-page" aria-label={'Страница: ' + (title.trim() || DOC_UNTITLED)}>
    {#if readonly}<div class="field-warning doc-notice" role="status"><Icon name="alert" size={16} /><span>Страница в корзине. Восстановите её в оглавлении, чтобы редактировать.</span></div>{/if}
    {#if saveState === 'conflict'}
      <div class="connection-error doc-notice" role="alert"><Icon name="alert" size={17} /><span>{saveError}</span><button onclick={() => { void load(); }}>Загрузить новую версию</button></div>
    {:else if saveState === 'error'}
      <div class="connection-error doc-notice" role="alert"><Icon name="alert" size={17} /><span>{saveError}</span><button onclick={() => { void save(); }}>Повторить</button></div>
    {/if}
    <textarea bind:this={titleField} class="doc-title" rows="1" aria-label="Название страницы" placeholder={DOC_UNTITLED} maxlength={DOC_TITLE_LIMIT} value={title} disabled={readonly} use:grow oninput={titleInput} onkeydown={titleKey}></textarea>
    <div class="doc-meta"><span class="doc-status doc-status-{saveState}" role="status">{readonly ? 'Только чтение' : STATUS[saveState]}</span><span>Обновлено {dateTime(page.updatedAt)}</span></div>
    <div class="doc-blocks">
      {#each blocks as block, position (block.id)}
        {@const kind = docBlockKind(block.type)}
        {@const editing = focused === block.id && !readonly}
        <div id="doc-block-{block.id}" class="doc-block doc-{block.type}" class:checked={block.type === 'todo' && block.checked} class:editing class:dragging={dragging === block.id}
          class:drop-before={dropTarget?.id === block.id && !dropTarget.after} class:drop-after={dropTarget?.id === block.id && dropTarget.after}
          style:--indent={block.indent ?? 0} role="group" aria-label={kind.label + ' ' + (position + 1)} ondragover={(event) => dragOver(event, block.id)} ondrop={drop}>
          <button type="button" class="doc-block-handle" data-doc-handle={block.id} aria-label={'Действия с блоком ' + (position + 1) + ': ' + kind.label} aria-haspopup="menu" aria-expanded={menu?.kind === 'block' && menu.id === block.id} title="Перетащите или откройте меню" draggable="true" disabled={readonly} ondragstart={(event) => dragStart(event, block.id)} ondragend={dragEnd} onclick={() => { void openBlockMenu(block.id); }}><Icon name="grip" size={15} /></button>
          <div class="doc-block-body">
            {#if block.type === 'divider'}
              <!-- The separator is selected and removed from the keyboard like any other block. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <div class="doc-divider-line" role="separator" tabindex={readonly ? -1 : 0} aria-label="Разделитель" onkeydown={(event) => dividerKey(event, block)}><hr /></div>
            {:else}
              {#if block.type === 'bulleted'}<span class="doc-block-marker" aria-hidden="true">•</span>
              {:else if block.type === 'numbered'}<span class="doc-block-marker" aria-hidden="true">{numbers.get(block.id) ?? 1}.</span>
              {:else if block.type === 'todo'}<input type="checkbox" class="doc-todo-box" aria-label="Отметить пункт" checked={block.checked ?? false} disabled={readonly} onchange={(event) => { block.checked = event.currentTarget.checked; markDirty(); }} />{/if}
              <div class="doc-block-content">
                {#if editing}
                  <textarea class="doc-block-text" rows="1" aria-label={kind.label} placeholder={placeholders[block.type]} maxlength={DOC_BLOCK_TEXT_LIMIT} value={block.text} spellcheck={block.type !== 'code'} use:field={block.id} oninput={(event) => input(event, block)} onkeydown={(event) => keydown(event, block)} onblur={() => blur(block.id)}></textarea>
                {:else if block.type === 'code'}
                  <div class="doc-block-view doc-code-view" class:empty={!block.text} role="textbox" aria-label={kind.label} tabindex={readonly ? -1 : 0} data-placeholder={placeholders.code} onclick={(event) => viewClick(event, block)} onkeydown={(event) => viewKey(event, block)}>{block.text}</div>
                {:else}
                  <div class="doc-block-view" class:empty={!block.text} role="textbox" aria-label={kind.label} tabindex={readonly ? -1 : 0} data-placeholder={viewPlaceholder(position)} onclick={(event) => viewClick(event, block)} onkeydown={(event) => viewKey(event, block)}>{@html renderInlineMarkdown(block.text)}</div>
                {/if}
                {#if block.type === 'code'}<input class="doc-code-language" aria-label="Язык кода" placeholder="язык" maxlength={DOC_LANGUAGE_LIMIT} value={block.language ?? ''} disabled={readonly} oninput={(event) => languageInput(event, block)} />{/if}
              </div>
            {/if}
          </div>
          {#if menu?.kind === 'slash' && menu.id === block.id}
            <div class="doc-block-menu" role="listbox" aria-label="Тип блока">
              {#each slashItems as item, option (item.type)}
                <button type="button" role="option" aria-selected={option === menu.active} class:active={option === menu.active} tabindex="-1" onmousedown={(event) => event.preventDefault()} onclick={() => applyKind(position, item.type)}><span class="doc-menu-label">{item.label}<small>{item.hint}</small></span>{#if item.shortcut}<kbd>{item.shortcut.trim()}</kbd>{/if}</button>
              {:else}<p class="doc-menu-empty">Ничего не найдено. Esc закрывает меню.</p>{/each}
            </div>
          {:else if menu?.kind === 'block' && menu.id === block.id}
            <div class="doc-block-menu" role="menu" tabindex="-1" aria-label={'Действия с блоком ' + (position + 1)} onkeydown={menuKey}>
              <p class="doc-menu-heading">Превратить в</p>
              {#each convertible as item (item.type)}<button type="button" role="menuitem" class:current={item.type === block.type} onclick={() => applyKind(position, item.type)}>{item.label}{#if item.type === block.type}<Icon name="check" size={14} />{/if}</button>{/each}
              <hr />
              <button type="button" role="menuitem" disabled={position === 0} onclick={() => { closeMenu(true); moveBlock(position, position - 1); }}>Переместить выше</button>
              <button type="button" role="menuitem" disabled={position === blocks.length - 1} onclick={() => { closeMenu(true); moveBlock(position, position + 1); }}>Переместить ниже</button>
              <button type="button" role="menuitem" class="danger" onclick={() => { closeMenu(false); removeAt(position); const target = blocks[Math.min(position, blocks.length - 1)]; if (target) void focusBlock(target.id, 'end'); }}><Icon name="trash" size={14} />Удалить блок</button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if !readonly}<button type="button" class="doc-add-block" onclick={appendBlock}><Icon name="plus" size={14} />Добавить блок</button>{/if}
  </article>
{/if}
