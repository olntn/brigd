<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import CliGuide from './CliGuide.svelte';
  import type { CliConfigOverview, CliConfigReport, CliConfigStatus, Provider } from './types';

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
    ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
    : failure instanceof Error ? failure.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
    let result;
    try { result = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
    if (!response.ok) throw new Error(result.error || `Ошибка запроса (${response.status})`);
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
  onMount(() => { void load(); return () => { alive = false; }; });

  async function configure(provider: Provider) {
    if (pending) return;
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
    if (status.error) return 'Файл не прочитан';
    return status.ready ? 'Разрешения включены' : 'Разрешения не включены';
  }
  function resultLabel(report: CliConfigReport): string {
    if (!report.added.length) return 'Без изменений';
    return `Файл обновлён${report.backup ? `, прежняя версия: ${report.backup}` : ''}`;
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
    <div class="cli-setup-heading"><Icon name="lock" size={22} /><div><h3 id="permissions-title">Разрешения</h3><p>Доступ работников к файлам и командам без подтверждений.</p></div></div>
    <button type="button" class="button secondary" aria-haspopup="dialog" onclick={openGuide}><Icon name="list" size={15} />Инструкция</button>
  </div>
  {#if error}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onclick={() => { void load(); }}>Повторить</button></div>{/if}
  {#if loading && !overview}
    <div class="detail-loading" role="status"><Icon name="refresh" class="spin" />Проверяем файлы CLI…</div>
  {:else if overview}
    <div class="cli-setup-grid">
      {#each providers as provider (provider)}
        {@const status = overview[provider]}
        {@const report = reports[provider]}
        <article class="cli-setup-card" aria-label={'Настройка ' + name(provider)} aria-busy={pending === provider}>
          <h3>{name(provider)}</h3>
          <p class="cli-setup-path"><Icon name="folder" size={14} /><code>{status.path}</code></p>
          <p class="cli-setup-state" class:is-ready={status.ready && !status.error}><Icon name={status.error ? 'alert' : status.ready ? 'circlecheck' : 'clock'} size={15} /><span>{stateLabel(status)}</span></p>
          {#if status.error}<p class="cli-setup-error">{status.error}</p>{/if}
          {#if status.login === false}<p class="cli-setup-error">Нет входа в Codex: выполните <code>codex login</code> в терминале.</p>{/if}
          <button type="button" class="button primary" disabled={!!pending} onclick={() => configure(provider)}><Icon name={pending === provider ? 'refresh' : 'check'} size={15} class={pending === provider ? 'spin' : ''} />Настроить разрешения {name(provider)}</button>
          {#if report}<p class="cli-setup-result" role="status">{resultLabel(report)}</p>{/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<!-- Clicks are stopped here so the settings dialog behind never treats them as its own backdrop. -->
<dialog bind:this={guide} class="editor-dialog cli-guide-dialog" aria-labelledby="cli-guide-title" oncancel={(event) => { event.preventDefault(); closeGuide(); }} onclick={(event) => { event.stopPropagation(); if (event.target === guide) closeGuide(); }}>
  {#if guideOpen}
    <div class="editor-form">
      <header class="editor-header"><h2 id="cli-guide-title">Инструкция по разрешениям</h2><button type="button" class="icon-button" aria-label="Закрыть инструкцию" onclick={closeGuide}><Icon name="close" size={21} /></button></header>
      <div class="cli-guide-body help-article"><CliGuide /></div>
      <footer class="editor-footer"><button type="button" class="button secondary" onclick={closeGuide}>Закрыть</button></footer>
    </div>
  {/if}
</dialog>
