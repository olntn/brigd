<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { serverText, t } from './i18n';
  import { MODEL_CATALOG_PROVIDER_LIMIT, MODEL_ID_LIMIT, MODEL_LABEL_LIMIT, normalizeModel } from './workers';
  import type { ModelCatalogEntry, ModelCatalogInput, Provider } from './types';

  let { models, loading, error, retry, onchange, ondelete, busy = $bindable(false) }: {
    models: ModelCatalogEntry[]; loading: boolean; error: string; retry: () => void;
    onchange: (entry: ModelCatalogEntry) => void; ondelete: (id: string) => void; busy?: boolean;
  } = $props();
  const providers: Provider[] = ['codex', 'claude'];
  const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
  let panel: HTMLElement;
  let labelInput = $state<HTMLInputElement>();
  let deleteConfirmButton = $state<HTMLButtonElement>();
  let editing = $state(false);
  let editingId = $state<string | null>(null);
  let provider = $state<Provider>('codex');
  let label = $state('');
  let modelId = $state('');
  let formError = $state('');
  let deletingId = $state<string | null>(null);
  let deleteError = $state('');
  let status = $state('');
  let returnFocus: HTMLElement | null = null;

  async function request<T>(path: string, options: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
    return body as T;
  }

  async function openEditor(nextProvider: Provider, trigger: HTMLElement, entry?: ModelCatalogEntry) {
    if (busy) return;
    returnFocus = trigger;
    editingId = entry?.id ?? null;
    provider = nextProvider;
    label = entry?.label ?? '';
    modelId = entry?.modelId ?? '';
    formError = '';
    deleteError = '';
    deletingId = null;
    status = '';
    editing = true;
    await tick();
    labelInput?.focus();
  }

  async function restoreFocus(nextProvider = provider) {
    await tick();
    if (returnFocus?.isConnected && !returnFocus.hasAttribute('disabled')) returnFocus.focus();
    else panel?.querySelector<HTMLButtonElement>(`[data-add-provider="${nextProvider}"]`)?.focus();
  }

  function cancelEditor() {
    if (busy) return;
    editing = false;
    editingId = null;
    label = '';
    modelId = '';
    formError = '';
    void restoreFocus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    formError = '';
    const cleanLabel = label.trim();
    if (!cleanLabel || cleanLabel.length > MODEL_LABEL_LIMIT || /[\u0000-\u001f\u007f-\u009f]/.test(label)) {
      formError = t('Укажите название модели: от 1 до {limit} символов, без управляющих символов.', { limit: MODEL_LABEL_LIMIT });
      return;
    }
    let cleanModel: string | null;
    // normalizeModel() shares its Russian messages with the server.
    try {
      cleanModel = normalizeModel(modelId);
      if (!cleanModel) throw new Error(t('Укажите ID модели. Значение CLI по умолчанию уже есть в выборе работника.'));
    } catch (error) { formError = error instanceof Error ? serverText(error.message) : t('Проверьте ID модели.'); return; }
    busy = true;
    const wasEditing = !!editingId;
    try {
      const input: ModelCatalogInput = { provider, modelId: cleanModel, label: cleanLabel };
      const saved = await request<ModelCatalogEntry>(editingId ? `/api/models/${encodeURIComponent(editingId)}` : '/api/models', {
        method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(input),
      });
      onchange(saved);
      editing = false;
      editingId = null;
      label = '';
      modelId = '';
      status = wasEditing ? t('Модель сохранена') : t('Модель добавлена');
    } catch (error) { formError = error instanceof Error ? error.message : t('Не удалось сохранить модель. Попробуйте ещё раз.'); }
    finally { busy = false; }
    if (!editing) void restoreFocus();
  }

  async function confirmDelete(entry: ModelCatalogEntry, trigger: HTMLElement) {
    if (busy) return;
    returnFocus = trigger;
    editing = false;
    editingId = null;
    formError = '';
    deletingId = entry.id;
    deleteError = '';
    status = '';
    await tick();
    deleteConfirmButton?.focus();
  }

  function cancelDelete() {
    if (busy) return;
    deletingId = null;
    deleteError = '';
    void restoreFocus();
  }

  async function remove(entry: ModelCatalogEntry) {
    if (busy) return;
    busy = true;
    deleteError = '';
    try {
      await request<{ ok: true }>(`/api/models/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      ondelete(entry.id);
      deletingId = null;
      status = t('Модель удалена из списка. Профили работников и история сохранены.');
    } catch (error) { deleteError = error instanceof Error ? error.message : t('Не удалось удалить модель. Попробуйте ещё раз.'); }
    finally { busy = false; }
    if (!deletingId) void restoreFocus(entry.provider);
  }
</script>

<section class="model-settings" bind:this={panel} aria-labelledby="model-catalog-title" aria-busy={busy}>
  <div class="model-settings-heading"><Icon name="spark" size={22} /><div><h3 id="model-catalog-title">{t('Модели')}</h3><p>{t('Настройте список для профилей работников. У каждого провайдера свой набор моделей.')}</p></div></div>
  <p class="model-catalog-note">{t('Изменения списка не меняют ID моделей в сохранённых профилях, текущих запусках и истории. Доступность модели зависит от вашего CLI и аккаунта.')}</p>
  {#if error}<div class="model-load-error" role="alert"><span>{error}</span><button type="button" class="button secondary" disabled={busy} onclick={retry}>{t('Повторить загрузку моделей')}</button></div>{/if}
  {#if deleteError && deletingId && !models.some(entry => entry.id === deletingId)}<div class="model-load-error" role="alert"><span>{deleteError}</span><button type="button" class="button secondary" disabled={busy} onclick={cancelDelete}>{t('Закрыть сообщение')}</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />{t('Загружаем список моделей…')}</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{deletingId ? t('Удаляем модель…') : t('Сохраняем модель…')} {t('Дождитесь ответа сервера, прежде чем закрывать настройки.')}</span></p>{/if}

  {#if editing}
    <form class="model-catalog-editor" aria-label={editingId ? t('Редактировать модель') : t('Добавить модель')} onsubmit={save}>
      <h4>{editingId ? t('Редактировать модель') : t('Добавить модель')}</h4>
      {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
      <label class="form-field"><span>{t('Название модели')} <span class="required">*</span></span><input bind:this={labelInput} name="modelLabel" aria-label={t('Название модели')} bind:value={label} maxlength={MODEL_LABEL_LIMIT} placeholder={t('Название в списке')} required disabled={busy} /></label>
      <label class="form-field"><span>{t('ID модели')} <span class="required">*</span></span><input name="modelId" aria-label={t('ID модели')} bind:value={modelId} maxlength={MODEL_ID_LIMIT} placeholder={t('Точный ID или алиас модели')} autocomplete="off" autocapitalize="off" spellcheck="false" required disabled={busy} /><small>{t('До {limit} символов, без пробелов. ID передаётся в CLI без изменений.', { limit: MODEL_ID_LIMIT })}</small></label>
      <label class="form-field"><span>{t('Провайдер модели')}</span><select name="modelProvider" aria-label={t('Провайдер модели')} bind:value={provider} disabled={busy}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
      <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelEditor}>{t('Отмена')}</button><button type="submit" class="button primary" disabled={busy}><Icon name={busy ? 'refresh' : editingId ? 'check' : 'plus'} class={busy ? 'spin' : ''} size={16} />{busy ? t('Сохраняем…') : editingId ? t('Сохранить модель') : t('Добавить модель')}</button></div>
    </form>
  {/if}

  <div class="model-provider-groups">
    {#each providers as group}
      <section class="model-provider-group" aria-label={t('Модели {provider}', { provider: providerName(group) })}>
        <div class="model-provider-heading"><h4>{providerName(group)}</h4><button type="button" data-add-provider={group} class="button secondary" disabled={busy} onclick={(event) => openEditor(group, event.currentTarget)} aria-label={t('Добавить модель {provider}', { provider: providerName(group) })}><Icon name="plus" size={15} />{t('Добавить')}</button></div>
        <div class="model-catalog-list">
          {#each models.filter(entry => entry.provider === group) as entry (entry.id)}
            <article class="model-catalog-entry" data-model-id={entry.id} aria-label={t('Модель: {name}', { name: entry.label })}>
              <div class="model-catalog-copy"><strong>{entry.label}</strong><span class="model-catalog-id">{entry.modelId}</span></div>
              <div class="model-entry-actions"><button type="button" class="icon-button" disabled={busy} aria-label={t('Изменить модель: {name}', { name: entry.label })} title={t('Изменить модель')} onclick={(event) => openEditor(group, event.currentTarget, entry)}><Icon name="edit" size={16} /></button><button type="button" class="icon-button" disabled={busy} aria-label={t('Удалить модель: {name}', { name: entry.label })} title={t('Удалить из списка')} onclick={(event) => confirmDelete(entry, event.currentTarget)}><Icon name="close" size={17} /></button></div>
              {#if deletingId === entry.id}<div class="model-delete-confirm"><p>{t('Удалить «{name}» из списка? Сохранённые профили и запуски продолжат использовать прежний ID.', { name: entry.label })}</p>{#if deleteError}<div class="form-error" role="alert"><span>{deleteError}</span></div>{/if}<div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy} onclick={cancelDelete}>{t('Отмена удаления')}</button><button bind:this={deleteConfirmButton} type="button" class="button danger" disabled={busy} onclick={() => remove(entry)}>{busy ? t('Удаляем…') : t('Удалить из списка')}</button></div></div>{/if}
            </article>
          {:else}
            {#if !loading && !error}<p class="model-catalog-empty">{t('Моделей пока нет. У работника остаются значение CLI по умолчанию и ручной ввод ID.')}</p>{/if}
          {/each}
        </div>
      </section>
    {/each}
  </div>
  <p class="model-catalog-limit">{t('До {limit} моделей для каждого провайдера. Изменения сохраняются на сервере.', { limit: MODEL_CATALOG_PROVIDER_LIMIT })}</p>
</section>
