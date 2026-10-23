<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import CliGuide from './CliGuide.svelte';
  import { serverText, t, tc } from './i18n';
  import type { CliAccessSettings, CliConfigOverview, CliConfigReport, CliConfigStatus, Provider } from './types';

  let access = $state<CliAccessSettings | null>(null);
  let accessLoading = $state(true);
  let accessSaving = $state(false);
  let accessError = $state('');
  let overview = $state<CliConfigOverview | null>(null);
  let loading = $state(true);
  let error = $state('');
  let pending = $state<Provider | null>(null);
  let reports = $state<Partial<Record<Provider, CliConfigReport>>>({});
  let guide: HTMLDialogElement;
  let guideOpen = $state(false);
  let alive = true;
  const providers: Provider[] = ['codex', 'claude'];
  const name = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
  const message = (failure: unknown) => failure instanceof TypeError
    ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
    : failure instanceof Error ? failure.message : t('Не удалось выполнить действие. Попробуйте ещё раз.');

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
    let result;
    try { result = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(result.error ? serverText(result.error) : t('Ошибка запроса ({status})', { status: response.status }));
    return result as T;
  }

  async function load() {
    try {
      const result = await request<CliConfigOverview>('/api/cli-config');
      if (!alive) return;
      overview = result;
      error = '';
    } catch (failure) { if (alive) error = message(failure); }
    finally { if (alive) loading = false; }
  }
  async function loadAccess() {
    accessLoading = true;
    try {
      const result = await request<CliAccessSettings>('/api/settings/permissions');
      if (!alive) return;
      access = result;
      accessError = '';
    } catch (failure) { if (alive) accessError = message(failure); }
    finally { if (alive) accessLoading = false; }
  }
  onMount(() => { void loadAccess(); void load(); return () => { alive = false; }; });

  async function toggleAccess() {
    if (!access || accessSaving || pending) return;
    const previous = access;
    access = { mode: previous.mode === 'full' ? 'standard' : 'full' };
    accessSaving = true;
    accessError = '';
    try {
      const result = await request<CliAccessSettings>('/api/settings/permissions', { method: 'PATCH', body: JSON.stringify(access) });
      if (alive) access = result;
    } catch (failure) {
      if (alive) { access = previous; accessError = message(failure); }
    } finally { if (alive) accessSaving = false; }
  }

  async function configure(provider: Provider) {
    if (pending || accessSaving) return;
    pending = provider;
    error = '';
    try {
      const report = await request<CliConfigReport>(`/api/cli-config/${provider}`, { method: 'POST', body: '{}' });
      if (!alive) return;
      reports = { ...reports, [provider]: report };
      await load();
    } catch (failure) { if (alive) error = message(failure); }
    finally { if (alive) pending = null; }
  }
  // One wording for both CLIs: the status reflects the file, the result reflects the press.
  function stateLabel(status: CliConfigStatus): string {
    if (status.error) return t('Файл не прочитан');
    return status.ready ? t('Разрешения включены') : t('Разрешения не включены');
  }
  function resultLabel(report: CliConfigReport): string {
    if (!report.added.length) return t('Без изменений');
    return report.backup ? t('Файл обновлён, прежняя версия: {backup}', { backup: report.backup }) : t('Файл обновлён');
  }
  async function openGuide() {
    guideOpen = true;
    await tick();
    if (alive) guide.showModal();
  }
  function closeGuide() {
    guide.close();
    guideOpen = false;
  }
</script>

<section class="cli-setup" aria-labelledby="permissions-title">
  <div class="cli-setup-top">
    <div class="cli-setup-heading"><Icon name="lock" size={22} /><div><h3 id="permissions-title">{t('Разрешения')}</h3><p>{t('Общий режим доступа для обоих CLI.')}</p></div></div>
    <button type="button" class="button secondary" aria-haspopup="dialog" onclick={openGuide}><Icon name="list" size={15} />{tc('guide', 'Инструкция')}</button>
  </div>
  {#if accessError}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{accessError}</span><button disabled={accessSaving || accessLoading} onclick={() => { void loadAccess(); }}>{t('Повторить')}</button></div>{/if}
  {#if accessLoading && !access}
    <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Загружаем режим доступа…')}</div>
  {:else if access}
    <div class="cli-access-card" aria-busy={accessSaving}>
      <button type="button" role="switch" aria-checked={access.mode === 'full'} aria-describedby="cli-access-description cli-access-timing" class="instruction-switch cli-access-switch" disabled={accessSaving || accessLoading || !!pending} onclick={toggleAccess}><span class="switch-track" aria-hidden="true"><span></span></span><span>{t('Полный доступ Codex и Claude Code')}</span></button>
      <p id="cli-access-description">{access.mode === 'full' ? t('Команды и запись файлов без подтверждений и песочниц CLI, с правами пользователя сервиса.') : t('Codex работает в песочнице рабочей папки. Claude Code использует правила разрешений; действия с запросом подтверждения блокируются.')} {t('Права ОС, границы контейнера, вход в аккаунты, лимиты и политики провайдеров сохраняются.')}</p>
      <p id="cli-access-timing" class="cli-access-timing" role="status">{accessSaving ? t('Сохраняем режим…') : t('Применяется к новым запускам и продолжениям сессий. Уже запущенные процессы сохраняют прежний режим.')}</p>
    </div>
  {/if}
  {#if access?.mode === 'standard'}
    <h4 class="cli-standard-title">{t('Настройки ограниченного режима')}</h4>
    <p class="cli-standard-description">{t('Эти кнопки дополняют пользовательские файлы CLI. Для полного доступа они не нужны.')}</p>
    {#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(); }}>{t('Повторить')}</button></div>{/if}
    {#if loading && !overview}
      <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />{t('Проверяем файлы CLI…')}</div>
    {:else if overview}
    <div class="cli-setup-grid">
      {#each providers as provider (provider)}
        {@const status = overview[provider]}
        {@const report = reports[provider]}
        <article class="cli-setup-card" aria-label={t('Настройка {provider}', { provider: name(provider) })} aria-busy={pending === provider}>
          <h3>{name(provider)}</h3>
          <p class="cli-setup-path"><Icon name="folder" size={14} /><code>{status.path}</code></p>
          <p class="cli-setup-state" class:is-ready={status.ready && !status.error}><Icon name={status.error ? 'alert' : status.ready ? 'circlecheck' : 'clock'} size={15} /><span>{stateLabel(status)}</span></p>
          {#if status.error}<p class="cli-setup-error">{serverText(status.error)}</p>{/if}
          {#if status.login === false}<p class="cli-setup-error">{t('Нет входа в Codex: выполните')} <code>codex login</code> {t('в терминале.')}</p>{/if}
          <button type="button" class="button primary" disabled={!!pending || accessSaving} onclick={() => configure(provider)}><Icon name={pending === provider ? 'refresh' : 'check'} size={15} class={pending === provider ? 'spin' : ''} />{t('Настроить разрешения {provider}', { provider: name(provider) })}</button>
          {#if report}<p class="cli-setup-result" role="status">{resultLabel(report)}</p>{/if}
        </article>
      {/each}
    </div>
    {/if}
  {/if}
</section>

<!-- Clicks are stopped here so the settings dialog behind never treats them as its own backdrop. -->
<dialog bind:this={guide} class="editor-dialog cli-guide-dialog" aria-labelledby="cli-guide-title" oncancel={(event) => { event.preventDefault(); closeGuide(); }} onclick={(event) => { event.stopPropagation(); if (event.target === guide) closeGuide(); }}>
  {#if guideOpen}
    <div class="editor-form">
      <header class="editor-header"><h2 id="cli-guide-title">{t('Инструкция по разрешениям')}</h2><button type="button" class="icon-button" aria-label={tc('guide', 'Закрыть инструкцию')} onclick={closeGuide}><Icon name="close" size={21} /></button></header>
      <div class="cli-guide-body help-article"><CliGuide /></div>
      <footer class="editor-footer"><button type="button" class="button secondary" onclick={closeGuide}>{t('Закрыть')}</button></footer>
    </div>
  {/if}
</dialog>
