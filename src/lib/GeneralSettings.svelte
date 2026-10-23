<script lang="ts">
  import Icon from './Icon.svelte';
  import BrowserNotificationSettings from './BrowserNotificationSettings.svelte';
  import { serverText, t, tk } from './i18n';
  import type { FallbackWorkers, GeneralSettings, Provider, Worker } from './types';

  let { settings, loading, error, retry, onchange, onmutation, workers = [], busy = $bindable(false) }: {
    settings: GeneralSettings | null;
    loading: boolean;
    error: string;
    retry: () => void;
    onchange: (value: GeneralSettings) => void;
    onmutation: () => void;
    /** Catalog for the default and replacement selects; archived profiles stay visible only while selected. */
    workers?: Worker[];
    busy?: boolean;
  } = $props();
  let value = $state('');
  let defaultSchedule = $state<GeneralSettings['defaultSchedule']>('manual');
  let webhookUrl = $state('');
  let webhookSecret = $state('');
  // Empty string stands for "no default worker", as in the task form.
  let defaultWorker = $state('');
  let agentTimeLimitMinutes = $state<number | undefined>();
  let integrationCheckTimeLimitMinutes = $state<number | undefined>();
  // Empty string stands for "no replacement"; IDs are kept even when the catalog has not loaded yet.
  let fallback = $state<Record<Provider, string>>({ codex: '', claude: '' });
  let dirty = $state(false);
  let formError = $state('');
  let status = $state('');
  let applied = '';
  const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
  const fallbackProviders: { provider: Provider; label: string }[] = [
    { provider: 'codex', label: tk('Если у Codex закончились лимиты') },
    { provider: 'claude', label: tk('Если у Claude Code закончились лимиты') },
  ];
  /** Active workers first; a saved but archived choice keeps its option so the form never silently drops it. */
  function workerOptions(selected: string): Worker[] {
    return workers.filter(worker => !worker.archived || worker.id === selected);
  }
  function defaultWorkerHint(selected: string): string {
    const worker = workers.find(item => item.id === selected);
    if (!selected) return t('В новой задаче работник не выбран: укажите его или провайдера в форме.');
    if (!worker) return t('Работник не найден в списке. Выберите другого или оставьте поле пустым.');
    if (worker.archived) return t('{name} в архиве и не подставляется в новые задачи. Восстановите профиль или выберите другого.', { name: worker.name });
    return t('{name} подставляется в поле «Работник» у новых простых задач. Его можно изменить в форме задачи.', { name: worker.name });
  }
  function fallbackHint(provider: Provider, selected: string): string {
    const worker = workers.find(item => item.id === selected);
    if (!worker) return t('Запуск останется с ошибкой, пока лимиты {provider} не восстановятся.', { provider: providerName(provider) });
    if (worker.archived) return t('{name} в архиве: восстановите работника или выберите другого, иначе замена не сработает.', { name: worker.name });
    if (worker.provider === provider) return t('{name} тоже использует {provider}: лимиты аккаунта общие, выберите работника другого провайдера.', { name: worker.name, provider: providerName(provider) });
    return t('{name} ({workerProvider}) подхватит новую сессию вместо работника {provider}.', { name: worker.name, workerProvider: providerName(worker.provider), provider: providerName(provider) });
  }

  $effect(() => {
    const next = JSON.stringify(settings);
    if (next === applied) return;
    applied = next;
    if (!dirty) {
      value = settings?.defaultCwd ?? '';
      defaultSchedule = settings?.defaultSchedule ?? 'manual';
      webhookUrl = settings?.webhookUrl ?? '';
      webhookSecret = settings?.webhookSecret ?? '';
      agentTimeLimitMinutes = settings?.agentTimeLimitMinutes ?? undefined;
      integrationCheckTimeLimitMinutes = settings?.integrationCheckTimeLimitMinutes ?? undefined;
      defaultWorker = settings?.defaultWorkerId ?? '';
      fallback = { codex: settings?.fallbackWorkers?.codex ?? '', claude: settings?.fallbackWorkers?.claude ?? '' };
    }
  });

  function touched() { dirty = true; formError = ''; status = ''; }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading || !settings) return;
    formError = '';
    status = '';
    const defaultCwd = value.trim();
    if (!defaultCwd) { formError = t('Укажите рабочую папку по умолчанию.'); return; }
    const fallbackWorkers: FallbackWorkers = { codex: fallback.codex || null, claude: fallback.claude || null };
    busy = true;
    onmutation();
    try {
      const response = await fetch('/api/settings/general', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultCwd, defaultSchedule, webhookUrl: webhookUrl.trim(), webhookSecret, agentTimeLimitMinutes: agentTimeLimitMinutes ?? null, integrationCheckTimeLimitMinutes: integrationCheckTimeLimitMinutes ?? null, defaultWorkerId: defaultWorker || null, fallbackWorkers }),
      });
      let body;
      try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
      if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
      const saved = body as GeneralSettings;
      dirty = false;
      value = saved.defaultCwd;
      defaultSchedule = saved.defaultSchedule;
      webhookUrl = saved.webhookUrl ?? '';
      webhookSecret = saved.webhookSecret ?? '';
      agentTimeLimitMinutes = saved.agentTimeLimitMinutes ?? undefined;
      integrationCheckTimeLimitMinutes = saved.integrationCheckTimeLimitMinutes ?? undefined;
      defaultWorker = saved.defaultWorkerId ?? '';
      fallback = { codex: saved.fallbackWorkers?.codex ?? '', claude: saved.fallbackWorkers?.claude ?? '' };
      onchange(saved);
      status = t('Настройки сохранены');
    } catch (failure) {
      formError = failure instanceof TypeError ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
        : failure instanceof Error ? failure.message : t('Не удалось сохранить настройки. Попробуйте ещё раз.');
    } finally { busy = false; }
  }
</script>

<section class="general-settings model-settings" aria-labelledby="general-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="sliders" size={22} /><div><h3 id="general-settings-title">{t('Общие')}</h3><p>{t('Параметры для новых задач и замена работников при исчерпании лимитов.')}</p></div></div>
  {#if error}<div class="model-load-error" role="alert"><span>{error}</span><button type="button" class="button secondary" disabled={busy} onclick={retry}>{t('Повторить загрузку настроек')}</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />{t('Загружаем общие настройки…')}</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{t('Сохраняем настройки…')}</span></p>{/if}
  <form class="general-settings-form" aria-label={t('Общие настройки')} onsubmit={save}>
    {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
    <label class="form-field"><span>{t('Рабочая папка по умолчанию')}</span><div class="input-with-icon"><Icon name="folder" size={16} /><input name="defaultCwd" aria-label={t('Рабочая папка по умолчанию')} aria-describedby="default-cwd-description" bind:value oninput={touched} maxlength="4096" placeholder="/workspace/projects/my-project" required disabled={busy || loading || !settings} spellcheck="false" autocapitalize="off" /></div><small id="default-cwd-description">{t('Абсолютный путь к папке на компьютере, где запущен brigd. Подставляется при создании задачи; его можно изменить в форме.')}</small></label>
    <label class="form-field"><span>{t('Тип запуска по умолчанию')}</span><select name="defaultSchedule" aria-label={t('Тип запуска по умолчанию')} aria-describedby="default-schedule-description" bind:value={defaultSchedule} onchange={touched} disabled={busy || loading || !settings}><option value="auto">{t('Автопилот')}</option><option value="manual">{t('Вручную')}</option><option value="interval">{t('По расписанию')}</option></select><small id="default-schedule-description">{t('Выбирается в поле «Когда запускать» у новых задач. Его можно изменить в форме задачи.')}</small></label>
    <label class="form-field"><span>{t('Работник по умолчанию')}</span><select name="defaultWorkerId" aria-label={t('Работник по умолчанию')} aria-describedby="default-worker-description" bind:value={defaultWorker} onchange={touched} disabled={busy || loading || !settings}><option value="">{t('Не выбирать')}</option>{#each workerOptions(defaultWorker) as worker (worker.id)}<option value={worker.id}>{worker.name} · {providerName(worker.provider)}{worker.archived ? ` · ${t('в архиве')}` : ''}</option>{/each}</select><small id="default-worker-description">{defaultWorkerHint(defaultWorker)}</small></label>
    <label class="form-field"><span>{t('Максимальная длительность хода агента, мин')}</span><input type="number" name="agentTimeLimitMinutes" min="1" max="1440" step="1" bind:value={agentTimeLimitMinutes} oninput={touched} disabled={busy || loading || !settings} /><small>{t('Пусто — без лимита. Применяется к новым ходам, включая ответы, дополнительные запросы и Интегратора. В задаче можно задать свой лимит.')}</small></label>
    <label class="form-field"><span>{t('Максимальная длительность проверки слияния, мин')}</span><input type="number" name="integrationCheckTimeLimitMinutes" min="1" max="1440" step="1" bind:value={integrationCheckTimeLimitMinutes} oninput={touched} disabled={busy || loading || !settings} /><small>{t('Пусто — без лимита. Ограничивает каждую команду проверки и её повторы; изменение применяется к новым попыткам слияния.')}</small></label>
    <fieldset class="fallback-settings" aria-describedby="fallback-description">
      <legend>{t('Замена при исчерпании лимитов')}</legend>
      <p id="fallback-description" class="fallback-help">{t('Когда CLI сообщает, что лимиты использования закончились, новую сессию с тем же заданием начинает выбранный работник, обычно другого провайдера: например, Codex Sol 6.1 ↔ Claude Code Opus 5.5. Продолжения сохранённых сессий не передаются. В профиле работника можно задать свою замену вместо этой.')}</p>
      {#each fallbackProviders as item (item.provider)}
        <label class="form-field"><span>{t(item.label)}</span>
          <select name="fallback-{item.provider}" aria-label={t(item.label)} aria-describedby="fallback-{item.provider}-hint" bind:value={fallback[item.provider]} onchange={touched} disabled={busy || loading || !settings}><option value="">{t('Не заменять')}</option>{#each workerOptions(fallback[item.provider]) as worker (worker.id)}<option value={worker.id}>{worker.name} · {providerName(worker.provider)}{worker.archived ? ` · ${t('в архиве')}` : ''}</option>{/each}</select>
          <small id="fallback-{item.provider}-hint">{fallbackHint(item.provider, fallback[item.provider])}</small>
        </label>
      {/each}
      {#if !workers.some(worker => !worker.archived)}<p class="fallback-help">{t('Сначала создайте работников в разделе «Работники»: замена выбирается из их профилей.')}</p>{/if}
    </fieldset>
    <fieldset class="fallback-settings webhook-settings">
      <legend>{t('Webhook')}</legend>
      <p class="fallback-help">{t('Сервер отправляет события на этот адрес независимо от вкладок браузера. Пустой URL отключает отправку.')}</p>
      <label class="form-field"><span>{t('URL webhook')}</span><input name="webhookUrl" type="url" bind:value={webhookUrl} oninput={touched} maxlength="4096" placeholder="https://example.com/brigd" disabled={busy || loading || !settings} /></label>
      <label class="form-field"><span>{t('Секрет')}</span><input name="webhookSecret" type="password" aria-label={t('Секрет')} aria-describedby="webhook-secret-description" bind:value={webhookSecret} oninput={touched} maxlength="4096" autocomplete="new-password" disabled={busy || loading || !settings} /><small id="webhook-secret-description">{t('Необязателен. Подписывает тело запроса HMAC-SHA256 в заголовке X-Brigd-Signature.')}</small></label>
    </fieldset>
    <div class="model-catalog-actions"><button type="submit" class="button primary" disabled={busy || loading || !settings}><Icon name={busy ? 'refresh' : 'check'} class={busy ? 'spin' : ''} size={16} />{busy ? t('Сохраняем…') : t('Сохранить настройки')}</button></div>
  </form>
  <BrowserNotificationSettings />
</section>

<style>
  .fallback-settings { display: grid; gap: 14px; margin: 0; padding: 16px 17px 17px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--subtle); min-width: 0; }
  .fallback-settings legend { font-size: .92rem; font-weight: 500; color: var(--secondary); padding: 0 6px; }
  .fallback-help { font-size: .8rem; line-height: 1.7; color: var(--muted); margin: 0; overflow-wrap: anywhere; }
</style>
