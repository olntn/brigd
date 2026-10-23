<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { serverText, t } from './i18n';
  import type { CheckTriageSettings } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  let settings = $state<CheckTriageSettings | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let formError = $state('');
  let status = $state('');
  let requested = false;

  $effect(() => {
    if (active && !requested) {
      requested = true;
      untrack(() => { void load(); });
    }
  });

  function message(error: unknown, fallback: string) {
    return error instanceof TypeError ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
      : error instanceof Error ? error.message : fallback;
  }
  async function request(options?: RequestInit): Promise<CheckTriageSettings> {
    const response = await fetch('/api/settings/check-triage', options);
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
    return body as CheckTriageSettings;
  }
  async function load() {
    if (busy) return;
    loading = true;
    loadError = '';
    try { settings = await request(); }
    catch (error) { loadError = message(error, t('Не удалось загрузить настройку разбора. Попробуйте ещё раз.')); }
    finally { loading = false; }
  }
  async function update(enabled: boolean | null) {
    if (busy) return;
    busy = true;
    formError = '';
    status = '';
    try {
      settings = await request({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      status = enabled === null ? t('Восстановлено значение по умолчанию.') : settings.enabled ? t('Разбор включён. Он применяется к следующей упавшей проверке.') : t('Разбор выключен. Упавшая проверка остаётся в карточке до решения человека.');
    } catch (error) { formError = message(error, t('Не удалось сохранить настройку. Попробуйте ещё раз.')); }
    finally { busy = false; }
  }
</script>

<section class="check-triage-settings model-settings" aria-labelledby="check-triage-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="refresh" size={22} /><div><h3 id="check-triage-settings-title">{t('Разбор упавших проверок')}</h3><p>{t('Что brigd делает сам, когда команда проверки слияния завершилась с ненулевым кодом.')}</p></div></div>
  {#if loadError}<div class="model-load-error" role="alert"><span>{loadError}</span><button type="button" class="button secondary" disabled={busy} onclick={() => { void load(); }}>{t('Повторить загрузку настройки')}</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />{t('Загружаем настройку разбора…')}</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
  {#if settings}
    <label class="check-triage-toggle"><input type="checkbox" checked={settings.enabled} disabled={busy || loading} onchange={event => { void update(event.currentTarget.checked); }} /><span>{t('Разбирать упавшие проверки автоматически')}</span></label>
    <ol class="check-triage-steps">
      <li>{t('Повтор: упавшая команда один раз запускается заново целиком в том же объединённом коде. Если она прошла, слияние продолжается, а карточка получает заметную пометку «Проверка прошла со второй попытки».')}</li>
      <li>{t('Проверка целевой ветки: если повтор тоже упал, те же команды выполняются на текущей вершине целевой ветки в отдельной чистой папке. Если упало и там, задача не возвращается: сломана целевая ветка.')}</li>
      <li>{t('Возврат работнику: иначе brigd отправляет дополнительный запрос в сохранённую сессию работника с концом вывода проверки — не больше {limit} раз на один результат, затем решает человек.', { limit: settings.handbackLimit })}</li>
    </ol>
    <p class="model-catalog-note">{t('Решения принимаются по кодам возврата, без модели. Разбор идёт в очереди слияния: пока он длится, новые агенты этого репозитория ждут. Повторы и проверка целевой ветки одной попытки вместе длятся не дольше {minutes} мин. Задачи с этапами автоматически не возвращаются.', { minutes: settings.timeLimitMinutes })}</p>
    <p class="model-catalog-note">{settings.saved === null ? t('Используется значение по умолчанию: {value}.', { value: settings.defaultEnabled ? t('включено') : t('выключено') }) : t('Сохранено в настройках.')} {t('Всего: прошли со второй попытки — {flaky} · целевая ветка не проходит — {targetFailed} · возвращено работникам — {returned} · исчерпан лимит возвратов — {exhausted} · без возврата — {notReturned} · остановлено — {stopped}.', { ...settings.counts })}</p>
    <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy || loading || settings.saved === null} onclick={() => { void update(null); }}>{t('Вернуть значение по умолчанию')}</button></div>
  {/if}
</section>
