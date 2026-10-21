<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { renderInlineMarkdown } from './markdown';
  import { TASK_STATUS_LABELS } from './status';
  import { createDocBlock, DOC_BLOCK_KINDS, DOC_BLOCK_LIMIT, DOC_BLOCK_TEXT_LIMIT, DOC_CALLOUT_COLOR_LABELS, DOC_CALLOUT_COLORS, DOC_CALLOUT_ICONS, DOC_INDENT_LIMIT, DOC_LANGUAGE_LIMIT, DOC_TABLE_CELL_LIMIT, DOC_TABLE_COLUMN_LIMIT, DOC_TABLE_ROW_LIMIT, DOC_TITLE_LIMIT, DOC_UNTITLED, docBlockKind, docHeadings, docHiddenBlockIds, docListNumbers, docRawOffset, docShortcut, isDocListType, isDocTextType, retypeDocBlock, type DocHeading, type DocShortcut } from './docs';
  import { docsFailureMessage, docsRequest, DocsRequestError } from './docs-client';
  import type { DocBlock, DocBlockType, DocImage, DocPage, DocPageSummary, Task, TaskDetail } from './types';

  let { pageId, autofocusTitle = false, trashed = false, notify, onchanged, onheadings, onopentask }: {
    pageId: string;
    autofocusTitle?: boolean;
    /** The sidebar no longer lists the page as live: reload so the editor shows the trash state or the restored page. */
    trashed?: boolean;
    notify: (message: string, type?: 'success' | 'error') => void;
    onchanged: (page: DocPageSummary) => void;
    onheadings: (headings: DocHeading[]) => void;
    onopentask?: (id: string) => void;
  } = $props();

  type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
  type Menu = { kind: 'slash' | 'block'; id: string; query: string; active: number };
  type Snapshot = { blocks: DocBlock[]; focused: string | null };
  const STATUS: Record<SaveState, string> = { saved: 'Сохранено', dirty: 'Есть несохранённые изменения', saving: 'Сохраняем…', error: 'Не удалось сохранить', conflict: 'Страница изменена в другом окне' };
  const SAVE_DELAY = 800;
  const UNDO_LIMIT = 50;
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
  let focusValue = '';
  let menu = $state<Menu | null>(null);
  let dragging = $state<string | null>(null);
  let dropTarget = $state<{ id: string; after: boolean } | null>(null);
  let tableCell = $state<{ id: string; row: number; column: number } | null>(null);
  let uploading = $state<string | null>(null);
  let taskSearch = $state<{ id: string; query: string } | null>(null);
  let taskList = $state<Task[] | null>(null);
  let taskCards = $state<Record<string, Task | null>>({});
  let titleField = $state<HTMLTextAreaElement>();
  let root = $state<HTMLElement>();
  let fileInput = $state<HTMLInputElement>();
  let uploadTarget: string | null = null;
  let alive = true;
  const textareas = new Map<string, HTMLTextAreaElement>();
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  let readonly = $derived(page?.deletedAt != null);
  let numbers = $derived(docListNumbers(blocks));
  let hidden = $derived(docHiddenBlockIds(blocks));
  let headings = $derived(docHeadings(blocks));
  let slashItems = $derived(menu?.kind === 'slash' ? DOC_BLOCK_KINDS.filter(kind => matches(kind.label, kind.keywords, menu!.query)) : []);
  let taskMatches = $derived(taskSearch && taskList ? taskList.filter(task => matchesTask(task, taskSearch!.query)).slice(0, 8) : []);
  const convertible = DOC_BLOCK_KINDS.filter(kind => isDocTextType(kind.type));
  const dateTime = (value: number) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  const shortId = (id: string) => id.slice(0, 8).toUpperCase();
  const index = (id: string) => blocks.findIndex(block => block.id === id);
  const placeholders: Record<DocBlockType, string> = {
    paragraph: 'Введите текст. Символ «/» открывает меню блоков', heading1: 'Заголовок 1', heading2: 'Заголовок 2', heading3: 'Заголовок 3',
    bulleted: 'Пункт списка', numbered: 'Пункт списка', todo: 'Задача', quote: 'Цитата', code: 'Код', divider: '',
    callout: 'Текст выноски', toggle: 'Название раскрывающегося блока', table: '', image: 'Подпись к изображению', toc: '', task: '',
  };

  function matches(label: string, keywords: string[], query: string): boolean {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return !needle || label.toLocaleLowerCase('ru-RU').includes(needle) || keywords.some(keyword => keyword.startsWith(needle));
  }
  function matchesTask(task: Task, query: string): boolean {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return !needle || task.title.toLocaleLowerCase('ru-RU').includes(needle) || task.id.toLowerCase().startsWith(needle.toLowerCase()) || shortId(task.id).startsWith(needle.toUpperCase());
  }
  $effect(() => { onheadings(headings); });
  let knownTrashed: boolean | null = null;
  $effect(() => {
    const current = trashed;
    if (knownTrashed === null) { knownTrashed = current; return; }
    if (current === knownTrashed) return;
    knownTrashed = current;
    untrack(() => { if (page && !loading) void load(); });
  });
  // Task cards referenced by blocks are read once per editor and refreshed on demand.
  $effect(() => {
    const ids = blocks.flatMap(block => block.type === 'task' && block.taskId ? [block.taskId] : []);
    untrack(() => { for (const id of ids) if (!(id in taskCards)) void loadTaskCard(id); });
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
      tableCell = null;
      taskSearch = null;
      undoStack.length = 0;
      redoStack.length = 0;
      loading = false;
      if (autofocusTitle && !readonly) { await tick(); if (alive) titleField?.focus(); }
    } catch (failure) {
      if (!alive) return;
      error = docsFailureMessage(failure);
      loading = false;
    }
  }
  async function loadTaskCard(id: string) {
    taskCards[id] = taskList?.find(task => task.id === id) ?? null;
    try {
      const detail = await docsRequest<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
      if (alive) taskCards[id] = detail.task;
    } catch { if (alive) taskCards[id] = null; }
  }
  async function ensureTasks() {
    try {
      const list = await docsRequest<Task[]>('/api/tasks');
      if (alive) taskList = list;
    } catch (failure) { if (alive) notify(docsFailureMessage(failure), 'error'); }
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

  /** Structural changes are undone as whole snapshots; typing inside a block keeps the browser's own undo. */
  function remember() {
    undoStack.push({ blocks: $state.snapshot(blocks) as DocBlock[], focused });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(from: Snapshot[], to: Snapshot[]) {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push({ blocks: $state.snapshot(blocks) as DocBlock[], focused });
    blocks = snapshot.blocks;
    menu = null;
    tableCell = null;
    markDirty();
    if (snapshot.focused && blocks.some(block => block.id === snapshot.focused)) void focusBlock(snapshot.focused, 'end');
    else focused = null;
  }
  const undo = () => restore(undoStack, redoStack);
  const redo = () => restore(redoStack, undoStack);
  function rootKey(event: KeyboardEvent) {
    if (readonly || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (key === 'y') { event.preventDefault(); redo(); }
  }

  function autosize(node: HTMLTextAreaElement) {
    node.style.height = '0';
    node.style.height = `${node.scrollHeight}px`;
  }
  function field(node: HTMLTextAreaElement, id: string) {
    textareas.set(id, node);
    autosize(node);
    const onFocus = () => { focusValue = node.value; };
    node.addEventListener('focus', onFocus);
    return { destroy() { node.removeEventListener('focus', onFocus); if (textareas.get(id) === node) textareas.delete(id); } };
  }
  function grow(node: HTMLTextAreaElement) { autosize(node); }
  async function focusBlock(id: string, caret: number | 'start' | 'end' = 'end') {
    if (readonly) return;
    focused = id;
    await tick();
    if (!alive) return;
    const node = textareas.get(id);
    if (!node) { root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(id)} .doc-block-focus`)?.focus(); return; }
    node.focus();
    const position = caret === 'end' ? node.value.length : caret === 'start' ? 0 : Math.min(caret, node.value.length);
    node.setSelectionRange(position, position);
    autosize(node);
    focusValue = node.value;
  }
  function blur(id: string) {
    if (focused !== id) return;
    focused = null;
    if (menu?.kind === 'slash' && menu.id === id) menu = null;
  }
  const visibleNeighbour = (position: number, step: -1 | 1): DocBlock | null => {
    for (let next = position + step; next >= 0 && next < blocks.length; next += step) if (!hidden.has(blocks[next]!.id)) return blocks[next]!;
    return null;
  };

  function insertAt(position: number, block: DocBlock, track = true): boolean {
    if (blocks.length >= DOC_BLOCK_LIMIT) { notify(`На странице допустимо не больше ${DOC_BLOCK_LIMIT} блоков. Вынесите часть на подстраницу.`, 'error'); return false; }
    if (track) remember();
    blocks.splice(position, 0, block);
    markDirty();
    return true;
  }
  function removeAt(position: number, track = true) {
    if (track) remember();
    blocks.splice(position, 1);
    if (!blocks.length) blocks.push(createDocBlock());
    markDirty();
  }
  function retype(position: number, type: DocBlockType, track = true): DocBlock {
    if (track) remember();
    blocks[position] = retypeDocBlock(blocks[position]!, type);
    markDirty();
    return blocks[position]!;
  }
  function moveBlock(from: number, to: number) {
    if (to < 0 || to >= blocks.length || from === to) return;
    remember();
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, block!);
    markDirty();
  }
  function setIndent(block: DocBlock, indent: number) {
    const next = Math.max(0, Math.min(DOC_INDENT_LIMIT, indent));
    if (next === (block.indent ?? 0)) return;
    remember();
    if (next) block.indent = next; else delete block.indent;
    markDirty();
  }
  function appendBlock() {
    const last = blocks.at(-1);
    if (last && last.type === 'paragraph' && !last.text) { void focusBlock(last.id, 'end'); return; }
    const block = createDocBlock();
    if (insertAt(blocks.length, block)) void focusBlock(block.id, 'start');
  }
  /** Blocks without a text field are followed by a paragraph so the caret always has somewhere to go. */
  function afterStructural(position: number, block: DocBlock) {
    if (block.type === 'table') { tableCell = { id: block.id, row: 0, column: 0 }; focused = null; void focusCell(); return; }
    if (block.type === 'task') { taskSearch = { id: block.id, query: '' }; focused = null; void ensureTasks(); void tick().then(() => root?.querySelector<HTMLInputElement>(`#doc-block-${CSS.escape(block.id)} .doc-task-search`)?.focus()); return; }
    if (block.type === 'image') { focused = null; void tick().then(() => root?.querySelector<HTMLButtonElement>(`#doc-block-${CSS.escape(block.id)} .doc-image-upload`)?.focus()); return; }
    const next = blocks[position + 1];
    if (next && isDocTextType(next.type)) { void focusBlock(next.id, 'start'); return; }
    const paragraph = createDocBlock();
    if (insertAt(position + 1, paragraph, false)) void focusBlock(paragraph.id, 'start');
    else focused = null;
  }
  function applyShortcut(position: number, shortcut: DocShortcut) {
    const block = retype(position, shortcut.type);
    block.text = shortcut.rest;
    if (shortcut.type === 'todo') block.checked = shortcut.checked ?? false;
    if (isDocTextType(shortcut.type)) void focusBlock(block.id, 'start'); else afterStructural(position, block);
  }
  function applyKind(position: number, type: DocBlockType) {
    const fromSlash = menu?.kind === 'slash';
    closeMenu(!fromSlash);
    const block = retype(position, type);
    if (fromSlash) block.text = '';
    if (isDocTextType(type)) void focusBlock(block.id, 'end'); else afterStructural(position, block);
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
      if (key === 'z' && value === focusValue) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (key === 'y' && value === focusValue) { event.preventDefault(); redo(); return; }
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
      if (value === '' && (isDocListType(block.type) || block.type === 'quote' || block.type === 'callout')) {
        if ((block.indent ?? 0) > 0) setIndent(block, (block.indent ?? 0) - 1);
        else retype(position, 'paragraph');
        void focusBlock(block.id, 'start');
        return;
      }
      remember();
      block.text = value.slice(0, start);
      const type = isDocListType(block.type) || block.type === 'quote' ? block.type : 'paragraph';
      const next = createDocBlock(type, value.slice(end));
      const indent = block.type === 'toggle' && !block.collapsed ? Math.min(DOC_INDENT_LIMIT, (block.indent ?? 0) + 1) : block.indent ?? 0;
      if (indent) next.indent = indent;
      if (insertAt(position + 1, next, false)) void focusBlock(next.id, 'start');
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
      if ((block.indent ?? 0) > 0 && block.type === 'paragraph') { event.preventDefault(); setIndent(block, (block.indent ?? 0) - 1); void focusBlock(block.id, 'start'); return; }
      if (block.type === 'code') return;
      const previous = visibleNeighbour(position, -1);
      if (!previous) return;
      event.preventDefault();
      if (!isDocTextType(previous.type)) {
        if (previous.type === 'divider') { removeAt(index(previous.id)); void focusBlock(block.id, 'start'); }
        else if (value === '') { removeAt(position); focused = null; root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(previous.id)} .doc-block-focus`)?.focus(); }
        return;
      }
      if (previous.type === 'code') { if (value === '') { removeAt(position); void focusBlock(previous.id, 'end'); } return; }
      if (previous.text.length + value.length > DOC_BLOCK_TEXT_LIMIT) { notify(`Вместе блоки превысят ${DOC_BLOCK_TEXT_LIMIT} символов. Сократите текст перед объединением.`, 'error'); return; }
      remember();
      const caret = previous.text.length;
      previous.text += value;
      blocks.splice(position, 1);
      markDirty();
      void focusBlock(previous.id, caret);
      return;
    }
    if (event.key === 'Delete' && start === value.length && end === value.length) {
      const next = visibleNeighbour(position, 1);
      if (!next) return;
      if (next.type === 'divider') { event.preventDefault(); removeAt(index(next.id)); return; }
      if (!isDocTextType(next.type) || next.type === 'code' || block.type === 'code') return;
      event.preventDefault();
      if (value.length + next.text.length > DOC_BLOCK_TEXT_LIMIT) { notify(`Вместе блоки превысят ${DOC_BLOCK_TEXT_LIMIT} символов. Сократите текст перед объединением.`, 'error'); return; }
      remember();
      block.text += next.text;
      blocks.splice(index(next.id), 1);
      markDirty();
      void focusBlock(block.id, start);
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !mod && value.lastIndexOf('\n', start - 1) === -1) {
      const previous = visibleNeighbour(position, -1);
      event.preventDefault();
      if (previous) void focusBlock(previous.id, 'end'); else titleField?.focus();
      return;
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && !mod && value.indexOf('\n', end) === -1) {
      const next = visibleNeighbour(position, 1);
      if (next) { event.preventDefault(); void focusBlock(next.id, 'start'); }
      return;
    }
    if (event.key === 'Tab') {
      if (block.type === 'code' && !event.shiftKey) {
        event.preventDefault();
        node.setRangeText('  ', start, end, 'end');
        block.text = node.value;
        autosize(node);
        markDirty();
      } else {
        event.preventDefault();
        setIndent(block, (block.indent ?? 0) + (event.shiftKey ? -1 : 1));
      }
    }
  }
  function wrap(node: HTMLTextAreaElement, block: DocBlock, marker: string) {
    const { selectionStart: start, selectionEnd: end, value } = node;
    const selected = value.slice(start, end);
    remember();
    if (!selected) {
      node.setRangeText(marker + marker, start, end, 'end');
      node.setSelectionRange(start + marker.length, start + marker.length);
    } else {
      const unwrapped = selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker) ? selected.slice(marker.length, -marker.length) : null;
      node.setRangeText(unwrapped ?? marker + selected + marker, start, end, 'select');
    }
    block.text = node.value;
    focusValue = node.value;
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
    const first = blocks.find(block => !hidden.has(block.id));
    if (first) { if (isDocTextType(first.type)) void focusBlock(first.id, 'start'); else root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(first.id)} .doc-block-focus`)?.focus(); }
  }
  /** Blocks without a text field: Backspace or Delete removes them, arrows move on, Enter adds a paragraph below. */
  function structuralKey(event: KeyboardEvent, block: DocBlock) {
    if (readonly || event.target !== event.currentTarget) return;
    const position = index(block.id);
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      removeAt(position);
      const target = blocks[Math.min(position, blocks.length - 1)];
      if (target) { if (isDocTextType(target.type)) void focusBlock(target.id, event.key === 'Backspace' ? 'end' : 'start'); else void tick().then(() => root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(target.id)} .doc-block-focus`)?.focus()); }
    } else if (event.key === 'ArrowUp') { const previous = visibleNeighbour(position, -1); if (previous) { event.preventDefault(); if (isDocTextType(previous.type)) void focusBlock(previous.id, 'end'); else root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(previous.id)} .doc-block-focus`)?.focus(); } }
    else if (event.key === 'ArrowDown') { const next = visibleNeighbour(position, 1); if (next) { event.preventDefault(); if (isDocTextType(next.type)) void focusBlock(next.id, 'start'); else root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(next.id)} .doc-block-focus`)?.focus(); } }
    else if (event.key === 'Enter') { event.preventDefault(); const next = createDocBlock(); if (block.indent) next.indent = block.indent; if (insertAt(position + 1, next)) void focusBlock(next.id, 'start'); }
  }
  /** Clicking rendered text opens the raw Markdown with the caret near the clicked character. */
  function viewClick(event: MouseEvent, block: DocBlock) {
    if (readonly) return;
    if (event.target instanceof HTMLAnchorElement) return;
    const node = event.currentTarget as HTMLElement;
    let visible = block.text.length;
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    const caret = !range && typeof document.caretPositionFromPoint === 'function' ? document.caretPositionFromPoint(event.clientX, event.clientY) : null;
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

  function toggleCollapse(block: DocBlock) {
    block.collapsed = !block.collapsed;
    markDirty();
  }
  function cycleIcon(block: DocBlock) {
    const current = DOC_CALLOUT_ICONS.indexOf(block.icon ?? '');
    block.icon = DOC_CALLOUT_ICONS[(current + 1) % DOC_CALLOUT_ICONS.length];
    markDirty();
  }
  // Tables: one cell edits at a time; the rest render their Markdown.
  async function focusCell() {
    await tick();
    const input = root?.querySelector<HTMLInputElement>('.doc-cell-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function editCell(block: DocBlock, row: number, column: number) {
    if (readonly) return;
    tableCell = { id: block.id, row, column };
    focused = null;
    void focusCell();
  }
  function cellInput(event: Event, block: DocBlock, row: number, column: number) {
    const node = event.currentTarget as HTMLInputElement;
    block.rows![row]![column] = node.value;
    markDirty();
  }
  function cellKey(event: KeyboardEvent, block: DocBlock, row: number, column: number) {
    const rows = block.rows!;
    if (event.key === 'Escape') { event.preventDefault(); tableCell = null; root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(block.id)} .doc-block-focus`)?.focus(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (row === rows.length - 1) { if (!addRow(block)) return; }
      tableCell = { id: block.id, row: row + 1, column };
      void focusCell();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const width = rows[0]!.length;
      const flat = row * width + column + (event.shiftKey ? -1 : 1);
      if (flat < 0 || flat >= rows.length * width) { tableCell = null; return; }
      tableCell = { id: block.id, row: Math.floor(flat / width), column: flat % width };
      void focusCell();
    }
  }
  function addRow(block: DocBlock): boolean {
    if (block.rows!.length >= DOC_TABLE_ROW_LIMIT) { notify(`В таблице не больше ${DOC_TABLE_ROW_LIMIT} строк`, 'error'); return false; }
    remember();
    block.rows!.push(block.rows![0]!.map(() => ''));
    markDirty();
    return true;
  }
  function addColumn(block: DocBlock) {
    if (block.rows![0]!.length >= DOC_TABLE_COLUMN_LIMIT) { notify(`В таблице не больше ${DOC_TABLE_COLUMN_LIMIT} столбцов`, 'error'); return; }
    remember();
    for (const row of block.rows!) row.push('');
    markDirty();
  }
  function removeRow(block: DocBlock) {
    if (block.rows!.length <= 1) return;
    remember();
    block.rows!.pop();
    if (tableCell?.id === block.id && tableCell.row >= block.rows!.length) tableCell = null;
    markDirty();
  }
  function removeColumn(block: DocBlock) {
    if (block.rows![0]!.length <= 1) return;
    remember();
    for (const row of block.rows!) row.pop();
    if (tableCell?.id === block.id && tableCell.column >= block.rows![0]!.length) tableCell = null;
    markDirty();
  }
  // Images are uploaded to the page first; the block then points at the stored copy.
  function pickImage(block: DocBlock) {
    uploadTarget = block.id;
    fileInput?.click();
  }
  async function uploadImage(event: Event) {
    const node = event.currentTarget as HTMLInputElement;
    const file = node.files?.[0];
    const id = uploadTarget;
    node.value = '';
    uploadTarget = null;
    if (!file || !id || uploading) return;
    uploading = id;
    try {
      const response = await fetch(`/api/docs/${encodeURIComponent(pageId)}/images?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      let result: DocImage & { error?: string };
      try { result = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
      if (!response.ok) throw new Error(result.error || `Ошибка загрузки (${response.status})`);
      if (!alive) return;
      const block = blocks.find(item => item.id === id);
      if (!block || block.type !== 'image') return;
      remember();
      block.imageId = result.id;
      markDirty();
      notify('Изображение загружено');
    } catch (failure) {
      if (alive) notify(docsFailureMessage(failure), 'error');
    } finally { if (alive) uploading = null; }
  }
  function replaceImage(block: DocBlock) {
    remember();
    block.imageId = null;
    markDirty();
  }
  // Task cards are chosen from the board; the block keeps only the id.
  function openTaskSearch(block: DocBlock) {
    taskSearch = { id: block.id, query: '' };
    void ensureTasks().then(() => tick()).then(() => root?.querySelector<HTMLInputElement>(`#doc-block-${CSS.escape(block.id)} .doc-task-search`)?.focus());
  }
  function chooseTask(block: DocBlock, task: Task) {
    remember();
    block.taskId = task.id;
    taskCards[task.id] = task;
    taskSearch = null;
    markDirty();
    void tick().then(() => root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(block.id)} .doc-block-focus`)?.focus());
  }
  function clearTask(block: DocBlock) {
    remember();
    block.taskId = null;
    markDirty();
    openTaskSearch(block);
  }
  function taskSearchKey(event: KeyboardEvent, block: DocBlock) {
    if (event.key === 'Escape') { event.preventDefault(); taskSearch = null; root?.querySelector<HTMLElement>(`#doc-block-${CSS.escape(block.id)} .doc-block-focus`)?.focus(); }
    else if (event.key === 'Enter') { event.preventDefault(); const first = taskMatches[0]; if (first) chooseTask(block, first); }
  }
  function scrollToHeading(id: string) {
    const target = document.getElementById(`doc-block-${id}`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    target?.querySelector<HTMLElement>('.doc-block-view, .doc-block-text')?.focus({ preventScroll: true });
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
    if (!(event.target instanceof Element)) return;
    if (menu?.kind === 'block' && !root?.querySelector('.doc-block-menu')?.contains(event.target) && !event.target.closest('[data-doc-handle]')) closeMenu(false);
    if (tableCell && !event.target.closest('.doc-cell-input')) tableCell = null;
    if (taskSearch && !event.target.closest('.doc-task-picker')) taskSearch = null;
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
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Undo shortcuts apply to the whole page, not to one control.) -->
  <article bind:this={root} class="doc-page" aria-label={'Страница: ' + (title.trim() || DOC_UNTITLED)} onkeydown={rootKey}>
    {#if readonly}<div class="field-warning doc-notice" role="status"><Icon name="alert" size={16} /><span>Страница в корзине. Восстановите её в оглавлении, чтобы редактировать.</span></div>{/if}
    {#if saveState === 'conflict'}
      <div class="connection-error doc-notice" role="alert"><Icon name="alert" size={17} /><span>{saveError}</span><button onclick={() => { void load(); }}>Загрузить новую версию</button></div>
    {:else if saveState === 'error'}
      <div class="connection-error doc-notice" role="alert"><Icon name="alert" size={17} /><span>{saveError}</span><button onclick={() => { void save(); }}>Повторить</button></div>
    {/if}
    <textarea bind:this={titleField} class="doc-title" rows="1" aria-label="Название страницы" placeholder={DOC_UNTITLED} maxlength={DOC_TITLE_LIMIT} value={title} disabled={readonly} use:grow oninput={titleInput} onkeydown={titleKey}></textarea>
    <div class="doc-meta"><span class="doc-status doc-status-{saveState}" role="status">{readonly ? 'Только чтение' : STATUS[saveState]}</span><span>Обновлено {dateTime(page.updatedAt)}</span></div>
    <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="doc-file-input" aria-label="Файл изображения" tabindex="-1" onchange={uploadImage} />
    <div class="doc-blocks">
      {#each blocks as block, position (block.id)}
        {@const kind = docBlockKind(block.type)}
        {@const editing = focused === block.id && !readonly}
        {@const card = block.type === 'task' && block.taskId ? taskCards[block.taskId] : undefined}
        {#if !hidden.has(block.id)}
        <div id="doc-block-{block.id}" class="doc-block doc-{block.type}" class:checked={block.type === 'todo' && block.checked} class:editing class:dragging={dragging === block.id}
          class:drop-before={dropTarget?.id === block.id && !dropTarget.after} class:drop-after={dropTarget?.id === block.id && dropTarget.after}
          style:--indent={block.indent ?? 0} role="group" aria-label={kind.label + ' ' + (position + 1)} ondragover={(event) => dragOver(event, block.id)} ondrop={drop}>
          <button type="button" class="doc-block-handle" data-doc-handle={block.id} aria-label={'Действия с блоком ' + (position + 1) + ': ' + kind.label} aria-haspopup="menu" aria-expanded={menu?.kind === 'block' && menu.id === block.id} title="Перетащите или откройте меню" draggable="true" disabled={readonly} ondragstart={(event) => dragStart(event, block.id)} ondragend={dragEnd} onclick={() => { void openBlockMenu(block.id); }}><Icon name="grip" size={15} /></button>
          <div class={'doc-block-body' + (block.type === 'callout' ? ` doc-callout-${block.color ?? 'gray'}` : '')}>
            {#if block.type === 'divider'}
              <!-- The separator is selected and removed from the keyboard like any other block. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <div class="doc-divider-line doc-block-focus" role="separator" tabindex={readonly ? -1 : 0} aria-label="Разделитель" onkeydown={(event) => structuralKey(event, block)}><hr /></div>
            {:else if block.type === 'toc'}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <nav class="doc-toc-frame doc-block-focus" tabindex={readonly ? -1 : 0} aria-label="Оглавление страницы" onkeydown={(event) => structuralKey(event, block)}>
                <p class="doc-toc-heading">Оглавление</p>
                {#if headings.length}<ol>{#each headings as heading (heading.id)}<li style:--level={heading.level}><button type="button" onclick={() => scrollToHeading(heading.id)}>{heading.text}</button></li>{/each}</ol>
                {:else}<p class="doc-toc-empty">Добавьте заголовки, и они появятся здесь.</p>{/if}
              </nav>
            {:else if block.type === 'table'}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <div class="doc-table-frame doc-block-focus" tabindex={readonly ? -1 : 0} role="group" aria-label="Таблица" onkeydown={(event) => structuralKey(event, block)}>
                <div class="doc-table-scroll"><table>
                  <tbody>
                    {#each block.rows ?? [] as row, rowIndex}
                      <tr>
                        {#each row as value, columnIndex}
                          {@const active = tableCell?.id === block.id && tableCell.row === rowIndex && tableCell.column === columnIndex}
                          <svelte:element this={block.header && rowIndex === 0 ? 'th' : 'td'} class:active>
                            {#if active && !readonly}
                              <input class="doc-cell-input" aria-label={'Ячейка ' + (rowIndex + 1) + ':' + (columnIndex + 1)} maxlength={DOC_TABLE_CELL_LIMIT} {value} oninput={(event) => cellInput(event, block, rowIndex, columnIndex)} onkeydown={(event) => cellKey(event, block, rowIndex, columnIndex)} />
                            {:else}
                              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                              <div class="doc-cell-view" class:empty={!value} role="textbox" aria-label={'Ячейка ' + (rowIndex + 1) + ':' + (columnIndex + 1)} tabindex={readonly ? -1 : 0} onclick={() => editCell(block, rowIndex, columnIndex)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); editCell(block, rowIndex, columnIndex); } }}>{@html renderInlineMarkdown(value)}</div>
                            {/if}
                          </svelte:element>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table></div>
                {#if !readonly}
                  <div class="doc-table-tools">
                    <button type="button" onclick={() => addRow(block)}><Icon name="plus" size={13} />Строка</button>
                    <button type="button" onclick={() => addColumn(block)}><Icon name="plus" size={13} />Столбец</button>
                    <button type="button" disabled={(block.rows?.length ?? 0) <= 1} onclick={() => removeRow(block)}>Убрать строку</button>
                    <button type="button" disabled={(block.rows?.[0]?.length ?? 0) <= 1} onclick={() => removeColumn(block)}>Убрать столбец</button>
                    <label><input type="checkbox" checked={block.header ?? true} onchange={(event) => { block.header = event.currentTarget.checked; markDirty(); }} />Первая строка — заголовок</label>
                  </div>
                {/if}
              </div>
            {:else if block.type === 'image'}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <figure class="doc-figure doc-block-focus" tabindex={readonly ? -1 : 0} onkeydown={(event) => structuralKey(event, block)}>
                {#if block.imageId}
                  <img src="/api/docs/{encodeURIComponent(pageId)}/images/{block.imageId}" alt={block.text || 'Изображение'} loading="lazy" />
                  {#if !readonly}<button type="button" class="doc-image-replace" onclick={() => replaceImage(block)}><Icon name="refresh" size={13} />Заменить</button>{/if}
                {:else}
                  <div class="doc-image-empty">
                    <button type="button" class="button secondary doc-image-upload" disabled={readonly || uploading === block.id} onclick={() => pickImage(block)}>{#if uploading === block.id}<Icon name="refresh" class="spin" size={15} />Загружаем…{:else}<Icon name="paperclip" size={15} />Выбрать изображение{/if}</button>
                    <small>PNG, JPEG, WebP или GIF до 10 МиБ</small>
                  </div>
                {/if}
                <figcaption>
                  {#if editing}
                    <textarea class="doc-block-text" rows="1" aria-label="Подпись к изображению" placeholder={placeholders.image} maxlength={DOC_BLOCK_TEXT_LIMIT} value={block.text} use:field={block.id} oninput={(event) => input(event, block)} onkeydown={(event) => keydown(event, block)} onblur={() => blur(block.id)}></textarea>
                  {:else}
                    <div class="doc-block-view" class:empty={!block.text} role="textbox" aria-label="Подпись к изображению" tabindex={readonly ? -1 : 0} data-placeholder={readonly ? '' : placeholders.image} onclick={(event) => viewClick(event, block)} onkeydown={(event) => viewKey(event, block)}>{@html renderInlineMarkdown(block.text)}</div>
                  {/if}
                </figcaption>
              </figure>
            {:else if block.type === 'task'}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <div class="doc-task-frame doc-block-focus" tabindex={readonly ? -1 : 0} role="group" aria-label="Задача" onkeydown={(event) => structuralKey(event, block)}>
                {#if block.taskId && !(taskSearch?.id === block.id)}
                  <div class="doc-task-card">
                    <span class="doc-task-id">{shortId(block.taskId)}</span>
                    <span class="doc-task-title">{card === undefined ? 'Загружаем задачу…' : card === null ? 'Задача недоступна' : card.title}</span>
                    {#if card}<span class="status-badge status-{card.status}"><span class="status-dot"></span>{TASK_STATUS_LABELS[card.status]}</span>{/if}
                    {#if card && onopentask}<button type="button" class="button secondary" onclick={() => onopentask?.(block.taskId!)}><Icon name="external" size={14} />Открыть</button>{/if}
                    {#if !readonly}<button type="button" class="button text-button" onclick={() => clearTask(block)}>Заменить</button>{/if}
                  </div>
                {:else}
                  <div class="doc-task-picker">
                    <input class="doc-task-search" aria-label="Поиск задачи" placeholder="Название или короткий ID задачи…" disabled={readonly} value={taskSearch?.id === block.id ? taskSearch.query : ''} onfocus={() => { if (taskSearch?.id !== block.id) openTaskSearch(block); }} oninput={(event) => { taskSearch = { id: block.id, query: event.currentTarget.value }; }} onkeydown={(event) => taskSearchKey(event, block)} />
                    {#if taskSearch?.id === block.id}
                      <ul class="doc-task-results" role="listbox" aria-label="Задачи">
                        {#each taskMatches as task (task.id)}<li><button type="button" role="option" aria-selected="false" onclick={() => chooseTask(block, task)}><span class="doc-task-id">{shortId(task.id)}</span><span>{task.title}</span><span class="status-badge status-{task.status}"><span class="status-dot"></span>{TASK_STATUS_LABELS[task.status]}</span></button></li>
                        {:else}<li class="doc-task-empty">{taskList ? 'Задачи не найдены' : 'Загружаем задачи…'}</li>{/each}
                      </ul>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else}
              {#if block.type === 'bulleted'}<span class="doc-block-marker" aria-hidden="true">•</span>
              {:else if block.type === 'numbered'}<span class="doc-block-marker" aria-hidden="true">{numbers.get(block.id) ?? 1}.</span>
              {:else if block.type === 'todo'}<input type="checkbox" class="doc-todo-box" aria-label="Отметить пункт" checked={block.checked ?? false} disabled={readonly} onchange={(event) => { block.checked = event.currentTarget.checked; markDirty(); }} />
              {:else if block.type === 'toggle'}<button type="button" class="doc-toggle-arrow" aria-expanded={!block.collapsed} aria-label={block.collapsed ? 'Развернуть блок' : 'Свернуть блок'} disabled={readonly} onclick={() => toggleCollapse(block)}><Icon name={block.collapsed ? 'chevron' : 'down'} size={14} /></button>
              {:else if block.type === 'callout'}<button type="button" class="doc-callout-icon" aria-label="Сменить иконку выноски" title="Сменить иконку" disabled={readonly} onclick={() => cycleIcon(block)}>{block.icon}</button>{/if}
              <div class="doc-block-content">
                {#if editing}
                  <textarea class="doc-block-text" rows="1" aria-label={kind.label} placeholder={placeholders[block.type]} maxlength={DOC_BLOCK_TEXT_LIMIT} value={block.text} spellcheck={block.type !== 'code'} use:field={block.id} oninput={(event) => input(event, block)} onkeydown={(event) => keydown(event, block)} onblur={() => blur(block.id)}></textarea>
                {:else if block.type === 'code'}
                  <div class="doc-block-view doc-code-view" class:empty={!block.text} role="textbox" aria-label={kind.label} tabindex={readonly ? -1 : 0} data-placeholder={placeholders.code} onclick={(event) => viewClick(event, block)} onkeydown={(event) => viewKey(event, block)}>{block.text}</div>
                {:else}
                  <div class="doc-block-view" class:empty={!block.text} role="textbox" aria-label={kind.label} tabindex={readonly ? -1 : 0} data-placeholder={block.type === 'paragraph' ? viewPlaceholder(position) : readonly ? '' : placeholders[block.type]} onclick={(event) => viewClick(event, block)} onkeydown={(event) => viewKey(event, block)}>{@html renderInlineMarkdown(block.text)}</div>
                {/if}
                {#if block.type === 'code'}<input class="doc-code-language" aria-label="Язык кода" placeholder="язык" maxlength={DOC_LANGUAGE_LIMIT} value={block.language ?? ''} disabled={readonly} oninput={(event) => languageInput(event, block)} />{/if}
                {#if block.type === 'callout' && !readonly}<select class="doc-callout-color" aria-label="Цвет выноски" value={block.color ?? 'gray'} onchange={(event) => { block.color = event.currentTarget.value as DocBlock['color']; markDirty(); }}>{#each DOC_CALLOUT_COLORS as color (color)}<option value={color}>{DOC_CALLOUT_COLOR_LABELS[color]}</option>{/each}</select>{/if}
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
              {#if isDocTextType(block.type)}
                <p class="doc-menu-heading">Превратить в</p>
                {#each convertible as item (item.type)}<button type="button" role="menuitem" class:current={item.type === block.type} onclick={() => applyKind(position, item.type)}>{item.label}{#if item.type === block.type}<Icon name="check" size={14} />{/if}</button>{/each}
                <hr />
              {/if}
              <button type="button" role="menuitem" disabled={position === 0} onclick={() => { closeMenu(true); moveBlock(position, position - 1); }}>Переместить выше</button>
              <button type="button" role="menuitem" disabled={position === blocks.length - 1} onclick={() => { closeMenu(true); moveBlock(position, position + 1); }}>Переместить ниже</button>
              <button type="button" role="menuitem" disabled={(block.indent ?? 0) >= DOC_INDENT_LIMIT} onclick={() => { closeMenu(true); setIndent(block, (block.indent ?? 0) + 1); }}>Вложить глубже</button>
              <button type="button" role="menuitem" disabled={!(block.indent ?? 0)} onclick={() => { closeMenu(true); setIndent(block, (block.indent ?? 0) - 1); }}>Вынести на уровень выше</button>
              <hr />
              <button type="button" role="menuitem" class="danger" onclick={() => { closeMenu(false); removeAt(position); const target = blocks[Math.min(position, blocks.length - 1)]; if (target && isDocTextType(target.type)) void focusBlock(target.id, 'end'); }}><Icon name="trash" size={14} />Удалить блок</button>
            </div>
          {/if}
        </div>
        {/if}
      {/each}
    </div>
    {#if !readonly}<button type="button" class="doc-add-block" onclick={appendBlock}><Icon name="plus" size={14} />Добавить блок</button>{/if}
  </article>
{/if}
