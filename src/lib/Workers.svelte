<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import WorkerAvatar from './WorkerAvatar.svelte';
  import { effortOptions, effortLabel, modelLabel, normalizeModel, MODEL_ID_LIMIT } from './workers';
  import type { Effort, ModelCatalogEntry, Provider, Worker, WorkerInput } from './types';

  let { workers, loading, error, retry, onchange, notify, models, modelsLoading, modelsError, retryModels }: {
    workers: Worker[]; loading: boolean; error: string; retry: () => void;
    onchange: (worker: Worker) => void; notify: (message: string, type?: 'success' | 'error') => void;
    models: ModelCatalogEntry[]; modelsLoading: boolean; modelsError: string; retryModels: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
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
  let communicationStyle = $state('');
  let avatarUrl = $state<string | null>(null);
  let previewUrl = $state<string | null>(null);
  let avatarBlob = $state<Blob | null>(null);
  let imageBusy = $state(false);
  let submitting = $state(false);
  let formError = $state('');
  let imageError = $state('');
  let archivedVisible = $state(false);
  let pending = $state<string[]>([]);
  let imageSequence = 0;
  let fileInput = $state<HTMLInputElement>();
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

  async function request<T>(path: string, options: RequestInit): Promise<T> {
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
    return body as T;
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    avatarBlob = null;
  }
  onDestroy(() => { imageSequence++; clearPreview(); });

  async function openEditor(worker?: Worker) {
    imageSequence++;
    clearPreview();
    imageBusy = false;
    editingId = worker?.id ?? null;
    name = worker?.name ?? '';
    description = worker?.description ?? '';
    provider = worker?.provider ?? 'codex';
    draftModel = worker?.model ?? '';
    customSelection = !!draftModel && (modelsError !== '' || !models.some(option => option.provider === provider && option.modelId === draftModel));
    effort = worker?.effort ?? 'default';
    communicationStyle = worker?.communicationStyle ?? '';
    avatarUrl = worker?.avatarUrl ?? null;
    formError = '';
    imageError = '';
    editing = true;
    await tick();
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('[name="workerName"]')?.focus();
  }

  function closeEditor() {
    if (submitting) return;
    imageSequence++;
    imageBusy = false;
    dialog.close();
    editing = false;
    clearPreview();
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
    imageBusy = false;
    clearPreview();
    avatarUrl = null;
    imageError = '';
    if (fileInput) fileInput.value = '';
  }

  function resetImageError() {
    imageSequence++;
    imageBusy = false;
    imageError = '';
    if (fileInput) fileInput.value = '';
  }

  async function selectImage(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    const sequence = ++imageSequence;
    imageError = '';
    imageBusy = false;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      imageError = 'Выберите PNG, JPEG или WebP. SVG и другие форматы не поддерживаются.'; return;
    }
    if (file.size > 5 * 1024 * 1024 || file.size === 0) {
      imageError = 'Выберите непустое изображение размером до 5 МБ.'; return;
    }
    imageBusy = true;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      if (sequence !== imageSequence) return;
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Изображение слишком большое. Уменьшите его до 40 мегапикселей.');
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Не удалось обработать изображение в этом браузере.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .85));
      if (sequence !== imageSequence) return;
      if (!blob || blob.size > 256 * 1024) throw new Error('Не удалось уменьшить изображение до 256 КБ. Выберите другое.');
      clearPreview();
      avatarBlob = blob;
      previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      if (sequence === imageSequence) imageError = error instanceof Error && error.name !== 'InvalidStateError' ? error.message : 'Не удалось прочитать изображение. Выберите другой файл.';
    } finally {
      bitmap?.close();
      if (sequence === imageSequence) imageBusy = false;
    }
  }

  async function saveWorker(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || imageBusy || imageError) return;
    formError = '';
    if (!name.trim()) { formError = 'Укажите имя работника.'; return; }
    let model: string | null;
    try {
      model = normalizeModel(draftModel);
      if (modelSelection === '__custom__' && !model) throw new Error('Укажите ID модели или выберите «По умолчанию CLI».');
    } catch (error) { formError = error instanceof Error ? error.message : 'Проверьте ID модели.'; return; }
    submitting = true;
    try {
      if (avatarBlob) {
        const uploaded = await request<{ avatarUrl: string }>('/api/avatars', {
          method: 'POST', headers: { 'Content-Type': avatarBlob.type }, body: avatarBlob,
        });
        avatarUrl = uploaded.avatarUrl;
        avatarBlob = null; // A failed profile save can reuse this upload on retry.
      }
      const payload: WorkerInput = { name: name.trim(), description: description.trim(), provider, model, effort, communicationStyle: communicationStyle.trim(), avatarUrl };
      const saved = await request<Worker>(editingId ? `/api/workers/${encodeURIComponent(editingId)}` : '/api/workers', {
        method: editingId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      onchange(saved);
      notify(editingId ? 'Профиль работника сохранён' : 'Работник создан');
      submitting = false;
      closeEditor();
    } catch (error) { formError = error instanceof Error ? error.message : 'Не удалось сохранить работника'; }
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
      notify(worker.archived ? 'Работник восстановлен' : 'Работник в архиве. Задачи и история сохранены.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Не удалось обновить работника', 'error'); }
    finally { pending = pending.filter(id => id !== worker.id); }
  }

  function backdropClick(event: MouseEvent) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeEditor();
  }
</script>

{#snippet workerCard(worker: Worker)}
  <article class="worker-card" class:archived-worker={worker.archived} aria-label={'Работник: ' + worker.name}>
    <div class="worker-card-heading"><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={48} /><div><h2>{worker.name}</h2><p class="worker-description" class:empty-description={!worker.description?.trim()}>{worker.description?.trim() || 'Описание не задано'}</p><p>{providerName(worker.provider)} <span>·</span> <span class="worker-model-label" title={worker.model ?? undefined}>{modelLabel(worker.model, models, worker.provider)}</span></p><p>Усилия: {effortLabel(worker.effort)}</p></div>{#if worker.archived}<span class="worker-archived-label">В архиве</span>{/if}</div>
    <div class="worker-card-actions"><button class="button secondary" disabled={pending.includes(worker.id)} onclick={() => openEditor(worker)} aria-label={'Изменить работника: ' + worker.name}><Icon name="edit" size={14} />Изменить</button><button class="button text-button" disabled={pending.includes(worker.id)} onclick={() => setArchived(worker)} aria-label={(worker.archived ? 'Восстановить работника: ' : 'В архив: ') + worker.name}><Icon name={pending.includes(worker.id) ? 'refresh' : worker.archived ? 'refresh' : 'inbox'} size={14} class={pending.includes(worker.id) ? 'spin' : ''} />{worker.archived ? 'Восстановить' : 'В архив'}</button></div>
  </article>
{/snippet}

<section class="page-heading"><div><div class="eyebrow">ВАША КОМАНДА АГЕНТОВ</div><h1>Работники<span>{activeWorkers.length}</span></h1><p>Профили работников для ваших задач.</p></div><button class="button primary create-button" onclick={() => openEditor()}><Icon name="plus" size={17} />Новый работник</button></section>
{#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={retry}>Повторить</button></div>{/if}
<div class="workers-note"><Icon name="spark" size={17} /><p>Выберите работника при создании задачи. Изменения профиля применятся к новым запускам, а история сохранит прежние имя, аватар и настройки.</p></div>
{#if loading}<div class="detail-loading" role="status"><Icon name="refresh" class="spin" />Загружаем работников…</div>
{:else if activeWorkers.length}<div class="workers-grid">{#each activeWorkers as worker (worker.id)}{@render workerCard(worker)}{/each}</div>
{:else if !error}<div class="no-results"><span class="empty-icon"><Icon name="spark" size={27} /></span><h2>Знакомьтесь, ваша будущая команда</h2><p>Создайте работника для обзоров кода, исследований или ежедневных задач.</p><button class="button primary" onclick={() => openEditor()}><Icon name="plus" size={16} />Создать первого работника</button></div>{/if}
{#if archivedWorkers.length}<section class="archive-section"><button class="archive-toggle" aria-expanded={archivedVisible} onclick={() => archivedVisible = !archivedVisible}><Icon name={archivedVisible ? 'down' : 'chevron'} size={16} /><strong>Архив работников</strong><span>{archivedWorkers.length}</span></button>{#if archivedVisible}<p class="workers-archive-help">Архивные работники сохраняются в назначенных задачах и истории; их расписания продолжают работать. Для новых назначений восстановите профиль.</p><div class="workers-grid">{#each archivedWorkers as worker (worker.id)}{@render workerCard(worker)}{/each}</div>{/if}</section>{/if}

<dialog bind:this={dialog} class="editor-dialog worker-editor" aria-labelledby="worker-editor-title" oncancel={(event) => { event.preventDefault(); closeEditor(); }} onclick={backdropClick}>
  {#if editing}<form class="editor-form" onsubmit={saveWorker}>
    <header class="editor-header"><div><span class="editor-kicker">ПРОФИЛЬ РАБОТНИКА</span><h2 id="worker-editor-title">{editingId ? 'Редактировать работника' : 'Новый работник'}</h2></div><button class="icon-button" type="button" aria-label="Закрыть профиль" disabled={submitting} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
    <div class="editor-fields">
      {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} />{formError}</div>{/if}
      <div class="worker-avatar-picker"><WorkerAvatar name={name || 'Работник'} avatarUrl={previewUrl ?? avatarUrl} size={76} /><div><label class="form-field"><span>Аватар</span><input bind:this={fileInput} name="workerAvatar" aria-label="Загрузить аватар" type="file" accept="image/png,image/jpeg,image/webp" onchange={selectImage} disabled={submitting} /><small>PNG, JPEG или WebP до 5 МБ. Уменьшим до 256 × 256 и загрузим при сохранении.</small></label>{#if previewUrl || avatarUrl || imageError}<button type="button" class="avatar-remove" disabled={submitting} onclick={() => imageError ? resetImageError() : removeAvatar()}>{imageError ? 'Сбросить выбор изображения' : 'Убрать аватар'}</button>{/if}</div></div>
      {#if imageBusy}<p class="worker-image-status" role="status">Подготавливаем изображение…</p>{/if}
      {#if imageError}<div class="form-error" role="alert">{imageError}</div>{/if}
      <label class="form-field"><span>Имя работника <span class="required">*</span></span><input name="workerName" aria-label="Имя работника" bind:value={name} maxlength="80" placeholder="Например, Мира" required disabled={submitting} /></label>
      <label class="form-field"><span>Описание</span><textarea name="workerDescription" aria-label="Описание" bind:value={description} rows="3" maxlength="1000" disabled={submitting}></textarea><small>Показывается рядом с именем работника в задачах.</small></label>
      <div class="worker-model-fields">
        <label class="form-field"><span>Провайдер</span><select name="workerProvider" aria-label="Провайдер" bind:value={provider} onchange={changeProvider} disabled={submitting}><option value="codex">Codex</option><option value="claude">Claude Code</option></select><small>При смене провайдера модель сбросится на значение CLI по умолчанию.</small></label>
        <label class="form-field"><span>Модель</span><select name="workerModel" aria-label="Модель" value={modelSelection} onchange={changeModel} disabled={submitting}><option value="">По умолчанию CLI</option>{#each providerModels as option (option.id)}<option value={option.modelId}>{option.label} · {option.modelId}</option>{/each}<option value="__custom__">Другая модель…</option></select><small>Список можно изменить в настройках. Доступность зависит от вашего CLI и аккаунта; ID можно указать вручную.</small></label>
      </div>
      {#if modelsError}<div class="model-load-error" role="alert"><span>{modelsError} Можно выбрать значение CLI по умолчанию или указать ID вручную.</span><button class="button secondary" type="button" disabled={submitting} onclick={retryModels}>Повторить загрузку моделей</button></div>
      {:else if modelsLoading}<p class="worker-image-status" role="status">Загружаем список моделей… Можно указать ID вручную.</p>
      {:else if !providerModels.length}<p class="worker-image-status">В списке этого провайдера пока нет моделей. Добавьте их в настройках или укажите ID вручную.</p>{/if}
      {#if modelSelection === '__custom__'}<label class="form-field"><span>ID модели <span class="required">*</span></span><input name="workerCustomModel" aria-label="ID модели" bind:value={draftModel} maxlength={MODEL_ID_LIMIT} placeholder={providerModels[0]?.modelId ?? 'model-id'} autocomplete="off" autocapitalize="off" spellcheck="false" required disabled={submitting} /><small>Укажите ID или алиас, который принимает ваш CLI, до {MODEL_ID_LIMIT} символов. Без пробелов внутри и символов управления.</small></label>{/if}
      <label class="form-field"><span>Уровень усилий</span><select name="workerEffort" aria-label="Уровень усилий" bind:value={effort} disabled={submitting}>{#each effortOptions[provider] as option}<option value={option}>{effortLabel(option)}</option>{/each}</select><small>Поддержка уровня зависит от выбранной модели, аккаунта и версии CLI. «По умолчанию CLI» сохраняет настройки CLI.</small></label>
      <label class="form-field"><span>Личные инструкции</span><textarea name="communicationStyle" aria-label="Личные инструкции" bind:value={communicationStyle} rows="5" maxlength="4000" disabled={submitting}></textarea><small>Передаются работнику при запуске. Показываются только в его профиле.</small></label>
      {#if editingId}<div class="form-note">Уже начатые запуски и их продолжения сохранят прежний профиль. Обновления будут действовать со следующего запуска.</div>{/if}
    </div>
    <footer class="editor-footer"><button type="button" class="button secondary" disabled={submitting} onclick={closeEditor}>Отмена</button><button type="submit" class="button primary" disabled={submitting || imageBusy || !!imageError}>{#if submitting}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId ? 'check' : 'plus'} size={16} />{/if}{submitting ? 'Сохраняем…' : editingId ? 'Сохранить профиль' : 'Создать работника'}</button></footer>
  </form>{/if}
</dialog>
