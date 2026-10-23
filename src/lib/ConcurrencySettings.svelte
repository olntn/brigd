<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { CONCURRENCY_LABELS, CONCURRENCY_LIMIT_MAX, isConcurrencyLimit } from './concurrency';
  import { serverText, t } from './i18n';
  import type { ConcurrencyLimits, ConcurrencySettings } from './types';

  let { active, busy = $bindable(false) }: { active: boolean; busy?: boolean } = $props();
  let settings = $state<ConcurrencySettings | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let formError = $state('');
  let status = $state('');
  let resetting = $state(false);
  // Number inputs bind null while empty.
  let perRepository = $state<number | null>(null);
  let parallel = $state<number | null>(null);
  let requested = false;
  const fields = ['maxPerRepository', 'maxParallel'] as const;

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
  async function request(options?: RequestInit): Promise<ConcurrencySettings> {
    const response = await fetch('/api/settings/concurrency', options);
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Попробуйте ещё раз.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
    return body as ConcurrencySettings;
  }
  function apply(value: ConcurrencySettings) {
    settings = value;
    perRepository = value.maxPerRepository;
    parallel = value.maxParallel;
  }
  async function load() {
    if (busy) return;
    loading = true;
    loadError = '';
    try { apply(await request()); }
    catch (error) { loadError = message(error, t('Не удалось загрузить лимиты. Попробуйте ещё раз.')); }
    finally { loading = false; }
  }
  async function update(patch: { [key in keyof ConcurrencyLimits]: number | null }) {
    if (busy) return;
    busy = true;
    resetting = patch.maxParallel === null && patch.maxPerRepository === null;
    formError = '';
    status = '';
    try {
      apply(await request({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
      status = resetting ? t('Лимиты сброшены к значениям запуска сервиса.') : t('Лимиты сохранены. Они применяются к следующим запускам без перезапуска сервиса.');
    } catch (error) { formError = message(error, t('Не удалось сохранить лимиты. Попробуйте ещё раз.')); }
    finally { busy = false; resetting = false; }
  }
  function touched() { formError = ''; status = ''; }
  function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading || !settings) return;
    const values = { maxPerRepository: perRepository, maxParallel: parallel };
    const invalid = fields.find(field => !isConcurrencyLimit(values[field]));
    if (invalid) { formError = t('{label}: целое число от 1 до {max}.', { label: t(CONCURRENCY_LABELS[invalid]), max: CONCURRENCY_LIMIT_MAX }); return; }
    void update(values);
  }
  const source = (field: keyof ConcurrencyLimits) => !settings ? ''
    : settings.saved[field] !== null ? t('Сохранено в настройках.') : t('Значение запуска сервиса: {value}.', { value: settings.defaults[field] });
  let capped = $derived(isConcurrencyLimit(perRepository) && isConcurrencyLimit(parallel) && perRepository > parallel);
</script>

<section class="concurrency-settings model-settings" aria-labelledby="concurrency-settings-title" aria-busy={busy || loading}>
  <div class="model-settings-heading"><Icon name="lanes" size={22} /><div><h3 id="concurrency-settings-title">{t('Параллельность')}</h3><p>{t('Сколько задач выполняется одновременно, в том числе в одном репозитории.')}</p></div></div>
  <p class="model-catalog-note">{t('Сохранённые значения имеют приоритет над переменными окружения BRIGD_MAX_PER_REPOSITORY и BRIGD_MAX_PARALLEL. Изменение действует со следующего запуска без перезапуска сервиса; работающие задачи не останавливаются, а при уменьшении лимита новые просто ждут свободного места.')}</p>
  {#if loadError}<div class="model-load-error" role="alert"><span>{loadError}</span><button type="button" class="button secondary" disabled={busy} onclick={() => { void load(); }}>{t('Повторить загрузку')}</button></div>{/if}
  {#if loading}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} />{t('Загружаем лимиты…')}</p>{/if}
  {#if status}<p class="model-catalog-status success" role="status"><Icon name="check" size={16} /><span>{status}</span></p>{/if}
  {#if busy}<p class="model-catalog-status" role="status"><Icon name="refresh" class="spin" size={16} /><span>{resetting ? t('Сбрасываем лимиты…') : t('Сохраняем лимиты…')}</span></p>{/if}
  <form class="concurrency-settings-form" aria-label={t('Лимиты параллельной работы')} novalidate onsubmit={save}>
    {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{formError}</span></div>{/if}
    <div class="concurrency-fields">
      <label class="form-field"><span>{t(CONCURRENCY_LABELS.maxPerRepository)}</span><input name="maxPerRepository" aria-label={t(CONCURRENCY_LABELS.maxPerRepository)} type="number" inputmode="numeric" min="1" max={CONCURRENCY_LIMIT_MAX} step="1" required aria-describedby="concurrency-repository-hint" bind:value={perRepository} oninput={touched} disabled={busy || loading || !settings} /><small id="concurrency-repository-hint">{t('Каждая задача работает в своём Git worktree. При 1 задачи одного репозитория идут по очереди.')} {source('maxPerRepository')}</small></label>
      <label class="form-field"><span>{t(CONCURRENCY_LABELS.maxParallel)}</span><input name="maxParallel" aria-label={t(CONCURRENCY_LABELS.maxParallel)} type="number" inputmode="numeric" min="1" max={CONCURRENCY_LIMIT_MAX} step="1" required aria-describedby="concurrency-parallel-hint" bind:value={parallel} oninput={touched} disabled={busy || loading || !settings} /><small id="concurrency-parallel-hint">{t('Агенты всех репозиториев вместе с проверками слияния: проверка занимает такое же место, как агент.')} {source('maxParallel')}</small></label>
    </div>
    {#if capped}<p class="field-warning" role="status"><Icon name="alert" size={15} /><span>{t('Общий лимит меньше: в одном репозитории одновременно будет работать не больше {count}.', { count: parallel ?? '' })}</span></p>{/if}
    <div class="concurrency-rules">
      <strong>{t('Как параллельные задачи попадают в целевую ветку')}</strong>
      <ul>
        <li>{t('Проверка и слияние результатов одного репозитория идут строго по одному. Следующий результат проверяется вместе с уже перенесённым, поэтому изменения разных задач не перезаписывают друг друга.')}</li>
        <li>{t('После постановки результата в очередь он проверяется, не дожидаясь остальных агентов: они продолжают работу в своих worktree. Новые задачи репозитория ждут окончания проверки. Ручное ожидание настраивается в разделе «Автопилот».')}</li>
        <li>{t('Конфликт разрешает Интегратор. Он получает первое свободное место, а пока он работает, слияния этого репозитория ждут: целевая ветка не меняется под ним. Его результат проверяется первым.')}</li>
      </ul>
    </div>
    <div class="model-catalog-actions"><button type="button" class="button secondary" disabled={busy || loading || !settings || (settings.saved.maxParallel === null && settings.saved.maxPerRepository === null)} onclick={() => { void update({ maxParallel: null, maxPerRepository: null }); }}>{t('Сбросить')}</button><button type="submit" class="button primary" disabled={busy || loading || !settings}><Icon name={busy && !resetting ? 'refresh' : 'check'} class={busy && !resetting ? 'spin' : ''} size={16} />{busy && !resetting ? t('Сохраняем…') : t('Сохранить лимиты')}</button></div>
  </form>
</section>

<style>
  .concurrency-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .concurrency-fields input { max-width: 120px; }
  .concurrency-rules { display: grid; gap: 8px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--subtle); font-size: .8rem; line-height: 1.7; color: var(--muted); }
  .concurrency-rules strong { font-size: .86rem; font-weight: 500; color: var(--secondary); }
  .concurrency-rules ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
</style>
