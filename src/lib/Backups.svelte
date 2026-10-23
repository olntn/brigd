<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { formatDate, formatNumber, serverText, t, tk } from './i18n';
  import type { BackupEntry, BackupOverview } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  const maxUploadSize = 256 * 1024 * 1024;
  const sourceLabels = { manual: tk('Создан вручную'), upload: tk('Загружен'), update: tk('Перед обновлением') };
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
    return error instanceof TypeError ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
      : error instanceof Error ? error.message : fallback;
  }

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); }
    catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
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
      if (!controller.signal.aborted) loadError = message(error, t('Не удалось загрузить бэкапы. Попробуйте ещё раз.'));
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
    pendingMessage = t('Создаём бэкап…');
    status = '';
    actionError = '';
    try {
      const saved = await request<BackupEntry>('/api/backups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      applyEntry(saved);
      status = t('Бэкап создан');
    } catch (error) { actionError = message(error, t('Не удалось создать бэкап. Попробуйте ещё раз.')); }
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
      actionError = file.size ? t('Файл бэкапа должен быть не больше 256 МБ.') : t('Файл бэкапа пуст. Выберите другой файл.');
      return;
    }
    busy = true;
    pendingMessage = t('Загружаем бэкап…');
    try {
      const saved = await request<BackupEntry>('/api/backups/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': encodeURIComponent(file.name) }, body: file,
      });
      applyEntry(saved);
      status = t('Бэкап загружен');
    } catch (error) { actionError = message(error, t('Не удалось загрузить бэкап. Попробуйте ещё раз.')); }
    finally { busy = false; }
  }

  async function select(entry: BackupEntry) {
    if (busy || loading) return;
    busy = true;
    pendingMessage = t('Восстанавливаем данные из бэкапа…');
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
    } catch (error) { actionError = message(error, t('Не удалось восстановить данные из бэкапа. Попробуйте ещё раз.')); }
    finally { busy = false; }
  }

  async function setAutoUpdate(entry: BackupEntry, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const autoUpdate = input.checked;
    if (busy || loading || !entry.selected) { input.checked = entry.autoUpdate; return; }
    busy = true;
    pendingMessage = autoUpdate ? t('Включаем автообновление и обновляем бэкап…') : t('Выключаем автообновление…');
    status = '';
    actionError = '';
    backups = backups.map(backup => backup.id === entry.id ? { ...backup, autoUpdate } : backup);
    try {
      const saved = await request<BackupEntry>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoUpdate }),
      });
      applyEntry(saved);
      status = saved.autoUpdate ? t('Автообновление включено. Бэкап обновлён.') : t('Автообновление выключено');
    } catch (error) {
      backups = backups.map(backup => backup.id === entry.id ? { ...backup, autoUpdate: entry.autoUpdate } : backup);
      actionError = message(error, t('Не удалось изменить автообновление бэкапа. Попробуйте ещё раз.'));
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
      renameError = t('Введите имя бэкапа.');
      renameInput?.focus();
      return;
    }
    busy = true;
    pendingMessage = t('Переименовываем бэкап…');
    status = '';
    actionError = '';
    try {
      const saved = await request<BackupEntry>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      applyEntry(saved);
      clearRename();
      status = t('Бэкап переименован');
    } catch (error) { renameError = message(error, t('Не удалось переименовать бэкап. Попробуйте ещё раз.')); }
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
    pendingMessage = t('Удаляем бэкап…');
    deleteError = '';
    status = '';
    try {
      await request<{ ok: true }>(`/api/backups/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      backups = backups.filter(backup => backup.id !== entry.id);
      deletingId = null;
      status = t('Бэкап удалён');
    } catch (error) { deleteError = message(error, t('Не удалось удалить бэкап. Попробуйте ещё раз.')); }
    finally { busy = false; }
    if (!deletingId) void restoreFocus();
  }

  function sizeLabel(size: number) {
    return size < 1024 ? `${size} ${t('Б')}` : size < 1024 * 1024 ? `${formatNumber(size / 1024, { maximumFractionDigits: 1 })} ${t('КБ')}`
      : `${formatNumber(size / (1024 * 1024), { maximumFractionDigits: 1 })} ${t('МБ')}`;
  }
  function dateLabel(timestamp: number, includeSeconds = false) {
    return formatDate(timestamp, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: includeSeconds ? '2-digit' : undefined });
  }
</script>

<svelte:window onkeydown={renameKey} />

<section class="backup-settings model-settings" aria-labelledby="backup-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="archive" size={22} /><div><h3 id="backup-settings-title">{t('Бэкапы')}</h3><p>{t('Создавайте копии данных приложения и восстанавливайте их, выбирая нужный бэкап. Здесь также доступны бэкапы перед обновлением.')}</p></div></div>
  <div class="backup-toolbar">
    <button bind:this={createButton} type="button" class="button primary" disabled={busy || loading} onclick={create}><Icon name="plus" size={16} />{t('Создать бэкап')}</button>
    <button type="button" class="button secondary" disabled={busy || loading} onclick={() => uploadInput.click()}><Icon name="folder" size={16} />{t('Загрузить бэкап')}</button>
    <button type="button" class="icon-button" disabled={busy || loading} onclick={() => { void load(); }} aria-label={t('Обновить список бэкапов')} title={t('Обновить список')}><Icon name="refresh" size={17} /></button>
    <input bind:this={uploadInput} class="backup-upload-input" type="file" aria-label={t('Файл бэкапа')} accept=".sqlite,.sqlite3,.db,.bak,application/vnd.sqlite3,application/x-sqlite3" disabled={busy || loading} onchange={upload} />
  </div>
  <p class="backup-upload-note">{t('Для загрузки выберите файл базы данных SQLite до 256 МБ.')}</p>
  {#if loadError}<div class="model-load-error" role="alert"><span>{loadError}</span><button type="button" class="button secondary" disabled={busy || loading} onclick={() => { void load(); }}>{t('Повторить загрузку бэкапов')}</button></div>{/if}
  {#if actionError}<div class="form-error backup-action-error" role="alert"><Icon name="alert" size={17} /><span>{actionError}</span></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{t('Загружаем список бэкапов…')}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{pendingMessage}</span></p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if !loading && !loadError && !backups.length}<p class="model-catalog-empty backup-empty">{t('Бэкапов пока нет. Создайте первый бэкап или загрузите сохранённый файл.')}</p>{/if}
  {#if backups.length}
    <ul class="backup-list" aria-label={t('Список бэкапов')}>
      {#each backups as entry (entry.id)}
        <li class="backup-entry" class:selected={entry.selected} aria-label={entry.name}>
          <div class="backup-entry-heading"><strong>{entry.name}</strong>{#if entry.selected}<span class="backup-selected"><Icon name="check" size={14} />{t('Выбран')}</span>{/if}</div>
          <div class="backup-entry-meta"><span>{t(sourceLabels[entry.source])}</span><time datetime={new Date(entry.createdAt).toISOString()}>{dateLabel(entry.createdAt)}</time><span>{sizeLabel(entry.size)}</span></div>
          {#if entry.updatedAt > entry.createdAt}<div class="backup-entry-meta"><span>{t('Обновлён:')} <time datetime={new Date(entry.updatedAt).toISOString()}>{dateLabel(entry.updatedAt, true)}</time></span></div>{/if}
          {#if entry.selected}
            <div class="backup-auto-update">
              <label><input type="checkbox" checked={entry.autoUpdate} disabled={busy || loading} aria-describedby={'backup-auto-update-note-' + entry.id} onchange={(event) => setAutoUpdate(entry, event)} /><span>{t('Автообновление бэкапа')}</span></label>
              <p id={'backup-auto-update-note-' + entry.id}>{t('Обновлять этот бэкап при изменении данных приложения. Копия будет перезаписываться.')}</p>
            </div>
          {/if}
          <div class="backup-entry-actions">
            <a class="button secondary" href="/api/backups/{encodeURIComponent(entry.id)}/download" download={entry.name} aria-label={t('Скачать бэкап: {name}', { name: entry.name })} aria-disabled={busy || loading} tabindex={busy || loading ? -1 : 0} onclick={(event) => { if (busy || loading) event.preventDefault(); }}><Icon name="down" size={16} />{t('Скачать')}</a>
            <button type="button" class="button secondary" disabled={busy || loading || renamingId === entry.id} aria-label={t('Переименовать бэкап: {name}', { name: entry.name })} onclick={(event) => beginRename(entry, event.currentTarget)}><Icon name="edit" size={16} />{t('Переименовать')}</button>
            <button type="button" class="button secondary" disabled={busy || loading} aria-label={entry.selected ? t('Восстановить бэкап: {name}', { name: entry.name }) : t('Выбрать бэкап: {name}', { name: entry.name })} onclick={(event) => confirmRestore(entry, event.currentTarget)}><Icon name="restore" size={16} />{entry.selected ? t('Восстановить снова') : t('Выбрать')}</button>
            <button type="button" class="button secondary danger-hover" disabled={busy || loading || entry.selected} aria-label={t('Удалить бэкап: {name}', { name: entry.name })} aria-describedby={entry.selected ? 'selected-backup-delete-note' : undefined} title={entry.selected ? t('Текущий выбранный бэкап нельзя удалить') : t('Удалить бэкап')} onclick={(event) => confirmDelete(entry, event.currentTarget)}><Icon name="close" size={16} />{t('Удалить')}</button>
          </div>
          {#if entry.selected}<p id="selected-backup-delete-note" class="backup-protected-note">{t('Текущий выбранный бэкап нельзя удалить.')}</p>{/if}
          {#if renamingId === entry.id}
            <form class="backup-rename-form" onsubmit={(event) => { event.preventDefault(); void rename(entry); }}>
              <label class="form-field"><span>{t('Имя бэкапа')}</span><input bind:this={renameInput} bind:value={renameDraft} type="text" autocomplete="off" disabled={busy || loading} aria-invalid={renameError ? true : undefined} aria-describedby={renameError ? 'backup-rename-error' : undefined} /></label>
              {#if renameError}<div id="backup-rename-error" class="form-error" role="alert"><Icon name="alert" size={17} /><span>{renameError}</span></div>{/if}
              <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelRename}>{t('Отмена переименования')}</button><button type="submit" class="button primary" disabled={busy || loading}><Icon name={busy ? 'refresh' : 'check'} class={busy ? 'spin' : ''} size={16} />{t('Сохранить имя')}</button></div>
            </form>
          {/if}
          {#if restoringId === entry.id}
            <div class="model-delete-confirm"><p>{t('Восстановить данные из бэкапа «{name}»? Данные приложения будут заменены. Активные запуски остановятся. Перед восстановлением сохраним текущие данные в отдельный бэкап. После восстановления страница перезагрузится.', { name: entry.name })}</p><div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelRestore}>{t('Отмена восстановления')}</button><button bind:this={restoreConfirmButton} type="button" class="button danger" disabled={busy || loading} onclick={() => select(entry)}>{busy ? t('Восстанавливаем…') : t('Восстановить данные')}</button></div></div>
          {/if}
          {#if deletingId === entry.id}
            <div class="model-delete-confirm"><p>{t('Удалить бэкап «{name}»? Файл будет удалён без возможности восстановления.', { name: entry.name })}</p>{#if deleteError}<div class="form-error" role="alert"><span>{deleteError}</span></div>{/if}<div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelDelete}>{t('Отмена удаления')}</button><button bind:this={deleteConfirmButton} type="button" class="button danger" disabled={busy || loading || entry.selected} onclick={() => remove(entry)}>{busy ? t('Удаляем…') : t('Удалить навсегда')}</button></div></div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
