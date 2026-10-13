<script lang="ts">
  import Icon from './Icon.svelte';
  import { parseIntegrationChecks } from './integration-checks';
  import type { AutopilotSettings } from './types';

  let { settings, loading, error, retry, onchange, onmutation, busy = $bindable(false) }: {
    settings: AutopilotSettings | null;
    loading: boolean;
    error: string;
    retry: () => void;
    onchange: (value: AutopilotSettings) => void;
    onmutation: () => void;
    busy?: boolean;
  } = $props();
  const example = '[\n  ["bun", "install", "--frozen-lockfile"],\n  ["bun", "run", "verify"]\n]';
  let value = $state('');
  let dirty = $state(false);
  let formError = $state('');
  let status = $state('');
  let resetting = $state(false);
  let applied = '';

  $effect(() => {
    const next = JSON.stringify(settings);
    if (next === applied) return;
    applied = next;
    if (!dirty) value = settings?.integrationChecks ? JSON.stringify(settings.integrationChecks, null, 2) : '';
  });

  async function update(integrationChecks: string[][] | null) {
    if (busy) return;
    busy = true;
    onmutation();
    resetting = integrationChecks === null;
    formError = '';
    status = '';
    try {
      const response = await fetch('/api/settings/autopilot', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ integrationChecks }),
      });
      let body;
      try { body = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.'); }
      if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
      const saved = body as AutopilotSettings;
      dirty = false;
      value = saved.integrationChecks ? JSON.stringify(saved.integrationChecks, null, 2) : '';
      onchange(saved);
      status = integrationChecks === null ? 'Настройка сброшена. Используется значение окружения, если оно задано.' : 'Проверки сохранены. Настройка применяется без перезапуска сервера.';
    } catch (failure) {
      formError = failure instanceof TypeError ? 'Нет связи с сервером. Проверьте подключение и повторите попытку.'
        : failure instanceof Error ? failure.message : 'Не удалось сохранить настройки. Попробуйте ещё раз.';
    } finally { busy = false; resetting = false; }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading) return;
    formError = '';
    status = '';
    let checks: string[][];
    try { checks = parseIntegrationChecks(value); }
    catch (failure) { formError = failure instanceof Error ? failure.message : 'Проверьте формат команд.'; return; }
    void update(checks);
  }
</script>

<section class="autopilot-settings model-settings" aria-labelledby="autopilot-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="moon" size={22} /><div><h3 id="autopilot-settings-title">Автопилот</h3><p>Задайте команды, которые проверяют результат перед слиянием с целевой веткой.</p></div></div>
  <p class="model-catalog-note">В рабочем режиме без BRIGD_INTEGRATION_CHECKS нельзя включить автопилот и запускать процессы, которым нужны эти проверки. Сохранённое здесь значение имеет приоритет над переменной окружения.</p>
  {#if error}<div class="model-load-error" role="alert"><span>{error}</span><button type="button" class="button secondary" disabled={busy} onclick={retry}>Повторить загрузку настроек</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />Загружаем настройки автопилота…</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{resetting ? 'Сбрасываем настройку…' : 'Сохраняем проверки…'} Дождитесь ответа сервера, прежде чем закрывать настройки.</span></p>{/if}
  <form class="autopilot-settings-form" onsubmit={save}>
    {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
    <label class="form-field"><span>BRIGD_INTEGRATION_CHECKS</span><textarea name="integrationChecks" aria-label="BRIGD_INTEGRATION_CHECKS" rows="7" bind:value oninput={() => { dirty = true; formError = ''; status = ''; }} placeholder={example} disabled={busy || loading} spellcheck="false" autocapitalize="off" aria-describedby="integration-checks-format integration-checks-source"></textarea><small id="integration-checks-format">JSON-массив команд: каждая команда — массив программы и её аргументов. Команды выполняются по очереди в рабочей папке проекта. Перед проверками добавьте установку зависимостей: в отдельной папке слияния их ещё нет.</small></label>
    <div class="autopilot-checks-example"><span>Пример</span><pre>{example}</pre></div>
    <p id="integration-checks-source" class="model-catalog-note">{settings?.source === 'settings' ? 'Используется значение из настроек.' : settings?.source === 'environment' ? 'Используется переменная окружения BRIGD_INTEGRATION_CHECKS.' : 'Проверки не настроены. В рабочем режиме зависимые процессы недоступны до сохранения команд.'} Сброс удаляет сохранённое значение и возвращает значение окружения, если оно задано.</p>
    <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy || loading || settings?.source !== 'settings'} onclick={() => { void update(null); }}>Сбросить настройку</button><button type="submit" class="button primary" disabled={busy || loading}><Icon name={busy && !resetting ? 'refresh' : 'check'} class={busy && !resetting ? 'spin' : ''} size={16} />{busy && !resetting ? 'Сохраняем…' : 'Сохранить проверки'}</button></div>
  </form>
</section>
