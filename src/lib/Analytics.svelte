<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { ANALYTICS_GROUPS, buildTaskAnalytics, type AnalyticsGroup, type AnalyticsPeriod, type AnalyticsWorker } from './analytics';
  import { formatDate, formatNumber, t, tk } from './i18n';
  import { TASK_PRIORITY_LABELS } from './priority';
  import { localWorker } from './worker-label';
  import type { Provider, Task } from './types';

  let { tasks, loading, error, onreload }: { tasks: Task[]; loading: boolean; error: string; onreload: () => Promise<void> } = $props();
  let period = $state<AnalyticsPeriod>('all');
  let provider = $state<'all' | Provider>('all');
  let includeArchived = $state(true);
  let now = $state(Date.now());
  let refreshing = $state(false);
  const labels: Record<AnalyticsGroup, string> = {
    ready: tk('К запуску'), active: tk('В работе'), attention: tk('Требуют внимания'), completed: tk('Завершено'), cancelled: tk('Отменено'),
  };
  const colors: Record<AnalyticsGroup, string> = {
    ready: 'var(--muted)', active: 'var(--accent)', attention: 'var(--warning)', completed: 'var(--success)', cancelled: 'var(--error)',
  };
  // Read the current time on incoming task changes as well as on the idle timer.
  let data = $derived(buildTaskAnalytics(tasks, { period, provider, includeArchived }, Math.max(now, Date.now())));
  let chartMax = $derived(Math.max(4, Math.ceil(Math.max(0, ...data.timeline.map(point => point.count)) / 4) * 4));
  let points = $derived(data.timeline.map((point, index) => ({ ...point,
    x: data.timeline.length === 1 ? 372 : 40 + index / (data.timeline.length - 1) * 664,
    y: 190 - point.count / chartMax * 166,
  })));
  let line = $derived(points.map(point => `${point.x},${point.y}`).join(' '));
  let priorityMax = $derived(Math.max(1, ...data.priorities.map(item => item.count)));
  let workerMax = $derived(Math.max(1, ...data.workers.map(item => item.count)));
  let donut = $derived.by(() => {
    let offset = 0;
    return `conic-gradient(${ANALYTICS_GROUPS.map(group => {
      const start = offset;
      offset += data.total ? data.groups[group] / data.total * 100 : 0;
      return `${colors[group]} ${start}% ${offset}%`;
    }).join(', ')})`;
  });

  onMount(() => {
    const timer = setInterval(() => { now = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });

  async function reload() {
    refreshing = true;
    try { await onreload(); now = Date.now(); }
    finally { refreshing = false; }
  }

  function bucketLabel(date: number, full = false) {
    return formatDate(date, data.granularity === 'year' ? { year: 'numeric' }
      : data.granularity === 'month' ? { month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short', ...(full ? { year: 'numeric' } : {}) });
  }

  function workerName(worker: AnalyticsWorker) {
    return worker.kind === 'workflow' ? t('Последовательности') : worker.kind === 'unassigned' ? t('Без работника')
      : localWorker({ id: worker.id.slice('worker:'.length), name: worker.name }).name;
  }

  function groupDescription(groups: Record<AnalyticsGroup, number>) {
    return ANALYTICS_GROUPS.map(group => `${t(labels[group])}: ${formatNumber(groups[group])}`).join(' · ');
  }
</script>

<section class="page-heading">
  <div><h1>{t('Аналитика')}</h1><p>{t('Обзор задач, их состояния и распределения работы.')}</p></div>
  <button class="button secondary" onclick={reload} disabled={loading || refreshing}><Icon name="refresh" size={16} class={refreshing ? 'spin' : ''} />{t('Обновить')}</button>
</section>

<section class="analytics" aria-label={t('Аналитика задач')}>
  <div class="analytics-filters">
    <label><span>{t('Период создания задач')}</span><select bind:value={period}>
      <option value="all">{t('За всё время')}</option><option value="7">{t('Последние 7 дней')}</option>
      <option value="30">{t('Последние 30 дней')}</option><option value="90">{t('Последние 90 дней')}</option>
    </select></label>
    <label><span>{t('Провайдер задачи')}</span><select bind:value={provider}>
      <option value="all">{t('Все агенты')}</option><option value="codex">Codex</option><option value="claude">Claude Code</option>
    </select></label>
    <label class="archive-toggle"><input type="checkbox" bind:checked={includeArchived} /><span>{t('Учитывать архив')}</span></label>
  </div>
  <p class="analytics-note">{t('Период отбирает задачи по дате создания. Статусы и исполнители показаны на текущий момент.')}</p>

  {#if loading}
    <div class="list-empty" aria-busy="true"><Icon name="refresh" size={19} class="spin" /><span>{t('Загружаем аналитику…')}</span></div>
  {:else if error}
    <div class="analytics-error" role="alert"><Icon name="alert" size={18} /><span>{error}</span><button class="button secondary" onclick={reload} disabled={refreshing}>{t('Повторить')}</button></div>
  {:else}
    <dl class="analytics-metrics" aria-label={t('Сводка по задачам')}>
      <div><dt>{t('Всего задач')}</dt><dd>{formatNumber(data.total)}<small>{t('В архиве: {count}', { count: formatNumber(data.archived) })}</small></dd></div>
      <div><dt><span class="dot" style:background={colors.completed}></span>{t('Завершено')}</dt><dd>{formatNumber(data.groups.completed)}<small>{t('{percent} от выбранных задач', { percent: formatNumber(data.completionRate, { style: 'percent', maximumFractionDigits: 1 }) })}</small></dd></div>
      <div><dt><span class="dot" style:background={colors.active}></span>{t('В работе')}</dt><dd>{formatNumber(data.groups.active)}<small>{t('Включая очередь и слияние')}</small></dd></div>
      <div><dt><span class="dot" style:background={colors.attention}></span>{t('Требуют внимания')}</dt><dd>{formatNumber(data.groups.attention)}<small>{t('Ожидание ответа, ошибки и блокировки')}</small></dd></div>
    </dl>

    {#if data.total === 0}
      <div class="no-results"><span class="empty-icon"><Icon name="chart" size={28} /></span><h2>{t('Нет задач для анализа')}</h2><p>{t('Измените период или фильтры. Графики появятся, когда будут задачи.')}</p></div>
    {:else}
      <div class="analytics-charts">
        <figure class="chart-card timeline-card" aria-label={t('Динамика создания задач')}>
          <figcaption><h2>{t('Динамика создания задач')}</h2><p>{data.granularity === 'year' ? t('Количество новых задач по годам') : data.granularity === 'month' ? t('Количество новых задач по месяцам') : t('Количество новых задач по дням')}</p></figcaption>
          <div class="chart-scroll">
            <svg class="timeline" viewBox="0 0 728 222" role="img" aria-label={t('Линейный график создания задач')}>
              <title>{t('Динамика создания задач')}</title>
              {#each [0, 1, 2, 3, 4] as tick}
                <line x1="40" x2="704" y1={190 - tick * 41.5} y2={190 - tick * 41.5} class="grid-line" />
                <text x="30" y={194 - tick * 41.5} text-anchor="end">{formatNumber(chartMax * tick / 4)}</text>
              {/each}
              <polygon points={`${points[0].x},190 ${line} ${points[points.length - 1].x},190`} fill="var(--accent)" fill-opacity=".09" />
              <polyline points={line} fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" />
              {#each points as point, index (point.date)}
                <circle cx={point.x} cy={point.y} r="3.5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"><title>{bucketLabel(point.date, true)}: {formatNumber(point.count)}</title></circle>
                {#if index === 0 || index === points.length - 1 || (index % Math.ceil(points.length / 5) === 0 && index < points.length - Math.ceil(points.length / 10))}
                  <text x={point.x} y="216" text-anchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{bucketLabel(point.date)}</text>
                {/if}
              {/each}
            </svg>
          </div>
          <details class="timeline-data"><summary>{t('Данные графика')}</summary><div class="data-scroll"><table><caption class="sr-only">{t('Динамика создания задач')}</caption><thead><tr><th scope="col">{t('Дата')}</th><th scope="col">{t('Создано задач')}</th></tr></thead><tbody>{#each data.timeline as point (point.date)}<tr><th scope="row">{bucketLabel(point.date, true)}</th><td>{formatNumber(point.count)}</td></tr>{/each}</tbody></table></div></details>
        </figure>

        <figure class="chart-card" aria-label={t('Распределение по статусам')}>
          <figcaption><h2>{t('Распределение по статусам')}</h2><p>{t('Текущее состояние выбранных задач')}</p></figcaption>
          <div class="status-chart">
            <div class="donut" style:background={donut} role="img" aria-label={t('Кольцевая диаграмма: {statuses}', { statuses: groupDescription(data.groups) })}><div><strong>{formatNumber(data.total)}</strong><span>{t('Всего задач')}</span></div></div>
            <ul class="chart-legend">{#each ANALYTICS_GROUPS as group}<li><span class="dot" style:background={colors[group]}></span><span>{t(labels[group])}</span><strong>{formatNumber(data.groups[group])}</strong><small>{formatNumber(data.groups[group] / data.total, { style: 'percent', maximumFractionDigits: 1 })}</small></li>{/each}</ul>
          </div>
        </figure>

        <figure class="chart-card" aria-label={t('Задачи по приоритетам')}>
          <figcaption><h2>{t('Задачи по приоритетам')}</h2><p>{t('Количество задач каждого приоритета')}</p></figcaption>
          <ul class="priority-chart">{#each data.priorities as item (item.priority)}<li><strong>{formatNumber(item.count)}</strong><div class="column-track" aria-hidden="true"><div class="priority-column {item.priority}" style:height={`${item.count / priorityMax * 100}%`}></div></div><span>{t(TASK_PRIORITY_LABELS[item.priority])}</span></li>{/each}</ul>
        </figure>

        <figure class="chart-card" aria-label={t('Задачи по исполнителям')}>
          <figcaption><h2>{t('Задачи по исполнителям')}</h2><p>{t('Последовательности учитываются отдельно, по одной карточке.')}</p></figcaption>
          <ul class="worker-chart">{#each data.workers as worker (worker.id)}<li><div class="worker-caption"><span>{workerName(worker)}</span><strong>{formatNumber(worker.count)}</strong></div><div class="worker-track" title={groupDescription(worker.groups)} aria-hidden="true">{#each ANALYTICS_GROUPS as group}<span style:width={`${worker.groups[group] / workerMax * 100}%`} style:background={colors[group]}></span>{/each}</div><span class="sr-only">{groupDescription(worker.groups)}</span></li>{/each}</ul>
          <ul class="worker-legend">{#each ANALYTICS_GROUPS as group}<li><span class="dot" style:background={colors[group]}></span>{t(labels[group])}</li>{/each}</ul>
        </figure>
      </div>
    {/if}
  {/if}
</section>

<style>
  .analytics { min-width: 0; }
  .analytics-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); }
  .analytics-filters label { display: grid; gap: 7px; color: var(--secondary); font-size: .85rem; min-width: 0; }
  .analytics-filters select { min-height: 36px; width: 100%; padding: 7px 30px 7px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
  .analytics-filters .archive-toggle { display: flex; align-items: center; min-height: 36px; gap: 8px; margin-left: auto; cursor: pointer; }
  .archive-toggle input { accent-color: var(--accent); }
  .analytics-note { margin: 12px 0 22px; color: var(--muted); font-size: .85rem; line-height: 1.6; }
  .analytics-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 0 0 22px; }
  .analytics-metrics > div { padding: 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); }
  dt { display: flex; align-items: center; gap: 7px; color: var(--secondary); font-size: .88rem; }
  dd { margin: 15px 0 0; font-size: 2.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  dd small { display: block; color: var(--muted); font-size: .8rem; font-weight: 400; margin-top: 7px; line-height: 1.6; }
  .analytics-charts { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 20px; }
  .chart-card { margin: 0; min-width: 0; padding: 22px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); }
  figcaption h2 { margin: 0; font-size: 1.08rem; font-weight: 600; }
  figcaption p { margin: 8px 0 22px; color: var(--muted); font-size: .82rem; line-height: 1.6; }
  .chart-scroll { overflow-x: auto; }
  .timeline { display: block; width: 100%; min-width: 360px; }
  .timeline text { font-size: 11px; fill: var(--muted); }
  .grid-line { stroke: var(--line); stroke-dasharray: 3 4; }
  .timeline-data { margin-top: 15px; color: var(--secondary); font-size: .82rem; }
  summary { cursor: pointer; width: fit-content; }
  .data-scroll { max-height: 240px; overflow: auto; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
  tbody th { font-weight: 400; }
  .status-chart { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 24px; }
  .donut { display: grid; place-items: center; width: 170px; height: 170px; flex-shrink: 0; border-radius: 50%; }
  .donut > div { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; width: 126px; height: 126px; border-radius: 50%; background: var(--surface); }
  .donut strong { font-size: 2.2rem; font-weight: 650; }
  .donut span { color: var(--muted); font-size: .8rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  .chart-legend { display: grid; gap: 16px; flex: 1; min-width: min(100%, 180px); font-size: .83rem; }
  .chart-legend li { display: flex; align-items: center; gap: 8px; }
  .chart-legend li > span:nth-child(2) { flex: 1; }
  .chart-legend small { color: var(--muted); min-width: 40px; text-align: right; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  strong { font-variant-numeric: tabular-nums; }
  .priority-chart { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .priority-chart li { display: flex; flex-direction: column; align-items: center; gap: 10px; min-width: 0; font-size: .83rem; }
  .priority-chart li > span { color: var(--secondary); overflow-wrap: anywhere; text-align: center; }
  .column-track { display: flex; align-items: end; height: 160px; width: 100%; max-width: 70px; border-bottom: 1px solid var(--line); }
  .priority-column { width: 100%; background: var(--accent); border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
  .priority-column.critical { background: var(--error); }
  .priority-column.high { background: var(--warning); }
  .priority-column.low { background: var(--muted); }
  .worker-chart { display: grid; align-content: start; gap: 19px; max-height: 290px; overflow-y: auto; padding-right: 4px; }
  .worker-caption { display: flex; gap: 12px; justify-content: space-between; margin-bottom: 8px; font-size: .85rem; }
  .worker-caption > span { overflow-wrap: anywhere; min-width: 0; }
  .worker-track { display: flex; height: 13px; background: var(--subtle); overflow: hidden; border-radius: var(--radius-sm); }
  .worker-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; font-size: .77rem; color: var(--secondary); }
  .worker-legend li { display: flex; align-items: center; gap: 5px; }
  .analytics-error { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px; color: var(--error); background: var(--error-bg); border: 1px solid var(--error-line); }
  .analytics-error > span { flex: 1; overflow-wrap: anywhere; }
  @media (max-width: 1200px) { .analytics-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .analytics-charts { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 480px) { .analytics-filters > label { flex: 1 1 100%; } .analytics-filters .archive-toggle { margin-left: 0; } .analytics-metrics { gap: 10px; } .analytics-metrics > div { padding: 14px; } dd { font-size: 2rem; } .chart-card { padding: 16px; } .priority-chart { gap: 8px; } }
</style>
