<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import AvatarEditor from './AvatarEditor.svelte';
  import { defaultAvatarCrop, exportAvatar, type AvatarCrop } from './avatar';
  import { effortOptions, effortLabel, modelLabel, normalizeModel, INTEGRATOR_WORKER, MODEL_ID_LIMIT } from './workers';
  import { serverText, t } from './i18n';
  import type { Effort, IntegratorMode, IntegratorProfile, IntegratorProfileInput, ModelCatalogEntry, Provider, Worker, WorkerInput } from './types';

  let { workers, loading, error, retry, onchange, ondelete, notify, models, modelsLoading, modelsError, retryModels }: {
    workers: Worker[]; loading: boolean; error: string; retry: () => void;
    onchange: (worker: Worker) => void; ondelete: (id: string) => void; notify: (message: string, type?: 'success' | 'error') => void;
    models: ModelCatalogEntry[]; modelsLoading: boolean; modelsError: string; retryModels: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let confirmation: HTMLDialogElement;
  let deleting = $state<Worker | null>(null);
  let deleteError = $state('');
  let removing = $state(false);
  let editing = $state(false);
  let editingId = $state<string | null>(null);
  let name = $state('');
  let description = $state('');
  let provider = $state<Provider>('codex');
  // Keep the actual ID independent of the available options. Renaming, moving or
  // deleting a catalog entry must never change an open draft or saved profile.
  let draftModel = $state('');
  let customSelection = $state(false);
  let effort = $state<Effort>('default');
  let ultracode = $state(false);
  // Empty string follows Настройки → Общие; otherwise the ID of the worker that picks up after exhausted limits.
  let fallbackWorkerId = $state('');
  let communicationStyle = $state('');
  let avatarUrl = $state<string | null>(null);
  let previewUrl = $state<string | null>(null);
  let avatarBlob = $state<Blob | null>(null);
  let imageSource = $state.raw<ImageBitmap | null>(null);
  let avatarCrop = $state<AvatarCrop>(defaultAvatarCrop());
  let imageLoading = $state(false);
  let imageRendering = $state(false);
  let imageBusy = $derived(imageLoading || imageRendering);
  let submitting = $state(false);
  let formError = $state('');
  let imageError = $state('');
  let archivedVisible = $state(false);
  let pending = $state<string[]>([]);
  let imageSequence = 0;
  let fileInput = $state<HTMLInputElement>();
  // The built-in integrator has one profile; the same dialog edits it with a reduced field set.
  let integrator = $state<IntegratorProfile | null>(null);
  let integratorLoading = $state(true);
  let integratorError = $state('');
  let editingBuiltin = $state(false);
  let integratorMode = $state<IntegratorMode>('inherit');
  let activeWorkers = $derived(workers.filter(worker => !worker.archived));
  let archivedWorkers = $derived(workers.filter(worker => worker.archived));
  let providerModels = $derived(modelsError ? [] : models.filter(model => model.provider === provider));
  let modelSelection = $derived(customSelection || (!!draftModel && !providerModels.some(option => option.modelId === draftModel)) ? '__custom__' : draftModel);
  $effect(() => {
    // Once a disappearing option becomes manual input, keep that input open even
    // while the user clears/retypes its value or the catalog recovers.
    if (editing && draftModel && !customSelection && !providerModels.some(option => option.modelId === draftModel)) customSelection = true;
  });
  const providerName = (value: Provider) => value === 'codex' ? 'Codex' : 'Claude Code';
  /** Other profiles that can take over; an archived profile stays listed only while it is the saved choice. */
  let fallbackOptions = $derived(workers.filter(worker => worker.id !== editingId && (!worker.archived || worker.id === fallbackWorkerId)));
  let fallbackHint = $derived.by(() => {
    const worker = workers.find(item => item.id === fallbackWorkerId);
    if (!worker) return t('Кто начнёт новую сессию с тем же заданием, если CLI этого работника сообщит об исчерпании лимитов. Пусто: как в Настройки → Общие.');
    if (worker.archived) return t('{name} в архиве: восстановите работника или выберите другого, иначе замена не сработает.', { name: worker.name });
    if (worker.provider === provider) return t('{name} тоже использует {provider}: лимиты аккаунта общие, выберите работника другого провайдера.', { name: worker.name, provider: providerName(provider) });
    return t('{name} ({provider}) подхватит новую сессию вместо этого работника.', { name: worker.name, provider: providerName(worker.provider) });
  });
  const fallbackLabel = (worker: Worker) => {
    if (!worker.fallbackWorkerId) return '';
    const fallback = workers.find(item => item.id === worker.fallbackWorkerId);
    return !fallback ? t('работник не найден') : fallback.archived ? t('{name} (в архиве)', { name: fallback.name }) : fallback.name;
  };
  let integratorSettings = $derived(!integrator ? (integratorError ? t('Настройки недоступны') : t('Загружаем настройки…')) : integrator.mode === 'inherit'
    ? t('Провайдер, модель и усилия — как у запуска, результат которого объединяется')
    : `${providerName(integrator.provider)} · ${t(modelLabel(integrator.model, modelsError ? undefined : models, integrator.provider))} · ${t(effortLabel(integrator.effort))}`);

  async function request<T>(path: string, options: RequestInit): Promise<T> {
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(serverText(body.error ?? '') || t('Ошибка запроса ({status})', { status: response.status }));
    return body as T;
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    avatarBlob = null;
  }
  function clearImageSource() {
    imageSource?.close();
    imageSource = null;
    imageRendering = false;
    avatarCrop = defaultAvatarCrop();
  }
  function previewAvatar(blob: Blob) {
    clearPreview();
    avatarBlob = blob;
    previewUrl = URL.createObjectURL(blob);
  }
  onDestroy(() => { imageSequence++; clearPreview(); clearImageSource(); });

  async function loadIntegrator() {
    integratorLoading = true;
    integratorError = '';
    try { integrator = await request<IntegratorProfile>('/api/integrator', {}); }
    catch (error) { integratorError = error instanceof Error ? error.message : t('Не удалось загрузить настройки Интегратора'); }
    finally { integratorLoading = false; }
  }
  onMount(() => { void loadIntegrator(); });

  function resetEditorMedia() {
    imageSequence++;
    clearPreview();
    clearImageSource();
    imageLoading = false;
  }
  async function presentEditor(focus: string) {
    formError = '';
    imageError = '';
    editing = true;
    await tick();
    dialog.showModal();
    dialog.querySelector<HTMLElement>(focus)?.focus();
  }
  async function openEditor(worker?: Worker) {
    resetEditorMedia();
    editingBuiltin = false;
    editingId = worker?.id ?? null;
    name = worker?.name ?? '';
    description = worker?.description ?? '';
    provider = worker?.provider ?? 'codex';
    draftModel = worker?.model ?? '';
    customSelection = !!draftModel && (modelsError !== '' || !models.some(option => option.provider === provider && option.modelId === draftModel));
    effort = worker?.effort ?? 'default';
    ultracode = worker?.ultracode ?? false;
    fallbackWorkerId = worker?.fallbackWorkerId ?? '';
    communicationStyle = worker?.communicationStyle ?? '';
    avatarUrl = worker?.avatarUrl ?? null;
    await presentEditor('[name="workerName"]');
  }
  async function openIntegratorEditor() {
    if (!integrator) return;
    resetEditorMedia();
    editingBuiltin = true;
    editingId = null;
    name = t(INTEGRATOR_WORKER.name);
    description = '';
    integratorMode = integrator.mode;
    provider = integrator.provider;
    draftModel = integrator.model ?? '';
    customSelection = !!draftModel && (modelsError !== '' || !models.some(option => option.provider === provider && option.modelId === draftModel));
    effort = integrator.effort;
    communicationStyle = integrator.communicationStyle;
    avatarUrl = integrator.avatarUrl;
    await presentEditor('[name="integratorMode"]');
  }

  function closeEditor() {
    if (submitting) return;
    imageSequence++;
    imageLoading = false;
    dialog.close();
    editing = false;
    clearPreview();
    clearImageSource();
  }

  function changeProvider(event: Event) {
    const nextProvider = (event.currentTarget as HTMLSelectElement).value as Provider;
    draftModel = '';
    customSelection = false;
    if (!effortOptions[nextProvider].includes(effort)) effort = 'default';
  }

  function changeModel(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    customSelection = value === '__custom__';
    if (!customSelection) draftModel = value;
  }

  function removeAvatar() {
    imageSequence++;
    imageLoading = false;
    clearPreview();
    clearImageSource();
    avatarUrl = null;
    imageError = '';
    if (fileInput) fileInput.value = '';
  }

  function resetImageError() {
    imageSequence++;
    imageLoading = false;
    imageError = '';
    if (fileInput) fileInput.value = '';
  }

  async function selectImage(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const sequence = ++imageSequence;
    imageError = '';
    imageLoading = false;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      imageError = t('Выберите PNG, JPEG или WebP. SVG и другие форматы не поддерживаются.'); return;
    }
    if (file.size > 5 * 1024 * 1024 || file.size === 0) {
      imageError = t('Выберите непустое изображение размером до 5 МБ.'); return;
    }
    imageLoading = true;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      if (sequence !== imageSequence) return;
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error(t('Изображение слишком большое. Уменьшите его до 40 мегапикселей.'));
      clearPreview();
      clearImageSource();
      imageSource = bitmap;
      bitmap = null;
      imageRendering = true;
    } catch (error) {
      if (sequence === imageSequence) imageError = error instanceof Error && error.name !== 'InvalidStateError' ? error.message : t('Не удалось прочитать изображение. Выберите другой файл.');
    } finally {
      bitmap?.close();
      if (sequence === imageSequence) imageLoading = false;
    }
  }

  async function editAvatar() {
    if (imageBusy || submitting || !avatarUrl || !/^\/api\/avatars\/[a-f0-9]{64}$/.test(avatarUrl)) return;
    const sequence = ++imageSequence;
    imageLoading = true;
    imageError = '';
    let bitmap: ImageBitmap | null = null;
    try {
      const response = await fetch(avatarUrl);
      if (!response.ok) throw new Error(t('Не удалось загрузить аватар. Попробуйте ещё раз.'));
      bitmap = await createImageBitmap(await response.blob());
      if (sequence !== imageSequence) return;
      clearImageSource();
      imageSource = bitmap;
      bitmap = null;
      imageRendering = true;
    } catch (error) {
      if (sequence === imageSequence) imageError = error instanceof Error ? error.message : t('Не удалось прочитать аватар.');
    } finally {
      bitmap?.close();
      if (sequence === imageSequence) imageLoading = false;
    }
  }

  async function saveWorker(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || imageBusy || imageError) return;
    formError = '';
    if (!editingBuiltin && !name.trim()) { formError = t('Укажите имя работника.'); return; }
    // In inherit mode the hidden CLI fields keep their saved values for a later switch back.
    const ownSettings = !editingBuiltin || integratorMode === 'custom';
    let model: string | null;
    try {
      model = ownSettings ? normalizeModel(draftModel) : integrator?.model ?? null;
      if (ownSettings && modelSelection === '__custom__' && !model) throw new Error(t('Укажите ID модели или выберите «По умолчанию CLI».'));
    } catch (error) { formError = error instanceof Error ? serverText(error.message) : t('Проверьте ID модели.'); return; }
    submitting = true;
    try {
      if (avatarBlob) {
        // Use the current controls even if the last preview has not painted yet.
        if (imageSource) avatarBlob = await exportAvatar(imageSource, avatarCrop);
        const uploaded = await request<{ avatarUrl: string }>('/api/avatars', {
          method: 'POST', headers: { 'Content-Type': avatarBlob.type }, body: avatarBlob,
        });
        avatarUrl = uploaded.avatarUrl;
        avatarBlob = null; // A failed profile save can reuse this upload on retry.
      }
      if (editingBuiltin) {
        const payload: IntegratorProfileInput = { mode: integratorMode, provider, model, effort, communicationStyle: communicationStyle.trim(), avatarUrl };
        integrator = await request<IntegratorProfile>('/api/integrator', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        notify(t('Настройки Интегратора сохранены'));
      } else {
        const payload: WorkerInput = { name: name.trim(), description: description.trim(), provider, model, effort, ultracode, fallbackWorkerId: fallbackWorkerId || null, communicationStyle: communicationStyle.trim(), avatarUrl };
        const saved = await request<Worker>(editingId ? `/api/workers/${encodeURIComponent(editingId)}` : '/api/workers', {
          method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        onchange(saved);
        notify(editingId ? t('Профиль работника сохранён') : t('Работник создан'));
      }
      submitting = false;
      closeEditor();
    } catch (error) { formError = error instanceof Error ? serverText(error.message) : t('Не удалось сохранить работника'); }
    finally { submitting = false; }
  }

  async function setArchived(worker: Worker) {
    if (pending.includes(worker.id)) return;
    pending = [...pending, worker.id];
    try {
      const saved = await request<Worker>(`/api/workers/${encodeURIComponent(worker.id)}`, {
        method: worker.archived ? 'PATCH' : 'DELETE', headers: { 'Content-Type': 'application/json' },
        ...(worker.archived ? { body: JSON.stringify({ archived: false }) } : {}),
      });
      onchange(saved);
      notify(worker.archived ? t('Работник восстановлен') : t('Работник в архиве. Задачи и история сохранены.'));
    } catch (error) { notify(error instanceof Error ? error.message : t('Не удалось обновить работника'), 'error'); }
    finally { pending = pending.filter(id => id !== worker.id); }
  }

  async function askDelete(worker: Worker) {
    if (pending.includes(worker.id) || removing) return;
    deleting = worker;
    deleteError = '';
    await tick();
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
    const worker = deleting;
    if (!worker || removing || pending.includes(worker.id)) return;
    removing = true;
    deleteError = '';
    pending = [...pending, worker.id];
    try {
      await request<{ ok: true }>(`/api/workers/${encodeURIComponent(worker.id)}/purge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      removing = false;
      closeDelete();
      ondelete(worker.id);
      notify(t('Работник удалён. История запусков сохранила его имя и настройки.'));
    } catch (failure) { deleteError = failure instanceof Error ? failure.message : t('Не удалось удалить работника'); }
    finally { removing = false; pending = pending.filter(id => id !== worker.id); }
  }

  function backdropClick(event: MouseEvent, target = dialog, close = closeEditor) {
    if (event.target !== target) return;
    const rect = target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }
</script>

{#snippet workerCard(worker: Worker)}
  <article class="worker-card" class:archived-worker={worker.archived} aria-label={t('Работник: {name}', { name: worker.name })}>
    <div class="worker-card-heading"><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={64} /><div><h2>{worker.name}</h2><p class="worker-description" class:empty-description={!worker.description?.trim()}>{worker.description?.trim() || t('Описание не задано')}</p><p>{providerName(worker.provider)} <span>·</span> <span class="worker-model-label" title={worker.model ?? undefined}>{t(modelLabel(worker.model, models, worker.provider))}</span></p><p>{t('Усилия: {effort}', { effort: t(effortLabel(worker.effort)) })}</p>{#if worker.fallbackWorkerId}<p class="worker-fallback-label">{t('Замена при лимитах: {name}', { name: fallbackLabel(worker) })}</p>{/if}</div>{#if worker.archived}<span class="worker-archived-label">{t('В архиве')}</span>{/if}</div>
    <div class="worker-card-actions"><button class="button secondary" disabled={pending.includes(worker.id)} onclick={() => openEditor(worker)} aria-label={t('Изменить работника: {name}', { name: worker.name })}><Icon name="edit" size={14} />{t('Изменить')}</button><button class="button text-button" disabled={pending.includes(worker.id)} onclick={() => setArchived(worker)} aria-label={worker.archived ? t('Восстановить работника: {name}', { name: worker.name }) : t('В архив: {name}', { name: worker.name })}><Icon name={pending.includes(worker.id) ? 'refresh' : worker.archived ? 'refresh' : 'inbox'} size={14} class={pending.includes(worker.id) ? 'spin' : ''} />{worker.archived ? t('Восстановить') : t('В архив')}</button><button class="button text-button danger-hover" disabled={pending.includes(worker.id)} onclick={() => askDelete(worker)} aria-label={t('Удалить работника: {name}', { name: worker.name })}><Icon name="trash" size={14} />{t('Удалить')}</button></div>
  </article>
{/snippet}

<section class="page-heading"><div><h1>{t('Работники')}</h1><p>{t('Профили работников для ваших задач.')}</p></div><button class="button primary create-button" onclick={() => openEditor()}><Icon name="plus" size={17} />{t('Новый работник')}</button></section>
{#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={retry}>{t('Повторить')}</button></div>{/if}
<div class="workers-note"><Icon name="spark" size={17} /><p>{t('Выберите работника при создании задачи. Изменения профиля применятся к новым запускам, а история сохранит прежние имя, аватар и настройки.')}</p></div>
{#if loading}<div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Загружаем работников…')}</div>
{:else if activeWorkers.length}<div class="workers-grid">{#each activeWorkers as worker (worker.id)}{@render workerCard(worker)}{/each}</div>
{:else if !error}<div class="no-results"><span class="empty-icon"><Icon name="spark" size={27} /></span><h2>{t('Знакомьтесь, ваша будущая команда')}</h2><p>{t('Создайте работника для обзоров кода, исследований или ежедневных задач.')}</p><button class="button primary" onclick={() => openEditor()}><Icon name="plus" size={16} />{t('Создать первого работника')}</button></div>{/if}
<section class="builtin-section" aria-label={t('Встроенные работники')}>
  <h2 class="builtin-heading">{t('Встроенный работник')}</h2>
  <article class="worker-card builtin-worker" aria-label={t('Встроенный работник: {name}', { name: t(INTEGRATOR_WORKER.name) })}>
    <div class="worker-card-heading"><WorkerAvatar name={t(INTEGRATOR_WORKER.name)} avatarUrl={integrator?.avatarUrl ?? null} size={64} /><div><h2>{t(INTEGRATOR_WORKER.name)}</h2><p class="worker-description">{t(INTEGRATOR_WORKER.description)}</p><p class="integrator-settings">{integratorSettings}</p></div><span class="worker-archived-label">{t('Встроенный')}</span></div>
    <p class="builtin-worker-note">{t('Запускается сам при конфликте слияния (или кнопкой «Поручить интегратору» в карточке задачи), разрешает конфликты в worktree задачи, после чего brigd заново проверяет и переносит результат. Коммиты объединения подписаны его именем. Его нельзя назначить задаче или архивировать; настройки запуска, указания и аватар меняются здесь.')}</p>
    {#if integratorError}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{integratorError}</span><button onclick={() => { void loadIntegrator(); }}>{t('Повторить')}</button></div>{/if}
    <div class="worker-card-actions"><button class="button secondary" disabled={!integrator || integratorLoading} onclick={() => { void openIntegratorEditor(); }} aria-label={t('Изменить работника: {name}', { name: t(INTEGRATOR_WORKER.name) })}><Icon name="edit" size={14} />{t('Изменить')}</button></div>
  </article>
</section>
{#if archivedWorkers.length}<section class="archive-section"><button class="archive-toggle" aria-expanded={archivedVisible} onclick={() => archivedVisible = !archivedVisible}><Icon name={archivedVisible ? 'down' : 'chevron'} size={16} /><strong>{t('Архив работников')}</strong></button>{#if archivedVisible}<p class="workers-archive-help">{t('Архивные работники сохраняются в назначенных задачах и истории; их расписания продолжают работать. Для новых назначений восстановите профиль.')}</p><div class="workers-grid">{#each archivedWorkers as worker (worker.id)}{@render workerCard(worker)}{/each}</div>{/if}</section>{/if}

<dialog bind:this={confirmation} class="editor-dialog instruction-delete-dialog" aria-labelledby="worker-delete-title" aria-describedby="worker-delete-description" oncancel={(event) => { event.preventDefault(); closeDelete(); }} onclick={(event) => backdropClick(event, confirmation, closeDelete)}>
  {#if deleting}
    <form class="editor-form" onsubmit={remove} aria-busy={removing}>
      <header class="editor-header"><h2 id="worker-delete-title">{t('Удалить работника навсегда?')}</h2><button type="button" class="icon-button" aria-label={t('Закрыть удаление')} disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}
        <p id="worker-delete-description">{t('Профиль «{name}» исчезнет из списка без возможности восстановления. История прошлых запусков сохранит его имя, аватар и настройки. Если работник выбран заменой при лимитах или работником по умолчанию, этот выбор очистится. Работника, назначенного в задачах, сначала замените в них или удалите эти задачи.', { name: deleting.name })}</p>
      </div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>{t('Отмена')}</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? t('Удаляем…') : t('Удалить навсегда')}</button></footer>
    </form>
  {/if}
</dialog>

<dialog bind:this={dialog} class="editor-dialog worker-editor" aria-labelledby="worker-editor-title" oncancel={(event) => { event.preventDefault(); closeEditor(); }} onclick={(event) => backdropClick(event)}>
  {#if editing}<form class="editor-form" onsubmit={saveWorker}>
    <header class="editor-header"><div><h2 id="worker-editor-title">{editingBuiltin ? t('Настройки Интегратора') : editingId ? t('Редактировать работника') : t('Новый работник')}</h2></div><button class="icon-button" type="button" aria-label={t('Закрыть профиль')} disabled={submitting} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
    <div class="editor-fields">
      {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} />{formError}</div>{/if}
      <div class="worker-avatar-picker"><WorkerAvatar name={name || t('Работник')} avatarUrl={previewUrl ?? avatarUrl} size={88} /><div><label class="form-field"><span>{t('Аватар')}</span><input bind:this={fileInput} name="workerAvatar" aria-label={t('Загрузить аватар')} type="file" accept="image/png,image/jpeg,image/webp" onchange={selectImage} disabled={submitting} /><small>{t('PNG, JPEG или WebP до 5 МБ. Настройте масштаб и область изображения перед сохранением.')}</small></label>{#if avatarUrl && !imageSource}<button type="button" class="avatar-remove" disabled={submitting || imageBusy} onclick={editAvatar}>{t('Изменить размер аватара')}</button>{/if}{#if previewUrl || avatarUrl || imageError}<button type="button" class="avatar-remove" disabled={submitting} onclick={() => imageError ? resetImageError() : removeAvatar()}>{imageError ? t('Сбросить выбор изображения') : t('Убрать аватар')}</button>{/if}</div></div>
      {#if imageSource}{@const source = imageSource}{#key source}<AvatarEditor image={source} bind:crop={avatarCrop} disabled={submitting} onpreview={(blob) => { if (imageSource === source) previewAvatar(blob); }} onbusy={(busy) => { if (imageSource === source) imageRendering = busy; }} onerror={(message) => { if (imageSource === source) imageError = message; }} />{/key}{/if}
      {#if imageBusy}<p class="worker-image-status" role="status">{t('Подготавливаем изображение…')}</p>{/if}
      {#if imageError}<div class="form-error" role="alert">{imageError}</div>{/if}
      {#if editingBuiltin}
      <label class="form-field"><span>{t('Настройки запуска')}</span><select name="integratorMode" aria-label={t('Настройки запуска')} bind:value={integratorMode} disabled={submitting}><option value="inherit">{t('Как у запуска, результат которого объединяется')}</option><option value="custom">{t('Свои провайдер, модель и усилия')}</option></select><small>{t('Сессия Интегратора всегда новая: настройки объединяемого запуска не дают ему контекста задачи, только тот же CLI.')}</small></label>
      {:else}
      <label class="form-field"><span>{t('Имя работника')} <span class="required">*</span></span><input name="workerName" aria-label={t('Имя работника')} bind:value={name} maxlength="80" placeholder={t('Например, Мира')} required disabled={submitting} /></label>
      <label class="form-field"><span>{t('Описание')}</span><textarea name="workerDescription" aria-label={t('Описание')} bind:value={description} rows="3" maxlength="1000" disabled={submitting}></textarea><small>{t('Показывается рядом с именем работника в задачах.')}</small></label>
      {/if}
      {#if !editingBuiltin || integratorMode === 'custom'}
      <div class="worker-model-fields">
        <label class="form-field"><span>{t('Провайдер')}</span><select name="workerProvider" aria-label={t('Провайдер')} bind:value={provider} onchange={changeProvider} disabled={submitting}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><small>{t('При смене провайдера модель сбросится на значение CLI по умолчанию.')}</small></label>
        <label class="form-field"><span>{t('Модель')}</span><select name="workerModel" aria-label={t('Модель')} value={modelSelection} onchange={changeModel} disabled={submitting}><option value="">{t('По умолчанию CLI')}</option>{#each providerModels as option (option.id)}<option value={option.modelId}>{option.label} · {option.modelId}</option>{/each}<option value="__custom__">{t('Другая модель…')}</option></select><small>{t('Список можно изменить в настройках. Доступность зависит от вашего CLI и аккаунта; ID можно указать вручную.')}</small></label>
      </div>
      {#if modelsError}<div class="model-load-error" role="alert"><span>{modelsError} {t('Можно выбрать значение CLI по умолчанию или указать ID вручную.')}</span><button class="button secondary" type="button" disabled={submitting} onclick={retryModels}>{t('Повторить загрузку моделей')}</button></div>
      {:else if modelsLoading}<p class="worker-image-status" role="status">{t('Загружаем список моделей… Можно указать ID вручную.')}</p>
      {:else if !providerModels.length}<p class="worker-image-status">{t('В списке этого провайдера пока нет моделей. Добавьте их в настройках или укажите ID вручную.')}</p>{/if}
      {#if modelSelection === '__custom__'}<label class="form-field"><span>{t('ID модели')} <span class="required">*</span></span><input name="workerCustomModel" aria-label={t('ID модели')} bind:value={draftModel} maxlength={MODEL_ID_LIMIT} placeholder={providerModels[0]?.modelId ?? 'model-id'} autocomplete="off" autocapitalize="off" spellcheck="false" required disabled={submitting} /><small>{t('Укажите ID или алиас, который принимает ваш CLI, до {limit} символов. Без пробелов внутри и символов управления.', { limit: MODEL_ID_LIMIT })}</small></label>{/if}
      <label class="form-field"><span>{t('Уровень усилий')}</span><select name="workerEffort" aria-label={t('Уровень усилий')} bind:value={effort} disabled={submitting}>{#each effortOptions[provider] as option}<option value={option}>{t(effortLabel(option))}</option>{/each}</select><small>{t('Поддержка уровня зависит от выбранной модели, аккаунта и версии CLI. «По умолчанию CLI» сохраняет настройки CLI.')}</small></label>
      {/if}
      {#if !editingBuiltin}
      <div class="form-field"><label class="worker-ultracode-option"><input name="workerUltracode" type="checkbox" bind:checked={ultracode} aria-describedby="worker-ultracode-help" disabled={submitting} /><span>ultracode</span></label><small id="worker-ultracode-help">{provider === 'codex' ? t('Включает режим ultra с подагентами. Вместо выбранного уровня усилий используется ultra.') : t('Включает режим ultracode с подагентами. Выбранный уровень усилий сохраняется.')}</small></div>
      <label class="form-field"><span>{t('Замена при лимитах')}</span><select name="workerFallback" aria-label={t('Замена при лимитах')} aria-describedby="worker-fallback-help" bind:value={fallbackWorkerId} disabled={submitting}><option value="">{t('Как в настройках')}</option>{#each fallbackOptions as option (option.id)}<option value={option.id}>{option.name} · {providerName(option.provider)}{option.archived ? ` · ${t('в архиве')}` : ''}</option>{/each}</select><small id="worker-fallback-help">{fallbackHint}</small></label>
      {/if}
      {#if editingBuiltin}
      <label class="form-field"><span>{t('Указания Интегратору')}</span><textarea name="communicationStyle" aria-label={t('Указания Интегратору')} bind:value={communicationStyle} rows="5" maxlength="4000" disabled={submitting}></textarea><small>{t('Передаются при разрешении конфликта: например, какие файлы не трогать или чью версию предпочитать. Показываются только здесь.')}</small></label>
      {:else}
      <label class="form-field"><span>{t('Личные инструкции')}</span><textarea name="communicationStyle" aria-label={t('Личные инструкции')} bind:value={communicationStyle} rows="5" maxlength="4000" disabled={submitting}></textarea><small>{t('Передаются работнику при запуске. Показываются только в его профиле.')}</small></label>
      {/if}
      {#if editingId || editingBuiltin}<div class="form-note">{t('Уже начатые запуски и их продолжения сохранят прежний профиль. Обновления будут действовать со следующего запуска.')}</div>{/if}
    </div>
    <footer class="editor-footer"><button type="button" class="button secondary" disabled={submitting} onclick={closeEditor}>{t('Отмена')}</button><button type="submit" class="button primary" disabled={submitting || imageBusy || !!imageError}>{#if submitting}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId || editingBuiltin ? 'check' : 'plus'} size={16} />{/if}{submitting ? t('Сохраняем…') : editingBuiltin ? t('Сохранить настройки') : editingId ? t('Сохранить профиль') : t('Создать работника')}</button></footer>
  </form>{/if}
</dialog>

<style>
  .worker-ultracode-option { display: flex; align-items: center; gap: 10px; color: var(--secondary); font-size: .92rem; cursor: pointer; }
  .worker-ultracode-option input[type='checkbox'] { width: 17px; height: 17px; margin: 0; padding: 0; }
  .worker-fallback-label { overflow-wrap: anywhere; }
</style>
