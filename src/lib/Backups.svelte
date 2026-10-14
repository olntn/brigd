<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import type { BackupEntry, BackupOverview } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  const maxUploadSize = 256 * 1024 * 1024;
  const sourceLabels = { manual: 'Создан вручную', upload: 'Загружен', update: 'Перед обновлением' };
  let backups = $state<BackupEntry[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let actionError = $state('');
  let status = $state('');
  let pendingMessage = $state('');
  let deletingId = $state<string | null>(null);
  let deleteError = $state('');
  let restoringId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameDraft = $state('');
  let renameError = $state('');
  let renameInput = $state<HTMLInputElement>();
  let uploadInput: HTMLInputElement;
  let createButton: HTMLButtonElement;
  let deleteConfirmButton = $state<HTMLButtonElement>();
  let restoreConfirmButton = $state<HTMLButtonElement>();
  let returnFocus: HTMLElement | null = null;
  let requested = false;
  let readController: AbortController | null = null;

  $effect(() => {
    if (active && !requested) {
      requested = true;
      untrack(() => { void load(); });
    }
  });
  onDestroy(() => { readController?.abort(); });

  function message(error: unknown, fallback: string) {
    return error instanceof TypeError ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
      : error instanceof Error ? error.message : fallback;
  }

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
    return body as T;
  }

  async function load() {
    if (busy) return;
    readController?.abort();
    const controller = new AbortController();
    readController = controller;
    loading = true;
    loadError = '';
    try {
      const result = await request<BackupOverview>('/api/backups', { signal: controller.signal });
      if (controller.signal.aborted) return;
      backups = result.backups.map(entry => ({ ...entry, selected: entry.id === result.selectedId }));
      if (!backups.some(entry => entry.id === deletingId && !entry.selected)) deletingId = null;
      if (!backups.some(entry => entry.id === restoringId)) restoringId = null;
      if (!backups.some(entry => entry.id === renamingId)) clearRename();
    } catch (error) {
      if (!controller.signal.aborted) loadError = message(error, 'Не удалось загрузить бэкапы. Попробуйте ещё раз.');
    } finally {
      if (readController === controller) {
        loading = false;
        readController = null;
      }
    }
  }

  function applyEntry(saved: BackupEntry) {
    backups = [saved, ...backups.filter(entry => entry.id !== saved.id).map(entry => saved.selected ? { ...entry, selected: false } : entry)]
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  async function create() {
    if (busy || loading) return;
    busy = true;
    pendingMessage = 'Создаём бэкап…';
    status = '';
    actionError = '';
    try {
      const saved = await request<BackupEntry>('/api/backups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      applyEntry(saved);
      status = 'Бэкап создан';
    } catch (error) { actionError = message(error, 'Не удалось создать бэкап. Попробуйте ещё раз.'); }
    finally { busy = false; }
  }

  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy || loading) return;
    status = '';
    actionError = '';
    if (!file.size || file.size > maxUploadSize) {
      actionError = file.size ? 'Файл бэкапа должен быть не больше 256 МБ.' : 'Файл бэкапа пуст. Выберите другой файл.';
      return;
    }
    busy = true;
    pendingMessage = 'Загружаем бэкап…';
    try {
      const saved = await request<BackupEntry>('/api/backups/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': encodeURIComponent(file.name) }, body: file,
      });
      applyEntry(saved);
      status = 'Бэкап загружен';
    } catch (error) { actionError = message(error, 'Не удалось загрузить бэкап. Попробуйте ещё раз.'); }
    finally { busy = false; }
  }

  async function select(entry: BackupEntry) {
    if (busy || loading) return;
    busy = true;
    pendingMessage = 'Восстанавливаем данные из бэкапа…';
    status = '';
    actionError = '';
    try {
      const saved = await request<BackupEntry>(`/api/backups/${encodeURIComponent(entry.id)}/select`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      applyEntry(saved);
      deletingId = null;
      deleteError = '';
      restoringId = null;
      window.location.reload();
    } catch (error) { actionError = message(error, 'Не удалось восстановить данные из бэкапа. Попробуйте ещё раз.'); }
    finally { busy = false; }
  }

  async function setAutoUpdate(entry: BackupEntry, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const autoUpdate = input.checked;
    if (busy || loading || !entry.selected) { input.checked = entry.autoUpdate; return; }
    busy = true;
    pendingMessage = autoUpdate ? 'Включаем автообновление и обновляем бэкап…' : 'Выключаем автообновление…';
    status = '';
    actionError = '';
    backups = backups.map(backup => backup.id === entry.id ? { ...backup, autoUpdate } : backup);
    try {
      const saved = await request<BackupEntry>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoUpdate }),
      });
      applyEntry(saved);
      status = saved.autoUpdate ? 'Автообновление включено. Бэкап обновлён.' : 'Автообновление выключено';
    } catch (error) {
      backups = backups.map(backup => backup.id === entry.id ? { ...backup, autoUpdate: entry.autoUpdate } : backup);
      actionError = message(error, 'Не удалось изменить автообновление бэкапа. Попробуйте ещё раз.');
    } finally { busy = false; }
  }

  async function confirmRestore(entry: BackupEntry, trigger: HTMLElement) {
    if (busy || loading) return;
    returnFocus = trigger;
    restoringId = entry.id;
    clearRename();
    deletingId = null;
    deleteError = '';
    actionError = '';
    status = '';
    await tick();
    restoreConfirmButton?.focus();
  }

  function cancelRestore() {
    if (busy) return;
    restoringId = null;
    actionError = '';
    void restoreFocus();
  }

  async function confirmDelete(entry: BackupEntry, trigger: HTMLElement) {
    if (busy || loading || entry.selected) return;
    returnFocus = trigger;
    deletingId = entry.id;
    restoringId = null;
    clearRename();
    deleteError = '';
    actionError = '';
    status = '';
    await tick();
    deleteConfirmButton?.focus();
  }

  function clearRename() {
    renamingId = null;
    renameDraft = '';
    renameError = '';
  }

  async function beginRename(entry: BackupEntry, trigger: HTMLElement) {
    if (busy || loading) return;
    returnFocus = trigger;
    renamingId = entry.id;
    renameDraft = entry.name;
    renameError = '';
    deletingId = null;
    restoringId = null;
    deleteError = '';
    actionError = '';
    status = '';
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function cancelRename() {
    if (busy) return;
    clearRename();
    void restoreFocus();
  }

  function renameKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !active || !renamingId || !(event.target instanceof Element) || !event.target.closest('.backup-rename-form')) return;
    event.preventDefault();
    event.stopPropagation();
    cancelRename();
  }

  async function rename(entry: BackupEntry) {
    if (busy || loading || renamingId !== entry.id) return;
    const name = renameDraft.normalize('NFC').trim();
    renameError = '';
    if (!name) {
      renameError = 'Введите имя бэкапа.';
      renameInput?.focus();
      return;
    }
    busy = true;
    pendingMessage = 'Переименовываем бэкап…';
    status = '';
    actionError = '';
    try {
      const saved = await request<BackupEntry>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      applyEntry(saved);
      clearRename();
      status = 'Бэкап переименован';
    } catch (error) { renameError = message(error, 'Не удалось переименовать бэкап. Попробуйте ещё раз.'); }
    finally { busy = false; }
    if (!renamingId) void restoreFocus();
  }

  async function restoreFocus() {
    await tick();
    if (returnFocus?.isConnected && !returnFocus.hasAttribute('disabled')) returnFocus.focus();
    else createButton?.focus();
  }

  function cancelDelete() {
    if (busy) return;
    deletingId = null;
    deleteError = '';
    void restoreFocus();
  }

  async function remove(entry: BackupEntry) {
    if (busy || loading || backups.find(backup => backup.id === entry.id)?.selected) return;
    busy = true;
    pendingMessage = 'Удаляем бэкап…';
    deleteError = '';
    status = '';
    try {
      await request<{ ok: true }>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      backups = backups.filter(backup => backup.id !== entry.id);
      deletingId = null;
      status = 'Бэкап удалён';
    } catch (error) { deleteError = message(error, 'Не удалось удалить бэкап. Попробуйте ещё раз.'); }
    finally { busy = false; }
    if (!deletingId) void restoreFocus();
  }

  function sizeLabel(size: number) {
    return size < 1024 ? `${size} Б` : size < 1024 * 1024 ? `${(size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`
      : `${(size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  }
  function dateLabel(timestamp: number, includeSeconds = false) {
    return new Date(timestamp).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: includeSeconds ? '2-digit' : undefined });
  }
</script>

<svelte:window onkeydown={renameKey} />

<section class="backup-settings model-settings" aria-labelledby="backup-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="archive" size={22} /><div><h3 id="backup-settings-title">Бэкапы</h3><p>Создавайте копии данных приложения и восстанавливайте их, выбирая нужный бэкап. Здесь также доступны бэкапы перед обновлением.</p></div></div>
  <div class="backup-toolbar">
    <button bind:this={createButton} type="button" class="button primary" disabled={busy || loading} onclick={create}><Icon name="plus" size={16} />Создать бэкап</button>
    <button type="button" class="button secondary" disabled={busy || loading} onclick={() => uploadInput.click()}><Icon name="folder" size={16} />Загрузить бэкап</button>
    <button type="button" class="icon-button" disabled={busy || loading} onclick={() => { void load(); }} aria-label="Обновить список бэкапов" title="Обновить список"><Icon name="refresh" size={17} /></button>
    <input bind:this={uploadInput} class="backup-upload-input" type="file" aria-label="Файл бэкапа" accept=".sqlite,.sqlite3,.db,.bak,application/vnd.sqlite3,application/x-sqlite3" disabled={busy || loading} onchange={upload} />
  </div>
  <p class="backup-upload-note">Для загрузки выберите файл базы данных SQLite до 256 МБ.</p>
  {#if loadError}<div class="model-load-error" role="alert"><span>{loadError}</span><button type="button" class="button secondary" disabled={busy || loading} onclick={() => { void load(); }}>Повторить загрузку бэкапов</button></div>{/if}
  {#if actionError}<div class="form-error backup-action-error" role="alert"><Icon name="alert" size={17} /><span>{actionError}</span></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>Загружаем список бэкапов…</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{pendingMessage}</span></p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if !loading && !loadError && !backups.length}<p class="model-catalog-empty backup-empty">Бэкапов пока нет. Создайте первый бэкап или загрузите сохранённый файл.</p>{/if}
  {#if backups.length}
    <ul class="backup-list" aria-label="Список бэкапов">
      {#each backups as entry (entry.id)}
        <li class="backup-entry" class:selected={entry.selected} aria-label={entry.name}>
          <div class="backup-entry-heading"><strong>{entry.name}</strong>{#if entry.selected}<span class="backup-selected"><Icon name="check" size={14} />Выбран</span>{/if}</div>
          <div class="backup-entry-meta"><span>{sourceLabels[entry.source]}</span><time datetime={new Date(entry.createdAt).toISOString()}>{dateLabel(entry.createdAt)}</time><span>{sizeLabel(entry.size)}</span></div>
          {#if entry.updatedAt > entry.createdAt}<div class="backup-entry-meta"><span>Обновлён: <time datetime={new Date(entry.updatedAt).toISOString()}>{dateLabel(entry.updatedAt, true)}</time></span></div>{/if}
          {#if entry.selected}
            <div class="backup-auto-update">
              <label><input type="checkbox" checked={entry.autoUpdate} disabled={busy || loading} aria-describedby={'backup-auto-update-note-' + entry.id} onchange={(event) => setAutoUpdate(entry, event)} /><span>Автообновление бэкапа</span></label>
              <p id={'backup-auto-update-note-' + entry.id}>Обновлять этот бэкап при изменении данных приложения. Копия будет перезаписываться.</p>
            </div>
          {/if}
          <div class="backup-entry-actions">
            <a class="button secondary" href="/api/backups/{encodeURIComponent(entry.id)}/download" download={entry.name} aria-label={'Скачать бэкап: ' + entry.name} aria-disabled={busy || loading} tabindex={busy || loading ? -1 : 0} onclick={(event) => { if (busy || loading) event.preventDefault(); }}><Icon name="down" size={16} />Скачать</a>
            <button type="button" class="button secondary" disabled={busy || loading || renamingId === entry.id} aria-label={'Переименовать бэкап: ' + entry.name} onclick={(event) => beginRename(entry, event.currentTarget)}><Icon name="edit" size={16} />Переименовать</button>
            <button type="button" class="button secondary" disabled={busy || loading} aria-label={(entry.selected ? 'Восстановить бэкап: ' : 'Выбрать бэкап: ') + entry.name} onclick={(event) => confirmRestore(entry, event.currentTarget)}><Icon name="restore" size={16} />{entry.selected ? 'Восстановить снова' : 'Выбрать'}</button>
            <button type="button" class="button secondary danger-hover" disabled={busy || loading || entry.selected} aria-label={'Удалить бэкап: ' + entry.name} aria-describedby={entry.selected ? 'selected-backup-delete-note' : undefined} title={entry.selected ? 'Текущий выбранный бэкап нельзя удалить' : 'Удалить бэкап'} onclick={(event) => confirmDelete(entry, event.currentTarget)}><Icon name="close" size={16} />Удалить</button>
          </div>
          {#if entry.selected}<p id="selected-backup-delete-note" class="backup-protected-note">Текущий выбранный бэкап нельзя удалить.</p>{/if}
          {#if renamingId === entry.id}
            <form class="backup-rename-form" onsubmit={(event) => { event.preventDefault(); void rename(entry); }}>
              <label class="form-field"><span>Имя бэкапа</span><input bind:this={renameInput} bind:value={renameDraft} type="text" autocomplete="off" disabled={busy || loading} aria-invalid={renameError ? true : undefined} aria-describedby={renameError ? 'backup-rename-error' : undefined} /></label>
              {#if renameError}<div id="backup-rename-error" class="form-error" role="alert"><Icon name="alert" size={17} /><span>{renameError}</span></div>{/if}
              <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelRename}>Отмена переименования</button><button type="submit" class="button primary" disabled={busy || loading}><Icon name={busy ? 'refresh' : 'check'} class={busy ? 'spin' : ''} size={16} />Сохранить имя</button></div>
            </form>
          {/if}
          {#if restoringId === entry.id}
            <div class="model-delete-confirm"><p>Восстановить данные из бэкапа «{entry.name}»? Данные приложения будут заменены. Активные запуски остановятся. Перед восстановлением сохраним текущие данные в отдельный бэкап. После восстановления страница перезагрузится.</p><div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelRestore}>Отмена восстановления</button><button bind:this={restoreConfirmButton} type="button" class="button danger" disabled={busy || loading} onclick={() => select(entry)}>{busy ? 'Восстанавливаем…' : 'Восстановить данные'}</button></div></div>
          {/if}
          {#if deletingId === entry.id}
            <div class="model-delete-confirm"><p>Удалить бэкап «{entry.name}»? Файл будет удалён без возможности восстановления.</p>{#if deleteError}<div class="form-error" role="alert"><span>{deleteError}</span></div>{/if}<div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelDelete}>Отмена удаления</button><button bind:this={deleteConfirmButton} type="button" class="button danger" disabled={busy || loading || entry.selected} onclick={() => remove(entry)}>{busy ? 'Удаляем…' : 'Удалить навсегда'}</button></div></div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
