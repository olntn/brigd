<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { INSTRUCTION_TITLE_LIMIT, INSTRUCTION_BODY_LIMIT, INSTRUCTION_COUNT_LIMIT, INSTRUCTION_ENABLED_TEXT_LIMIT, INSTRUCTION_ENABLED_BYTES_LIMIT } from './instructions';
  import type { Instruction, InstructionInput } from './types';

  let { notify }: { notify: (message: string, type?: 'success' | 'error') => void } = $props();
  let instructions = $state<Instruction[]>([]);
  let loading = $state(true);
  let error = $state('');
  let editor: HTMLDialogElement;
  let confirmation: HTMLDialogElement;
  let createButton: HTMLButtonElement;
  let heading: HTMLHeadingElement;
  let editorOpener: HTMLElement | null = null;
  let editorReturnId: string | null = null;
  let editing = $state(false);
  let editingId = $state<string | null>(null);
  let title = $state('');
  let body = $state('');
  let enabled = $state(true);
  let formError = $state('');
  let deleting = $state<Instruction | null>(null);
  let deleteError = $state('');
  let pending = $state<string | null>(null);
  let sequence = 0;
  let reading = false;
  let alive = true;
  let enabledCount = $derived(instructions.filter(item => item.enabled).length);
  let enabledCharacters = $derived(instructions.reduce((total, item) => total + (item.enabled ? item.title.length + item.body.length : 0), 0));
  let enabledBytes = $derived(new TextEncoder().encode(JSON.stringify(instructions.filter(item => item.enabled).map(({ id, title, body }) => ({ id, title, body })))).byteLength);
  let saving = $derived(pending === 'save');
  let removing = $derived(pending === 'delete');
  const count = (value: number) => value.toLocaleString('ru-RU');
  const message = (failure: unknown) => failure instanceof TypeError
    ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
    : failure instanceof Error ? failure.message : 'Не удалось сохранить изменения. Попробуйте ещё раз.';

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(result.error || `Ошибка запроса (${response.status})`);
    return result as T;
  }

  async function load() {
    if (reading || pending) return;
    reading = true;
    const readSequence = ++sequence;
    try {
      const result = await request<Instruction[]>('/api/instructions');
      if (!alive || readSequence !== sequence) return;
      if (!Array.isArray(result)) throw new Error('Не удалось прочитать список инструкций. Попробуйте ещё раз.');
      instructions = result;
      error = '';
    } catch (failure) {
      if (alive && readSequence === sequence) error = message(failure);
    } finally {
      reading = false;
      if (alive && readSequence === sequence) loading = false;
    }
  }

  onMount(() => {
    void load();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2000);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; sequence++; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  });

  function savedInstruction(saved: Instruction) {
    // Invalidate reads that began before a mutation so they cannot undo its result.
    sequence++;
    instructions = instructions.some(item => item.id === saved.id)
      ? instructions.map(item => item.id === saved.id ? saved : item)
      : [...instructions, saved];
    loading = false;
    error = '';
  }

  async function openEditor(item?: Instruction) {
    if (pending) return;
    editorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editorReturnId = item?.id ?? null;
    editingId = item?.id ?? null;
    title = item?.title ?? '';
    body = item?.body ?? '';
    enabled = item?.enabled ?? true;
    formError = '';
    editing = true;
    await tick();
    if (!alive) return;
    editor.showModal();
    editor.querySelector<HTMLInputElement>('[name="instructionTitle"]')?.focus();
  }

  async function closeEditor() {
    if (saving) return;
    editor.close();
    editing = false;
    // Wait for pending controls to be enabled again before restoring focus.
    // At the 100-item limit the create opener stays disabled; focus the saved rule instead.
    await tick();
    if (!alive || editor.open) return;
    const savedButton = editorReturnId ? document.querySelector<HTMLButtonElement>(`[data-edit-instruction="${CSS.escape(editorReturnId)}"]`) : null;
    if (editorOpener?.isConnected && !editorOpener.matches(':disabled')) editorOpener.focus();
    else if (savedButton && !savedButton.disabled) savedButton.focus();
    else if (!createButton.disabled) createButton.focus();
    else heading.focus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    formError = '';
    if (!title.trim() || !body.trim()) { formError = 'Заполните название и текст инструкции.'; return; }
    if (title.trim().length > INSTRUCTION_TITLE_LIMIT || body.trim().length > INSTRUCTION_BODY_LIMIT) {
      formError = 'Сократите название или текст инструкции до указанного лимита.'; return;
    }
    const payload: InstructionInput = { title: title.trim(), body: body.trim(), enabled };
    pending = 'save';
    sequence++;
    try {
      const saved = await request<Instruction>(editingId ? `/api/instructions/${encodeURIComponent(editingId)}` : '/api/instructions', {
        method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      if (!alive) return;
      savedInstruction(saved);
      editorReturnId = saved.id;
      notify(editingId ? 'Инструкция сохранена' : 'Инструкция создана');
      pending = null;
      closeEditor();
    } catch (failure) {
      if (alive) formError = message(failure);
    } finally {
      if (alive) { pending = null; loading = false; }
    }
  }

  async function toggle(item: Instruction) {
    if (pending) return;
    const focused = document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.toggleInstruction === item.id ? document.activeElement : null;
    pending = item.id;
    sequence++;
    try {
      const saved = await request<Instruction>(`/api/instructions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }),
      });
      if (!alive) return;
      savedInstruction(saved);
      notify(saved.enabled ? 'Инструкция включена для новых запусков' : 'Инструкция выключена для новых запусков');
    } catch (failure) { if (alive) notify(message(failure), 'error'); }
    finally {
      if (alive) {
        pending = null;
        loading = false;
        await tick();
        // Disabling a native button can blur it. Restore keyboard position only
        // when the user has not moved to another control while waiting.
        if (alive && focused?.isConnected && !focused.disabled && (document.activeElement === document.body || document.activeElement === focused)) focused.focus();
      }
    }
  }

  async function askDelete(item: Instruction) {
    if (pending) return;
    deleting = item;
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
    if (pending || !deleting) return;
    const id = deleting.id;
    pending = 'delete';
    sequence++;
    deleteError = '';
    try {
      await request<{ ok: true }>(`/api/instructions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!alive) return;
      sequence++;
      instructions = instructions.filter(item => item.id !== id);
      error = '';
      notify('Инструкция удалена. История запусков сохранена.');
      pending = null;
      closeDelete();
      await tick();
      createButton?.focus();
    } catch (failure) { if (alive) deleteError = message(failure); }
    finally { if (alive) { pending = null; loading = false; } }
  }

  function backdropClick(event: MouseEvent, dialog: HTMLDialogElement, close: () => void) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }
</script>

<section class="page-heading">
  <div><div class="eyebrow">ОБЩИЕ ПРАВИЛА ДЛЯ АГЕНТОВ</div><h1 bind:this={heading} tabindex="-1">Инструкции<span>{instructions.length}</span></h1><p>Сохраните правила, которые важны в каждой задаче.</p></div>
  <button bind:this={createButton} class="button primary create-button" disabled={!!pending || instructions.length >= INSTRUCTION_COUNT_LIMIT} onclick={() => openEditor()}><Icon name="plus" size={17} />Новая инструкция</button>
</section>
<div class="workers-note instructions-note"><Icon name="list" size={18} /><p>Включённые инструкции применяются ко всем новым запускам любых задач: вручную и по расписанию, в Codex и Claude Code. Каждый запуск сохраняет свою копию. Изменение, выключение или удаление правила не меняет уже начатые запуски и их продолжения.</p></div>
{#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(); }}>Повторить</button></div>{/if}
{#if instructions.length}
  <p class="instructions-capacity">Включено: {enabledCount} из {instructions.length}. Текст включённых: {count(enabledCharacters)} / {count(INSTRUCTION_ENABLED_TEXT_LIMIT)} символов; с учётом кодирования: {count(enabledBytes)} / {count(INSTRUCTION_ENABLED_BYTES_LIMIT)} байт. Сохранено: {instructions.length} / {INSTRUCTION_COUNT_LIMIT}.</p>
{/if}
{#if instructions.length >= INSTRUCTION_COUNT_LIMIT}<p class="field-warning" role="status">Достигнут лимит: {INSTRUCTION_COUNT_LIMIT} инструкций. Удалите ненужную, чтобы создать новую.</p>{/if}
{#if loading}
  <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />Загружаем инструкции…</div>
{:else if instructions.length}
  <div class="instructions-grid">
    {#each instructions as item (item.id)}
      <article class="instruction-card" class:instruction-disabled={!item.enabled} aria-label={'Инструкция: ' + item.title} aria-busy={pending === item.id}>
        <div class="instruction-card-heading"><h2>{item.title}</h2><button type="button" role="switch" data-toggle-instruction={item.id} aria-checked={item.enabled} aria-label={'Включить инструкцию: ' + item.title} class="instruction-switch" disabled={!!pending} onclick={() => toggle(item)}><span class="switch-track" aria-hidden="true"><span></span></span><span>{pending === item.id ? 'Сохраняем…' : item.enabled ? 'Включена' : 'Выключена'}</span></button></div>
        <p class="instruction-preview">{item.body}</p>
        <div class="instruction-card-actions"><button class="button secondary" data-edit-instruction={item.id} disabled={!!pending} onclick={() => openEditor(item)} aria-label={'Изменить инструкцию: ' + item.title}><Icon name="edit" size={14} />Изменить</button><button class="button text-button danger-hover" disabled={!!pending} onclick={() => askDelete(item)} aria-label={'Удалить инструкцию: ' + item.title}><Icon name="close" size={14} />Удалить</button></div>
      </article>
    {/each}
  </div>
{:else if !error}
  <div class="no-results"><span class="empty-icon"><Icon name="list" size={27} /></span><h2>Ваши правила, в каждой задаче</h2><p>Например: отвечать по-русски, проверять тесты после правок или сначала объяснять риски.</p><button class="button primary" disabled={!!pending} onclick={() => openEditor()}><Icon name="plus" size={16} />Создать первую инструкцию</button></div>
{/if}

<dialog bind:this={editor} class="editor-dialog instruction-editor" aria-labelledby="instruction-editor-title" oncancel={(event) => { event.preventDefault(); closeEditor(); }} onclick={(event) => backdropClick(event, editor, closeEditor)}>
  {#if editing}
    <form class="editor-form" onsubmit={save} aria-busy={saving}>
      <header class="editor-header"><div><span class="editor-kicker">ОБЩЕЕ ПРАВИЛО</span><h2 id="instruction-editor-title">{editingId ? 'Редактировать инструкцию' : 'Новая инструкция'}</h2></div><button type="button" class="icon-button" aria-label="Закрыть инструкцию" disabled={saving} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
        <label class="form-field"><span>Название <span class="required">*</span></span><input name="instructionTitle" aria-label="Название инструкции" aria-describedby="instruction-title-count" bind:value={title} maxlength={INSTRUCTION_TITLE_LIMIT} placeholder="Например, проверка изменений" required disabled={saving} /><small id="instruction-title-count">{count(title.length)} / {count(INSTRUCTION_TITLE_LIMIT)} символов</small></label>
        <label class="form-field"><span>Текст инструкции <span class="required">*</span></span><textarea name="instructionBody" aria-label="Текст инструкции" aria-describedby="instruction-body-count" bind:value={body} maxlength={INSTRUCTION_BODY_LIMIT} rows="8" placeholder="После правок запусти подходящие тесты. Если тесты не удалось выполнить, укажи причину." required disabled={saving}></textarea><small id="instruction-body-count">{count(body.length)} / {count(INSTRUCTION_BODY_LIMIT)} символов</small></label>
        <label class="instruction-enabled-option"><input type="checkbox" bind:checked={enabled} disabled={saving} /><span>Включить для новых запусков</span></label>
        <p class="form-note">Правило действует для всех задач и обоих агентов. Текущие запуски и их продолжения сохраняют прежние инструкции. Общий объём включённых правил ограничен {count(INSTRUCTION_ENABLED_BYTES_LIMIT)} байтами с учётом кодирования. Длинную инструкцию можно сохранить выключенной.</p>
      </div>
      <footer class="editor-footer"><button type="button" class="button secondary" disabled={saving} onclick={closeEditor}>Отмена</button><button type="submit" class="button primary" disabled={saving}>{#if saving}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId ? 'check' : 'plus'} size={16} />{/if}{saving ? 'Сохраняем…' : editingId ? 'Сохранить инструкцию' : 'Создать инструкцию'}</button></footer>
    </form>
  {/if}
</dialog>

<dialog bind:this={confirmation} class="editor-dialog instruction-delete-dialog" aria-labelledby="instruction-delete-title" aria-describedby="instruction-delete-description" oncancel={(event) => { event.preventDefault(); closeDelete(); }} onclick={(event) => backdropClick(event, confirmation, closeDelete)}>
  {#if deleting}
    <form class="editor-form" onsubmit={remove} aria-busy={removing}>
      <header class="editor-header"><h2 id="instruction-delete-title">Удалить инструкцию?</h2><button type="button" class="icon-button" aria-label="Закрыть удаление" disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">{#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}<p id="instruction-delete-description">«{deleting.title}» больше не будет в списке. Отменить удаление нельзя; можно выключить правило, чтобы сохранить его. Копии в истории запусков останутся.</p></div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>Отмена</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? 'Удаляем…' : 'Удалить инструкцию'}</button></footer>
    </form>
  {/if}
</dialog>
