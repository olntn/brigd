<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { DEFAULT_TAG_COLOR, TAG_COLORS, TAG_COUNT_LIMIT, TAG_NAME_LIMIT, tagColorStyle } from './tags';
  import { serverText, t, tc } from './i18n';
  import type { Tag, TagInput } from './types';

  let { tags, loading, error, onreload, onchanged, ondeleted, onmutation, notify }: {
    tags: Tag[];
    loading: boolean;
    error: string;
    onreload: () => unknown;
    onchanged: (tag: Tag) => void;
    ondeleted: (id: string) => void;
    onmutation?: (pending: boolean) => void;
    notify: (message: string, type?: 'success' | 'error') => void;
  } = $props();

  let editor: HTMLDialogElement;
  let confirmation: HTMLDialogElement;
  let createButton: HTMLButtonElement;
  let heading: HTMLHeadingElement;
  let editorOpener: HTMLElement | null = null;
  let deleteOpener: HTMLElement | null = null;
  let editorReturnId: string | null = null;
  let editing = $state(false);
  let editingId = $state<string | null>(null);
  let name = $state('');
  let color = $state(DEFAULT_TAG_COLOR);
  let formError = $state('');
  let deleting = $state<Tag | null>(null);
  let deleteError = $state('');
  let pending = $state<'save' | 'delete' | null>(null);
  let alive = true;
  let orderedTags = $derived([...tags].sort((left, right) => left.name.localeCompare(right.name, 'ru')));
  let saving = $derived(pending === 'save');
  let removing = $derived(pending === 'delete');
  const message = (failure: unknown) => failure instanceof TypeError
    ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
    : failure instanceof Error ? failure.message : t('Не удалось сохранить изменения. Попробуйте ещё раз.');

  onDestroy(() => {
    alive = false;
    if (pending) onmutation?.(false);
  });

  async function request<T>(path: string, options: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    let result;
    try { result = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(serverText(result.error ?? '') || t('Ошибка запроса ({status})', { status: response.status }));
    return result as T;
  }

  function beginMutation(kind: 'save' | 'delete') {
    pending = kind;
    onmutation?.(true);
  }

  function finishMutation() {
    if (!alive) return;
    pending = null;
    onmutation?.(false);
  }

  function editButton(id: string | null) {
    return id ? document.querySelector<HTMLButtonElement>(`[data-edit-tag="${CSS.escape(id)}"]`) : null;
  }

  function restoreFocus(opener: HTMLElement | null, fallbackId: string | null = null) {
    const fallback = editButton(fallbackId);
    if (opener?.isConnected && !opener.matches(':disabled')) opener.focus();
    else if (fallback && !fallback.disabled) fallback.focus();
    else if (createButton && !createButton.disabled) createButton.focus();
    else heading?.focus();
  }

  async function openEditor(item?: Tag) {
    if (pending || loading) return;
    editorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editorReturnId = item?.id ?? null;
    editingId = item?.id ?? null;
    name = item?.name ?? '';
    color = item?.color ?? DEFAULT_TAG_COLOR;
    formError = '';
    editing = true;
    await tick();
    if (!alive) return;
    editor.showModal();
    editor.querySelector<HTMLInputElement>('[name="tagName"]')?.focus();
  }

  async function closeEditor() {
    if (saving) return;
    editor.close();
    editing = false;
    await tick();
    if (alive && !editor.open) restoreFocus(editorOpener, editorReturnId);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    formError = '';
    const trimmedName = name.trim();
    if (!trimmedName) { formError = t('Введите название тега.'); return; }
    if (trimmedName.length > TAG_NAME_LIMIT) { formError = t('Название должно быть не длиннее {limit} символов.', { limit: TAG_NAME_LIMIT }); return; }
    const payload: TagInput = { name: trimmedName, color };
    beginMutation('save');
    try {
      const saved = await request<Tag>(editingId ? `/api/tags/${encodeURIComponent(editingId)}` : '/api/tags', {
        method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      if (!alive) return;
      onchanged(saved);
      editorReturnId = saved.id;
      notify(editingId ? t('Тег сохранён') : t('Тег создан'));
      finishMutation();
      void closeEditor();
    } catch (failure) {
      if (alive) formError = message(failure);
    } finally {
      if (pending === 'save') finishMutation();
    }
  }

  async function askDelete(item: Tag) {
    if (pending) return;
    deleteOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    deleting = item;
    deleteError = '';
    await tick();
    if (!alive) return;
    confirmation.showModal();
    confirmation.querySelector<HTMLButtonElement>('[data-cancel-delete]')?.focus();
  }

  async function closeDelete() {
    if (removing) return;
    confirmation.close();
    deleting = null;
    await tick();
    if (alive && !confirmation.open) restoreFocus(deleteOpener);
  }

  async function remove(event: SubmitEvent) {
    event.preventDefault();
    if (pending || !deleting) return;
    const id = deleting.id;
    const index = orderedTags.findIndex(item => item.id === id);
    const nextId = orderedTags[index + 1]?.id ?? orderedTags[index - 1]?.id ?? null;
    deleteError = '';
    beginMutation('delete');
    try {
      await request<{ ok: true }>(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!alive) return;
      ondeleted(id);
      notify(t('Тег удалён и снят со всех задач'));
      finishMutation();
      confirmation.close();
      deleting = null;
      await tick();
      if (alive) restoreFocus(null, nextId);
    } catch (failure) {
      if (alive) deleteError = message(failure);
    } finally {
      if (pending === 'delete') finishMutation();
    }
  }

  function backdropClick(event: MouseEvent, dialog: HTMLDialogElement, close: () => void) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }
</script>

<section class="page-heading">
  <div>
    <h1 bind:this={heading} tabindex="-1">{t('Теги')}</h1>
    <p>{t('Объединяйте задачи по проектам, темам и приоритетам.')}</p>
  </div>
  <button bind:this={createButton} type="button" class="button primary create-button" disabled={!!pending || loading || tags.length >= TAG_COUNT_LIMIT} onclick={() => openEditor()}><Icon name="plus" size={17} />{t('Новый тег')}</button>
</section>

<div class="workers-note tags-note"><Icon name="tag" size={18} /><p>{t('Создайте теги и назначайте их задачам при создании или в карточке задачи. На доске можно отфильтровать задачи по нужному тегу.')}</p></div>

{#if error}
  <div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button type="button" disabled={!!pending || loading} onclick={() => { void onreload(); }}>{t('Повторить')}</button></div>
{/if}
{#if tags.length >= TAG_COUNT_LIMIT}
  <p class="field-warning tags-limit" role="status">{t('Достигнут лимит: {limit} тегов. Удалите ненужный, чтобы создать новый.', { limit: TAG_COUNT_LIMIT })}</p>
{/if}

{#if loading}
  <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Загружаем теги…')}</div>
{:else if tags.length}
  <div class="tags-list">
    {#each orderedTags as item (item.id)}
      <article class="tag-card" aria-label={t('Тег: {name}', { name: item.name })}>
        <div class="tag-card-name"><h2 class="tag-name-badge" style={tagColorStyle(item.color)}>{item.name}</h2></div>
        <div class="tag-card-actions">
          <button type="button" class="button secondary" data-edit-tag={item.id} disabled={!!pending} onclick={() => openEditor(item)} aria-label={t('Изменить тег: {name}', { name: item.name })}><Icon name="edit" size={14} />{t('Изменить')}</button>
          <button type="button" class="button text-button danger-hover" disabled={!!pending} onclick={() => askDelete(item)} aria-label={t('Удалить тег: {name}', { name: item.name })}><Icon name="close" size={14} />{t('Удалить')}</button>
        </div>
      </article>
    {/each}
  </div>
  <p class="tags-capacity">{t('Создано {count} из {limit} тегов.', { count: tags.length, limit: TAG_COUNT_LIMIT })}</p>
{:else if !error}
  <div class="no-results tags-empty"><span class="empty-icon"><Icon name="tag" size={27} /></span><h2>{t('Свои теги для ваших задач')}</h2><p>{t('Например: «Сайт», «Исследование» или «Срочно».')}<br />{t('Одной задаче можно назначить несколько тегов.')}</p><button type="button" class="button primary" disabled={!!pending} onclick={() => openEditor()}><Icon name="plus" size={16} />{t('Создать первый тег')}</button></div>
{/if}

<dialog bind:this={editor} class="editor-dialog tag-editor" aria-labelledby="tag-editor-title" oncancel={(event) => { event.preventDefault(); void closeEditor(); }} onclick={(event) => backdropClick(event, editor, closeEditor)}>
  {#if editing}
    <form class="editor-form" onsubmit={save} aria-busy={saving}>
      <header class="editor-header"><div><h2 id="tag-editor-title">{editingId ? t('Редактировать тег') : t('Новый тег')}</h2></div><button type="button" class="icon-button" aria-label={t('Закрыть редактор тега')} disabled={saving} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
        <label class="form-field"><span>{tc('tag', 'Название')} <span class="required">*</span></span><input name="tagName" aria-label={t('Название тега')} aria-describedby="tag-name-count" bind:value={name} maxlength={TAG_NAME_LIMIT} placeholder={t('Например, Сайт')} required disabled={saving} /><small id="tag-name-count">{t('{count} / {limit} символов', { count: name.length, limit: TAG_NAME_LIMIT })}</small></label>
        <fieldset class="tag-colors" disabled={saving}>
          <legend>{t('Цвет тега')}</legend>
          <div class="tag-color-options">
            {#each TAG_COLORS as preset (preset.value)}
              <button type="button" class="tag-color-option" class:selected={color.toLowerCase() === preset.value.toLowerCase()} style={tagColorStyle(preset.value)} aria-label={t('Цвет: {name}', { name: t(preset.name) })} aria-pressed={color.toLowerCase() === preset.value.toLowerCase()} title={t(preset.name)} onclick={() => { color = preset.value; }}>{#if color.toLowerCase() === preset.value.toLowerCase()}<Icon name="check" size={18} />{/if}</button>
            {/each}
          </div>
          <label class="tag-custom-color"><input type="color" name="tagColor" aria-label={t('Свой цвет')} bind:value={color} /><span>{t('Свой цвет')}</span><small>{color.toUpperCase()}</small></label>
        </fieldset>
        <div class="tag-preview-section"><span>{t('Предпросмотр')}</span><span class="tag-preview" style={tagColorStyle(color)}><span>{name.trim() || t('Название тега')}</span></span></div>
        <p class="form-note">{editingId ? t('Название и цвет обновятся во всех задачах с этим тегом.') : t('После создания тег можно назначить любой задаче.')}</p>
      </div>
      <footer class="editor-footer"><button type="button" class="button secondary" disabled={saving} onclick={closeEditor}>{t('Отмена')}</button><button type="submit" class="button primary" disabled={saving}>{#if saving}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId ? 'check' : 'plus'} size={16} />{/if}{saving ? t('Сохраняем…') : editingId ? t('Сохранить тег') : t('Создать тег')}</button></footer>
    </form>
  {/if}
</dialog>

<dialog bind:this={confirmation} class="editor-dialog tag-delete-dialog" aria-labelledby="tag-delete-title" aria-describedby="tag-delete-description" oncancel={(event) => { event.preventDefault(); void closeDelete(); }} onclick={(event) => backdropClick(event, confirmation, closeDelete)}>
  {#if deleting}
    <form class="editor-form" onsubmit={remove} aria-busy={removing}>
      <header class="editor-header"><h2 id="tag-delete-title">{t('Удалить тег?')}</h2><button type="button" class="icon-button" aria-label={t('Закрыть удаление тега')} disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">{#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}<p id="tag-delete-description">{t('Тег «{name}» будет удалён из списка и снят со всех задач. Сами задачи сохранятся. Отменить удаление нельзя.', { name: deleting.name })}</p></div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>{t('Отмена')}</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? t('Удаляем…') : t('Удалить тег')}</button></footer>
    </form>
  {/if}
</dialog>

<style>
  .tags-note :global(svg) { flex-shrink: 0; }
  .tags-list { display: grid; gap: 10px; }
  .tag-card { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 18px; padding: 18px 20px; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
  .tag-card-name { display: flex; align-items: center; flex: 1 1 15rem; min-width: 0; }
  .tag-name-badge { margin: 0; min-width: 0; max-width: 100%; padding: 5px 9px; border: 1px solid var(--tag-border-color); border-radius: var(--radius-sm); background: var(--tag-background); color: var(--tag-text-color); font-size: .92rem; font-weight: 500; line-height: 1.6; overflow-wrap: anywhere; }
  .tag-card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .tags-capacity { margin: 16px 0 0; color: var(--muted); font-size: .77rem; }
  .tags-limit { margin: 0 0 18px; }
  .tags-empty p { max-width: 30rem; }
  .tag-editor, .tag-delete-dialog { width: 36rem; }
  .tag-editor .form-note { margin: 0; }
  .tag-colors { min-width: 0; margin: 0; padding: 0; border: 0; }
  .tag-colors legend { padding: 0; margin-bottom: 11px; color: var(--secondary); font-size: .92rem; font-weight: 500; }
  .tag-color-options { display: flex; flex-wrap: wrap; gap: 10px; padding: 3px; }
  .tag-color-option { display: grid; place-items: center; width: 34px; height: 34px; flex-shrink: 0; border: 1px solid var(--tag-border-color); border-radius: var(--radius-sm); background: var(--tag-background); color: var(--tag-text-color); }
  .tag-color-option.selected { outline: 2px solid var(--focus); outline-offset: 3px; }
  .tag-color-option:hover:not(:disabled) { box-shadow: 0 0 0 2px var(--line); }
  .tag-color-option:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
  .tag-custom-color { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 15px; color: var(--secondary); font-size: .85rem; cursor: pointer; }
  .tag-custom-color input { width: 42px; height: 34px; flex-shrink: 0; padding: 3px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; }
  .tag-custom-color small { color: var(--muted); font-size: .77rem; }
  .tag-colors:disabled .tag-custom-color, .tag-colors:disabled input { cursor: default; }
  .tag-preview-section { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-width: 0; padding: 12px; border: 1px dashed var(--line); border-radius: var(--radius-md); }
  .tag-preview-section > span:first-child { color: var(--muted); font-size: .77rem; }
  .tag-preview { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; padding: 5px 8px; border: 1px solid var(--tag-border-color); border-radius: var(--radius-sm); background: var(--tag-background); color: var(--tag-text-color); font-size: .85rem; line-height: 1.5; }
  .tag-preview > span { min-width: 0; overflow-wrap: anywhere; }
  .tag-delete-dialog .editor-header h2 { margin: 0; }
  .tag-delete-dialog .editor-fields > p { margin: 0; font-size: .92rem; line-height: 1.8; color: var(--secondary); overflow-wrap: anywhere; }
  .tag-editor .form-error > span, .tag-delete-dialog .form-error > span { min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    .tag-card { padding: 16px; }
    .tag-card-actions { width: 100%; padding-top: 12px; border-top: 1px solid var(--line); }
    .tag-card-actions .button { flex: 1; }
    .tag-editor .editor-footer .button, .tag-delete-dialog .editor-footer .button { flex: 1 1 100%; }
  }
</style>
