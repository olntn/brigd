<script lang="ts">
  import { untrack } from 'svelte';
  import { serverText, t } from './i18n';
  import type { ResultTransferSettings } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  let settings = $state<ResultTransferSettings | null>(null);
  let mode = $state<ResultTransferSettings['mode']>('automatic');
  let manualWait = $state<ResultTransferSettings['manualWait']>('continue');
  let error = $state('');
  let status = $state('');
  let loading = $state(false);
  let requested = false;
  $effect(() => {
    if (active && !requested) { requested = true; untrack(() => { void load(); }); }
  });
  async function request(patch?: ResultTransferSettings): Promise<ResultTransferSettings> {
    const response = await fetch('/api/settings/result-transfer', patch ? {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    } : undefined);
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
    return body;
  }
  function apply(value: ResultTransferSettings) { settings = value; mode = value.mode; manualWait = value.manualWait; }
  function failure(value: unknown) {
    return value instanceof TypeError ? t('Нет связи с сервером. Проверьте подключение и повторите попытку.')
      : value instanceof Error ? value.message : t('Не удалось сохранить настройки. Попробуйте ещё раз.');
  }
  async function load() {
    loading = true; error = '';
    try { apply(await request()); } catch (value) { error = failure(value); } finally { loading = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading || !settings) return;
    busy = true; error = ''; status = '';
    try { apply(await request({ mode, manualWait })); status = t('Настройки переноса сохранены.'); }
    catch (value) { error = failure(value); }
    finally { busy = false; }
  }
</script>

<section class="model-settings" aria-labelledby="result-transfer-title" aria-busy={loading || busy}>
  <div class="model-settings-heading"><div><h3 id="result-transfer-title">{t('Перенос результата')}</h3><p>{t('Режим применяется, когда результат готов. Уже начатый перенос продолжается автоматически; ожидающие результаты переносятся только по кнопке.')}</p></div></div>
  {#if error}<div class="form-error" role="alert">{error}{#if !settings}<button class="button secondary" type="button" disabled={loading} onclick={load}>{t('Повторить загрузку настроек')}</button>{/if}</div>{/if}
  {#if status}<p class="model-catalog-status success" role="status">{status}</p>{/if}
  <form onsubmit={save}>
    <label class="form-field"><span>{t('Перенос результата')}</span><select bind:value={mode} onchange={() => { error = ''; status = ''; }} disabled={busy || loading || !settings}><option value="automatic">{t('Автоматически')}</option><option value="manual">{t('Вручную')}</option></select></label>
    <label class="form-field"><span>{t('Пока результат ждёт ручного переноса')}</span><select aria-label={t('Пока результат ждёт ручного переноса')} aria-describedby="result-transfer-wait-hint" bind:value={manualWait} onchange={() => { error = ''; status = ''; }} disabled={mode !== 'manual' || busy || loading || !settings}><option value="continue">{t('Не задерживать новые запуски')}</option><option value="wait">{t('Ждать переноса')}</option></select><small id="result-transfer-wait-hint">{t('Без ожидания новые агенты стартуют от текущей целевой ветки без неперенесённых результатов. Во время проверки и слияния новые запуски репозитория всегда ждут.')}</small></label>
    <div class="model-catalog-actions"><button class="button primary" disabled={busy || loading || !settings}>{busy ? t('Сохраняем…') : t('Сохранить настройки')}</button></div>
  </form>
</section>
