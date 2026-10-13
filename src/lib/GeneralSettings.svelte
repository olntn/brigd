<script lang="ts">
  import Icon from './Icon.svelte';
  import type { GeneralSettings } from './types';

  let { settings, loading, error, retry, onchange, onmutation, busy = $bindable(false) }: {
    settings: GeneralSettings | null;
    loading: boolean;
    error: string;
    retry: () => void;
    onchange: (value: GeneralSettings) => void;
    onmutation: () => void;
    busy?: boolean;
  } = $props();
  let value = $state('');
  let defaultSchedule = $state<GeneralSettings['defaultSchedule']>('manual');
  let dirty = $state(false);
  let formError = $state('');
  let status = $state('');
  let applied = '';

  $effect(() => {
    const next = JSON.stringify(settings);
    if (next === applied) return;
    applied = next;
    if (!dirty) {
      value = settings?.defaultCwd ?? '';
      defaultSchedule = settings?.defaultSchedule ?? 'manual';
    }
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading || !settings) return;
    formError = '';
    status = '';
    const defaultCwd = value.trim();
    if (!defaultCwd) { formError = 'Укажите рабочую папку по умолчанию.'; return; }
    busy = true;
    onmutation();
    try {
      const response = await fetch('/api/settings/general', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultCwd, defaultSchedule }),
      });
      let body;
      try { body = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
      if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
      const saved = body as GeneralSettings;
      dirty = false;
      value = saved.defaultCwd;
      defaultSchedule = saved.defaultSchedule;
      onchange(saved);
      status = 'Настройки сохранены';
    } catch (failure) {
      formError = failure instanceof TypeError ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
        : failure instanceof Error ? failure.message : 'Не удалось сохранить настройки. Попробуйте ещё раз.';
    } finally { busy = false; }
  }
</script>

<section class="general-settings model-settings" aria-labelledby="general-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="sliders" size={22} /><div><h3 id="general-settings-title">Общие</h3><p>Параметры для новых задач.</p></div></div>
  {#if error}<div class="model-load-error" role="alert"><span>{error}</span><button type="button" class="button secondary" disabled={busy} onclick={retry}>Повторить загрузку настроек</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />Загружаем общие настройки…</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>Сохраняем настройки…</span></p>{/if}
  <form class="general-settings-form" aria-label="Общие настройки" onsubmit={save}>
    {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
    <label class="form-field"><span>Рабочая папка по умолчанию</span><div class="input-with-icon"><Icon name="folder" size={16} /><input name="defaultCwd" aria-label="Рабочая папка по умолчанию" aria-describedby="default-cwd-description" bind:value oninput={() => { dirty = true; formError = ''; status = ''; }} maxlength="4096" placeholder="/workspace/projects/my-project" required disabled={busy || loading || !settings} spellcheck="false" autocapitalize="off" /></div><small id="default-cwd-description">Абсолютный путь к папке на компьютере, где запущен brigd. Подставляется при создании задачи; его можно изменить в форме.</small></label>
    <label class="form-field"><span>Тип запуска по умолчанию</span><select name="defaultSchedule" aria-label="Тип запуска по умолчанию" aria-describedby="default-schedule-description" bind:value={defaultSchedule} onchange={() => { dirty = true; formError = ''; status = ''; }} disabled={busy || loading || !settings}><option value="auto">Автопилот</option><option value="manual">Вручную</option><option value="interval">По расписанию</option></select><small id="default-schedule-description">Выбирается в поле «Когда запускать» у новых задач. Его можно изменить в форме задачи.</small></label>
    <div class="model-catalog-actions"><button type="submit" class="button primary" disabled={busy || loading || !settings}><Icon name={busy ? 'refresh' : 'check'} class={busy ? 'spin' : ''} size={16} />{busy ? 'Сохраняем…' : 'Сохранить настройки'}</button></div>
  </form>
</section>
