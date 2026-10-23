<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './lib/Icon.svelte';
  import Workers from './lib/Workers.svelte';
  import ModelSettings from './lib/ModelSettings.svelte';
  import GeneralSettings from './lib/GeneralSettings.svelte';
  import AutopilotSettings from './lib/AutopilotSettings.svelte';
  import ConcurrencySettings from './lib/ConcurrencySettings.svelte';
  import Backups from './lib/Backups.svelte';
  import StorageSettings from './lib/StorageSettings.svelte';
  import Instructions from './lib/Instructions.svelte';
  import Docs from './lib/Docs.svelte';
  import Autopilot from './lib/Autopilot.svelte';
  import CliSetup from './lib/CliSetup.svelte';
  import { TASK_STATUS_LABELS } from './lib/status';
  import Tags from './lib/Tags.svelte';
  import TagPicker from './lib/TagPicker.svelte';
  import AttachmentComposer from './lib/AttachmentComposer.svelte';
  import AttachmentList from './lib/AttachmentList.svelte';
  import BrigLogo from './lib/BrigLogo.svelte';
  import WorkerAvatar from './lib/WorkerAvatar.svelte';
  import WorkflowEditor from './lib/WorkflowEditor.svelte';
  import WorkflowChecklist from './lib/WorkflowChecklist.svelte';
  import IntegrationPanel from './lib/IntegrationPanel.svelte';
  import TaskLogs from './lib/TaskLogs.svelte';
  import CodeDiff from './lib/CodeDiff.svelte';
  import CommentBody from './lib/CommentBody.svelte';
  import { taskActivity } from './lib/activity';
  import { WORKFLOW_MIN_STEPS, WORKFLOW_MAX_STEPS, WORKFLOW_TEXT_LIMIT, WORKFLOW_BYTES_LIMIT } from './lib/workflows';
  import { effortLabel, modelLabel, runUltracode } from './lib/workers';
  import { tagColorStyle } from './lib/tags';
  import { followupTargets, followupFingerprint, followupStage, runWorkflowSteps, taskHasCompletedRun, resolveFollowupTarget, followupSessionKey, type FollowupTarget } from './lib/followups';
  import { applyTheme, readTheme, saveTheme, themes, themeStorageKey, type Theme } from './lib/theme';
  import { plural } from './lib/format';
  import type { AppInfo, Attachment, AutopilotSettings as AutopilotSettingsValue, Comment, FollowupInput, GeneralSettings as GeneralSettingsValue, ModelCatalogEntry, Provider, Run, Tag, Task, TaskDetail, TaskInput, TaskStatus, Worker, WorkerSnapshot } from './lib/types';

  type Scope = 'all' | 'scheduled' | 'autopilot' | 'attention' | 'completed';
  type View = 'board' | 'list';
  let info = $state<AppInfo | null>(null);
  let tasks = $state<Task[]>([]);
  let page = $state<'tasks' | 'autopilot' | 'workers' | 'instructions' | 'docs' | 'tags' | 'archive'>(location.hash.startsWith('#/docs') ? 'docs' : 'tasks');
  let tags = $state<Tag[]>([]);
  let tagsLoading = $state(true);
  let tagsError = $state('');
  let tagSequence = 0;
  let tagReadSequence: number | null = null;
  let tagMutationPending = $state(false);
  let tagFilter = $state('all');
  let archiveTagFilter = $state('all');
  let editingTags = $state(false);
  let taskTagIds = $state<string[]>([]);
  let tagsSaving = $state(false);
  let taskTagsError = $state('');
  let workers = $state<Worker[]>([]);
  let workersLoading = $state(true);
  let workersError = $state('');
  let workerSequence = 0;
  let models = $state<ModelCatalogEntry[]>([]);
  let modelsLoading = $state(true);
  let modelsError = $state('');
  let modelSequence = 0;
  let modelReadSequence: number | null = null;
  let modelMutationPending = $state(false);
  let generalSettings = $state<GeneralSettingsValue | null>(null);
  let generalSettingsLoading = $state(true);
  let generalSettingsError = $state('');
  let generalSettingsSequence = 0;
  let generalSettingsReadSequence: number | null = null;
  let generalSettingsRequest: Promise<void> | null = null;
  let generalSettingsMutationPending = $state(false);
  let autopilotSettings = $state<AutopilotSettingsValue | null>(null);
  let autopilotSettingsLoading = $state(true);
  let autopilotSettingsError = $state('');
  let autopilotSettingsSequence = 0;
  let autopilotSettingsReadSequence: number | null = null;
  let autopilotSettingsMutationPending = $state(false);
  let backupsMutationPending = $state(false);
  let storageMutationPending = $state(false);
  let concurrencyMutationPending = $state(false);
  let settingsMutationPending = $derived(modelMutationPending || generalSettingsMutationPending || autopilotSettingsMutationPending || concurrencyMutationPending || backupsMutationPending || storageMutationPending);
  let integrationChecksMissing = $derived(info?.mode === 'cli' && !autopilotSettings?.integrationChecks?.length);
  const integrationChecksRequired = 'Сначала задайте BRIGD_INTEGRATION_CHECKS в Настройки → Автопилот.';
  let loading = $state(true);
  let connectionError = $state('');
  let search = $state('');
  let provider = $state<'all' | Provider>('all');
  let scope = $state<Scope>('all');
  let view = $state<View>('board');
  let showProblems = $state(true);
  let archiveSearch = $state('');
  let selectedId = $state<string | null>(null);
  let detail = $state<TaskDetail | null>(null);
  let detailError = $state('');
  let detailTab = $state<'conversation' | 'logs' | 'changes' | 'history'>('conversation');
  let activity = $derived(taskActivity(detail));
  let comment = $state('');
  let followupTargetKey = $state('');
  let followupRecipientSession = $state('');
  let followupRecipientOpen = $state(false);
  let followupSending = $state(false);
  let followupError = $state('');
  let followupAttempt = $state<{ taskId: string; signature: string; payload: FollowupInput; target: FollowupTarget } | null>(null);
  let commentAttachmentIds = $state<string[]>([]);
  let answer = $state('');
  let acknowledgeInterruption = $state(false);
  let pending = $state<string[]>([]);
  let toast = $state<{ text: string; type: 'success' | 'error' } | null>(null);
  let drawer: HTMLDialogElement;
  let editor: HTMLDialogElement;
  let deleteDialog: HTMLDialogElement;
  /** One card, or every card that was in the archive when the confirmation opened. */
  let deleting = $state<{ kind: 'task'; task: Task } | { kind: 'archive'; count: number; archivedBefore: number } | null>(null);
  let deleteError = $state('');
  let removing = $state(false);
  let settings: HTMLDialogElement;
  let settingsOpen = $state(false);
  const settingsSections = [
    { id: 'general', label: 'Общие', icon: 'sliders' },
    { id: 'appearance', label: 'Внешний вид', icon: 'palette' },
    { id: 'models', label: 'Модели', icon: 'spark' },
    { id: 'permissions', label: 'Разрешения', icon: 'lock' },
    { id: 'autopilot', label: 'Автопилот', icon: 'moon' },
    { id: 'concurrency', label: 'Параллельность', icon: 'lanes' },
    { id: 'storage', label: 'Хранилище', icon: 'folder' },
    { id: 'backups', label: 'Бэкапы', icon: 'archive' },
  ] as const;
  let settingsSection = $state<(typeof settingsSections)[number]['id']>('general');
  const themeGroups = [{ scheme: 'light', label: 'Светлые' }, { scheme: 'dark', label: 'Тёмные' }] as const;
  let theme = $state<Theme>(readTheme());
  let themeSaveError = $state(false);
  let editorOpen = $state(false);
  let editingId = $state<string | null>(null);
  let formTitle = $state('');
  let formTagIds = $state<string[]>([]);
  let formInstruction = $state('');
  let formProvider = $state<Provider>('codex');
  let formWorkerId = $state('');
  let formComplex = $state(false);
  let formSteps = $state<{ key: string; workerId: string; title: string; instruction: string }[]>([]);
  let formOriginalStepWorkers = $state<string[]>([]);
  /** null follows the assigned worker profiles; a boolean is this task's own choice. */
  let formUltracode = $state<boolean | null>(null);
  let drawerContext = $state(0);
  let editorContext = $state(0);
  let formAttachments = $state<Attachment[]>([]);
  let formAttachmentCount = $state(0);
  let formUploading = $state(false);
  let formAttachmentInvalid = $state(false);
  let commentAttachmentCount = $state(0);
  let commentUploading = $state(false);
  let commentAttachmentInvalid = $state(false);
  let answerAttachmentCount = $state(0);
  let answerUploading = $state(false);
  let answerAttachmentInvalid = $state(false);
  let formComposer = $state<AttachmentComposer>();
  let commentComposer = $state<AttachmentComposer>();
  let answerComposer = $state<AttachmentComposer>();
  let formOriginalWorker = $state<Worker | null>(null);
  let formCwd = $state('');
  let formSchedule = $state<'manual' | 'interval' | 'auto'>('manual');
  let formInterval = $state(60);
  let formFirstRun = $state('');
  let formPaused = $state(false);
  let formError = $state('');
  let submitting = $state(false);
  let drawerSequence = 0;
  let taskSequence = 0;
  let toastTimer: ReturnType<typeof setTimeout>;

  const labels = TASK_STATUS_LABELS;
  const columnData: { status: TaskStatus; title: string; icon: string; empty: string }[] = [
    { status: 'ready', title: 'К запуску', icon: 'circle', empty: 'Следующая идея начинается здесь' },
    { status: 'running', title: 'В работе', icon: 'bolt', empty: 'Агенты готовы к работе' },
    { status: 'waiting_input', title: 'Нужен ответ', icon: 'message', empty: 'Ничего не требует вашего участия' },
    { status: 'completed', title: 'Завершено', icon: 'circlecheck', empty: 'Здесь будут готовые результаты' },
  ];
  const activeStatuses: TaskStatus[] = ['queued', 'preparing', 'running', 'waiting_input', 'interrupted', 'cancelling', 'awaiting_merge', 'integrating', 'merge_interrupted'];
  const attentionStatuses: TaskStatus[] = ['waiting_input', 'interrupted', 'failed', 'blocked', 'merge_conflict', 'merge_failed', 'merge_blocked', 'merge_interrupted'];
  // Board columns have no place for these statuses; the problem panel above the board shows them, most urgent first.
  const problemStatuses: TaskStatus[] = ['failed', 'blocked', 'merge_conflict', 'merge_failed', 'merge_blocked', 'interrupted', 'merge_interrupted', 'cancelled'];
  let activeTasks = $derived(tasks.filter(task => task.archivedAt === null));
  let archivedTasks = $derived(tasks.filter(task => task.archivedAt !== null).sort((a, b) => b.archivedAt! - a.archivedAt!));
  let archiveResults = $derived(archivedTasks.filter(task => {
    const query = archiveSearch.trim().toLocaleLowerCase();
    return matchesTag(task, archiveTagFilter) && (!query || `${task.title} ${task.instruction} ${task.cwd}`.toLocaleLowerCase().includes(query));
  }));
  let filtered = $derived(activeTasks.filter(task => {
    const query = search.trim().toLocaleLowerCase();
    return (provider === 'all' || taskProviders(task).includes(provider))
      && matchesTag(task, tagFilter)
      && (scope === 'all' || (scope === 'scheduled' && task.schedule === 'interval') || (scope === 'attention' && attentionStatuses.includes(task.status)) || (scope === 'completed' && task.status === 'completed') || (scope === 'autopilot' && task.schedule === 'auto'))
      && (!query || `${task.title} ${task.instruction} ${task.cwd} ${task.worker?.name ?? ''} ${task.latestRun?.worker?.name ?? ''} ${(task.steps ?? []).map(step => `${step.title} ${workers.find(worker => worker.id === step.workerId)?.name ?? ''}`).join(' ')} ${(task.latestRun?.steps ?? []).map(step => `${step.title} ${step.worker.name}`).join(' ')}`.toLocaleLowerCase().includes(query));
  }));
  let problemTasks = $derived(filtered.filter(task => problemStatuses.includes(task.status)).sort((a, b) => problemStatuses.indexOf(a.status) - problemStatuses.indexOf(b.status)));
  let selectedTask = $derived(detail?.task ?? tasks.find(task => task.id === selectedId) ?? null);
  let currentRun = $derived(selectedTask?.latestRun ?? null);
  let completedTargets = $derived(followupTargets(detail?.runs ?? []));
  let recipientOptions = $derived(followupAttempt && !completedTargets.some(target => target.key === followupAttempt?.target.key)
    ? [followupAttempt.target, ...completedTargets] : completedTargets);
  let followupTarget = $derived(resolveFollowupTarget(recipientOptions, followupTargetKey, followupRecipientSession));
  $effect(() => {
    // Follow a replacement run within the selected session, never another worker's session.
    if (followupTarget) {
      followupTargetKey = followupTarget.key;
      followupRecipientSession = followupSessionKey(followupTarget);
    }
  });
  let followupDraftSignature = $derived(followupTarget ? followupFingerprint({ sourceRunId: followupTarget.sourceRunId,
    sourceStepIndex: followupTarget.sourceStepIndex, body: comment.trim(), attachmentIds: commentAttachmentIds }) : '');
  let retryingFollowup = $derived(!!followupAttempt && followupAttempt.taskId === selectedId && followupAttempt.signature === followupDraftSignature);
  let followupBlocked = $derived(integrationChecksMissing ? integrationChecksRequired
    : !followupTarget ? followupTargetKey ? 'Выбранная сессия больше не найдена. Выберите получателя заново.' : 'После завершения запуска здесь можно отправить агенту дополнительный запрос.'
    : !followupTarget.sessionId ? 'Идентификатор сессии не сохранён. Продолжить её нельзя. Для работы в новой сессии создайте отдельную задачу.'
    : selectedTask && taskIsOccupied(selectedTask) && !retryingFollowup ? 'Задача занята. Завершите текущий запуск или ответьте агенту в блоке выше.' : '');
  let inputRunKey = $state('');
  $effect(() => {
    const next = `${currentRun?.id ?? ''}:${currentRun?.currentStepIndex ?? ''}:${currentRun?.turn ?? ''}:${currentRun?.steps?.[currentRun?.currentStepIndex ?? -1]?.attempts?.at(-1)?.id ?? ''}:${currentRun?.status === 'interrupted'}`;
    if (next !== inputRunKey) { inputRunKey = next; answer = ''; acknowledgeInterruption = false; }
  });
  let taskBusy = $derived(selectedId ? pending.includes(selectedId) : false);
  $effect(() => {
    if (taskBusy || detailTab !== 'conversation') followupRecipientOpen = false;
  });
  let currentStep = $derived(currentRun?.currentStepIndex != null ? currentRun.steps?.[currentRun.currentStepIndex] ?? null : null);
  let interruptedWithoutSession = $derived(!!currentRun?.steps?.length && currentRun.status === 'interrupted' && !currentRun.sessionId);
  let runCanRetry = $derived(!!currentRun?.steps?.length && (['failed', 'blocked'].includes(currentRun.status) || interruptedWithoutSession));
  let runCanResume = $derived(currentRun && (currentRun.status === 'waiting_input' || (currentRun.status === 'interrupted' && !!currentRun.sessionId)));
  let formWorker = $derived(workers.find(worker => worker.id === formWorkerId) ?? (formOriginalWorker?.id === formWorkerId ? formOriginalWorker : null));
  let providerAvailable = $derived(info?.mode === 'mock' || info?.providers.find(p => p.id === (formWorker?.provider ?? formProvider))?.available);
  /** Profile settings behind the ultracode checkbox: the assigned worker, or every chosen stage worker of a complex task. */
  let formProfileUltracode = $derived(formComplex ? formSteps.flatMap(step => { const worker = workers.find(item => item.id === step.workerId); return worker ? [worker.ultracode] : []; }) : [formWorker?.ultracode ?? false]);
  let formUltracodeMixed = $derived(formUltracode === null && formProfileUltracode.includes(true) && formProfileUltracode.includes(false));
  let formUltracodeChecked = $derived(formUltracode ?? (formProfileUltracode.length > 0 && formProfileUltracode.every(Boolean)));

  async function api<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
    let body;
    try { body = await response.json(); } catch { throw new Error('Сервер вернул неожиданный ответ. Проверьте, что brigd запущен.'); }
    if (!response.ok) throw new Error(body.error || `Ошибка запроса (${response.status})`);
    return body as T;
  }

  function notify(text: string, type: 'success' | 'error' = 'success') {
    clearTimeout(toastTimer);
    toast = { text, type };
    if (type === 'success') toastTimer = setTimeout(() => { toast = null; }, 4500);
  }

  function notifyForTask(taskId: string, context: number, text: string, type: 'success' | 'error' = 'success') {
    if (context !== drawerContext || (selectedId && selectedId !== taskId)) return;
    notify(text, type);
  }

  async function loadTasks() {
    const sequence = ++taskSequence;
    try {
      const result = await api<Task[]>('/api/tasks');
      if (sequence !== taskSequence) return;
      tasks = result;
      connectionError = '';
    } catch (error) {
      if (sequence === taskSequence) connectionError = error instanceof Error ? error.message : 'Не удалось подключиться к серверу';
    } finally { if (sequence === taskSequence) loading = false; }
  }

  async function loadWorkers() {
    const sequence = ++workerSequence;
    try {
      const result = await api<Worker[]>('/api/workers');
      if (sequence !== workerSequence) return;
      workers = result;
      workersError = '';
    } catch (error) {
      if (sequence === workerSequence) workersError = error instanceof Error ? error.message : 'Не удалось загрузить работников';
    } finally { if (sequence === workerSequence) workersLoading = false; }
  }

  async function loadTags() {
    if (tagMutationPending || tagReadSequence !== null) return;
    const sequence = ++tagSequence;
    tagReadSequence = sequence;
    try {
      const result = await api<Tag[]>('/api/tags');
      if (sequence !== tagSequence) return;
      tags = result;
      tagsError = '';
      if (!['all', 'untagged'].includes(tagFilter) && !tags.some(tag => tag.id === tagFilter)) tagFilter = 'all';
      if (!['all', 'untagged'].includes(archiveTagFilter) && !tags.some(tag => tag.id === archiveTagFilter)) archiveTagFilter = 'all';
    } catch (error) {
      if (sequence === tagSequence) tagsError = error instanceof Error ? error.message : 'Не удалось загрузить теги';
    } finally {
      if (tagReadSequence === sequence) tagReadSequence = null;
      if (sequence === tagSequence) tagsLoading = false;
    }
  }

  function tagMutation(pending: boolean) {
    tagMutationPending = pending;
    if (pending) { tagSequence++; tagReadSequence = null; }
  }

  function tagChanged(tag: Tag) {
    tagSequence++;
    tagReadSequence = null;
    tags = (tags.some(item => item.id === tag.id) ? tags.map(item => item.id === tag.id ? tag : item) : [...tags, tag]).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    tagsLoading = false;
    tagsError = '';
    taskSequence++;
    drawerSequence++;
    const update = (task: Task) => ({ ...task, tags: (task.tags ?? []).map(item => item.id === tag.id ? tag : item) });
    tasks = tasks.map(update);
    if (detail) detail = { ...detail, task: update(detail.task) };
  }

  function taskChanged(saved: Task) {
    taskSequence++;
    drawerSequence++;
    tasks = tasks.map(item => item.id === saved.id ? saved : item);
    if (detail?.task.id === saved.id) detail = { ...detail, task: saved };
  }

  function tagDeleted(id: string) {
    tagSequence++;
    tagReadSequence = null;
    tags = tags.filter(tag => tag.id !== id);
    tagsLoading = false;
    tagsError = '';
    if (tagFilter === id) tagFilter = 'all';
    if (archiveTagFilter === id) archiveTagFilter = 'all';
    formTagIds = formTagIds.filter(tagId => tagId !== id);
    taskTagIds = taskTagIds.filter(tagId => tagId !== id);
    taskSequence++;
    drawerSequence++;
    const update = (task: Task) => ({ ...task, tagIds: (task.tagIds ?? []).filter(tagId => tagId !== id), tags: (task.tags ?? []).filter(tag => tag.id !== id) });
    tasks = tasks.map(update);
    if (detail) detail = { ...detail, task: update(detail.task) };
  }

  async function loadModels() {
    // Do not read midway through a write. Its result invalidates every older read.
    if (modelMutationPending || modelReadSequence !== null) return;
    const sequence = ++modelSequence;
    modelReadSequence = sequence;
    try {
      const result = await api<ModelCatalogEntry[]>('/api/models');
      if (sequence !== modelSequence) return;
      models = result;
      modelsError = '';
    } catch (error) {
      if (sequence === modelSequence) modelsError = error instanceof Error ? error.message : 'Не удалось загрузить модели';
    } finally {
      if (modelReadSequence === sequence) modelReadSequence = null;
      if (sequence === modelSequence) modelsLoading = false;
    }
  }

  function modelChanged(entry: ModelCatalogEntry) {
    modelSequence++;
    modelReadSequence = null;
    models = models.some(item => item.id === entry.id) ? models.map(item => item.id === entry.id ? entry : item) : [...models, entry];
    modelsError = '';
    modelsLoading = false;
  }

  function modelDeleted(id: string) {
    modelSequence++;
    modelReadSequence = null;
    models = models.filter(item => item.id !== id);
    modelsError = '';
    modelsLoading = false;
  }

  function loadGeneralSettings(): Promise<void> {
    if (generalSettingsMutationPending) return Promise.resolve();
    if (generalSettingsRequest && generalSettingsReadSequence !== null) return generalSettingsRequest;
    const sequence = ++generalSettingsSequence;
    generalSettingsReadSequence = sequence;
    generalSettingsRequest = (async () => {
      try {
        const result = await api<GeneralSettingsValue>('/api/settings/general');
        if (sequence !== generalSettingsSequence) return;
        generalSettings = result;
        generalSettingsError = '';
      } catch (error) {
        if (sequence === generalSettingsSequence) generalSettingsError = error instanceof Error ? error.message : 'Не удалось загрузить общие настройки';
      } finally {
        if (generalSettingsReadSequence === sequence) {
          generalSettingsReadSequence = null;
          generalSettingsRequest = null;
        }
        if (sequence === generalSettingsSequence) generalSettingsLoading = false;
      }
    })();
    return generalSettingsRequest;
  }

  function generalSettingsChanged(value: GeneralSettingsValue) {
    generalSettingsSequence++;
    generalSettingsReadSequence = null;
    generalSettings = value;
    generalSettingsError = '';
    generalSettingsLoading = false;
    if (info) info = { ...info, cwd: value.defaultCwd };
  }

  function generalSettingsMutationStarted() {
    generalSettingsSequence++;
    generalSettingsReadSequence = null;
  }

  async function loadAutopilotSettings() {
    if (autopilotSettingsMutationPending || autopilotSettingsReadSequence !== null) return;
    const sequence = ++autopilotSettingsSequence;
    autopilotSettingsReadSequence = sequence;
    try {
      const result = await api<AutopilotSettingsValue>('/api/settings/autopilot');
      if (sequence !== autopilotSettingsSequence) return;
      autopilotSettings = result;
      autopilotSettingsError = '';
    } catch (error) {
      if (sequence === autopilotSettingsSequence) autopilotSettingsError = error instanceof Error ? error.message : 'Не удалось загрузить настройки автопилота';
    } finally {
      if (autopilotSettingsReadSequence === sequence) autopilotSettingsReadSequence = null;
      if (sequence === autopilotSettingsSequence) autopilotSettingsLoading = false;
    }
  }

  function autopilotSettingsChanged(value: AutopilotSettingsValue) {
    autopilotSettingsSequence++;
    autopilotSettingsReadSequence = null;
    autopilotSettings = value;
    autopilotSettingsError = '';
    autopilotSettingsLoading = false;
  }

  function autopilotSettingsMutationStarted() {
    autopilotSettingsSequence++;
    autopilotSettingsReadSequence = null;
  }

  function workerChanged(worker: Worker) {
    workerSequence++;
    workers = workers.some(item => item.id === worker.id) ? workers.map(item => item.id === worker.id ? worker : item) : [worker, ...workers];
    workersError = '';
    workersLoading = false;
    taskSequence++;
    drawerSequence++;
    tasks = tasks.map(task => task.workerId === worker.id ? { ...task, worker, provider: worker.provider } : task);
    if (detail?.task.workerId === worker.id) detail = { ...detail, task: { ...detail.task, worker, provider: worker.provider } };
    void refresh();
  }

  function workerDeleted(id: string) {
    workerSequence++;
    workers = workers.filter(worker => worker.id !== id).map(worker => worker.fallbackWorkerId === id ? { ...worker, fallbackWorkerId: null } : worker);
    workersError = '';
    workersLoading = false;
    void refresh();
  }

  async function loadDetail(id = selectedId) {
    if (!id) return;
    const sequence = ++drawerSequence;
    try {
      const result = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
      if (selectedId !== id || sequence !== drawerSequence) return;
      detail = result;
      detailError = '';
    } catch (error) {
      if (selectedId === id && sequence === drawerSequence) detailError = error instanceof Error ? error.message : 'Не удалось загрузить задачу';
    }
  }

  async function refresh() {
    await Promise.all([loadTasks(), loadWorkers(), loadModels(), loadTags(), loadGeneralSettings(), loadAutopilotSettings(), selectedId ? loadDetail() : Promise.resolve()]);
  }

  async function loadInfo() {
    try { info = await api<AppInfo>('/api/info'); } catch { /* The task list surfaces connectivity errors. */ }
  }

  onMount(() => {
    applyTheme(theme);
    const onThemeStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) {
        theme = readTheme();
        applyTheme(theme);
        themeSaveError = false;
      }
    };
    window.addEventListener('storage', onThemeStorage);
    // Documentation links carry a hash; the other pages keep the plain URL.
    const onHash = () => { if (location.hash.startsWith('#/docs') && page !== 'docs') page = 'docs'; };
    window.addEventListener('hashchange', onHash);
    void loadInfo();
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') { void refresh(); if (!info) void loadInfo(); }
    }, 2000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(interval); clearTimeout(toastTimer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('storage', onThemeStorage); window.removeEventListener('hashchange', onHash); };
  });
  $effect(() => { if (page !== 'docs' && location.hash.startsWith('#/docs')) history.replaceState(null, '', location.pathname + location.search); });

  /** Documentation blocks link to task cards: a page opens its card here. */
  async function openTaskById(id: string) {
    const known = tasks.find(task => task.id === id);
    if (known) { await openTask(known); return; }
    try { const result = await api<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`); await openTask(result.task); }
    catch (failure) { notify(failure instanceof Error ? failure.message : 'Задача недоступна', 'error'); }
  }

  function openSettings(section?: (typeof settingsSections)[number]['id']) {
    if (section) settingsSection = section;
    settingsOpen = true;
    settings.showModal();
    void loadGeneralSettings();
    void loadModels();
    void loadAutopilotSettings();
  }

  function closeSettings() {
    if (settingsMutationPending) return;
    settings.close();
    settingsOpen = false;
  }

  function selectTheme(value: Theme) {
    theme = value;
    applyTheme(theme);
    themeSaveError = !saveTheme(theme);
  }

  async function openTask(task: Task) {
    if (followupSending || tagsSaving) return;
    drawerContext++;
    selectedId = task.id;
    detail = null;
    detailError = '';
    comment = '';
    followupTargetKey = '';
    followupRecipientSession = '';
    followupRecipientOpen = false;
    followupAttempt = null;
    followupError = '';
    commentAttachmentIds = [];
    answer = '';
    acknowledgeInterruption = false;
    detailTab = 'conversation';
    editingTags = false;
    taskTagsError = '';
    drawer.showModal();
    await loadDetail(task.id);
  }

  function closeDrawer() {
    if (followupSending || tagsSaving) return;
    drawer.close();
    drawerContext++;
    selectedId = null;
    detail = null;
    drawerSequence++;
  }

  function localInputDate(timestamp: number | null): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }

  async function openEditor(task?: Task) {
    if (submitting) return;
    const context = ++editorContext;
    if (!task) {
      // The current catalog decides whether the default worker can still be preselected.
      await Promise.all([loadGeneralSettings(), loadWorkers()]);
      if (context !== editorContext) return;
    }
    const defaultWorker = task ? null : workers.find(worker => worker.id === generalSettings?.defaultWorkerId && !worker.archived) ?? null;
    formAttachments = [...(task?.attachments ?? [])];
    formAttachmentCount = formAttachments.length;
    formUploading = false;
    formAttachmentInvalid = false;
    editingId = task?.id ?? null;
    formTitle = task?.title ?? '';
    formTagIds = [...(task?.tagIds ?? [])];
    void loadTags();
    formInstruction = task?.instruction ?? '';
    formProvider = task?.provider ?? defaultWorker?.provider ?? 'codex';
    formWorkerId = task?.workerId ?? defaultWorker?.id ?? '';
    formOriginalWorker = task?.worker ?? null;
    formComplex = !!task?.steps?.length;
    formSteps = (task?.steps?.length ? task.steps : [1, 2].map(index => ({ workerId: '', title: `Этап ${index}`, instruction: '' }))).map(step => ({ ...step, key: crypto.randomUUID() }));
    formOriginalStepWorkers = task?.steps?.map(step => step.workerId) ?? [];
    formUltracode = task?.ultracode ?? null;
    if (task) void loadWorkers();
    formCwd = task?.cwd ?? generalSettings?.defaultCwd ?? info?.cwd ?? '';
    formSchedule = task?.schedule ?? generalSettings?.defaultSchedule ?? 'manual';
    formInterval = task?.intervalMinutes ?? 60;
    formFirstRun = localInputDate(task?.firstRunAt ?? null);
    formPaused = task?.paused ?? false;
    formError = '';
    editorOpen = true;
    await tick();
    editor.showModal();
    editor.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
  }

  function closeEditor() {
    if (submitting) return;
    editor.close();
    editorOpen = false;
    editorContext++;
  }

  async function saveTask(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || formUploading || formAttachmentInvalid) return;
    formError = '';
    if (!formTitle.trim() || !formInstruction.trim() || !formCwd.trim()) {
      formError = 'Укажите название, инструкцию и рабочую папку.'; return;
    }
    if (formSchedule === 'interval' && (!Number.isInteger(formInterval) || formInterval < 1)) {
      formError = 'Интервал должен быть целым числом минут, не меньше 1.'; return;
    }
    const firstRunAt = formSchedule === 'interval' && formFirstRun ? new Date(formFirstRun).getTime() : null;
    if (firstRunAt !== null && !Number.isFinite(firstRunAt)) { formError = 'Проверьте время первого запуска.'; return; }
    if (formComplex && (formSteps.length < WORKFLOW_MIN_STEPS || formSteps.length > WORKFLOW_MAX_STEPS)) { formError = 'В сложной задаче должно быть от 2 до 20 этапов.'; return; }
    if (formComplex && formSteps.some(step => !step.title.trim() || !step.instruction.trim() || !step.workerId)) { formError = 'Укажите название, работника и задание каждого этапа.'; return; }
    if (formComplex && formSteps.some(step => !workers.some(worker => worker.id === step.workerId && (!worker.archived || formOriginalStepWorkers.includes(worker.id))))) { formError = 'Проверьте работников этапов: недоступного или нового архивного работника нужно заменить.'; return; }
    if (formComplex && workers.some(worker => worker.archived && formSteps.filter(step => step.workerId === worker.id).length > formOriginalStepWorkers.filter(id => id === worker.id).length)) { formError = 'Архивному работнику нельзя назначить дополнительные этапы. Восстановите профиль или выберите другого работника.'; return; }
    if (formComplex && (formSteps.reduce((size, step) => size + step.title.trim().length + step.instruction.trim().length, 0) > WORKFLOW_TEXT_LIMIT || new TextEncoder().encode(JSON.stringify(formSteps.map(({ title, instruction, workerId }) => ({ workerId, title: title.trim(), instruction: instruction.trim() })))).byteLength > WORKFLOW_BYTES_LIMIT)) { formError = 'План слишком большой. Сократите задания этапов: суммарный лимит 64 000 символов и 96 000 байт.'; return; }
    if (!formComplex && formWorkerId && !formWorker) { formError = 'Работник недоступен. Обновите список или выберите другого.'; return; }
    if (!formComplex && formWorker?.archived && formWorker.id !== formOriginalWorker?.id) { formError = 'Этот работник в архиве. Выберите другого или восстановите профиль.'; return; }
    const payload: TaskInput = {
      title: formTitle.trim(), instruction: formInstruction.trim(), provider: formComplex ? workers.find(worker => worker.id === formSteps[0]?.workerId)?.provider ?? formProvider : formWorker?.provider ?? formProvider, workerId: formComplex ? null : formWorkerId || null, cwd: formCwd.trim(),
      steps: formComplex ? formSteps.map(({ workerId, title, instruction }) => ({ workerId, title: title.trim(), instruction: instruction.trim() })) : [],
      schedule: formSchedule, intervalMinutes: formSchedule === 'interval' ? formInterval : null,
      firstRunAt, paused: formPaused,
      ultracode: formUltracode,
      tagIds: formTagIds,
    };
    const savedEditingId = editingId;
    const context = editorContext;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    try { attachments = formComposer?.prepareSubmission(); } catch (error) { formError = error instanceof Error ? error.message : 'Проверьте загрузку файлов.'; return; }
    submitting = true;
    try {
      const saved = await api<Task>(savedEditingId ? `/api/tasks/${encodeURIComponent(savedEditingId)}` : '/api/tasks', { method: savedEditingId ? 'PATCH' : 'POST', body: JSON.stringify({ ...payload, attachmentIds: attachments?.attachmentIds ?? [] }) });
      attachments?.finish(true);
      notify(savedEditingId ? 'Изменения сохранены' : 'Задача создана');
      submitting = false;
      closeEditor();
      taskSequence++;
      drawerSequence++;
      tasks = savedEditingId ? tasks.map(task => task.id === saved.id ? saved : task) : [saved, ...tasks];
      if (detail?.task.id === saved.id) detail = { ...detail, task: saved };
      if (!savedEditingId) await openTask(saved);
      void refresh();
    } catch (error) { attachments?.finish(false); if (context === editorContext) formError = error instanceof Error ? error.message : 'Не удалось сохранить задачу'; }
    finally { submitting = false; }
  }

  async function openTaskTags(task: Task) {
    const context = drawerContext;
    taskTagIds = [...(task.tagIds ?? [])];
    taskTagsError = '';
    editingTags = true;
    void loadTags();
    await tick();
    if (context === drawerContext && selectedId === task.id && editingTags) drawer.querySelector<HTMLInputElement>('.task-tag-section input[type="search"]')?.focus();
  }

  async function closeTaskTags() {
    if (tagsSaving) return;
    editingTags = false;
    await tick();
    drawer.querySelector<HTMLButtonElement>('[data-edit-task-tags]')?.focus();
  }

  async function saveTaskTags(task: Task) {
    if (tagsSaving || pending.includes(task.id)) return;
    const context = drawerContext;
    tagsSaving = true;
    taskTagsError = '';
    pending = [...pending, task.id];
    try {
      const saved = await api<Task>(`/api/tasks/${encodeURIComponent(task.id)}/tags`, { method: 'PATCH', body: JSON.stringify({ tagIds: taskTagIds }) });
      taskSequence++;
      drawerSequence++;
      tasks = tasks.map(item => item.id === saved.id ? saved : item);
      if (context === drawerContext && selectedId === saved.id) {
        if (detail) detail = { ...detail, task: saved };
        editingTags = false;
        notify('Теги задачи сохранены');
      }
      void refresh();
    } catch (error) {
      if (context === drawerContext) taskTagsError = error instanceof Error ? error.message : 'Не удалось сохранить теги';
    } finally {
      tagsSaving = false;
      pending = pending.filter(id => id !== task.id);
      await tick();
      if (context === drawerContext && selectedId === task.id && !editingTags) drawer.querySelector<HTMLButtonElement>('[data-edit-task-tags]')?.focus();
    }
  }

  async function act(task: Task, action: 'run' | 'pause' | 'resume' | 'cancel' | 'retry' | 'archive' | 'restore', response?: string) {
    if (pending.includes(task.id)) return;
    if (integrationChecksMissing && ['run', 'resume', 'retry'].includes(action)) { notify(integrationChecksRequired, 'error'); return; }
    if (action === 'run' && !canStartManual(task)) return;
    if (action === 'archive' && (task.archivedAt !== null || taskIsOccupied(task))) return;
    if (action === 'restore' && task.archivedAt === null) return;
    if (action === 'cancel' && (task.status === 'cancelling' || (task.latestRun?.status === 'interrupted' && !acknowledgeInterruption))) return;
    if (action === 'resume' && task.latestRun?.status === 'interrupted' && !acknowledgeInterruption) return;
    if (action === 'retry' && (!task.latestRun?.steps?.length || (!['failed', 'blocked'].includes(task.latestRun.status) && !(task.latestRun.status === 'interrupted' && !task.latestRun.sessionId && acknowledgeInterruption)))) return;
    const context = drawerContext;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    if (action === 'resume') {
      if (answerUploading || answerAttachmentInvalid) return;
      try { attachments = answerComposer?.prepareSubmission(); } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : 'Проверьте загрузку файлов.', 'error'); return; }
    }
    pending = [...pending, task.id];
    try {
      if (action === 'run') {
        await api<Run>(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', body: '{}' });
        notifyForTask(task.id, context, info?.mode === 'mock' ? 'Демо-запуск начат' : 'Задача запущена');
      } else if (action === 'pause') {
        await api<Task>(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ paused: !task.paused }) });
        notifyForTask(task.id, context, task.schedule === 'auto' ? (task.paused ? 'Задача возвращена в очередь автопилота' : 'Задача отложена: автопилот её не возьмёт') : task.paused ? 'Расписание возобновлено' : 'Расписание приостановлено');
      } else if (action === 'archive' || action === 'restore') {
        await api<Task>(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', body: '{}' });
        notifyForTask(task.id, context, action === 'archive' ? 'Задача перенесена в архив' : 'Задача восстановлена и снова на доске');
      } else if (task.latestRun) {
        const updatedRun = await api<Run>(`/api/runs/${encodeURIComponent(task.latestRun.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'resume' ? { answer: response?.trim() || (attachments?.attachmentIds.length ? '' : 'Продолжи выполнение задачи с того места, где остановился.'), attachmentIds: attachments?.attachmentIds ?? [], ...(task.latestRun.status === 'interrupted' ? { acknowledgeInterruption: true } : {}) } : ['retry', 'cancel'].includes(action) && task.latestRun.status === 'interrupted' ? { acknowledgeInterruption: true } : {}) });
        attachments?.finish(true);
        if (['resume', 'retry', 'cancel'].includes(action) && selectedId === task.id && context === drawerContext) { answer = ''; acknowledgeInterruption = false; }
        notifyForTask(task.id, context, action === 'resume' ? 'Ответ отправлен, агент продолжает работу' : action === 'retry' ? 'Текущий этап запущен заново. Завершённые этапы сохранены.' : updatedRun.status === 'cancelling' ? 'Останавливаем процесс агента…' : 'Запуск отменён');
      }
      await refresh();
    } catch (error) { attachments?.finish(false); notifyForTask(task.id, context, error instanceof Error ? error.message : 'Не удалось выполнить действие', 'error'); }
    finally { pending = pending.filter(id => id !== task.id); }
  }

  async function openDelete(target: NonNullable<typeof deleting>) {
    if (removing) return;
    deleting = target;
    deleteError = '';
    await tick();
    deleteDialog.showModal();
    deleteDialog.querySelector<HTMLButtonElement>('[data-cancel-delete]')?.focus();
  }

  function askDeleteTask(task: Task) {
    if (pending.includes(task.id) || taskIsOccupied(task) || (selectedId === task.id && (followupSending || tagsSaving))) return;
    void openDelete({ kind: 'task', task });
  }

  function askDeleteArchive() {
    if (!archivedTasks.length) return;
    void openDelete({ kind: 'archive', count: archivedTasks.length, archivedBefore: Math.max(...archivedTasks.map(task => task.archivedAt!)) });
  }

  function closeDelete() {
    if (removing) return;
    deleteDialog.close();
    deleting = null;
  }

  async function confirmDelete(event: SubmitEvent) {
    event.preventDefault();
    const target = deleting;
    if (!target || removing) return;
    const taskId = target.kind === 'task' ? target.task.id : null;
    if (taskId && pending.includes(taskId)) return;
    removing = true;
    deleteError = '';
    if (taskId) pending = [...pending, taskId];
    try {
      let message = 'Задача удалена';
      if (target.kind === 'task') await api<{ ok: true }>(`/api/tasks/${encodeURIComponent(target.task.id)}/purge`, { method: 'POST', body: '{}' });
      else {
        const result = await api<{ deleted: number; skipped: number }>('/api/archive/purge', { method: 'POST', body: JSON.stringify({ archivedBefore: target.archivedBefore }) });
        message = `Удалено задач из архива: ${result.deleted}.${result.skipped ? ` Не удалены: ${result.skipped} — их процессы ещё завершаются, повторите позже.` : ''}`;
      }
      taskSequence++;
      drawerSequence++;
      if (taskId) tasks = tasks.filter(task => task.id !== taskId);
      removing = false;
      closeDelete();
      if (taskId && selectedId === taskId) closeDrawer();
      notify(message);
      void refresh();
    } catch (error) { deleteError = error instanceof Error ? error.message : 'Не удалось удалить'; }
    finally {
      removing = false;
      if (taskId) pending = pending.filter(id => id !== taskId);
    }
  }

  async function integrationAction(runId: string, action: 'integrate' | 'cancel-integration' | 'reconcile', acknowledgement: boolean) {
    const task = selectedTask;
    const context = drawerContext;
    if (!task || pending.includes(task.id)) return;
    if (integrationChecksMissing && action !== 'cancel-integration') { notify(integrationChecksRequired, 'error'); return; }
    pending = [...pending, task.id];
    try {
      await api(`/api/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST', body: JSON.stringify({ acknowledgeInterruption: acknowledgement }) });
      notifyForTask(task.id, context, action === 'integrate' ? 'Результат поставлен в очередь проверки и слияния' : action === 'reconcile' ? 'Интегратор объединит результат с целевой веткой и повторит проверку' : 'Остановка слияния запрошена');
      await refresh();
    } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : 'Не удалось изменить состояние слияния', 'error'); }
    finally { pending = pending.filter(id => id !== task.id); }
  }

  async function sendComment(event: SubmitEvent) {
    event.preventDefault();
    const task = selectedTask;
    const body = comment.trim();
    const context = drawerContext;
    if (!task || (!body && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid) return;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    try { attachments = commentComposer?.prepareSubmission(); } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : 'Проверьте загрузку файлов.', 'error'); return; }
    pending = [...pending, task.id];
    try {
      await api<Comment>(`/api/tasks/${encodeURIComponent(task.id)}/comments`, { method: 'POST', body: JSON.stringify({ body, attachmentIds: attachments?.attachmentIds ?? [] }) });
      attachments?.finish(true);
      if (selectedId === task.id && context === drawerContext) { comment = ''; followupAttempt = null; followupError = ''; await loadDetail(task.id); }
    } catch (error) { attachments?.finish(false); notifyForTask(task.id, context, error instanceof Error ? error.message : 'Не удалось сохранить заметку', 'error'); }
    finally { pending = pending.filter(id => id !== task.id); }
  }

  async function sendFollowup() {
    const task = selectedTask;
    const target = followupTarget;
    const body = comment.trim();
    const context = drawerContext;
    if (integrationChecksMissing) { followupError = integrationChecksRequired; return; }
    if (!task || !target || !target.sessionId || (!body && !commentAttachmentCount) || taskBusy || followupSending || commentUploading || commentAttachmentInvalid) return;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    try { attachments = commentComposer?.prepareSubmission(); }
    catch (error) { followupError = error instanceof Error ? error.message : 'Проверьте загрузку файлов.'; return; }
    const draft = { sourceRunId: target.sourceRunId, sourceStepIndex: target.sourceStepIndex, body, attachmentIds: attachments?.attachmentIds ?? [] };
    const signature = followupFingerprint(draft);
    const previous = followupAttempt?.taskId === task.id && followupAttempt.signature === signature ? followupAttempt : null;
    if (taskIsOccupied(task) && !previous) { attachments?.finish(false); followupError = 'Задача занята. Дождитесь завершения текущего запуска.'; return; }
    const attempt = previous ?? { taskId: task.id, signature, payload: { ...draft, requestId: crypto.randomUUID() }, target };
    followupAttempt = attempt;
    followupTargetKey = target.key;
    followupSending = true;
    followupError = '';
    pending = [...pending, task.id];
    try {
      const run = await api<Run>(`/api/tasks/${encodeURIComponent(task.id)}/followups`, { method: 'POST', body: JSON.stringify(attempt.payload) });
      attachments?.finish(true);
      // Immediately lock task actions, before polling catches up with the new run.
      taskSequence++;
      drawerSequence++;
      const updateTask = (item: Task): Task => item.id === task.id ? { ...item, latestRun: run, status: run.status, hasCompletedRun: true } : item;
      tasks = tasks.map(updateTask);
      if (selectedId === task.id && context === drawerContext) {
        if (detail) detail = { ...detail, task: updateTask(detail.task), runs: [run, ...detail.runs.filter(item => item.id !== run.id)] };
        comment = '';
        followupAttempt = null;
        // Keep the explicitly selected recipient while the new request runs.
        // Completed-target polling will rebind its source ID in the same session.
        // Resetting here would select another worker's last completed run.
        followupTargetKey = target.key;
        followupRecipientSession = followupSessionKey(target);
        notifyForTask(task.id, context, 'Дополнительный запрос отправлен в ту же сессию');
      }
      await refresh();
    } catch (error) {
      attachments?.finish(false);
      if (selectedId === task.id && context === drawerContext) followupError = error instanceof Error ? error.message : 'Не удалось отправить запрос.';
      // Retain exact payload and request ID: an uncertain response may already have started a run.
    } finally {
      followupSending = false;
      pending = pending.filter(id => id !== task.id);
    }
  }

  function recipientLabel(target: FollowupTarget): string {
    return `${target.worker?.name ?? providerName(target.provider)}${target.stageIndex != null ? ` · Этап ${target.stageIndex + 1}: ${target.stageTitle}` : ''} · ${dateTime(target.startedAt)} · ${target.isFollowup ? 'Доп. запрос' : target.isReconcile ? 'Конфликт' : 'Запуск'} ${target.sourceRunId.slice(0, 6)}${target.sessionId ? '' : ' · Сессия не сохранена'}`;
  }

  function dateTime(timestamp: number | null, short = false): string {
    if (!timestamp) return '—';
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...(short ? {} : { hour: '2-digit', minute: '2-digit' }) }).format(timestamp);
  }

  function intervalLabel(minutes: number | null): string {
    if (!minutes) return 'По расписанию';
    if (minutes % 1440 === 0) return minutes === 1440 ? 'Каждый день' : `Каждые ${minutes / 1440} дн.`;
    if (minutes % 60 === 0) return minutes === 60 ? 'Каждый час' : `Каждые ${minutes / 60} ч.`;
    return `Каждые ${minutes} мин.`;
  }

  function scheduleLabel(task: Task, short = false): string {
    if (task.schedule === 'auto') return task.paused ? 'Автопилот: отложено' : 'Автопилот';
    if (task.paused) return short ? 'На паузе' : 'Расписание на паузе';
    return task.schedule === 'interval' ? intervalLabel(task.intervalMinutes) : 'Вручную';
  }
  function scheduleIcon(task: Task): string { return task.paused ? 'pause' : task.schedule === 'interval' ? 'clock' : task.schedule === 'auto' ? 'moon' : 'play'; }
  function taskIsOccupied(task: Task) { return activeStatuses.includes(task.status) || !!task.latestRun?.steps?.length && ['failed', 'blocked'].includes(task.status); }
  function canStartManual(task: Task) { return !taskIsOccupied(task) && !taskHasCompletedRun(task); }
  function workflowSteps(task: Task) { const saved = runWorkflowSteps(task.latestRun); return saved.length ? saved : task.steps ?? []; }
  function workflowProgress(task: Task) { const steps = workflowSteps(task); return `${runWorkflowSteps(task.latestRun).filter(step => step.status === 'completed').length} из ${steps.length} этапов завершено`; }
  function visibleWorker(task: Task) { return (taskIsOccupied(task) || !!task.latestRun?.steps?.length || !!task.latestRun?.followup || !!task.latestRun?.reconcile) && task.latestRun ? task.latestRun.worker : task.worker ?? workers.find(worker => worker.id === task.steps?.[0]?.workerId) ?? null; }
  function taskProviders(task: Task): Provider[] { return [visibleProvider(task), ...(task.steps ?? []).flatMap(step => { const worker = workers.find(item => item.id === step.workerId); return worker ? [worker.provider] : []; }), ...runWorkflowSteps(task.latestRun).map(step => step.worker.provider)]; }
  function visibleProvider(task: Task) { return (taskIsOccupied(task) || !!task.latestRun?.steps?.length || !!task.latestRun?.followup || !!task.latestRun?.reconcile) && task.latestRun ? task.latestRun.provider : task.provider; }
  /** Whether the shown run requests ultra mode, or whether the next run would: the card's own choice, else the visible worker's profile. */
  function visibleUltracode(task: Task): boolean {
    const run = task.latestRun;
    if (run && (taskIsOccupied(task) || !!run.steps?.length || !!run.followup || !!run.reconcile)) return runUltracode(run) ?? false;
    return task.ultracode ?? visibleWorker(task)?.ultracode ?? false;
  }
  /** A finished integrator turn without its own merge keeps the conflicted result's merge controls in reach. */
  let sourceIntegration = $derived(currentRun?.reconcile && !currentRun.integration && !activeStatuses.includes(currentRun.status)
    ? detail?.runs.find(run => run.id === currentRun!.reconcile!.sourceRunId)?.integration ?? null : null);
  function attachmentAuthor(file: Attachment) {
    if (file.source === 'user') return 'Вы';
    const run = detail?.runs.find(item => item.id === file.runId);
    return (file.stepIndex != null ? run?.steps?.[file.stepIndex]?.worker.name : run?.worker?.name) ?? (run ? providerName(run.provider) : 'Агент');
  }
  function commentRun(entry: Comment) { return entry.runId ? detail?.runs.find(run => run.id === entry.runId) ?? null : null; }
  function commentWorker(entry: Comment) { const run = commentRun(entry); return ['agent', 'question', 'result'].includes(entry.kind) ? (entry.stepIndex != null ? run?.steps?.[entry.stepIndex]?.worker : run?.steps?.length ? null : run?.worker) ?? null : null; }
  function commentAuthor(entry: Comment) {
    if (entry.kind === 'user') return 'Вы';
    if (entry.kind === 'system') return 'brigd';
    const identity = commentWorker(entry);
    if (identity) return identity.name;
    if (entry.kind === 'question') return 'Вопрос агента';
    if (entry.kind === 'result') return 'Результат';
    return providerName(commentRun(entry)?.provider ?? selectedTask?.provider ?? 'codex');
  }
  function providerName(value: Provider) { return value === 'codex' ? 'Codex' : 'Claude Code'; }
  function shortPath(path: string) { const parts = path.replace(/\\/g, '/').split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; }
  function elapsed(run: Run) {
    const seconds = Math.max(0, Math.floor(((run.finishedAt ?? run.updatedAt) - run.startedAt) / 1000));
    return seconds < 60 ? `${seconds} сек.` : `${Math.floor(seconds / 60)} мин. ${seconds % 60} сек.`;
  }
  function matchesTag(task: Task, value: string) { return value === 'all' || (value === 'untagged' ? !(task.tagIds ?? []).length : (task.tagIds ?? []).includes(value)); }
  function resetFilters() { search = ''; provider = 'all'; tagFilter = 'all'; setScope('all'); }
  function setScope(value: Scope) { scope = value; showProblems = true; }
  function globalKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && followupRecipientOpen) {
      event.preventDefault();
      followupRecipientOpen = false;
      drawer.querySelector<HTMLElement>('.followup-session-picker summary')?.focus();
      return;
    }
  }
  function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = ['conversation', 'logs', 'changes', 'history'] as const;
    const next = (tabs.indexOf(detailTab) + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    detailTab = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'history' : tabs[next];
    drawer.querySelector<HTMLButtonElement>(`#${detailTab}-tab`)?.focus();
  }
  function settingsTabKey(event: KeyboardEvent) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = settingsSections.map(section => section.id);
    const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    settingsSection = event.key === 'Home' ? ids[0] : event.key === 'End' ? ids[ids.length - 1] : ids[(ids.indexOf(settingsSection) + step + ids.length) % ids.length];
    settings.querySelector<HTMLButtonElement>(`#settings-${settingsSection}-tab`)?.focus();
  }
  function backdropClick(event: MouseEvent, dialog: HTMLDialogElement, close: () => void) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }
</script>

<svelte:window onkeydown={globalKey} onclick={(event) => { if (event.target instanceof Element && !event.target.closest('.followup-session-picker')) followupRecipientOpen = false; }} />

{#snippet providerBadge(value: Provider, compact = false)}
  <span class:compact class="provider-badge {value}"><span class="provider-mark">{#if value === 'codex'}<Icon name="code" size={compact ? 12 : 14} />{:else}<span class="claude-mark" aria-hidden="true">✳</span>{/if}</span>{providerName(value)}</span>
{/snippet}

{#snippet workerBadge(worker: Worker | WorkerSnapshot, compact = false)}
  <span class="worker-identity" class:compact title={worker.name}><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={compact ? 32 : 40} /><span class="worker-identity-copy"><span>{worker.name}</span>{#if worker.description?.trim()}<small class="worker-description">{worker.description}</small>{/if}<small class="worker-model-label" title={worker.model ?? undefined}>{providerName(worker.provider)} · {modelLabel(worker.model, 'archived' in worker ? models : undefined, worker.provider)}</small></span>{#if 'archived' in worker && worker.archived}<small>в архиве</small>{/if}</span>
{/snippet}

{#snippet statusBadge(status: TaskStatus)}
  <span class="status-badge status-{status}"><span class="status-dot"></span>{labels[status]}</span>
{/snippet}

{#snippet workspaceNote(run: Run)}
  {#if run.workspace?.mode === 'worktree' && (run.workspace.removedAt || run.workspace.recreatedAt)}
    <p class="workspace-note">{#if run.workspace.removedAt}{run.workspace.removedBy === 'cleanup' ? 'Папка запуска удалена при очистке хранилища' : 'Папка запуска удалена после переноса результата'} {dateTime(run.workspace.removedAt)}.{#if run.status === 'completed' && run.sessionId && selectedTask?.archivedAt === null} Ответ или дополнительный запрос создаст папку заново; если ветка {run.workspace.branch} удалена, она восстановится из последнего перенесённого коммита. Неотслеживаемые файлы прежней сессии не восстанавливаются.{/if}{:else}Папка запуска создана заново для ветки {run.workspace.branch} {dateTime(run.workspace.recreatedAt!)}; неотслеживаемые файлы прежней сессии в ней отсутствуют.{/if}</p>
  {/if}
{/snippet}
{#snippet instructionSnapshot(run: Run)}
  <details class="run-instruction-snapshot">
    <summary>Общие инструкции запуска</summary>
    <p class="snapshot-help">Копия на момент старта. При продолжении этого запуска используются те же правила.</p>
    <section class="snapshot-instruction"><h4>Общее задание запуска</h4><p>{run.instruction}</p></section>
    <section class="snapshot-instruction"><h4>Рабочая папка запуска</h4><p>{run.cwd}</p></section>
    {#if run.workspace?.mode === 'worktree'}<section class="snapshot-instruction"><h4>Изолированная рабочая папка</h4><p>{run.workspace.cwd}</p><p>Ветка: {run.workspace.branch}</p><p>После завершения изменения проверяются вместе с целевой веткой и переносятся в проект.</p></section>{/if}
    {#if run.worker && !run.steps?.length}<section class="snapshot-instruction worker-run-settings"><h4>Настройки работника на момент запуска</h4><p><span>{run.worker.name}</span>{#if run.worker.description?.trim()}<small class="worker-description">{run.worker.description}</small>{/if}<br />{providerName(run.worker.provider)}<br />Модель: {modelLabel(run.worker.model)}{#if run.worker.model && modelLabel(run.worker.model) !== run.worker.model} ({run.worker.model}){/if}<br />Усилия: {effortLabel(run.worker.effort)}<br />Режим ultracode: {runUltracode(run) ? 'включён' : 'выключен'}{#if run.ultracode != null} (задано в задаче){/if}</p></section>{/if}
    {#if run.inputAttachments?.length}<section class="snapshot-instruction"><h4>Файлы на момент запуска</h4><AttachmentList attachments={run.inputAttachments} taskId={run.taskId} label="Файлы запуска" author={attachmentAuthor} /></section>{/if}
    {#each run.instructions ?? [] as instruction (instruction.id)}
      <section class="snapshot-instruction"><h4>{instruction.title}</h4><p>{instruction.body}</p></section>
    {:else}<p class="snapshot-empty">В этом запуске нет общих инструкций.</p>{/each}
  </details>
{/snippet}

{#snippet taskTags(task: Task)}
  {#if task.tags?.length}<span class="task-tags">{#each task.tags as tag (tag.id)}<span class="task-tag" style={tagColorStyle(tag.color)}><span>{tag.name}</span></span>{/each}</span>{/if}
{/snippet}

{#snippet taskCard(task: Task)}
  <article class="task-card {task.status}" class:paused-card={task.paused}>
    <button class="card-main" onclick={() => openTask(task)} aria-label={'Открыть задачу: ' + task.title}>
      <div class="card-top">{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}{#if visibleUltracode(task)}<span class="ultracode-badge" title="Режим ultracode">ultracode</span>{/if}<span class="task-ref">{task.id.slice(0, 6).toUpperCase()}</span></div>
      <h3>{task.title}</h3>
      <p class="card-description">{task.latestRun?.summary || task.instruction}</p>
      {@render taskTags(task)}
      {#if workflowSteps(task).length}<div class="card-workflow-progress"><Icon name="list" size={14} /><span>{workflowProgress(task)}</span></div>{/if}
      {#if task.latestRun?.followup}<div class="card-followup-label"><Icon name="message" size={14} /><span>Дополнительный запрос{#if followupStage(task.latestRun)} · Этап {followupStage(task.latestRun)!.index + 1}{/if}</span></div>
      {:else if task.latestRun?.reconcile}<div class="card-followup-label"><Icon name="refresh" size={14} /><span>Разрешение конфликта слияния</span></div>{/if}
      {#if task.status === 'cancelling'}<div class="card-cancelling"><Icon name="refresh" size={13} class="spin" />Останавливается</div>{/if}
      {#if task.status === 'waiting_input'}<div class="card-signal"><Icon name="message" size={13} /> Агент ждёт вашего ответа</div>{/if}
      {#if task.status === 'queued'}<div class="card-signal"><Icon name="clock" size={13} /> Ожидает свободного места для запуска</div>{/if}
      {#if task.status === 'preparing'}<div class="card-signal"><Icon name="refresh" size={13} class="spin" /> Подготавливается рабочая папка</div>{/if}
      {#if task.status === 'interrupted'}<div class="card-signal"><Icon name="alert" size={13} /> Проверьте прерванный запуск</div>{/if}
      {#if task.latestRun?.error && ['failed', 'blocked'].includes(task.status)}<div class="card-error">{task.latestRun.error}</div>{/if}
      {#if task.attachments?.length}<div class="card-attachment-count"><Icon name="folder" size={13} /><span>Файлов: {task.attachments.length}</span></div>{/if}
    </button>
    <div class="card-footer">
      <span class="card-schedule" class:is-paused={task.paused}><Icon name={scheduleIcon(task)} size={12} />{scheduleLabel(task)}</span>
      <div class="card-actions">
        {#if !taskIsOccupied(task)}
          <button class="icon-button" disabled={pending.includes(task.id)} onclick={() => act(task, 'archive')} aria-label={'В архив: ' + task.title} title="В архив"><Icon name={pending.includes(task.id) ? 'refresh' : 'archive'} size={14} class={pending.includes(task.id) ? 'spin' : ''} /></button>
        {/if}
        {#if canStartManual(task)}
          <button class="card-run icon-button" disabled={pending.includes(task.id) || integrationChecksMissing} onclick={() => act(task, 'run')} aria-label={(workflowSteps(task).length && task.runCount ? 'Начать заново: ' : 'Запустить: ') + task.title} title={integrationChecksMissing ? integrationChecksRequired : workflowSteps(task).length && task.runCount ? 'Начать всю последовательность заново' : 'Запустить задачу'}><Icon name={pending.includes(task.id) ? 'refresh' : 'play'} size={14} class={pending.includes(task.id) ? 'spin' : ''} /></button>
        {:else}<span class="card-run-count" title="Количество запусков"><Icon name="history" size={12} />{task.runCount}</span>{/if}
      </div>
    </div>
  </article>
{/snippet}

<div class="app-shell">
  <aside class="sidebar" aria-label="Основная навигация">
    <a class="brand" href="/" aria-label="brigd — главная"><span class="brand-symbol"><BrigLogo size={28} /></span><span>brigd<span class="brand-dot">.</span></span></a>
    <nav class="main-nav" aria-label="Задачи">
      <button class:active={page === 'tasks'} aria-label="Задачи" onclick={() => { page = 'tasks'; resetFilters(); }}><Icon name="board" /><span>Задачи</span></button>
      <button class:active={page === 'autopilot'} aria-label="Автопилот" onclick={() => { page = 'autopilot'; }}><Icon name="moon" /><span>Автопилот</span></button>
      <button class:active={page === 'workers'} aria-label="Работники" onclick={() => { page = 'workers'; void loadWorkers(); }}><Icon name="spark" /><span>Работники</span></button>
      <button class:active={page === 'instructions'} aria-label="Инструкции" onclick={() => { page = 'instructions'; }}><Icon name="list" /><span>Инструкции</span></button>
      <button class:active={page === 'docs'} aria-label="Документация" onclick={() => { page = 'docs'; }}><Icon name="book" /><span>Документация</span></button>
      <button class:active={page === 'tags'} aria-label="Теги" onclick={() => { page = 'tags'; void loadTags(); }}><Icon name="tag" /><span>Теги</span></button>
    </nav>
    <div class="sidebar-bottom">
      <button class="archive-button" class:active={page === 'archive'} aria-label="Архив" onclick={() => { page = 'archive'; }}><Icon name="archive" /><span>Архив</span></button>
      <button class="settings-button" onclick={() => openSettings()} aria-haspopup="dialog"><Icon name="sliders" /><span>Настройки</span></button>
    </div>
  </aside>

  <main class="main-content">
    <div class="workspace-content">
      {#if page === 'instructions'}
        <Instructions {notify} />
      {:else if page === 'docs'}
        <Docs {notify} onopentask={(id) => { void openTaskById(id); }} />
      {:else if page === 'autopilot'}
        <Autopilot {tasks} {notify} settings={autopilotSettings} checksRequired={info?.mode !== 'mock'} onopen={openTask} onchanged={taskChanged} onsettings={openSettings} />
      {:else if page === 'tags'}
        <Tags {tags} loading={tagsLoading} error={tagsError} onreload={loadTags} onchanged={tagChanged} ondeleted={tagDeleted} onmutation={tagMutation} {notify} />
      {:else if page === 'archive'}
        <section class="page-heading" aria-label="Архив задач"><div><h1>Архив</h1><p>Задачи в архиве не показываются на доске и не запускаются по расписанию. История, комментарии и файлы сохраняются, пока задачу не удалят.</p></div>{#if !loading && archivedTasks.length}<button class="button danger" disabled={removing} onclick={askDeleteArchive}><Icon name="trash" size={16} />Удалить все</button>{/if}</section>
        {#if loading}
          <div class="list-empty" aria-busy="true"><Icon name="refresh" size={19} class="spin" /><span>Загружаем архив…</span></div>
        {:else if archivedTasks.length === 0}
          <div class="no-results"><span class="empty-icon"><Icon name="archive" size={28} /></span><h2>Архив пуст</h2><p>Нажмите значок архива на доске или кнопку «В архив» в открытой задаче.</p></div>
        {:else}
          <div class="toolbar"><label class="search-box"><Icon name="search" size={16} /><input bind:value={archiveSearch} type="search" placeholder="Найти в архиве…" aria-label="Поиск в архиве" /></label><label class="provider-filter tag-filter"><Icon name="tag" size={15} /><select bind:value={archiveTagFilter} aria-label="Фильтр по тегу" disabled={tagsLoading}><option value="all">Все теги</option><option value="untagged">Без тегов</option>{#each tags as tag (tag.id)}<option value={tag.id}>{tag.name}</option>{/each}</select><Icon name="down" size={13} /></label></div>
          {#if tagsError}<div class="connection-error" role="alert"><span>{tagsError}</span><button onclick={() => { void loadTags(); }}>Повторить загрузку тегов</button></div>{/if}
          <div class="task-list archive-list"><div class="list-heading"><span>ЗАДАЧА</span><span>АГЕНТ</span><span>СТАТУС</span><span>В АРХИВЕ С</span><span></span><span></span></div>{#each archiveResults as task (task.id)}<div class="task-row"><button class="list-task-name" onclick={() => openTask(task)}><span class="list-task-icon"><Icon name="archive" size={17} /></span><span><strong>{task.title}</strong><small>{shortPath(task.cwd)}</small>{@render taskTags(task)}</span></button><div>{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}</div><div>{@render statusBadge(task.status)}</div><span class="list-schedule">{dateTime(task.archivedAt!)}</span><div class="archive-row-actions"><button class="button secondary" disabled={pending.includes(task.id)} aria-label={'Восстановить: ' + task.title} onclick={() => act(task, 'restore')}><Icon name={pending.includes(task.id) ? 'refresh' : 'restore'} size={15} class={pending.includes(task.id) ? 'spin' : ''} />Восстановить</button>{#if !taskIsOccupied(task)}<button class="button text-button danger-hover" disabled={pending.includes(task.id)} aria-label={'Удалить: ' + task.title} onclick={() => askDeleteTask(task)}><Icon name="trash" size={15} />Удалить</button>{/if}</div><button class="icon-button" aria-label={'Открыть: ' + task.title} onclick={() => openTask(task)}><Icon name="chevron" size={17} /></button></div>{:else}<div class="list-empty"><Icon name="search" size={20} /><span>В архиве ничего не найдено</span></div>{/each}</div>
        {/if}
      {:else if page === 'workers'}
        <Workers {workers} loading={workersLoading} error={workersError} retry={() => { void loadWorkers(); }} onchange={workerChanged} ondelete={workerDeleted} {notify} {models} {modelsLoading} {modelsError} retryModels={() => { void loadModels(); }} />
      {:else}
      <section class="page-heading" aria-label="Управление задачами"><button class="button primary create-button" onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={17} />Новая задача</button></section>

      {#if info?.mode === 'mock'}
        <div class="mode-banner"><span class="mode-icon"><Icon name="spark" size={17} /></span><div><strong>Демонстрационный режим</strong><span>Запуски симулируются. Codex и Claude CLI не вызываются, файлы не изменяются.</span></div><span class="demo-badge">MOCK</span></div>
      {/if}
      {#if integrationChecksMissing}<div class="connection-error" role="status"><Icon name="alert" size={17} /><span>Запуски недоступны: задайте BRIGD_INTEGRATION_CHECKS.</span><button onclick={() => openSettings('autopilot')}>Настройки автопилота</button></div>{/if}
      {#if connectionError}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{connectionError}</span><button onclick={() => { void loadInfo(); void refresh(); }}>Повторить</button></div>{/if}

      <div class="toolbar">
        <div class="view-toggle" aria-label="Вид задач"><button class:selected={view === 'board'} aria-pressed={view === 'board'} onclick={() => view = 'board'}><Icon name="board" size={15} />Доска</button><button class:selected={view === 'list'} aria-pressed={view === 'list'} onclick={() => view = 'list'}><Icon name="list" size={16} />Список</button></div>
        <div class="toolbar-filters">
          <label class="search-box"><Icon name="search" size={16} /><input bind:value={search} type="search" placeholder="Найти задачу…" aria-label="Поиск задач" /></label>
          <label class="provider-filter"><Icon name="inbox" size={15} /><select value={scope} onchange={(event) => setScope(event.currentTarget.value as Scope)} aria-label="Фильтр задач"><option value="all">Все задачи</option><option value="attention">Требуют внимания</option><option value="scheduled">По расписанию</option><option value="autopilot">Автопилот</option><option value="completed">Завершённые</option></select><Icon name="down" size={13} /></label>
          <label class="provider-filter"><Icon name="sliders" size={15} /><select bind:value={provider} aria-label="Фильтр по агенту"><option value="all">Все агенты</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select><Icon name="down" size={13} /></label>
          <label class="provider-filter tag-filter"><Icon name="tag" size={15} /><select bind:value={tagFilter} aria-label="Фильтр по тегу" disabled={tagsLoading}><option value="all">Все теги</option><option value="untagged">Без тегов</option>{#each tags as tag (tag.id)}<option value={tag.id}>{tag.name}</option>{/each}</select><Icon name="down" size={13} /></label>
        </div>
      </div>
      {#if tagsError}<div class="connection-error" role="alert"><span>{tagsError}</span><button onclick={() => { void loadTags(); }}>Повторить загрузку тегов</button></div>{/if}

      {#if loading}
        <div class="board-grid skeleton-grid" aria-label="Загружаем задачи" aria-busy="true">{#each [1, 2, 3, 4] as column}<div class="skeleton-column"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-card"></div>{#if column < 3}<div class="skeleton skeleton-card short"></div>{/if}</div>{/each}</div>
      {:else if filtered.length === 0 && activeTasks.length > 0}
        <div class="no-results"><span class="empty-icon"><Icon name={scope === 'attention' && tagFilter === 'all' ? 'circlecheck' : 'search'} size={28} /></span><h2>{scope === 'attention' && !search && provider === 'all' && tagFilter === 'all' ? 'Всё под контролем' : 'Задачи не найдены'}</h2><p>{scope === 'attention' && !search && provider === 'all' && tagFilter === 'all' ? 'Сейчас нет задач, которым нужно ваше внимание.' : 'Попробуйте другой запрос или измените фильтры.'}</p><button class="button secondary" onclick={resetFilters}>Показать все задачи</button></div>
      {:else}
        {#if activeTasks.length === 0 && !connectionError}
          <section class="welcome-card"><div class="welcome-art" aria-hidden="true"><span class="art-orbit orbit-one"></span><span class="art-orbit orbit-two"></span><span class="art-mini art-code"><Icon name="code" size={19} /></span><span class="art-main"><BrigLogo size={39} /></span><span class="art-mini art-star">✳</span><span class="art-spark">✦</span></div><div class="welcome-copy"><h2>Освободите время для своих идей</h2><p>Поручите агенту проверить проект, собрать сводку или помочь с кодом.<br class="desktop-break" /> Запустите один раз или настройте регулярную работу.</p><button class="button primary" onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={16} />Создать первую задачу<Icon name="arrow" size={16} /></button></div><div class="welcome-steps"><div><span>1</span>Опишите задачу</div><div><span>2</span>Выберите агента</div><div><span>3</span>Следите за результатом</div></div></section>
        {/if}

        {#if view === 'board'}
          {#if problemTasks.length}
            <section class="problem-panel" aria-label="Проблемные задачи">
              <button class="problem-toggle" aria-expanded={showProblems} onclick={() => showProblems = !showProblems}><span class="problem-title"><span class="problem-icon"><Icon name="alert" size={16} /></span><strong>Проблемные задачи</strong><span class="problem-count" aria-label={'Задач: ' + problemTasks.length}>{problemTasks.length}</span><small>Ошибки, блокировки, конфликты слияния, прерванные и отменённые запуски</small></span><span class="problem-chevron"><Icon name={showProblems ? 'down' : 'chevron'} size={15} /></span></button>
              {#if showProblems}<div class="problem-grid">{#each problemTasks as task (task.id)}<div class="problem-card">{@render statusBadge(task.status)}{@render taskCard(task)}</div>{/each}</div>{/if}
            </section>
          {/if}
          <div class="board-grid" class:empty-board={activeTasks.length === 0}>
            {#each columnData as column}
              {@const items = filtered.filter(task => task.status === column.status || (column.status === 'ready' && task.status === 'queued') || (column.status === 'running' && ['preparing', 'cancelling', 'awaiting_merge', 'integrating'].includes(task.status)))}
              <section class="board-column column-{column.status}" aria-label={column.title}>
                <div class="column-heading"><span class="column-icon"><Icon name={column.icon} size={15} /></span><h2>{column.title}</h2><span class="column-count" aria-label={'Задач: ' + items.length}>{items.length}</span>{#if column.status === 'ready'}<button class="icon-button add-column" onclick={() => openEditor()} disabled={!info} aria-label="Добавить задачу"><Icon name="plus" size={16} /></button>{/if}</div>
                <div class="column-cards">{#each items as task (task.id)}{@render taskCard(task)}{:else}<div class="column-empty"><Icon name={column.icon} size={21} /><p>{column.empty}</p>{#if column.status === 'ready'}<button onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={12} />Добавить задачу</button>{/if}</div>{/each}</div>
              </section>
            {/each}
          </div>
        {:else}
          <div class="task-list"><div class="list-heading"><span>ЗАДАЧА</span><span>АГЕНТ</span><span>СТАТУС</span><span>ЗАПУСК</span><span></span></div>{#each filtered as task (task.id)}<div class="task-row"><button class="list-task-name" onclick={() => openTask(task)}><span class="list-task-icon"><Icon name={task.schedule === 'interval' ? 'clock' : task.schedule === 'auto' ? 'moon' : 'terminal'} size={17} /></span><span><strong>{task.title}</strong><small>{shortPath(task.cwd)}</small>{@render taskTags(task)}{#if task.latestRun?.followup}<small class="list-followup-label">Дополнительный запрос{#if followupStage(task.latestRun)} · Этап {followupStage(task.latestRun)!.index + 1}{/if}</small>{/if}{#if workflowSteps(task).length}<small class="list-workflow-progress">{workflowProgress(task)}</small>{/if}</span></button><div>{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}</div><div>{@render statusBadge(task.status)}</div><span class="list-schedule">{scheduleLabel(task, true)}</span><button class="icon-button" aria-label={'Открыть: ' + task.title} onclick={() => openTask(task)}><Icon name="chevron" size={17} /></button></div>{:else}<div class="list-empty"><Icon name="inbox" size={24} /><span>Новые задачи появятся здесь</span></div>{/each}</div>
        {/if}
      {/if}
      {/if}
    </div>
  </main>
</div>

<dialog class="task-drawer" bind:this={drawer} aria-labelledby="detail-title" oncancel={(event) => { event.preventDefault(); closeDrawer(); }} onclick={(event) => backdropClick(event, drawer, closeDrawer)}>
  <div class="drawer-content">
    <header class="drawer-topbar">
      <span class="drawer-task-ref"><Icon name="terminal" size={16} />Задача <span class="detail-ref">{selectedId?.slice(0, 8).toUpperCase()}</span></span>
      {#if selectedTask}<div class="drawer-badges">{@render statusBadge(selectedTask.status)}{#if currentRun?.followup}<span class="followup-type-badge">Дополнительный запрос</span>{/if}{#if currentRun?.reconcile}<span class="followup-type-badge">Разрешение конфликта</span>{/if}{#if visibleWorker(selectedTask)}{@render workerBadge(visibleWorker(selectedTask)!)}{:else}{@render providerBadge(visibleProvider(selectedTask), true)}{/if}{#if visibleUltracode(selectedTask)}<span class="ultracode-badge" title="Режим ultracode">ultracode</span>{/if}{#if selectedTask.latestRun?.mock}<span class="demo-badge">MOCK</span>{/if}{#if workflowSteps(selectedTask).length}<span class="workflow-type-badge">Сложная задача</span>{/if}</div>{/if}
      <button class="icon-button" aria-label="Закрыть задачу" disabled={followupSending || tagsSaving} onclick={closeDrawer}><Icon name="close" size={20} /></button>
    </header>
    {#if selectedTask}
      <div class="task-detail-layout">
      <section class="task-information" aria-label="Информация о задаче">
      <div class="drawer-heading">
        <h2 id="detail-title">{selectedTask.title}</h2><p class="detail-created">Создано {dateTime(selectedTask.createdAt)}</p>
        {#if selectedTask.nextRunAt && !selectedTask.paused && selectedTask.archivedAt === null}<p class="detail-next-run"><Icon name="clock" size={14} /><span>Следующий запуск {dateTime(selectedTask.nextRunAt)}</span></p>{/if}
        <div class="detail-actions">
          {#if selectedTask.archivedAt !== null}
            <button class="button primary" disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'restore')}><Icon name={taskBusy ? 'refresh' : 'restore'} size={15} class={taskBusy ? 'spin' : ''} />Восстановить</button>
            {#if !taskIsOccupied(selectedTask)}<button class="button secondary danger-hover" disabled={taskBusy || followupSending || tagsSaving} onclick={() => selectedTask && askDeleteTask(selectedTask)}><Icon name="trash" size={15} />Удалить</button>{/if}
          {:else}
          {#if canStartManual(selectedTask)}
            <button class="button primary" disabled={taskBusy || integrationChecksMissing} onclick={() => selectedTask && act(selectedTask, 'run')}><Icon name={taskBusy ? 'refresh' : 'play'} size={15} class={taskBusy ? 'spin' : ''} />{selectedTask.runCount ? selectedTask.steps?.length ? 'Начать всю задачу заново' : 'Повторить запуск' : 'Запустить'}</button>
          {:else if selectedTask.status === 'cancelling'}<button class="button secondary" disabled><Icon name="refresh" class="spin" size={15} />Останавливаем…</button>
          {:else if currentRun && currentRun.status !== 'completed' && taskIsOccupied(selectedTask)}<button class="button secondary danger-hover" disabled={taskBusy || (currentRun.status === 'interrupted' && !acknowledgeInterruption)} title={currentRun.status === 'interrupted' ? 'Сначала подтвердите ниже, что предыдущий процесс CLI остановлен' : undefined} onclick={() => selectedTask && act(selectedTask, 'cancel')}><Icon name="stop" size={14} />Отменить запуск</button>{/if}
          <button class="button secondary" disabled={taskBusy} onclick={() => selectedTask && openEditor(selectedTask)}><Icon name="edit" size={15} />Изменить</button>
          {#if !taskIsOccupied(selectedTask)}<button class="button secondary" disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'archive')}><Icon name="archive" size={15} />В архив</button><button class="button secondary danger-hover" disabled={taskBusy || followupSending || tagsSaving} onclick={() => selectedTask && askDeleteTask(selectedTask)}><Icon name="trash" size={15} />Удалить</button>{/if}
          {#if selectedTask.schedule !== 'manual'}{@const pauseLabel = selectedTask.schedule === 'auto' ? (selectedTask.paused ? 'Вернуть в очередь автопилота' : 'Отложить в автопилоте') : selectedTask.paused ? 'Возобновить расписание' : 'Приостановить расписание'}<button class="icon-button schedule-pause" title={pauseLabel} aria-label={pauseLabel} disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'pause')}><Icon name={selectedTask.paused ? 'play' : 'pause'} size={17} /></button>{/if}
          {/if}
        </div>
        {#if integrationChecksMissing}<p class="field-warning" role="status"><Icon name="alert" size={15} /><span>Чтобы запустить или продолжить процесс, задайте BRIGD_INTEGRATION_CHECKS в <button class="inline-link" onclick={() => openSettings('autopilot')}>настройках автопилота</button>.</span></p>{/if}
        {#if selectedTask.archivedAt !== null}<p class="archived-task-note"><Icon name="archive" size={16} /><span>В архиве с {dateTime(selectedTask.archivedAt)}. Задача не показывается на доске и не запускается по расписанию. Восстановите её, чтобы продолжить работу.</span></p>
        {:else if taskHasCompletedRun(selectedTask)}<p class="completed-task-help workflow-help">В этой карточке уже есть завершённый запуск. Дополнительные запросы отправляются агенту из обсуждения.{#if selectedTask.schedule === 'interval'} {selectedTask.paused ? 'Расписание остаётся на паузе.' : 'Автоматические запуски по расписанию продолжаются.'}{/if}</p>{/if}
        {#if selectedTask.archivedAt === null && selectedTask.steps?.length && selectedTask.runCount && canStartManual(selectedTask)}<p class="workflow-help">Новый запуск выполнит все этапы с начала по сохранённому плану. История предыдущих запусков останется.</p>{/if}
      </div>
      {#if selectedTask.status === 'cancelling'}<div class="cancelling-note" role="status"><Icon name="refresh" size={16} class="spin" /><span>Ожидаем завершения процесса агента и его дочерних процессов. {taskHasCompletedRun(selectedTask) ? 'После остановки можно отправить дополнительный запрос в завершённую сессию.' : 'Новый запуск станет доступен после остановки.'} Уже выполненные действия не откатываются.</span></div>{/if}
      {#if toast}<div class="drawer-notice {toast.type}" role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'error' ? 'alert' : 'circlecheck'} size={16} /><span>{toast.text}</span><button class="icon-button" aria-label="Закрыть уведомление" onclick={() => toast = null}><Icon name="close" size={14} /></button></div>{/if}
      {#if detailError}<div class="detail-error" role="alert">{detailError}</div>{/if}
      <section class="task-tag-section" aria-label="Теги задачи">
        <div class="task-tag-heading"><h3><Icon name="tag" size={14} />Теги</h3>{#if selectedTask.archivedAt === null && !editingTags}<button class="tag-edit-button" data-edit-task-tags disabled={taskBusy} onclick={() => selectedTask && openTaskTags(selectedTask)}><Icon name="edit" size={13} />Изменить теги</button>{/if}</div>
        {#if editingTags && selectedTask.archivedAt === null}
          <TagPicker {tags} bind:selected={taskTagIds} disabled={tagsSaving} loading={tagsLoading} error={tagsError} onreload={loadTags} />
          {#if taskTagsError}<p class="tag-save-error" role="alert">{taskTagsError}</p>{/if}
          <div class="task-tag-actions"><button type="button" class="button secondary" disabled={tagsSaving} onclick={closeTaskTags}>Отмена</button><button type="button" class="button primary" disabled={taskBusy || tagsLoading} onclick={() => selectedTask && saveTaskTags(selectedTask)}>{#if tagsSaving}<Icon name="refresh" size={14} class="spin" />{/if}{tagsSaving ? 'Сохраняем…' : 'Сохранить теги'}</button></div>
        {:else if selectedTask.tags?.length}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable regions need keyboard focus for native scrolling.) -->
          <div class="assigned-task-tags" role="region" aria-label="Назначенные теги" tabindex="0">{@render taskTags(selectedTask)}</div>
        {:else}<p class="task-tags-empty">Теги не назначены</p>{/if}
      </section>
      <section class="instruction-section"><h3>{selectedTask.steps?.length ? 'ОБЩАЯ ЦЕЛЬ ЗАДАЧИ' : 'ЗАДАНИЕ ДЛЯ АГЕНТА'}</h3><p>{selectedTask.instruction}</p></section>
      {#if selectedTask.attachments?.some(file => file.source === 'user')}<section class="task-attachments" aria-label="Файлы задачи"><h3>Файлы задачи</h3><AttachmentList attachments={selectedTask.attachments.filter(file => file.source === 'user')} taskId={selectedTask.id} author={attachmentAuthor} /></section>{/if}
      {#if detail?.attachments?.some(file => file.source === 'agent' && !file.commentId)}<section class="task-attachments" aria-label="Файлы агента"><h3>Файлы агента</h3><AttachmentList attachments={detail.attachments.filter(file => file.source === 'agent' && !file.commentId)} taskId={selectedTask.id} author={attachmentAuthor} /></section>{/if}
      {#if currentRun?.followup}
        <section class="current-followup" aria-label="Дополнительный запрос">
          <div class="followup-heading"><h3>Дополнительный запрос</h3>{@render statusBadge(currentRun.status)}</div>
          <p class="followup-stage">{currentRun.worker?.name ?? providerName(currentRun.provider)}{#if followupStage(currentRun)} · Этап {followupStage(currentRun)!.index + 1}: {followupStage(currentRun)!.title}{/if}</p>
          <p class="followup-request">{currentRun.followup.request || 'Запрос с вложениями'}</p>
          <p class="workflow-help">Продолжение сохранённой сессии. Остальные этапы не запускаются.</p>
        </section>
        {#if currentRun.followup.workflow?.steps.length}<div class="current-workflow"><WorkflowChecklist run={currentRun} historical /></div>{/if}
      {:else if currentRun?.reconcile}
        <section class="current-followup" aria-label="Разрешение конфликта">
          <div class="followup-heading"><h3>Разрешение конфликта слияния</h3>{@render statusBadge(currentRun.status)}</div>
          <p class="followup-stage">{currentRun.worker?.name ?? 'Интегратор'} · целевая ветка {currentRun.reconcile.targetBranch}{#if currentRun.reconcile.depth > 1} · попытка {currentRun.reconcile.depth}{/if}</p>
          {#if currentRun.reconcile.conflicts.length}<p class="followup-request">{currentRun.reconcile.conflicts.join('\n')}</p>{/if}
          <p class="workflow-help">Целевая ветка объединена в worktree задачи. Интегратор разрешает конфликты в файлах, затем brigd создаёт merge-коммит и заново проверяет результат.</p>
        </section>
      {:else if currentRun?.steps?.length}<div class="current-workflow"><WorkflowChecklist run={currentRun} /></div>{/if}
      {#if selectedTask.steps?.length}
        <details class="workflow-template" open={!currentRun}><summary>{currentRun && selectedTask.schedule === 'interval' ? 'План следующего запуска по расписанию' : 'План задачи'}</summary><p class="workflow-help">Все работники используют общую рабочую папку, цель задачи и общие инструкции. Этапы идут по порядку.</p><ol>{#each selectedTask.steps as step}{@const worker = workers.find(worker => worker.id === step.workerId)}<li><strong>{step.title}</strong><div class="workflow-template-worker">{#if worker}<WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={36} /><span>{worker.name}{#if worker.description?.trim()}<small class="worker-description">{worker.description}</small>{/if}</span>{:else}<span>Работник недоступен</span>{/if}</div><p>{step.instruction}</p></li>{/each}</ol></details>
      {/if}
      {#if currentRun}<div class="current-run-instructions">{@render instructionSnapshot(currentRun)}</div>{/if}
      {#if currentRun}{@render workspaceNote(currentRun)}{/if}
      {#if currentRun?.integration}<IntegrationPanel integration={currentRun.integration} busy={taskBusy} launchBlocked={integrationChecksMissing} historical={selectedTask.archivedAt !== null} onaction={(action, acknowledgement) => integrationAction(currentRun!.id, action, acknowledgement)} />
      {:else if currentRun?.reconcile && !activeStatuses.includes(currentRun.status) && sourceIntegration}<IntegrationPanel integration={sourceIntegration} busy={taskBusy} launchBlocked={integrationChecksMissing} historical={selectedTask.archivedAt !== null} onaction={(action, acknowledgement) => integrationAction(currentRun!.reconcile!.sourceRunId, action, acknowledgement)} />{/if}
      {#if currentRun?.error}<div class="run-error"><Icon name="alert" size={17} /><div><strong>{labels[currentRun.status]}</strong><p>{currentRun.error}</p></div></div>{/if}
      {#if currentRun?.status === 'interrupted' && !currentRun.sessionId && !currentRun.steps?.length}<div class="resume-warning">Идентификатор сессии не сохранён. {taskHasCompletedRun(selectedTask) ? 'Продолжение недоступно. Для работы в новой сессии создайте отдельную задачу.' : 'Продолжение недоступно; отмените запуск, чтобы начать заново.'}</div><label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>Я проверил(а), что предыдущий процесс CLI остановлен</span></label>{/if}
      {#if currentRun?.status === 'interrupted' && currentRun.steps?.slice((currentRun.currentStepIndex ?? -1) + 1).some(step => step.status === 'cancelled')}<div class="cancelling-note" role="status"><Icon name="alert" size={16} /><span>Отмена уже запрошена. Продолжение касается только текущего этапа; остальные этапы отменены.</span></div>{/if}
      {#if runCanRetry && currentStep}
        <section class="workflow-retry-panel" aria-label="Повтор текущего этапа">
          <h3><Icon name="alert" size={18} />{interruptedWithoutSession ? 'Сессия прерванного этапа не сохранена' : 'Текущий этап остановлен'}</h3>
          <p class="current-step-context">Этап {(currentRun?.currentStepIndex ?? 0) + 1}: {currentStep.title} · {currentStep.worker.name}{#if currentStep.worker.description?.trim()}<small class="worker-description">{currentStep.worker.description}</small>{/if}</p>
          {#if interruptedWithoutSession}<p>После сбоя прежний процесс CLI мог остаться запущенным. Остановите его и подтвердите это перед повтором или отменой запуска.</p>{/if}
          <p>Повтор создаст новую сессию только для этого этапа. Завершённые этапы и сохранённые настройки останутся. Уже выполненные действия и изменения файлов не откатываются и могут повториться.</p>
          {#if currentRun?.status === 'blocked'}<p>Устраните причину блокировки перед повтором. Эта кнопка не предоставляет агенту дополнительных разрешений.</p>{/if}
          {#if !taskHasCompletedRun(selectedTask)}<p>Чтобы начать всю последовательность с первого этапа, сначала отмените этот запуск.</p>{/if}
          {#if interruptedWithoutSession}<label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>Я проверил(а), что предыдущий процесс CLI остановлен</span></label>{/if}
          <button class="button primary" disabled={taskBusy || integrationChecksMissing || (interruptedWithoutSession && !acknowledgeInterruption)} onclick={() => selectedTask && act(selectedTask, 'retry')}><Icon name="refresh" size={15} />{taskBusy ? 'Запускаем…' : 'Повторить текущий этап'}</button>
        </section>
      {/if}
      </section>
      <section class="task-activity" aria-label="Комментарии и логи задачи">
      <div class="detail-tabs" role="tablist" aria-label="История задачи">
        <button id="conversation-tab" role="tab" tabindex={detailTab === 'conversation' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'conversation'} aria-controls="conversation-panel" class:active={detailTab === 'conversation'} onclick={() => detailTab = 'conversation'}><Icon name="message" size={15} />Комментарии{#if currentRun?.status === 'waiting_input'}<span class="tab-attention" aria-label="Нужен ответ">!</span>{/if}</button>
        <button id="logs-tab" role="tab" tabindex={detailTab === 'logs' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'logs'} aria-controls="logs-panel" class:active={detailTab === 'logs'} onclick={() => detailTab = 'logs'}><Icon name="terminal" size={15} />Логи</button>
        <button id="changes-tab" role="tab" tabindex={detailTab === 'changes' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'changes'} aria-controls="changes-panel" class:active={detailTab === 'changes'} onclick={() => detailTab = 'changes'}><Icon name="code" size={15} />Изменения</button>
        <button id="history-tab" role="tab" tabindex={detailTab === 'history' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'history'} aria-controls="history-panel" class:active={detailTab === 'history'} onclick={() => detailTab = 'history'}><Icon name="history" size={15} />Запуски</button>
      </div>
      {#if !detail}<div class="detail-loading"><Icon name="refresh" class="spin" size={19} />Загружаем историю…</div>{:else if detailTab === 'conversation'}
        <div id="conversation-panel" tabindex="0" role="tabpanel" aria-labelledby="conversation-tab" class="conversation-panel">{#each activity.comments as entry (entry.id)}<article class="comment-entry comment-{entry.kind}">{#if commentWorker(entry)}<WorkerAvatar name={commentWorker(entry)!.name} avatarUrl={commentWorker(entry)!.avatarUrl} size={40} />{:else}<span class="comment-avatar">{#if entry.kind === 'user'}Я{:else if entry.kind === 'system'}<Icon name="terminal" size={14} />{:else if entry.kind === 'question'}<Icon name="message" size={14} />{:else}<Icon name="spark" size={14} />{/if}</span>{/if}<div class="comment-main"><div class="comment-meta"><span class="comment-author"><strong>{commentAuthor(entry)}</strong>{#if commentWorker(entry)?.description?.trim()}<small class="worker-description">{commentWorker(entry)!.description}</small>{/if}</span>{#if commentRun(entry)?.followup}<span class="comment-step-label">Дополнительный запрос{#if followupStage(commentRun(entry)!)} · Этап {followupStage(commentRun(entry)!)!.index + 1}{/if}</span>{:else if entry.stepIndex != null}<span class="comment-step-label">Этап {entry.stepIndex + 1}</span>{/if}<time datetime={new Date(entry.createdAt).toISOString()}>{dateTime(entry.createdAt)}</time></div>{#if entry.body}<CommentBody body={entry.body} />{/if}<AttachmentList attachments={entry.attachments ?? []} taskId={selectedTask.id} label="Вложения сообщения" author={attachmentAuthor} /></div></article>{:else}<div class="conversation-empty"><Icon name="message" size={25} /><strong>У каждой задачи своя история</strong><p>Здесь появятся сообщения агента, вопросы и результат.{#if selectedTask.archivedAt === null}<br />Можно оставить заметку уже сейчас.{/if}</p></div>{/each}</div>
      {:else if detailTab === 'logs'}
        <div id="logs-panel" tabindex="0" role="tabpanel" aria-labelledby="logs-tab" class="logs-panel"><TaskLogs logs={activity.logs} runs={detail.runs} taskId={selectedTask.id} author={attachmentAuthor} /></div>
      {:else if detailTab === 'changes'}
        <div id="changes-panel" tabindex="0" role="tabpanel" aria-labelledby="changes-tab" class="changes-panel">{#key selectedTask.id}<CodeDiff runs={detail.runs} />{/key}</div>
      {:else}
        <div id="history-panel" tabindex="0" role="tabpanel" aria-labelledby="history-tab" class="history-panel">{#each detail.runs as run (run.id)}<article class="run-entry"><div class="run-heading"><span class="run-number"><Icon name={run.followup ? "message" : run.reconcile ? "refresh" : "play"} size={14} />{run.followup ? "Дополнительный запрос" : run.reconcile ? "Разрешение конфликта" : "Запуск"} {run.id.slice(0, 6)}</span>{@render statusBadge(run.status)}</div><div class="run-meta">{#if run.worker}{@render workerBadge(run.worker, true)}{:else}{@render providerBadge(run.provider, true)}{/if}<span>·</span><span>{dateTime(run.startedAt)}</span><span>·</span><span>{run.trigger === 'followup' ? 'Из обсуждения' : run.trigger === 'reconcile' ? 'Конфликт слияния' : run.trigger === 'schedule' ? 'По расписанию' : run.trigger === 'autopilot' ? 'Автопилот' : 'Вручную'}</span><span>·</span><span>{elapsed(run)}</span>{#if run.mock}<span class="demo-badge">MOCK</span>{/if}</div>{#if run.followup}<div class="run-followup-request"><strong>Запрос{#if followupStage(run)} · Этап {followupStage(run)!.index + 1}: {followupStage(run)!.title}{/if}</strong><p>{run.followup.request || 'Запрос с вложениями'}</p></div>{:else if run.reconcile}<div class="run-followup-request"><strong>Целевая ветка: {run.reconcile.targetBranch}</strong>{#if run.reconcile.conflicts.length}<ul class="integration-conflicts">{#each run.reconcile.conflicts as path}<li><code>{path}</code></li>{/each}</ul>{/if}</div>{/if}{#if run.reconcile}<div class="run-followup-request"><strong>Целевая ветка {run.reconcile.targetBranch}{#if run.reconcile.depth > 1} · попытка {run.reconcile.depth}{/if}</strong>{#if run.reconcile.conflicts.length}<p>{run.reconcile.conflicts.join('\n')}</p>{/if}</div>{/if}{#if run.summary}<p>{run.summary}</p>{/if}{#if run.error}<p class="run-history-error">{run.error}</p>{/if}{#if run.steps?.length}<WorkflowChecklist {run} />{:else if run.followup?.workflow?.steps.length}<WorkflowChecklist {run} historical />{/if}{@render instructionSnapshot(run)}{@render workspaceNote(run)}{#if run.integration}<IntegrationPanel integration={run.integration} historical />{/if}<div class="run-details">Ход {run.turn}{#if run.worker}<span> · Усилия: {effortLabel(run.worker.effort)}</span>{/if}{#if runUltracode(run)}<span> · ultracode</span>{/if}{#if run.sessionId}<span title={run.sessionId}> · Сессия {run.sessionId.slice(0, 14)}…</span>{/if}</div></article>{:else}<div class="conversation-empty"><Icon name="history" size={25} /><strong>Запусков пока нет</strong><p>Запустите задачу, чтобы увидеть её историю.</p></div>{/each}</div>
      {/if}
      {#if runCanResume && !interruptedWithoutSession}
        <form class="resume-panel" hidden={detailTab !== 'conversation'} onpaste={(event) => answerComposer?.handlePaste(event)} onsubmit={(event) => { event.preventDefault(); if (selectedTask && (answer.trim() || answerAttachmentCount || currentRun?.status === 'interrupted')) void act(selectedTask, 'resume', answer); }}>
          <div class="resume-title"><Icon name={currentRun?.status === 'interrupted' ? 'alert' : 'message'} size={18} /><strong>{currentRun?.status === 'interrupted' ? 'Запуск был прерван' : 'Агенту нужен ваш ответ'}</strong></div>
          {#if currentStep}<p class="current-step-context">Этап {(currentRun?.currentStepIndex ?? 0) + 1}: {currentStep.title} · {currentStep.worker.name}{#if currentStep.worker.description?.trim()}<small class="worker-description">{currentStep.worker.description}</small>{/if}</p>{/if}
          <p>{currentRun?.status === 'interrupted' ? 'Прежний процесс CLI мог остаться запущенным после сбоя. Остановите его перед продолжением. Уже выполненные действия и изменения файлов не откатываются.' : currentStep ? 'Ответ получит работник текущего этапа в той же сессии. Следующие этапы ждут его завершения.' : 'Ответ будет передан агенту в ту же сессию, и работа продолжится.'}</p>
            {#if currentRun?.status === 'interrupted'}<label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>Я проверил(а), что предыдущий процесс CLI остановлен</span></label>{/if}
          {#if !currentRun?.sessionId && (!currentRun?.mock || currentRun?.followup)}<div class="resume-warning">Идентификатор сессии не сохранён. {taskHasCompletedRun(selectedTask) ? 'Продолжение недоступно. Для работы в новой сессии создайте отдельную задачу.' : 'Продолжение недоступно; отмените запуск, чтобы начать заново.'}</div>
          {:else}<label class="sr-only" for="resume-answer">Ответ агенту</label><textarea id="resume-answer" bind:value={answer} maxlength="8000" rows="3" placeholder={currentRun?.status === 'interrupted' ? 'Что учесть при продолжении? (необязательно)' : 'Напишите ответ или уточнение…'} required={currentRun?.status === 'waiting_input' && !answerAttachmentCount} disabled={taskBusy}></textarea>
            {#key `${drawerContext}:${inputRunKey}`}<AttachmentComposer bind:this={answerComposer} label="Файлы ответа" disabled={taskBusy} bind:count={answerAttachmentCount} bind:uploading={answerUploading} bind:invalid={answerAttachmentInvalid} />{/key}
            <button class="button primary" type="submit" disabled={taskBusy || integrationChecksMissing || answerUploading || answerAttachmentInvalid || (currentRun?.status === 'waiting_input' && !answer.trim() && !answerAttachmentCount) || (currentRun?.status === 'interrupted' && !acknowledgeInterruption)}><Icon name="arrow" size={15} />{taskBusy ? 'Отправляем…' : 'Продолжить работу'}</button>
          {/if}
        </form>
      {/if}
      {#if detail && selectedTask.archivedAt !== null}<p class="archived-comment-note" hidden={detailTab !== 'conversation'}><Icon name="archive" size={15} />Задача в архиве. Восстановите её, чтобы оставить заметку или отправить агенту дополнительный запрос.</p>
      {:else if detail}<form class="comment-form" hidden={detailTab !== 'conversation'} onpaste={(event) => commentComposer?.handlePaste(event)} onsubmit={sendComment}>
        <label for="task-comment">Заметка к задаче</label>
        {#key drawerContext}<AttachmentComposer compact bind:this={commentComposer} label="Файлы заметки" disabled={taskBusy} bind:count={commentAttachmentCount} bind:uploading={commentUploading} bind:invalid={commentAttachmentInvalid} bind:attachmentIds={commentAttachmentIds}>
          <textarea id="task-comment" bind:value={comment} maxlength="8000" placeholder="Добавьте заметку или новое задание агенту…" rows="3" disabled={taskBusy}></textarea>
          {#snippet footer(attachFiles)}
            {#if followupError}<div class="followup-error" role="alert"><p>{followupError}</p>{#if retryingFollowup}<p>Текст и файлы сохранены. Повторная отправка этого же запроса защищена от дублирования.</p>{/if}</div>{/if}
            <div class="comment-actions">
              {@render attachFiles()}
              <button class="button secondary" type="submit" title={`Сохранить текст и файлы в истории задачи без запуска агента.${runCanResume ? ' Для ответа на текущий вопрос используйте «Продолжить работу» выше.' : ''}`} disabled={(!comment.trim() && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid}><Icon name="check" size={16} />Сохранить заметку</button>
              {#if recipientOptions.length}
                <div class="followup-send-actions" class:has-picker={recipientOptions.length > 1 || !followupTarget}>
                  <button class="button primary" type="button" title={followupBlocked || `Отправить текст и файлы в сессию: ${recipientLabel(followupTarget!)}. Агент продолжит работу с прежними настройками. Остальные этапы не запускаются.`} onclick={() => void sendFollowup()} disabled={(!comment.trim() && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid || !!followupBlocked}><Icon name={followupSending ? 'refresh' : 'send'} class={followupSending ? 'spin' : ''} size={16} />{followupSending ? 'Отправляем…' : 'Отправить агенту'}</button>
                  {#if recipientOptions.length > 1 || !followupTarget}
                    <details class="followup-session-picker" bind:open={followupRecipientOpen}>
                      <summary class="button primary" aria-label="Выбрать сессию агента" aria-disabled={taskBusy} title="Выбрать завершённую сессию" onclick={(event) => { if (taskBusy) event.preventDefault(); }}><Icon name="down" size={16} /></summary>
                      <div class="followup-session-menu">
                        <label for="followup-recipient">Получатель дополнительного запроса</label>
                        <select id="followup-recipient" value={followupTarget?.key ?? ''} disabled={taskBusy} onchange={(event) => { followupTargetKey = event.currentTarget.value; followupError = ''; followupRecipientOpen = false; drawer.querySelector<HTMLElement>('.followup-session-picker summary')?.focus(); }}>
                          {#if !followupTarget}<option value="" disabled>Выберите завершённую сессию</option>{/if}
                          {#each recipientOptions as target (target.key)}<option value={target.key}>{recipientLabel(target)}</option>{/each}
                        </select>
                      </div>
                    </details>
                  {/if}
                </div>
              {/if}
            </div>
          {/snippet}
        </AttachmentComposer>{/key}
      </form>{/if}
      </section>
      </div>
    {:else}<div class="detail-loading"><Icon name="refresh" class="spin" />Загружаем задачу…</div>{/if}
  </div>
</dialog>

<dialog bind:this={deleteDialog} class="editor-dialog instruction-delete-dialog" aria-labelledby="task-delete-title" aria-describedby="task-delete-description" oncancel={(event) => { event.preventDefault(); closeDelete(); }} onclick={(event) => backdropClick(event, deleteDialog, closeDelete)}>
  {#if deleting}
    <form class="editor-form" onsubmit={confirmDelete} aria-busy={removing}>
      <header class="editor-header"><h2 id="task-delete-title">{deleting.kind === 'task' ? 'Удалить задачу навсегда?' : 'Удалить все задачи из архива?'}</h2><button type="button" class="icon-button" aria-label="Закрыть удаление" disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}
        <p id="task-delete-description">{#if deleting.kind === 'task'}«{deleting.task.title}» будет удалена{:else}{deleting.count} {plural(deleting.count, 'задача будет удалена', 'задачи будут удалены', 'задач будут удалены')}{/if} без возможности восстановления вместе с историей запусков, обсуждением, логами и файлами. Рабочие папки запусков освободит очистка в Настройки → Хранилище; ветки Git в проекте не удаляются.</p>
      </div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>Отмена</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? 'Удаляем…' : deleting.kind === 'task' ? 'Удалить навсегда' : 'Удалить все'}</button></footer>
    </form>
  {/if}
</dialog>

<dialog class="settings-dialog" bind:this={settings} aria-labelledby="settings-title" oncancel={(event) => { event.preventDefault(); closeSettings(); }} onclick={(event) => backdropClick(event, settings, closeSettings)}>
  <div class="settings-frame">
    <header class="settings-header"><h2 id="settings-title">Настройки</h2><button class="icon-button" aria-label="Закрыть настройки" disabled={settingsMutationPending} onclick={closeSettings}><Icon name="close" size={21} /></button></header>
    <div class="settings-layout">
      <div class="settings-nav" role="tablist" aria-label="Разделы настроек" aria-orientation="vertical">
        {#each settingsSections as section (section.id)}
          <button id="settings-{section.id}-tab" role="tab" tabindex={settingsSection === section.id ? 0 : -1} onkeydown={settingsTabKey} aria-selected={settingsSection === section.id} aria-controls="settings-{section.id}-panel" class:active={settingsSection === section.id} onclick={() => settingsSection = section.id}><Icon name={section.icon} size={17} /><span>{section.label}</span></button>
        {/each}
      </div>
      <!-- Inactive panels stay mounted so unsaved drafts survive switching sections. -->
      <div id="settings-general-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-general-tab" hidden={settingsSection !== 'general'}>
        {#if settingsOpen}<GeneralSettings settings={generalSettings} loading={generalSettingsLoading} error={generalSettingsError} retry={() => { void loadGeneralSettings(); }} onchange={generalSettingsChanged} onmutation={generalSettingsMutationStarted} {workers} bind:busy={generalSettingsMutationPending} />{/if}
      </div>
      <div id="settings-appearance-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-appearance-tab" hidden={settingsSection !== 'appearance'}>
        <fieldset class="theme-settings">
          <legend>Цветовая схема</legend>
          <p id="theme-description">Выбор сохраняется в этом браузере.</p>
          {#each themeGroups as group (group.scheme)}
            <h3 class="theme-group-title">{group.label}</h3>
            <div class="theme-options">
              {#each themes.filter(option => option.colorScheme === group.scheme) as option (option.id)}
                <label class="theme-option" class:selected={theme === option.id}>
                  <input type="radio" name="theme" value={option.id} checked={theme === option.id} onchange={() => selectTheme(option.id)} aria-label={option.label} aria-describedby="theme-description" />
                  <span class="theme-preview" aria-hidden="true">{#each option.preview as color}<span style:background={color}></span>{/each}</span>
                  <span class="theme-name">{option.label}</span>
                </label>
              {/each}
            </div>
          {/each}
        </fieldset>
        {#if themeSaveError}<p class="settings-warning" role="status">Тема изменена, но браузер не разрешил сохранить выбор. После перезагрузки выберите тему снова.</p>{/if}
      </div>
      <div id="settings-models-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-models-tab" hidden={settingsSection !== 'models'}>
        {#if settingsOpen}<ModelSettings {models} loading={modelsLoading} error={modelsError} retry={() => { void loadModels(); }} onchange={modelChanged} ondelete={modelDeleted} bind:busy={modelMutationPending} />{/if}
      </div>
      <div id="settings-permissions-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-permissions-tab" hidden={settingsSection !== 'permissions'}>
        {#if settingsOpen}<CliSetup />{/if}
      </div>
      <div id="settings-autopilot-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-autopilot-tab" hidden={settingsSection !== 'autopilot'}>
        {#if settingsOpen}<AutopilotSettings settings={autopilotSettings} loading={autopilotSettingsLoading} error={autopilotSettingsError} retry={() => { void loadAutopilotSettings(); }} onchange={autopilotSettingsChanged} onmutation={autopilotSettingsMutationStarted} bind:busy={autopilotSettingsMutationPending} />{/if}
      </div>
      <div id="settings-concurrency-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-concurrency-tab" hidden={settingsSection !== 'concurrency'}>
        {#if settingsOpen}<ConcurrencySettings active={settingsSection === 'concurrency'} bind:busy={concurrencyMutationPending} />{/if}
      </div>
      <div id="settings-storage-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-storage-tab" hidden={settingsSection !== 'storage'}>
        {#if settingsOpen}<StorageSettings active={settingsSection === 'storage'} bind:busy={storageMutationPending} />{/if}
      </div>
      <div id="settings-backups-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-backups-tab" hidden={settingsSection !== 'backups'}>
        {#if settingsOpen}<Backups active={settingsSection === 'backups'} bind:busy={backupsMutationPending} />{/if}
      </div>
    </div>
  </div>
</dialog>

<dialog class="editor-dialog" bind:this={editor} aria-labelledby="editor-title" oncancel={(event) => { event.preventDefault(); closeEditor(); }} onclick={(event) => backdropClick(event, editor, closeEditor)}>
  {#if editorOpen}
    <form onsubmit={saveTask} class="editor-form" onpaste={(event) => formComposer?.handlePaste(event)}>
      <header class="editor-header"><div><h2 id="editor-title">{editingId ? 'Редактировать задачу' : 'Новая задача'}</h2></div><button class="icon-button" type="button" aria-label="Закрыть форму" disabled={submitting} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} />{formError}</div>{/if}
        {#if editingId && selectedTask && taskIsOccupied(selectedTask)}<div class="form-note">Изменения применятся к следующему запуску. Текущий запуск сохраняет план этапов, работников, настройки, инструкции и рабочую папку. Для повтора этапа используется сохранённый план.</div>{/if}
        <label class="form-field"><span>Название задачи <span class="required">*</span></span><input bind:value={formTitle} name="title" placeholder="Например, проверить новые изменения" required maxlength="140" disabled={submitting} /></label>
        <TagPicker {tags} bind:selected={formTagIds} disabled={submitting} loading={tagsLoading} error={tagsError} onreload={loadTags} />
        <div class="task-type-switch" role="group" aria-label="Тип задачи"><button type="button" class:selected={!formComplex} aria-pressed={!formComplex} disabled={submitting} onclick={() => formComplex = false}>Простая задача</button><button type="button" class:selected={formComplex} aria-pressed={formComplex} disabled={submitting} onclick={() => formComplex = true}>Сложная задача</button></div>
        {#if formComplex}<p class="workflow-help">Одна общая цель, несколько работников по очереди. Порядок и задания можно изменить до запуска.</p>{/if}
        <label class="form-field"><span>{formComplex ? 'Общая цель и ограничения' : 'Что нужно сделать?'} <span class="required">*</span></span><textarea bind:value={formInstruction} name="instruction" maxlength="16000" rows="4" placeholder="Опишите результат, важные детали и ограничения. Агент получит эту инструкцию при каждом запуске." required disabled={submitting}></textarea></label>
        {#key editorContext}<AttachmentComposer bind:this={formComposer} initial={formAttachments} label="Файлы задачи" disabled={submitting} bind:count={formAttachmentCount} bind:uploading={formUploading} bind:invalid={formAttachmentInvalid} />{/key}
        {#if !formComplex}
        <label class="form-field"><span>Работник</span><select name="workerId" aria-label="Работник" bind:value={formWorkerId} onchange={() => { formUltracode = null; }} disabled={submitting || workersLoading}><option value="">Без работника — выбрать провайдера вручную</option>{#each workers.filter(worker => !worker.archived || worker.id === formOriginalWorker?.id) as worker (worker.id)}<option value={worker.id}>{worker.name} · {providerName(worker.provider)}{worker.archived ? ' (в архиве)' : ''}</option>{/each}{#if formOriginalWorker && !workers.some(worker => worker.id === formOriginalWorker?.id)}<option value={formOriginalWorker.id}>{formOriginalWorker.name}{formOriginalWorker.archived ? ' (в архиве)' : ''}</option>{/if}</select><small>Профили можно создать и настроить в разделе «Работники».</small></label>
        {#if formWorker}
          <div class="worker-assignment">{@render workerBadge(formWorker)}<div class="worker-assignment-meta"><span>Усилия: {effortLabel(formWorker.effort)}</span></div></div>
          {#if formWorker.archived}<p class="field-warning"><Icon name="inbox" size={15} />Работник в архиве. Можно сохранить это назначение, выбрать другого или убрать работника. Для новых назначений сначала восстановите профиль.</p>{/if}
        {:else}
        <fieldset class="provider-options"><legend>Агент</legend>{#each ['codex', 'claude'] as agent}<label class:selected={formProvider === agent}><input type="radio" bind:group={formProvider} value={agent} disabled={submitting} /><span class="agent-option-logo {agent}">{#if agent === 'codex'}<Icon name="code" size={20} />{:else}<span class="claude-mark">✳</span>{/if}</span><span><strong>{providerName(agent as Provider)}</strong><small>{info?.mode === 'mock' ? 'Демо-адаптер' : info?.providers.find(p => p.id === agent)?.available ? 'CLI доступен' : 'CLI не найден'}</small></span><span class="radio-indicator">{#if formProvider === agent}<span></span>{/if}</span></label>{/each}</fieldset>
        {/if}
        {#if info?.mode === 'cli' && !providerAvailable}<p class="field-warning"><Icon name="alert" size={14} />CLI выбранного агента не найден. Задачу можно сохранить, но для запуска потребуется установить и авторизовать CLI.</p>{/if}
        {:else}<WorkflowEditor bind:steps={formSteps} {workers} originalWorkerIds={formOriginalStepWorkers} disabled={submitting} loading={workersLoading} onworkerchange={() => { formUltracode = null; }} unavailableProviders={info?.mode === 'cli' ? info.providers.filter(provider => !provider.available).map(provider => provider.id) : []} />{/if}
        <div class="form-field"><label class="task-ultracode-option"><input name="ultracode" type="checkbox" checked={formUltracodeChecked} indeterminate={formUltracodeMixed} aria-describedby="task-ultracode-help" disabled={submitting} onchange={(event) => { formUltracode = event.currentTarget.checked; }} /><span>ultracode</span></label><small id="task-ultracode-help">{#if formUltracode === null}{#if formComplex}{formUltracodeMixed ? 'Сейчас как в профилях работников: у части этапов режим ultracode включён, у остальных нет.' : formProfileUltracode.length ? `Как в профилях работников этапов: режим ultracode ${formUltracodeChecked ? 'включён' : 'выключен'}.` : 'Как в профилях работников этапов.'}{:else if formWorker}Как в профиле работника: режим ultracode {formUltracodeChecked ? 'включён' : 'выключен'}.{:else}Без работника режим ultracode определяют настройки установленного CLI. Поставьте галочку, чтобы включить режим для этой задачи, или поставьте и снимите её, чтобы явно выключить.{/if}{#if formComplex || formWorker}{' '}Поставьте или снимите галочку, чтобы задать режим для этой задачи.{/if}{:else}Задано для этой задачи: режим ultracode {formUltracodeChecked ? 'включён' : 'выключен'}{formComplex ? ' на всех этапах' : ''}, независимо от {formComplex || formWorker ? 'профиля работника' : 'настроек CLI'}. <button type="button" class="inline-link" disabled={submitting} onclick={() => { formUltracode = null; }}>{formComplex ? 'Вернуть как в профилях работников' : formWorker ? 'Вернуть как в профиле работника' : 'Вернуть настройку CLI'}</button>{/if} Нужна поддержка режима установленным CLI.</small></div>
        {#if workersError}<div class="field-warning"><span>Не удалось обновить список работников.{!formComplex ? ' Можно выбрать модель вручную.' : ' Проверьте подключения и повторите загрузку.'}</span><button type="button" onclick={() => { void loadWorkers(); }}>Повторить</button></div>{/if}
        <label class="form-field"><span>Рабочая папка <span class="required">*</span></span><div class="input-with-icon"><Icon name="folder" size={16} /><input bind:value={formCwd} name="cwd" maxlength="4096" placeholder="/workspace/projects/my-project" required disabled={submitting} spellcheck="false" /></div><small>{formComplex ? 'Одна общая папка для всех этапов. Следующий работник увидит файлы предыдущего.' : 'Абсолютный путь к папке, в которой будет работать агент.'}</small></label>
        <div class="schedule-section"><div class="schedule-title"><span class="schedule-title-icon"><Icon name="clock" size={18} /></span><div><strong>Когда запускать</strong><span>Вручную, регулярно или из очереди автопилота</span></div></div><div class="schedule-switch"><button type="button" class:selected={formSchedule === 'auto'} aria-pressed={formSchedule === 'auto'} disabled={submitting} onclick={() => formSchedule = 'auto'}><Icon name="moon" size={14} />Автопилот</button><button type="button" class:selected={formSchedule === 'manual'} aria-pressed={formSchedule === 'manual'} disabled={submitting} onclick={() => formSchedule = 'manual'}><Icon name="play" size={14} />Вручную</button><button type="button" class:selected={formSchedule === 'interval'} aria-pressed={formSchedule === 'interval'} disabled={submitting} onclick={() => formSchedule = 'interval'}><Icon name="clock" size={14} />По расписанию</button></div>{#if formSchedule === 'interval'}<div class="schedule-fields"><label class="form-field"><span>Повторять каждые</span><div class="input-suffix"><input type="number" bind:value={formInterval} name="intervalMinutes" min="1" max="525600" step="1" required disabled={submitting} /><span>минут</span></div></label><label class="form-field"><span>Первый запуск</span><input type="datetime-local" bind:value={formFirstRun} name="firstRunAt" disabled={submitting} /><small>Пусто: сразу после сохранения. Местное время.</small></label></div><label class="pause-option"><input type="checkbox" bind:checked={formPaused} disabled={submitting} /><span>Сохранить расписание на паузе</span></label><p class="schedule-note">Планировщик работает, пока запущен сервер brigd. Активные запуски одной задачи не накладываются.</p>{/if}{#if formSchedule === 'auto'}<label class="pause-option"><input type="checkbox" bind:checked={formPaused} disabled={submitting} /><span>Пока отложить: не брать из очереди</span></label><p class="schedule-note">Задача встанет в очередь автопилота и запустится, когда дойдёт её очередь и освободится место. Включить автопилот на ночь можно в разделе «Автопилот».</p>{/if}</div>
        {#if info?.mode === 'mock'}<div class="editor-mode-note"><Icon name="spark" size={14} /><span>Демо-режим: реальные CLI не вызываются.</span></div>{:else}<div class="editor-mode-note"><Icon name="terminal" size={14} /><span>Агент может изменять файлы в рабочей папке согласно инструкции.</span></div>{/if}
      </div>
      <footer class="editor-footer"><button type="button" class="button secondary" onclick={closeEditor} disabled={submitting}>Отмена</button><button type="submit" class="button primary" disabled={submitting || formUploading || formAttachmentInvalid}>{#if submitting}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId ? 'check' : 'plus'} size={16} />{/if}{submitting ? 'Сохраняем…' : editingId ? 'Сохранить изменения' : 'Создать задачу'}</button></footer>
    </form>
  {/if}
</dialog>

{#if toast && !selectedId}<div class="toast {toast.type}" role={toast.type === 'error' ? 'alert' : 'status'}><span><Icon name={toast.type === 'error' ? 'alert' : 'circlecheck'} size={18} /></span><p>{toast.text}</p><button class="icon-button" aria-label="Закрыть уведомление" onclick={() => toast = null}><Icon name="close" size={16} /></button></div>{/if}
