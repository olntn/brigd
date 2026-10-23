<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './lib/Icon.svelte';
  import Workers from './lib/Workers.svelte';
  import ModelSettings from './lib/ModelSettings.svelte';
  import GeneralSettings from './lib/GeneralSettings.svelte';
  import AutopilotSettings from './lib/AutopilotSettings.svelte';
  import CheckTriageSettings from './lib/CheckTriageSettings.svelte';
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
  import { CHECK_HANDBACK_LIMIT, passedOnRetry } from './lib/check-triage';
  import { effortLabel, modelLabel, runUltracode } from './lib/workers';
  import { localWorker } from './lib/worker-label';
  import { tagColorStyle } from './lib/tags';
  import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, TASK_PRIORITY_LABELS } from './lib/priority';
  import { followupTargets, followupFingerprint, followupStage, runWorkflowSteps, taskHasCompletedRun, resolveFollowupTarget, followupSessionKey, type FollowupTarget } from './lib/followups';
  import { applyTheme, readTheme, saveTheme, themes, themeStorageKey, type Theme } from './lib/theme';
  import { applyLocale, formatDate, getLocale, localeStorageKey, locales, plural, readLocale, saveLocale, serverText, setLocale, t, tk, type Locale } from './lib/i18n';
  import type { AppInfo, Attachment, AutopilotSettings as AutopilotSettingsValue, AutopilotState, Comment, FollowupInput, GeneralSettings as GeneralSettingsValue, ModelCatalogEntry, Provider, Run, Tag, Task, TaskDetail, TaskInput, TaskPriority, TaskStatus, Worker, WorkerSnapshot } from './lib/types';

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
  let autopilotEnabled = $state<boolean | null>(null);
  let autopilotStatusLoading = $state(true);
  let autopilotStatusSequence = 0;
  let autopilotStatusReading = false;
  let autopilotStatusLabel = $derived(autopilotEnabled === null ? (autopilotStatusLoading ? t('Загрузка…') : t('Неизвестно')) : autopilotEnabled ? t('Включён') : t('Выключен'));
  let backupsMutationPending = $state(false);
  let storageMutationPending = $state(false);
  let concurrencyMutationPending = $state(false);
  let checkTriageMutationPending = $state(false);
  let settingsMutationPending = $derived(modelMutationPending || generalSettingsMutationPending || autopilotSettingsMutationPending || checkTriageMutationPending || concurrencyMutationPending || backupsMutationPending || storageMutationPending);
  let integrationChecksMissing = $derived(info?.mode === 'cli' && !autopilotSettings?.integrationChecks?.length);
  let integrationChecksRequired = $derived(t('Сначала задайте BRIGD_INTEGRATION_CHECKS в Настройки → Автопилот.'));
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
    { id: 'general', label: tk('Общие'), icon: 'sliders' },
    { id: 'language', label: tk('Язык'), icon: 'globe' },
    { id: 'appearance', label: tk('Внешний вид'), icon: 'palette' },
    { id: 'models', label: tk('Модели'), icon: 'spark' },
    { id: 'permissions', label: tk('Разрешения'), icon: 'lock' },
    { id: 'autopilot', label: tk('Автопилот'), icon: 'moon' },
    { id: 'concurrency', label: tk('Параллельность'), icon: 'lanes' },
    { id: 'storage', label: tk('Хранилище'), icon: 'folder' },
    { id: 'backups', label: tk('Бэкапы'), icon: 'archive' },
  ] as const;
  let settingsSection = $state<(typeof settingsSections)[number]['id']>('general');
  const themeGroups = [{ scheme: 'light', label: tk('Светлые') }, { scheme: 'dark', label: tk('Тёмные') }] as const;
  let theme = $state<Theme>(readTheme());
  let themeSaveError = $state(false);
  let localeSaveError = $state(false);
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
  let formPriority = $state<TaskPriority>(DEFAULT_TASK_PRIORITY);
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
  let formTimeLimitMinutes = $state<number | undefined>();
  let formFirstRun = $state('');
  let formPaused = $state(false);
  let formError = $state('');
  let submitting = $state(false);
  let drawerSequence = 0;
  let taskSequence = 0;
  let toastTimer: ReturnType<typeof setTimeout>;

  const labels = TASK_STATUS_LABELS;
  const columnData: { status: TaskStatus; title: string; icon: string; empty: string }[] = [
    { status: 'ready', title: tk('К запуску'), icon: 'circle', empty: tk('Следующая идея начинается здесь') },
    { status: 'running', title: tk('В работе'), icon: 'bolt', empty: tk('Агенты готовы к работе') },
    { status: 'waiting_input', title: tk('Нужен ответ'), icon: 'message', empty: tk('Ничего не требует вашего участия') },
    { status: 'completed', title: tk('Завершено'), icon: 'circlecheck', empty: tk('Здесь будут готовые результаты') },
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
    : !followupTarget ? followupTargetKey ? t('Выбранная сессия больше не найдена. Выберите получателя заново.') : t('После завершения запуска здесь можно отправить агенту дополнительный запрос.')
    : !followupTarget.sessionId ? t('Идентификатор сессии не сохранён. Продолжить её нельзя. Для работы в новой сессии создайте отдельную задачу.')
    : selectedTask && taskIsOccupied(selectedTask) && !retryingFollowup ? t('Задача занята. Завершите текущий запуск или ответьте агенту в блоке выше.') : '');
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
  let runCanResume = $derived(currentRun && (currentRun.status === 'waiting_input' || (currentRun.status === 'interrupted' && !!currentRun.sessionId) || (currentRun.timeLimitExceeded && !!currentRun.steps.length && !!currentRun.sessionId)));
  let formWorker = $derived(workers.find(worker => worker.id === formWorkerId) ?? (formOriginalWorker?.id === formWorkerId ? formOriginalWorker : null));
  let providerAvailable = $derived(info?.mode === 'mock' || info?.providers.find(p => p.id === (formWorker?.provider ?? formProvider))?.available);
  /** Profile settings behind the ultracode checkbox: the assigned worker, or every chosen stage worker of a complex task. */
  let formProfileUltracode = $derived(formComplex ? formSteps.flatMap(step => { const worker = workers.find(item => item.id === step.workerId); return worker ? [worker.ultracode] : []; }) : [formWorker?.ultracode ?? false]);
  let formUltracodeMixed = $derived(formUltracode === null && formProfileUltracode.includes(true) && formProfileUltracode.includes(false));
  let formUltracodeChecked = $derived(formUltracode ?? (formProfileUltracode.length > 0 && formProfileUltracode.every(Boolean)));

  async function api<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...options, headers: options?.method ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers });
    let body;
    try { body = await response.json(); } catch { throw new Error(t('Сервер вернул неожиданный ответ. Проверьте, что brigd запущен.')); }
    if (!response.ok) throw new Error(body.error ? serverText(body.error) : t('Ошибка запроса ({status})', { status: response.status }));
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
      if (sequence === taskSequence) connectionError = error instanceof Error ? error.message : t('Не удалось подключиться к серверу');
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
      if (sequence === workerSequence) workersError = error instanceof Error ? error.message : t('Не удалось загрузить работников');
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
      if (sequence === tagSequence) tagsError = error instanceof Error ? error.message : t('Не удалось загрузить теги');
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
      if (sequence === modelSequence) modelsError = error instanceof Error ? error.message : t('Не удалось загрузить модели');
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
        if (sequence === generalSettingsSequence) generalSettingsError = error instanceof Error ? error.message : t('Не удалось загрузить общие настройки');
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
      if (sequence === autopilotSettingsSequence) autopilotSettingsError = error instanceof Error ? error.message : t('Не удалось загрузить настройки автопилота');
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
      if (selectedId === id && sequence === drawerSequence) detailError = error instanceof Error ? error.message : t('Не удалось загрузить задачу');
    }
  }

  function autopilotStatusChanged(enabled: boolean | null) {
    // A response from the open page supersedes any older navigation poll.
    autopilotStatusSequence++;
    autopilotEnabled = enabled;
    autopilotStatusLoading = false;
  }

  async function loadAutopilotStatus() {
    // The autopilot page already polls and reports successful changes immediately.
    if (page === 'autopilot' || autopilotStatusReading) return;
    autopilotStatusReading = true;
    const sequence = ++autopilotStatusSequence;
    try {
      const result = await api<AutopilotState>('/api/autopilot');
      if (sequence === autopilotStatusSequence) autopilotStatusChanged(result.enabled);
    } catch {
      if (sequence === autopilotStatusSequence) autopilotStatusChanged(null);
    } finally { autopilotStatusReading = false; }
  }

  async function refresh() {
    await Promise.all([loadTasks(), loadWorkers(), loadModels(), loadTags(), loadGeneralSettings(), loadAutopilotSettings(), loadAutopilotStatus(), selectedId ? loadDetail() : Promise.resolve()]);
  }

  async function loadInfo() {
    try { info = await api<AppInfo>('/api/info'); } catch { /* The task list surfaces connectivity errors. */ }
  }

  onMount(() => {
    applyTheme(theme);
    applyLocale();
    const onThemeStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) {
        theme = readTheme();
        applyTheme(theme);
        themeSaveError = false;
      }
      if (event.key === localeStorageKey || event.key === null) {
        setLocale(readLocale());
        localeSaveError = false;
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
    catch (failure) { notify(failure instanceof Error ? failure.message : t('Задача недоступна'), 'error'); }
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

  function selectLocale(value: Locale) {
    setLocale(value);
    localeSaveError = !saveLocale(value);
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
    formSteps = (task?.steps?.length ? task.steps : [1, 2].map(index => ({ workerId: '', title: t('Этап {number}', { number: index }), instruction: '' }))).map(step => ({ ...step, key: crypto.randomUUID() }));
    formOriginalStepWorkers = task?.steps?.map(step => step.workerId) ?? [];
    formUltracode = task?.ultracode ?? null;
    formPriority = task?.priority ?? DEFAULT_TASK_PRIORITY;
    if (task) void loadWorkers();
    formCwd = task?.cwd ?? generalSettings?.defaultCwd ?? info?.cwd ?? '';
    formSchedule = task?.schedule ?? generalSettings?.defaultSchedule ?? 'manual';
    formInterval = task?.intervalMinutes ?? 60;
    formTimeLimitMinutes = task?.timeLimitMinutes ?? undefined;
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
      formError = t('Укажите название, инструкцию и рабочую папку.'); return;
    }
    if (formSchedule === 'interval' && (!Number.isInteger(formInterval) || formInterval < 1)) {
      formError = t('Интервал должен быть целым числом минут, не меньше 1.'); return;
    }
    const firstRunAt = formSchedule === 'interval' && formFirstRun ? new Date(formFirstRun).getTime() : null;
    if (firstRunAt !== null && !Number.isFinite(firstRunAt)) { formError = t('Проверьте время первого запуска.'); return; }
    if (formComplex && (formSteps.length < WORKFLOW_MIN_STEPS || formSteps.length > WORKFLOW_MAX_STEPS)) { formError = t('В сложной задаче должно быть от 2 до 20 этапов.'); return; }
    if (formComplex && formSteps.some(step => !step.title.trim() || !step.instruction.trim() || !step.workerId)) { formError = t('Укажите название, работника и задание каждого этапа.'); return; }
    if (formComplex && formSteps.some(step => !workers.some(worker => worker.id === step.workerId && (!worker.archived || formOriginalStepWorkers.includes(worker.id))))) { formError = t('Проверьте работников этапов: недоступного или нового архивного работника нужно заменить.'); return; }
    if (formComplex && workers.some(worker => worker.archived && formSteps.filter(step => step.workerId === worker.id).length > formOriginalStepWorkers.filter(id => id === worker.id).length)) { formError = t('Архивному работнику нельзя назначить дополнительные этапы. Восстановите профиль или выберите другого работника.'); return; }
    if (formComplex && (formSteps.reduce((size, step) => size + step.title.trim().length + step.instruction.trim().length, 0) > WORKFLOW_TEXT_LIMIT || new TextEncoder().encode(JSON.stringify(formSteps.map(({ title, instruction, workerId }) => ({ workerId, title: title.trim(), instruction: instruction.trim() })))).byteLength > WORKFLOW_BYTES_LIMIT)) { formError = t('План слишком большой. Сократите задания этапов: суммарный лимит 64 000 символов и 96 000 байт.'); return; }
    if (!formComplex && formWorkerId && !formWorker) { formError = t('Работник недоступен. Обновите список или выберите другого.'); return; }
    if (!formComplex && formWorker?.archived && formWorker.id !== formOriginalWorker?.id) { formError = t('Этот работник в архиве. Выберите другого или восстановите профиль.'); return; }
    const payload: TaskInput = {
      title: formTitle.trim(), instruction: formInstruction.trim(), provider: formComplex ? workers.find(worker => worker.id === formSteps[0]?.workerId)?.provider ?? formProvider : formWorker?.provider ?? formProvider, workerId: formComplex ? null : formWorkerId || null, cwd: formCwd.trim(),
      steps: formComplex ? formSteps.map(({ workerId, title, instruction }) => ({ workerId, title: title.trim(), instruction: instruction.trim() })) : [],
      schedule: formSchedule, intervalMinutes: formSchedule === 'interval' ? formInterval : null,
      firstRunAt, paused: formPaused,
      timeLimitMinutes: formTimeLimitMinutes ?? null,
      ultracode: formUltracode,
      priority: formPriority,
      tagIds: formTagIds,
    };
    const savedEditingId = editingId;
    const context = editorContext;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    try { attachments = formComposer?.prepareSubmission(); } catch (error) { formError = error instanceof Error ? error.message : t('Проверьте загрузку файлов.'); return; }
    submitting = true;
    try {
      const saved = await api<Task>(savedEditingId ? `/api/tasks/${encodeURIComponent(savedEditingId)}` : '/api/tasks', { method: savedEditingId ? 'PATCH' : 'POST', body: JSON.stringify({ ...payload, attachmentIds: attachments?.attachmentIds ?? [] }) });
      attachments?.finish(true);
      notify(savedEditingId ? t('Изменения сохранены') : t('Задача создана'));
      submitting = false;
      closeEditor();
      taskSequence++;
      drawerSequence++;
      tasks = savedEditingId ? tasks.map(task => task.id === saved.id ? saved : task) : [saved, ...tasks];
      if (detail?.task.id === saved.id) detail = { ...detail, task: saved };
      if (!savedEditingId) await openTask(saved);
      void refresh();
    } catch (error) { attachments?.finish(false); if (context === editorContext) formError = error instanceof Error ? error.message : t('Не удалось сохранить задачу'); }
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
        notify(t('Теги задачи сохранены'));
      }
      void refresh();
    } catch (error) {
      if (context === drawerContext) taskTagsError = error instanceof Error ? error.message : t('Не удалось сохранить теги');
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
      try { attachments = answerComposer?.prepareSubmission(); } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : t('Проверьте загрузку файлов.'), 'error'); return; }
    }
    pending = [...pending, task.id];
    try {
      if (action === 'run') {
        await api<Run>(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', body: '{}' });
        notifyForTask(task.id, context, info?.mode === 'mock' ? t('Демо-запуск начат') : t('Задача запущена'));
      } else if (action === 'pause') {
        await api<Task>(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ paused: !task.paused }) });
        notifyForTask(task.id, context, task.schedule === 'auto' ? (task.paused ? t('Задача возвращена в очередь автопилота') : t('Задача отложена: автопилот её не возьмёт')) : task.paused ? t('Расписание возобновлено') : t('Расписание приостановлено'));
      } else if (action === 'archive' || action === 'restore') {
        await api<Task>(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', body: '{}' });
        notifyForTask(task.id, context, action === 'archive' ? t('Задача перенесена в архив') : t('Задача восстановлена и снова на доске'));
      } else if (task.latestRun) {
        const updatedRun = await api<Run>(`/api/runs/${encodeURIComponent(task.latestRun.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'resume' ? { answer: response?.trim() || (attachments?.attachmentIds.length ? '' : t('Продолжи выполнение задачи с того места, где остановился.')), attachmentIds: attachments?.attachmentIds ?? [], ...(task.latestRun.status === 'interrupted' ? { acknowledgeInterruption: true } : {}) } : ['retry', 'cancel'].includes(action) && task.latestRun.status === 'interrupted' ? { acknowledgeInterruption: true } : {}) });
        attachments?.finish(true);
        if (['resume', 'retry', 'cancel'].includes(action) && selectedId === task.id && context === drawerContext) { answer = ''; acknowledgeInterruption = false; }
        notifyForTask(task.id, context, action === 'resume' ? t('Ответ отправлен, агент продолжает работу') : action === 'retry' ? t('Текущий этап запущен заново. Завершённые этапы сохранены.') : updatedRun.status === 'cancelling' ? t('Останавливаем процесс агента…') : t('Запуск отменён'));
      }
      await refresh();
    } catch (error) { attachments?.finish(false); notifyForTask(task.id, context, error instanceof Error ? error.message : t('Не удалось выполнить действие'), 'error'); }
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
      let message = t('Задача удалена');
      if (target.kind === 'task') await api<{ ok: true }>(`/api/tasks/${encodeURIComponent(target.task.id)}/purge`, { method: 'POST', body: '{}' });
      else {
        const result = await api<{ deleted: number; skipped: number }>('/api/archive/purge', { method: 'POST', body: JSON.stringify({ archivedBefore: target.archivedBefore }) });
        message = result.skipped
          ? t('Удалено задач из архива: {deleted}. Не удалены: {skipped} — их процессы ещё завершаются, повторите позже.', { deleted: result.deleted, skipped: result.skipped })
          : t('Удалено задач из архива: {deleted}.', { deleted: result.deleted });
      }
      taskSequence++;
      drawerSequence++;
      if (taskId) tasks = tasks.filter(task => task.id !== taskId);
      removing = false;
      closeDelete();
      if (taskId && selectedId === taskId) closeDrawer();
      notify(message);
      void refresh();
    } catch (error) { deleteError = error instanceof Error ? error.message : t('Не удалось удалить'); }
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
      notifyForTask(task.id, context, action === 'integrate' ? t('Результат поставлен в очередь проверки и слияния') : action === 'reconcile' ? t('Интегратор объединит результат с целевой веткой и повторит проверку') : t('Остановка слияния запрошена'));
      await refresh();
    } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : t('Не удалось изменить состояние слияния'), 'error'); }
    finally { pending = pending.filter(id => id !== task.id); }
  }

  async function sendComment(event: SubmitEvent) {
    event.preventDefault();
    const task = selectedTask;
    const body = comment.trim();
    const context = drawerContext;
    if (!task || (!body && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid) return;
    let attachments: ReturnType<AttachmentComposer['prepareSubmission']> | undefined;
    try { attachments = commentComposer?.prepareSubmission(); } catch (error) { notifyForTask(task.id, context, error instanceof Error ? error.message : t('Проверьте загрузку файлов.'), 'error'); return; }
    pending = [...pending, task.id];
    try {
      await api<Comment>(`/api/tasks/${encodeURIComponent(task.id)}/comments`, { method: 'POST', body: JSON.stringify({ body, attachmentIds: attachments?.attachmentIds ?? [] }) });
      attachments?.finish(true);
      if (selectedId === task.id && context === drawerContext) { comment = ''; followupAttempt = null; followupError = ''; await loadDetail(task.id); }
    } catch (error) { attachments?.finish(false); notifyForTask(task.id, context, error instanceof Error ? error.message : t('Не удалось сохранить заметку'), 'error'); }
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
    catch (error) { followupError = error instanceof Error ? error.message : t('Проверьте загрузку файлов.'); return; }
    const draft = { sourceRunId: target.sourceRunId, sourceStepIndex: target.sourceStepIndex, body, attachmentIds: attachments?.attachmentIds ?? [] };
    const signature = followupFingerprint(draft);
    const previous = followupAttempt?.taskId === task.id && followupAttempt.signature === signature ? followupAttempt : null;
    if (taskIsOccupied(task) && !previous) { attachments?.finish(false); followupError = t('Задача занята. Дождитесь завершения текущего запуска.'); return; }
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
        notifyForTask(task.id, context, t('Дополнительный запрос отправлен в ту же сессию'));
      }
      await refresh();
    } catch (error) {
      attachments?.finish(false);
      if (selectedId === task.id && context === drawerContext) followupError = error instanceof Error ? error.message : t('Не удалось отправить запрос.');
      // Retain exact payload and request ID: an uncertain response may already have started a run.
    } finally {
      followupSending = false;
      pending = pending.filter(id => id !== task.id);
    }
  }

  function recipientLabel(target: FollowupTarget): string {
    return `${target.worker ? localWorker(target.worker).name : providerName(target.provider)}${target.stageIndex != null ? ` · ${t('Этап {number}: {title}', { number: target.stageIndex + 1, title: target.stageTitle ?? '' })}` : ''} · ${dateTime(target.startedAt)} · ${target.isFollowup ? t('Доп. запрос') : target.isReconcile ? t('Конфликт') : t('Запуск')} ${target.sourceRunId.slice(0, 6)}${target.sessionId ? '' : ` · ${t('Сессия не сохранена')}`}`;
  }

  function clockTime(timestamp: number): string {
    return formatDate(timestamp, { hour: '2-digit', minute: '2-digit' });
  }

  function dateTime(timestamp: number | null, short = false): string {
    if (!timestamp) return '—';
    return formatDate(timestamp, { day: 'numeric', month: 'short', ...(short ? {} : { hour: '2-digit', minute: '2-digit' }) });
  }

  function intervalLabel(minutes: number | null): string {
    if (!minutes) return t('По расписанию');
    if (minutes % 1440 === 0) return minutes === 1440 ? t('Каждый день') : t('Каждые {count} дн.', { count: minutes / 1440 });
    if (minutes % 60 === 0) return minutes === 60 ? t('Каждый час') : t('Каждые {count} ч.', { count: minutes / 60 });
    return t('Каждые {count} мин.', { count: minutes });
  }

  function scheduleLabel(task: Task, short = false): string {
    if (task.schedule === 'auto') return task.paused ? t('Автопилот: отложено') : t('Автопилот');
    if (task.paused) return short ? t('На паузе') : t('Расписание на паузе');
    return task.schedule === 'interval' ? intervalLabel(task.intervalMinutes) : t('Вручную');
  }
  function scheduleIcon(task: Task): string { return task.paused ? 'pause' : task.schedule === 'interval' ? 'clock' : task.schedule === 'auto' ? 'moon' : 'play'; }
  function taskIsOccupied(task: Task) { return activeStatuses.includes(task.status) || !!task.latestRun?.steps?.length && ['failed', 'blocked'].includes(task.status); }
  function canStartManual(task: Task) { return !taskIsOccupied(task) && !taskHasCompletedRun(task); }
  function workflowSteps(task: Task) { const saved = runWorkflowSteps(task.latestRun); return saved.length ? saved : task.steps ?? []; }
  function workflowProgress(task: Task) { const steps = workflowSteps(task); return t('{done} из {total} этапов завершено', { done: runWorkflowSteps(task.latestRun).filter(step => step.status === 'completed').length, total: steps.length }); }
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
    if (file.source === 'user') return t('Вы');
    const run = detail?.runs.find(item => item.id === file.runId);
    const worker = file.stepIndex != null ? run?.steps?.[file.stepIndex]?.worker : run?.worker;
    return (worker ? localWorker(worker).name : null) ?? (run ? providerName(run.provider) : t('Агент'));
  }
  function commentRun(entry: Comment) { return entry.runId ? detail?.runs.find(run => run.id === entry.runId) ?? null : null; }
  function commentWorker(entry: Comment) { const run = commentRun(entry); return ['agent', 'question', 'result'].includes(entry.kind) ? (entry.stepIndex != null ? run?.steps?.[entry.stepIndex]?.worker : run?.steps?.length ? null : run?.worker) ?? null : null; }
  function commentAuthor(entry: Comment) {
    if (entry.kind === 'user') return t('Вы');
    if (entry.kind === 'system') return 'brigd';
    const identity = commentWorker(entry);
    if (identity) return identity.name;
    if (entry.kind === 'question') return t('Вопрос агента');
    if (entry.kind === 'result') return t('Результат');
    return providerName(commentRun(entry)?.provider ?? selectedTask?.provider ?? 'codex');
  }
  function providerName(value: Provider) { return value === 'codex' ? 'Codex' : 'Claude Code'; }
  function shortPath(path: string) { const parts = path.replace(/\\/g, '/').split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path; }
  function elapsed(run: Run) {
    const seconds = Math.max(0, Math.floor(((run.finishedAt ?? run.updatedAt) - run.startedAt) / 1000));
    return seconds < 60 ? t('{seconds} сек.', { seconds }) : t('{minutes} мин. {seconds} сек.', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
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
  /** The task's own ultracode choice, phrased for what it overrides. */
  function ultracodeOverrideNote(): string {
    if (formComplex) return formUltracodeChecked ? t('Задано для этой задачи: режим ultracode включён на всех этапах, независимо от профиля работника.') : t('Задано для этой задачи: режим ultracode выключен на всех этапах, независимо от профиля работника.');
    if (formWorker) return formUltracodeChecked ? t('Задано для этой задачи: режим ultracode включён, независимо от профиля работника.') : t('Задано для этой задачи: режим ultracode выключен, независимо от профиля работника.');
    return formUltracodeChecked ? t('Задано для этой задачи: режим ultracode включён, независимо от настроек CLI.') : t('Задано для этой задачи: режим ultracode выключен, независимо от настроек CLI.');
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

{#snippet workerBadge(stored: Worker | WorkerSnapshot, compact = false)}
  {@const worker = localWorker(stored)}
  <span class="worker-identity" class:compact title={worker.name}><WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={compact ? 32 : 40} /><span class="worker-identity-copy"><span>{worker.name}</span>{#if worker.description?.trim()}<small class="worker-description">{worker.description}</small>{/if}<small class="worker-model-label" title={worker.model ?? undefined}>{providerName(worker.provider)} · {t(modelLabel(worker.model, 'archived' in worker ? models : undefined, worker.provider))}</small></span>{#if 'archived' in worker && worker.archived}<small>{t('в архиве')}</small>{/if}</span>
{/snippet}

{#snippet statusBadge(status: TaskStatus)}
  <span class="status-badge status-{status}"><span class="status-dot"></span>{t(labels[status])}</span>
{/snippet}

{#snippet workspaceNote(run: Run)}
  {#if run.workspace?.mode === 'worktree' && (run.workspace.removedAt || run.workspace.recreatedAt)}
    <p class="workspace-note">{#if run.workspace.removedAt}{run.workspace.removedBy === 'cleanup' ? t('Папка запуска удалена при очистке хранилища {time}.', { time: dateTime(run.workspace.removedAt) }) : t('Папка запуска удалена после переноса результата {time}.', { time: dateTime(run.workspace.removedAt) })}{#if run.status === 'completed' && run.sessionId && selectedTask?.archivedAt === null}{' '}{t('Ответ или дополнительный запрос создаст папку заново; если ветка {branch} удалена, она восстановится из последнего перенесённого коммита. Неотслеживаемые файлы прежней сессии не восстанавливаются.', { branch: run.workspace.branch ?? '' })}{/if}{:else}{t('Папка запуска создана заново для ветки {branch} {time}; неотслеживаемые файлы прежней сессии в ней отсутствуют.', { branch: run.workspace.branch ?? '', time: dateTime(run.workspace.recreatedAt!) })}{/if}</p>
  {/if}
{/snippet}
{#snippet instructionSnapshot(run: Run)}
  <details class="run-instruction-snapshot">
    <summary>{t('Общие инструкции запуска')}</summary>
    <p class="snapshot-help">{t('Копия на момент старта. При продолжении этого запуска используются те же правила.')}</p>
    <section class="snapshot-instruction"><h4>{t('Общее задание запуска')}</h4><p>{run.instruction}</p></section>
    <section class="snapshot-instruction"><h4>{t('Рабочая папка запуска')}</h4><p>{run.cwd}</p></section>
    {#if run.workspace?.mode === 'worktree'}<section class="snapshot-instruction"><h4>{t('Изолированная рабочая папка')}</h4><p>{run.workspace.cwd}</p><p>{t('Ветка: {branch}', { branch: run.workspace.branch ?? '' })}</p><p>{t('После завершения изменения проверяются вместе с целевой веткой и переносятся в проект.')}</p></section>{/if}
    {#if run.worker && !run.steps?.length}<section class="snapshot-instruction worker-run-settings"><h4>{t('Настройки работника на момент запуска')}</h4><p><span>{run.worker.name}</span>{#if run.worker.description?.trim()}<small class="worker-description">{run.worker.description}</small>{/if}<br />{providerName(run.worker.provider)}<br />{t('Модель: {model}', { model: t(modelLabel(run.worker.model)) })}{#if run.worker.model && modelLabel(run.worker.model) !== run.worker.model} ({run.worker.model}){/if}<br />{t('Усилия: {effort}', { effort: t(effortLabel(run.worker.effort)) })}<br />{runUltracode(run) ? t('Режим ultracode: включён') : t('Режим ultracode: выключен')}{#if run.ultracode != null}{' '}{t('(задано в задаче)')}{/if}</p></section>{/if}
    {#if run.inputAttachments?.length}<section class="snapshot-instruction"><h4>{t('Файлы на момент запуска')}</h4><AttachmentList attachments={run.inputAttachments} taskId={run.taskId} label={t('Файлы запуска')} author={attachmentAuthor} /></section>{/if}
    {#each run.instructions ?? [] as instruction (instruction.id)}
      <section class="snapshot-instruction"><h4>{instruction.title}</h4><p>{instruction.body}</p></section>
    {:else}<p class="snapshot-empty">{t('В этом запуске нет общих инструкций.')}</p>{/each}
  </details>
{/snippet}

{#snippet taskTags(task: Task)}
  {#if task.tags?.length}<span class="task-tags">{#each task.tags as tag (tag.id)}<span class="task-tag" style={tagColorStyle(tag.color)}><span>{tag.name}</span></span>{/each}</span>{/if}
{/snippet}

{#snippet priorityBadge(priority: TaskPriority)}
  <span class="priority-badge priority-{priority}" title={t('Приоритет: {priority}', { priority: t(TASK_PRIORITY_LABELS[priority]) })}><span class="sr-only">{t('Приоритет:') + ' '}</span>{t(TASK_PRIORITY_LABELS[priority])}</span>
{/snippet}

{#snippet taskCard(task: Task)}
  <article class="task-card {task.status}" class:paused-card={task.paused}>
    <button class="card-main" onclick={() => openTask(task)} aria-label={t('Открыть задачу: {title}', { title: task.title })}>
      <div class="card-top">{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}{#if visibleUltracode(task)}<span class="ultracode-badge" title={t('Режим ultracode')}>ultracode</span>{/if}{#if task.priority !== DEFAULT_TASK_PRIORITY}{@render priorityBadge(task.priority)}{/if}<span class="task-ref">{task.id.slice(0, 6).toUpperCase()}</span></div>
      <h3>{task.title}</h3>
      <p class="card-description">{task.latestRun?.summary || task.instruction}</p>
      {@render taskTags(task)}
      {#if workflowSteps(task).length}<div class="card-workflow-progress"><Icon name="list" size={14} /><span>{workflowProgress(task)}</span></div>{/if}
      {#if task.latestRun?.followup?.checkFailure}<div class="card-followup-label"><Icon name="refresh" size={14} /><span>{t('Возврат после упавшей проверки · {round} из {limit}', { round: task.latestRun.followup.checkFailure.round, limit: CHECK_HANDBACK_LIMIT })}</span></div>
      {:else if task.latestRun?.followup}<div class="card-followup-label"><Icon name="message" size={14} /><span>{t('Дополнительный запрос')}{#if followupStage(task.latestRun)} · {t('Этап {number}', { number: followupStage(task.latestRun)!.index + 1 })}{/if}</span></div>
      {:else if task.latestRun?.reconcile}<div class="card-followup-label"><Icon name="refresh" size={14} /><span>{t('Разрешение конфликта слияния')}</span></div>{/if}
      {#if task.latestRun?.progress}<div class="card-progress" title={t('Статус выполнения: {text}', { text: task.latestRun.progress.text })}><Icon name="refresh" size={13} class="spin" /><span>{task.latestRun.progress.text}</span></div>{/if}
      {#if passedOnRetry(task.latestRun?.integration?.triage)}<div class="card-signal" title={t('Повтор мог скрыть гонку, которую внесла сама задача. Сравните выводы обеих попыток.')}><Icon name="alert" size={13} /> {t('Проверка прошла со второй попытки')}</div>{/if}
      {#if task.status === 'cancelling'}<div class="card-cancelling"><Icon name="refresh" size={13} class="spin" />{t('Останавливается')}</div>{/if}
      {#if task.status === 'waiting_input'}<div class="card-signal"><Icon name="message" size={13} /> {t('Агент ждёт вашего ответа')}</div>{/if}
      {#if task.status === 'queued'}<div class="card-signal"><Icon name="clock" size={13} /> {t('Ожидает свободного места для запуска')}</div>{/if}
      {#if task.status === 'preparing'}<div class="card-signal"><Icon name="refresh" size={13} class="spin" /> {t('Подготавливается рабочая папка')}</div>{/if}
      {#if task.status === 'interrupted'}<div class="card-signal"><Icon name="alert" size={13} /> {t('Проверьте прерванный запуск')}</div>{/if}
      {#if task.latestRun?.error && ['failed', 'blocked'].includes(task.status)}<div class="card-error">{serverText(task.latestRun.error)}</div>{/if}
      {#if task.attachments?.length}<div class="card-attachment-count"><Icon name="folder" size={13} /><span>{t('Файлов: {count}', { count: task.attachments.length })}</span></div>{/if}
    </button>
    <div class="card-footer">
      <span class="card-schedule" class:is-paused={task.paused}><Icon name={scheduleIcon(task)} size={12} />{scheduleLabel(task)}</span>
      <div class="card-actions">
        {#if !taskIsOccupied(task)}
          <button class="icon-button" disabled={pending.includes(task.id)} onclick={() => act(task, 'archive')} aria-label={t('В архив: {title}', { title: task.title })} title={t('В архив')}><Icon name={pending.includes(task.id) ? 'refresh' : 'archive'} size={14} class={pending.includes(task.id) ? 'spin' : ''} /></button>
        {/if}
        {#if canStartManual(task)}
          <button class="card-run icon-button" disabled={pending.includes(task.id) || integrationChecksMissing} onclick={() => act(task, 'run')} aria-label={workflowSteps(task).length && task.runCount ? t('Начать заново: {title}', { title: task.title }) : t('Запустить: {title}', { title: task.title })} title={integrationChecksMissing ? integrationChecksRequired : workflowSteps(task).length && task.runCount ? t('Начать всю последовательность заново') : t('Запустить задачу')}><Icon name={pending.includes(task.id) ? 'refresh' : 'play'} size={14} class={pending.includes(task.id) ? 'spin' : ''} /></button>
        {:else}<span class="card-run-count" title={t('Количество запусков')}><Icon name="history" size={12} />{task.runCount}</span>{/if}
      </div>
    </div>
  </article>
{/snippet}

<div class="app-shell">
  <aside class="sidebar" aria-label={t('Основная навигация')}>
    <a class="brand" href="/" aria-label={t('brigd — главная')}><span class="brand-symbol"><BrigLogo size={28} /></span><span>brigd<span class="brand-dot">.</span></span></a>
    <nav class="main-nav" aria-label={t('Задачи')}>
      <button class:active={page === 'tasks'} aria-label={t('Задачи')} onclick={() => { page = 'tasks'; resetFilters(); }}><Icon name="board" /><span>{t('Задачи')}</span></button>
      <button class:active={page === 'autopilot'} aria-label={t('Автопилот')} aria-describedby="autopilot-nav-status" title={t('Автопилот: {status}', { status: autopilotStatusLabel.toLowerCase() })} onclick={() => { page = 'autopilot'; }}>
        <Icon name="moon" /><span class="autopilot-nav-label"><span>{t('Автопилот')}</span><span class="autopilot-nav-status" class:is-enabled={autopilotEnabled === true} class:is-unknown={autopilotEnabled === null} aria-hidden="true"></span></span><span id="autopilot-nav-status" class="sr-only">{autopilotStatusLabel}</span>
      </button>
      <button class:active={page === 'workers'} aria-label={t('Работники')} onclick={() => { page = 'workers'; void loadWorkers(); }}><Icon name="spark" /><span>{t('Работники')}</span></button>
      <button class:active={page === 'instructions'} aria-label={t('Инструкции')} onclick={() => { page = 'instructions'; }}><Icon name="list" /><span>{t('Инструкции')}</span></button>
      <button class:active={page === 'docs'} aria-label={t('Документация')} onclick={() => { page = 'docs'; }}><Icon name="book" /><span>{t('Документация')}</span></button>
      <button class:active={page === 'tags'} aria-label={t('Теги')} onclick={() => { page = 'tags'; void loadTags(); }}><Icon name="tag" /><span>{t('Теги')}</span></button>
    </nav>
    <div class="sidebar-bottom">
      <button class="archive-button" class:active={page === 'archive'} aria-label={t('Архив')} onclick={() => { page = 'archive'; }}><Icon name="archive" /><span>{t('Архив')}</span></button>
      <button class="settings-button" onclick={() => openSettings()} aria-haspopup="dialog"><Icon name="sliders" /><span>{t('Настройки')}</span></button>
    </div>
  </aside>

  <main class="main-content">
    <div class="workspace-content">
      {#if page === 'instructions'}
        <Instructions {notify} />
      {:else if page === 'docs'}
        <Docs {notify} onopentask={(id) => { void openTaskById(id); }} />
      {:else if page === 'autopilot'}
        <Autopilot {tasks} {notify} settings={autopilotSettings} checksRequired={info?.mode !== 'mock'} onopen={openTask} onchanged={taskChanged} onsettings={openSettings} onstatus={autopilotStatusChanged} />
      {:else if page === 'tags'}
        <Tags {tags} loading={tagsLoading} error={tagsError} onreload={loadTags} onchanged={tagChanged} ondeleted={tagDeleted} onmutation={tagMutation} {notify} />
      {:else if page === 'archive'}
        <section class="page-heading" aria-label={t('Архив задач')}><div><h1>{t('Архив')}</h1><p>{t('Задачи в архиве не показываются на доске и не запускаются по расписанию. История, комментарии и файлы сохраняются, пока задачу не удалят.')}</p></div>{#if !loading && archivedTasks.length}<button class="button danger" disabled={removing} onclick={askDeleteArchive}><Icon name="trash" size={16} />{t('Удалить все')}</button>{/if}</section>
        {#if loading}
          <div class="list-empty" aria-busy="true"><Icon name="refresh" size={19} class="spin" /><span>{t('Загружаем архив…')}</span></div>
        {:else if archivedTasks.length === 0}
          <div class="no-results"><span class="empty-icon"><Icon name="archive" size={28} /></span><h2>{t('Архив пуст')}</h2><p>{t('Нажмите значок архива на доске или кнопку «В архив» в открытой задаче.')}</p></div>
        {:else}
          <div class="toolbar"><label class="search-box"><Icon name="search" size={16} /><input bind:value={archiveSearch} type="search" placeholder={t('Найти в архиве…')} aria-label={t('Поиск в архиве')} /></label><label class="provider-filter tag-filter"><Icon name="tag" size={15} /><select bind:value={archiveTagFilter} aria-label={t('Фильтр по тегу')} disabled={tagsLoading}><option value="all">{t('Все теги')}</option><option value="untagged">{t('Без тегов')}</option>{#each tags as tag (tag.id)}<option value={tag.id}>{tag.name}</option>{/each}</select><Icon name="down" size={13} /></label></div>
          {#if tagsError}<div class="connection-error" role="alert"><span>{tagsError}</span><button onclick={() => { void loadTags(); }}>{t('Повторить загрузку тегов')}</button></div>{/if}
          <div class="task-list archive-list"><div class="list-heading"><span>{t('ЗАДАЧА')}</span><span>{t('АГЕНТ')}</span><span>{t('СТАТУС')}</span><span>{t('В АРХИВЕ С')}</span><span></span><span></span></div>{#each archiveResults as task (task.id)}<div class="task-row"><button class="list-task-name" onclick={() => openTask(task)}><span class="list-task-icon"><Icon name="archive" size={17} /></span><span><strong>{task.title}</strong><small>{#if task.priority !== DEFAULT_TASK_PRIORITY}{@render priorityBadge(task.priority)}{/if}{shortPath(task.cwd)}</small>{@render taskTags(task)}</span></button><div>{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}</div><div>{@render statusBadge(task.status)}</div><span class="list-schedule">{dateTime(task.archivedAt!)}</span><div class="archive-row-actions"><button class="button secondary" disabled={pending.includes(task.id)} aria-label={t('Восстановить: {title}', { title: task.title })} onclick={() => act(task, 'restore')}><Icon name={pending.includes(task.id) ? 'refresh' : 'restore'} size={15} class={pending.includes(task.id) ? 'spin' : ''} />{t('Восстановить')}</button>{#if !taskIsOccupied(task)}<button class="button text-button danger-hover" disabled={pending.includes(task.id)} aria-label={t('Удалить: {title}', { title: task.title })} onclick={() => askDeleteTask(task)}><Icon name="trash" size={15} />{t('Удалить')}</button>{/if}</div><button class="icon-button" aria-label={t('Открыть: {title}', { title: task.title })} onclick={() => openTask(task)}><Icon name="chevron" size={17} /></button></div>{:else}<div class="list-empty"><Icon name="search" size={20} /><span>{t('В архиве ничего не найдено')}</span></div>{/each}</div>
        {/if}
      {:else if page === 'workers'}
        <Workers {workers} loading={workersLoading} error={workersError} retry={() => { void loadWorkers(); }} onchange={workerChanged} ondelete={workerDeleted} {notify} {models} {modelsLoading} {modelsError} retryModels={() => { void loadModels(); }} />
      {:else}
      <section class="page-heading" aria-label={t('Управление задачами')}><button class="button primary create-button" onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={17} />{t('Новая задача')}</button></section>

      {#if info?.mode === 'mock'}
        <div class="mode-banner"><span class="mode-icon"><Icon name="spark" size={17} /></span><div><strong>{t('Демонстрационный режим')}</strong><span>{t('Запуски симулируются. Codex и Claude CLI не вызываются, файлы не изменяются.')}</span></div><span class="demo-badge">MOCK</span></div>
      {/if}
      {#if integrationChecksMissing}<div class="connection-error" role="status"><Icon name="alert" size={17} /><span>{t('Запуски недоступны: задайте BRIGD_INTEGRATION_CHECKS.')}</span><button onclick={() => openSettings('autopilot')}>{t('Настройки автопилота')}</button></div>{/if}
      {#if connectionError}<div class="connection-error" role="alert"><Icon name="alert" size={17} /><span>{connectionError}</span><button onclick={() => { void loadInfo(); void refresh(); }}>{t('Повторить')}</button></div>{/if}

      <div class="toolbar">
        <div class="view-toggle" aria-label={t('Вид задач')}><button class:selected={view === 'board'} aria-pressed={view === 'board'} onclick={() => view = 'board'}><Icon name="board" size={15} />{t('Доска')}</button><button class:selected={view === 'list'} aria-pressed={view === 'list'} onclick={() => view = 'list'}><Icon name="list" size={16} />{t('Список')}</button></div>
        <div class="toolbar-filters">
          <label class="search-box"><Icon name="search" size={16} /><input bind:value={search} type="search" placeholder={t('Найти задачу…')} aria-label={t('Поиск задач')} /></label>
          <label class="provider-filter"><Icon name="inbox" size={15} /><select value={scope} onchange={(event) => setScope(event.currentTarget.value as Scope)} aria-label={t('Фильтр задач')}><option value="all">{t('Все задачи')}</option><option value="attention">{t('Требуют внимания')}</option><option value="scheduled">{t('По расписанию')}</option><option value="autopilot">{t('Автопилот')}</option><option value="completed">{t('Завершённые')}</option></select><Icon name="down" size={13} /></label>
          <label class="provider-filter"><Icon name="sliders" size={15} /><select bind:value={provider} aria-label={t('Фильтр по агенту')}><option value="all">{t('Все агенты')}</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select><Icon name="down" size={13} /></label>
          <label class="provider-filter tag-filter"><Icon name="tag" size={15} /><select bind:value={tagFilter} aria-label={t('Фильтр по тегу')} disabled={tagsLoading}><option value="all">{t('Все теги')}</option><option value="untagged">{t('Без тегов')}</option>{#each tags as tag (tag.id)}<option value={tag.id}>{tag.name}</option>{/each}</select><Icon name="down" size={13} /></label>
        </div>
      </div>
      {#if tagsError}<div class="connection-error" role="alert"><span>{tagsError}</span><button onclick={() => { void loadTags(); }}>{t('Повторить загрузку тегов')}</button></div>{/if}

      {#if loading}
        <div class="board-grid skeleton-grid" aria-label={t('Загружаем задачи')} aria-busy="true">{#each [1, 2, 3, 4] as column}<div class="skeleton-column"><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-card"></div>{#if column < 3}<div class="skeleton skeleton-card short"></div>{/if}</div>{/each}</div>
      {:else if filtered.length === 0 && activeTasks.length > 0}
        <div class="no-results"><span class="empty-icon"><Icon name={scope === 'attention' && tagFilter === 'all' ? 'circlecheck' : 'search'} size={28} /></span><h2>{scope === 'attention' && !search && provider === 'all' && tagFilter === 'all' ? t('Всё под контролем') : t('Задачи не найдены')}</h2><p>{scope === 'attention' && !search && provider === 'all' && tagFilter === 'all' ? t('Сейчас нет задач, которым нужно ваше внимание.') : t('Попробуйте другой запрос или измените фильтры.')}</p><button class="button secondary" onclick={resetFilters}>{t('Показать все задачи')}</button></div>
      {:else}
        {#if activeTasks.length === 0 && !connectionError}
          <section class="welcome-card"><div class="welcome-art" aria-hidden="true"><span class="art-orbit orbit-one"></span><span class="art-orbit orbit-two"></span><span class="art-mini art-code"><Icon name="code" size={19} /></span><span class="art-main"><BrigLogo size={39} /></span><span class="art-mini art-star">✳</span><span class="art-spark">✦</span></div><div class="welcome-copy"><h2>{t('Освободите время для своих идей')}</h2><p>{t('Поручите агенту проверить проект, собрать сводку или помочь с кодом.')}<br class="desktop-break" /> {t('Запустите один раз или настройте регулярную работу.')}</p><button class="button primary" onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={16} />{t('Создать первую задачу')}<Icon name="arrow" size={16} /></button></div><div class="welcome-steps"><div><span>1</span>{t('Опишите задачу')}</div><div><span>2</span>{t('Выберите агента')}</div><div><span>3</span>{t('Следите за результатом')}</div></div></section>
        {/if}

        {#if view === 'board'}
          {#if problemTasks.length}
            <section class="problem-panel" aria-label={t('Проблемные задачи')}>
              <button class="problem-toggle" aria-expanded={showProblems} onclick={() => showProblems = !showProblems}><span class="problem-title"><span class="problem-icon"><Icon name="alert" size={16} /></span><strong>{t('Проблемные задачи')}</strong><span class="problem-count" aria-label={t('Задач: {count}', { count: problemTasks.length })}>{problemTasks.length}</span><small>{t('Ошибки, блокировки, конфликты слияния, прерванные и отменённые запуски')}</small></span><span class="problem-chevron"><Icon name={showProblems ? 'down' : 'chevron'} size={15} /></span></button>
              {#if showProblems}<div class="problem-grid">{#each problemTasks as task (task.id)}<div class="problem-card">{@render statusBadge(task.status)}{@render taskCard(task)}</div>{/each}</div>{/if}
            </section>
          {/if}
          <div class="board-grid" class:empty-board={activeTasks.length === 0}>
            {#each columnData as column}
              {@const items = filtered.filter(task => task.status === column.status || (column.status === 'ready' && task.status === 'queued') || (column.status === 'running' && ['preparing', 'cancelling', 'awaiting_merge', 'integrating'].includes(task.status)))}
              <section class="board-column column-{column.status}" aria-label={t(column.title)}>
                <div class="column-heading"><span class="column-icon"><Icon name={column.icon} size={15} /></span><h2>{t(column.title)}</h2><span class="column-count" aria-label={t('Задач: {count}', { count: items.length })}>{items.length}</span>{#if column.status === 'ready'}<button class="icon-button add-column" onclick={() => openEditor()} disabled={!info} aria-label={t('Добавить задачу')}><Icon name="plus" size={16} /></button>{/if}</div>
                <div class="column-cards">{#each items as task (task.id)}{@render taskCard(task)}{:else}<div class="column-empty"><Icon name={column.icon} size={21} /><p>{t(column.empty)}</p>{#if column.status === 'ready'}<button onclick={() => openEditor()} disabled={!info}><Icon name="plus" size={12} />{t('Добавить задачу')}</button>{/if}</div>{/each}</div>
              </section>
            {/each}
          </div>
        {:else}
          <div class="task-list"><div class="list-heading"><span>{t('ЗАДАЧА')}</span><span>{t('АГЕНТ')}</span><span>{t('СТАТУС')}</span><span>{t('ЗАПУСК')}</span><span></span></div>{#each filtered as task (task.id)}<div class="task-row"><button class="list-task-name" onclick={() => openTask(task)}><span class="list-task-icon"><Icon name={task.schedule === 'interval' ? 'clock' : task.schedule === 'auto' ? 'moon' : 'terminal'} size={17} /></span><span><strong>{task.title}</strong><small>{#if task.priority !== DEFAULT_TASK_PRIORITY}{@render priorityBadge(task.priority)}{/if}{shortPath(task.cwd)}</small>{@render taskTags(task)}{#if task.latestRun?.followup?.checkFailure}<small class="list-followup-label">{t('Возврат после упавшей проверки · {round} из {limit}', { round: task.latestRun.followup.checkFailure.round, limit: CHECK_HANDBACK_LIMIT })}</small>{:else if task.latestRun?.followup}<small class="list-followup-label">{t('Дополнительный запрос')}{#if followupStage(task.latestRun)} · {t('Этап {number}', { number: followupStage(task.latestRun)!.index + 1 })}{/if}</small>{/if}{#if passedOnRetry(task.latestRun?.integration?.triage)}<small class="list-flaky-label">{t('Проверка прошла со второй попытки')}</small>{/if}{#if workflowSteps(task).length}<small class="list-workflow-progress">{workflowProgress(task)}</small>{/if}{#if task.latestRun?.progress}<small class="list-progress" title={t('Статус выполнения: {text}', { text: task.latestRun.progress.text })}>{task.latestRun.progress.text}</small>{/if}</span></button><div>{#if visibleWorker(task)}{@render workerBadge(visibleWorker(task)!, true)}{:else}{@render providerBadge(visibleProvider(task), true)}{/if}</div><div>{@render statusBadge(task.status)}</div><span class="list-schedule">{scheduleLabel(task, true)}</span><button class="icon-button" aria-label={t('Открыть: {title}', { title: task.title })} onclick={() => openTask(task)}><Icon name="chevron" size={17} /></button></div>{:else}<div class="list-empty"><Icon name="inbox" size={24} /><span>{t('Новые задачи появятся здесь')}</span></div>{/each}</div>
        {/if}
      {/if}
      {/if}
    </div>
  </main>
</div>

<dialog class="task-drawer" bind:this={drawer} aria-labelledby="detail-title" oncancel={(event) => { event.preventDefault(); closeDrawer(); }} onclick={(event) => backdropClick(event, drawer, closeDrawer)}>
  <div class="drawer-content">
    <header class="drawer-topbar">
      <span class="drawer-task-ref"><Icon name="terminal" size={16} />{t('Задача')} <span class="detail-ref">{selectedId?.slice(0, 8).toUpperCase()}</span></span>
      {#if selectedTask}<div class="drawer-badges">{@render statusBadge(selectedTask.status)}{#if currentRun?.followup?.checkFailure}<span class="followup-type-badge">{t('Возврат после упавшей проверки')}</span>{:else if currentRun?.followup}<span class="followup-type-badge">{t('Дополнительный запрос')}</span>{/if}{#if currentRun?.reconcile}<span class="followup-type-badge">{t('Разрешение конфликта')}</span>{/if}{#if visibleWorker(selectedTask)}{@render workerBadge(visibleWorker(selectedTask)!)}{:else}{@render providerBadge(visibleProvider(selectedTask), true)}{/if}{#if visibleUltracode(selectedTask)}<span class="ultracode-badge" title={t('Режим ultracode')}>ultracode</span>{/if}{@render priorityBadge(selectedTask.priority)}{#if selectedTask.latestRun?.mock}<span class="demo-badge">MOCK</span>{/if}{#if workflowSteps(selectedTask).length}<span class="workflow-type-badge">{t('Сложная задача')}</span>{/if}</div>{/if}
      <button class="icon-button" aria-label={t('Закрыть задачу')} disabled={followupSending || tagsSaving} onclick={closeDrawer}><Icon name="close" size={20} /></button>
    </header>
    {#if selectedTask}
      <div class="task-detail-layout">
      <section class="task-information" aria-label={t('Информация о задаче')}>
      <div class="drawer-heading">
        <h2 id="detail-title">{selectedTask.title}</h2><p class="detail-created">{t('Создано {time}', { time: dateTime(selectedTask.createdAt) })}</p>
        {#if currentRun?.progress}<p class="detail-progress" role="status"><Icon name="refresh" size={14} class="spin" /><span><strong>{t('Статус выполнения:')}</strong> {currentRun.progress.text}{' · '}<time datetime={new Date(currentRun.progress.updatedAt).toISOString()}>{t('с {time}', { time: clockTime(currentRun.progress.updatedAt) })}</time></span></p>{/if}
        {#if selectedTask.nextRunAt && !selectedTask.paused && selectedTask.archivedAt === null}<p class="detail-next-run"><Icon name="clock" size={14} /><span>{t('Следующий запуск {time}', { time: dateTime(selectedTask.nextRunAt) })}</span></p>{/if}
        <div class="detail-actions">
          {#if selectedTask.archivedAt !== null}
            <button class="button primary" disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'restore')}><Icon name={taskBusy ? 'refresh' : 'restore'} size={15} class={taskBusy ? 'spin' : ''} />{t('Восстановить')}</button>
            {#if !taskIsOccupied(selectedTask)}<button class="button secondary danger-hover" disabled={taskBusy || followupSending || tagsSaving} onclick={() => selectedTask && askDeleteTask(selectedTask)}><Icon name="trash" size={15} />{t('Удалить')}</button>{/if}
          {:else}
          {#if canStartManual(selectedTask)}
            <button class="button primary" disabled={taskBusy || integrationChecksMissing} onclick={() => selectedTask && act(selectedTask, 'run')}><Icon name={taskBusy ? 'refresh' : 'play'} size={15} class={taskBusy ? 'spin' : ''} />{selectedTask.runCount ? selectedTask.steps?.length ? t('Начать всю задачу заново') : t('Повторить запуск') : t('Запустить')}</button>
          {:else if selectedTask.status === 'cancelling'}<button class="button secondary" disabled><Icon name="refresh" class="spin" size={15} />{t('Останавливаем…')}</button>
          {:else if currentRun && currentRun.status !== 'completed' && taskIsOccupied(selectedTask)}<button class="button secondary danger-hover" disabled={taskBusy || (currentRun.status === 'interrupted' && !acknowledgeInterruption)} title={currentRun.status === 'interrupted' ? t('Сначала подтвердите ниже, что предыдущий процесс CLI остановлен') : undefined} onclick={() => selectedTask && act(selectedTask, 'cancel')}><Icon name="stop" size={14} />{t('Отменить запуск')}</button>{/if}
          <button class="button secondary" disabled={taskBusy} onclick={() => selectedTask && openEditor(selectedTask)}><Icon name="edit" size={15} />{t('Изменить')}</button>
          {#if !taskIsOccupied(selectedTask)}<button class="button secondary" disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'archive')}><Icon name="archive" size={15} />{t('В архив')}</button><button class="button secondary danger-hover" disabled={taskBusy || followupSending || tagsSaving} onclick={() => selectedTask && askDeleteTask(selectedTask)}><Icon name="trash" size={15} />{t('Удалить')}</button>{/if}
          {#if selectedTask.schedule !== 'manual'}{@const pauseLabel = selectedTask.schedule === 'auto' ? (selectedTask.paused ? t('Вернуть в очередь автопилота') : t('Отложить в автопилоте')) : selectedTask.paused ? t('Возобновить расписание') : t('Приостановить расписание')}<button class="icon-button schedule-pause" title={pauseLabel} aria-label={pauseLabel} disabled={taskBusy} onclick={() => selectedTask && act(selectedTask, 'pause')}><Icon name={selectedTask.paused ? 'play' : 'pause'} size={17} /></button>{/if}
          {/if}
        </div>
        {#if integrationChecksMissing}<p class="field-warning" role="status"><Icon name="alert" size={15} /><span>{t('Чтобы запустить или продолжить процесс, задайте BRIGD_INTEGRATION_CHECKS в')} <button class="inline-link" onclick={() => openSettings('autopilot')}>{t('настройках автопилота')}</button>.</span></p>{/if}
        {#if selectedTask.archivedAt !== null}<p class="archived-task-note"><Icon name="archive" size={16} /><span>{t('В архиве с {time}. Задача не показывается на доске и не запускается по расписанию. Восстановите её, чтобы продолжить работу.', { time: dateTime(selectedTask.archivedAt) })}</span></p>
        {:else if taskHasCompletedRun(selectedTask)}<p class="completed-task-help workflow-help">{t('В этой карточке уже есть завершённый запуск. Дополнительные запросы отправляются агенту из обсуждения.')}{#if selectedTask.schedule === 'interval'}{' '}{selectedTask.paused ? t('Расписание остаётся на паузе.') : t('Автоматические запуски по расписанию продолжаются.')}{/if}</p>{/if}
        {#if selectedTask.archivedAt === null && selectedTask.steps?.length && selectedTask.runCount && canStartManual(selectedTask)}<p class="workflow-help">{t('Новый запуск выполнит все этапы с начала по сохранённому плану. История предыдущих запусков останется.')}</p>{/if}
      </div>
      {#if selectedTask.status === 'cancelling'}<div class="cancelling-note" role="status"><Icon name="refresh" size={16} class="spin" /><span>{t('Ожидаем завершения процесса агента и его дочерних процессов.')} {taskHasCompletedRun(selectedTask) ? t('После остановки можно отправить дополнительный запрос в завершённую сессию.') : t('Новый запуск станет доступен после остановки.')} {t('Уже выполненные действия не откатываются.')}</span></div>{/if}
      {#if toast}<div class="drawer-notice {toast.type}" role={toast.type === 'error' ? 'alert' : 'status'}><Icon name={toast.type === 'error' ? 'alert' : 'circlecheck'} size={16} /><span>{toast.text}</span><button class="icon-button" aria-label={t('Закрыть уведомление')} onclick={() => toast = null}><Icon name="close" size={14} /></button></div>{/if}
      {#if detailError}<div class="detail-error" role="alert">{detailError}</div>{/if}
      <section class="task-tag-section" aria-label={t('Теги задачи')}>
        <div class="task-tag-heading"><h3><Icon name="tag" size={14} />{t('Теги')}</h3>{#if selectedTask.archivedAt === null && !editingTags}<button class="tag-edit-button" data-edit-task-tags disabled={taskBusy} onclick={() => selectedTask && openTaskTags(selectedTask)}><Icon name="edit" size={13} />{t('Изменить теги')}</button>{/if}</div>
        {#if editingTags && selectedTask.archivedAt === null}
          <TagPicker {tags} bind:selected={taskTagIds} disabled={tagsSaving} loading={tagsLoading} error={tagsError} onreload={loadTags} />
          {#if taskTagsError}<p class="tag-save-error" role="alert">{taskTagsError}</p>{/if}
          <div class="task-tag-actions"><button type="button" class="button secondary" disabled={tagsSaving} onclick={closeTaskTags}>{t('Отмена')}</button><button type="button" class="button primary" disabled={taskBusy || tagsLoading} onclick={() => selectedTask && saveTaskTags(selectedTask)}>{#if tagsSaving}<Icon name="refresh" size={14} class="spin" />{/if}{tagsSaving ? t('Сохраняем…') : t('Сохранить теги')}</button></div>
        {:else if selectedTask.tags?.length}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable regions need keyboard focus for native scrolling.) -->
          <div class="assigned-task-tags" role="region" aria-label={t('Назначенные теги')} tabindex="0">{@render taskTags(selectedTask)}</div>
        {:else}<p class="task-tags-empty">{t('Теги не назначены')}</p>{/if}
      </section>
      <section class="instruction-section"><h3>{selectedTask.steps?.length ? t('ОБЩАЯ ЦЕЛЬ ЗАДАЧИ') : t('ЗАДАНИЕ ДЛЯ АГЕНТА')}</h3><p>{selectedTask.instruction}</p></section>
      {#if selectedTask.attachments?.some(file => file.source === 'user')}<section class="task-attachments" aria-label={t('Файлы задачи')}><h3>{t('Файлы задачи')}</h3><AttachmentList attachments={selectedTask.attachments.filter(file => file.source === 'user')} taskId={selectedTask.id} author={attachmentAuthor} /></section>{/if}
      {#if detail?.attachments?.some(file => file.source === 'agent' && !file.commentId)}<section class="task-attachments" aria-label={t('Файлы агента')}><h3>{t('Файлы агента')}</h3><AttachmentList attachments={detail.attachments.filter(file => file.source === 'agent' && !file.commentId)} taskId={selectedTask.id} author={attachmentAuthor} /></section>{/if}
      {#if currentRun?.followup?.checkFailure}
        {@const failure = currentRun.followup.checkFailure}
        <section class="current-followup" aria-label={t('Возврат после упавшей проверки')}>
          <div class="followup-heading"><h3>{t('Возврат после упавшей проверки')}</h3>{@render statusBadge(currentRun.status)}</div>
          <p class="followup-stage">{currentRun.worker ? localWorker(currentRun.worker).name : providerName(currentRun.provider)} · {t('возврат {round} из {limit}', { round: failure.round, limit: CHECK_HANDBACK_LIMIT })}</p>
          <p class="followup-request"><code>{failure.argv.join(' ')}</code> · {t('код {code}', { code: String(failure.exitCode) })}</p>
          <p class="workflow-help">{t('brigd сам вернул задачу в сохранённую сессию работника: проверка слияния не прошла и при повторе, а на целевой ветке {branch} проходит. Работник продолжит на том же коде, на котором упала проверка, затем результат снова проверяется и сливается.', { branch: failure.targetBranch })}</p>
          {#if failure.output}<details class="integration-output"><summary>{failure.outputTruncated ? t('Вывод, переданный работнику: конец') : t('Вывод, переданный работнику')}</summary><pre>{failure.output}</pre></details>{/if}
        </section>
      {:else if currentRun?.followup}
        <section class="current-followup" aria-label={t('Дополнительный запрос')}>
          <div class="followup-heading"><h3>{t('Дополнительный запрос')}</h3>{@render statusBadge(currentRun.status)}</div>
          <p class="followup-stage">{currentRun.worker ? localWorker(currentRun.worker).name : providerName(currentRun.provider)}{#if followupStage(currentRun)} · {t('Этап {number}: {title}', { number: followupStage(currentRun)!.index + 1, title: followupStage(currentRun)!.title })}{/if}</p>
          <p class="followup-request">{currentRun.followup.request || t('Запрос с вложениями')}</p>
          <p class="workflow-help">{t('Продолжение сохранённой сессии. Остальные этапы не запускаются.')}</p>
        </section>
        {#if currentRun.followup.workflow?.steps.length}<div class="current-workflow"><WorkflowChecklist run={currentRun} historical /></div>{/if}
      {:else if currentRun?.reconcile}
        <section class="current-followup" aria-label={t('Разрешение конфликта')}>
          <div class="followup-heading"><h3>{t('Разрешение конфликта слияния')}</h3>{@render statusBadge(currentRun.status)}</div>
          <p class="followup-stage">{currentRun.worker ? localWorker(currentRun.worker).name : t('Интегратор')} · {t('целевая ветка {branch}', { branch: currentRun.reconcile.targetBranch })}{#if currentRun.reconcile.depth > 1} · {t('попытка {number}', { number: currentRun.reconcile.depth })}{/if}</p>
          {#if currentRun.reconcile.conflicts.length}<p class="followup-request">{currentRun.reconcile.conflicts.join('\n')}</p>{/if}
          <p class="workflow-help">{t('Целевая ветка объединена в worktree задачи. Интегратор разрешает конфликты в файлах, затем brigd создаёт merge-коммит и заново проверяет результат.')}</p>
        </section>
      {:else if currentRun?.steps?.length}<div class="current-workflow"><WorkflowChecklist run={currentRun} /></div>{/if}
      {#if selectedTask.steps?.length}
        <details class="workflow-template" open={!currentRun}><summary>{currentRun && selectedTask.schedule === 'interval' ? t('План следующего запуска по расписанию') : t('План задачи')}</summary><p class="workflow-help">{t('Все работники используют общую рабочую папку, цель задачи и общие инструкции. Этапы идут по порядку.')}</p><ol>{#each selectedTask.steps as step}{@const worker = workers.find(worker => worker.id === step.workerId)}<li><strong>{step.title}</strong><div class="workflow-template-worker">{#if worker}<WorkerAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={36} /><span>{worker.name}{#if worker.description?.trim()}<small class="worker-description">{worker.description}</small>{/if}</span>{:else}<span>{t('Работник недоступен')}</span>{/if}</div><p>{step.instruction}</p></li>{/each}</ol></details>
      {/if}
      {#if currentRun}<div class="current-run-instructions">{@render instructionSnapshot(currentRun)}</div>{/if}
      {#if currentRun}{@render workspaceNote(currentRun)}{/if}
      {#if currentRun?.integration}<IntegrationPanel integration={currentRun.integration} busy={taskBusy} launchBlocked={integrationChecksMissing} historical={selectedTask.archivedAt !== null} onaction={(action, acknowledgement) => integrationAction(currentRun!.id, action, acknowledgement)} />
      {:else if currentRun?.reconcile && !activeStatuses.includes(currentRun.status) && sourceIntegration}<IntegrationPanel integration={sourceIntegration} busy={taskBusy} launchBlocked={integrationChecksMissing} historical={selectedTask.archivedAt !== null} onaction={(action, acknowledgement) => integrationAction(currentRun!.reconcile!.sourceRunId, action, acknowledgement)} />{/if}
      {#if currentRun?.error}<div class="run-error"><Icon name="alert" size={17} /><div><strong>{t(labels[currentRun.status])}</strong><p>{serverText(currentRun.error)}</p></div></div>{/if}
      {#if currentRun?.status === 'interrupted' && !currentRun.sessionId && !currentRun.steps?.length}<div class="resume-warning">{t('Идентификатор сессии не сохранён.')} {taskHasCompletedRun(selectedTask) ? t('Продолжение недоступно. Для работы в новой сессии создайте отдельную задачу.') : t('Продолжение недоступно; отмените запуск, чтобы начать заново.')}</div><label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>{t('Я проверил(а), что предыдущий процесс CLI остановлен')}</span></label>{/if}
      {#if currentRun?.status === 'interrupted' && currentRun.steps?.slice((currentRun.currentStepIndex ?? -1) + 1).some(step => step.status === 'cancelled')}<div class="cancelling-note" role="status"><Icon name="alert" size={16} /><span>{t('Отмена уже запрошена. Продолжение касается только текущего этапа; остальные этапы отменены.')}</span></div>{/if}
      {#if runCanRetry && currentStep}
        <section class="workflow-retry-panel" aria-label={t('Повтор текущего этапа')}>
          <h3><Icon name="alert" size={18} />{interruptedWithoutSession ? t('Сессия прерванного этапа не сохранена') : t('Текущий этап остановлен')}</h3>
          <p class="current-step-context">{t('Этап {number}: {title}', { number: (currentRun?.currentStepIndex ?? 0) + 1, title: currentStep.title })} · {currentStep.worker.name}{#if currentStep.worker.description?.trim()}<small class="worker-description">{currentStep.worker.description}</small>{/if}</p>
          {#if interruptedWithoutSession}<p>{t('После сбоя прежний процесс CLI мог остаться запущенным. Остановите его и подтвердите это перед повтором или отменой запуска.')}</p>{/if}
          <p>{t('Повтор создаст новую сессию только для этого этапа. Завершённые этапы и сохранённые настройки останутся. Уже выполненные действия и изменения файлов не откатываются и могут повториться.')}</p>
          {#if currentRun?.status === 'blocked'}<p>{t('Устраните причину блокировки перед повтором. Эта кнопка не предоставляет агенту дополнительных разрешений.')}</p>{/if}
          {#if !taskHasCompletedRun(selectedTask)}<p>{t('Чтобы начать всю последовательность с первого этапа, сначала отмените этот запуск.')}</p>{/if}
          {#if interruptedWithoutSession}<label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>{t('Я проверил(а), что предыдущий процесс CLI остановлен')}</span></label>{/if}
          <button class="button primary" disabled={taskBusy || integrationChecksMissing || (interruptedWithoutSession && !acknowledgeInterruption)} onclick={() => selectedTask && act(selectedTask, 'retry')}><Icon name="refresh" size={15} />{taskBusy ? t('Запускаем…') : t('Повторить текущий этап')}</button>
        </section>
      {/if}
      </section>
      <section class="task-activity" aria-label={t('Комментарии и логи задачи')}>
      <div class="detail-tabs" role="tablist" aria-label={t('История задачи')}>
        <button id="conversation-tab" role="tab" tabindex={detailTab === 'conversation' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'conversation'} aria-controls="conversation-panel" class:active={detailTab === 'conversation'} onclick={() => detailTab = 'conversation'}><Icon name="message" size={15} />{t('Комментарии')}{#if currentRun?.status === 'waiting_input'}<span class="tab-attention" aria-label={t('Нужен ответ')}>!</span>{/if}</button>
        <button id="logs-tab" role="tab" tabindex={detailTab === 'logs' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'logs'} aria-controls="logs-panel" class:active={detailTab === 'logs'} onclick={() => detailTab = 'logs'}><Icon name="terminal" size={15} />{t('Логи')}</button>
        <button id="changes-tab" role="tab" tabindex={detailTab === 'changes' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'changes'} aria-controls="changes-panel" class:active={detailTab === 'changes'} onclick={() => detailTab = 'changes'}><Icon name="code" size={15} />{t('Изменения')}</button>
        <button id="history-tab" role="tab" tabindex={detailTab === 'history' ? 0 : -1} onkeydown={tabKey} aria-selected={detailTab === 'history'} aria-controls="history-panel" class:active={detailTab === 'history'} onclick={() => detailTab = 'history'}><Icon name="history" size={15} />{t('Запуски')}</button>
      </div>
      {#if !detail}<div class="detail-loading"><Icon name="refresh" class="spin" size={19} />{t('Загружаем историю…')}</div>{:else if detailTab === 'conversation'}
        <div id="conversation-panel" tabindex="0" role="tabpanel" aria-labelledby="conversation-tab" class="conversation-panel">{#each activity.comments as entry (entry.id)}<article class="comment-entry comment-{entry.kind}">{#if commentWorker(entry)}<WorkerAvatar name={commentWorker(entry)!.name} avatarUrl={commentWorker(entry)!.avatarUrl} size={40} />{:else}<span class="comment-avatar">{#if entry.kind === 'user'}{t('Я')}{:else if entry.kind === 'system'}<Icon name="terminal" size={14} />{:else if entry.kind === 'question'}<Icon name="message" size={14} />{:else}<Icon name="spark" size={14} />{/if}</span>{/if}<div class="comment-main"><div class="comment-meta"><span class="comment-author"><strong>{commentAuthor(entry)}</strong>{#if commentWorker(entry)?.description?.trim()}<small class="worker-description">{commentWorker(entry)!.description}</small>{/if}</span>{#if commentRun(entry)?.followup}<span class="comment-step-label">{t('Дополнительный запрос')}{#if followupStage(commentRun(entry)!)} · {t('Этап {number}', { number: followupStage(commentRun(entry)!)!.index + 1 })}{/if}</span>{:else if entry.stepIndex != null}<span class="comment-step-label">{t('Этап {number}', { number: entry.stepIndex + 1 })}</span>{/if}<time datetime={new Date(entry.createdAt).toISOString()}>{dateTime(entry.createdAt)}</time></div>{#if entry.body}<CommentBody body={entry.body} />{/if}<AttachmentList attachments={entry.attachments ?? []} taskId={selectedTask.id} label={t('Вложения сообщения')} author={attachmentAuthor} /></div></article>{:else}<div class="conversation-empty"><Icon name="message" size={25} /><strong>{t('У каждой задачи своя история')}</strong><p>{t('Здесь появятся сообщения агента, вопросы и результат.')}{#if selectedTask.archivedAt === null}<br />{t('Можно оставить заметку уже сейчас.')}{/if}</p></div>{/each}</div>
      {:else if detailTab === 'logs'}
        <div id="logs-panel" tabindex="0" role="tabpanel" aria-labelledby="logs-tab" class="logs-panel"><TaskLogs logs={activity.logs} runs={detail.runs} taskId={selectedTask.id} author={attachmentAuthor} /></div>
      {:else if detailTab === 'changes'}
        <div id="changes-panel" tabindex="0" role="tabpanel" aria-labelledby="changes-tab" class="changes-panel">{#key selectedTask.id}<CodeDiff runs={detail.runs} />{/key}</div>
      {:else}
        <div id="history-panel" tabindex="0" role="tabpanel" aria-labelledby="history-tab" class="history-panel">{#each detail.runs as run (run.id)}<article class="run-entry"><div class="run-heading"><span class="run-number"><Icon name={run.followup ? "message" : run.reconcile ? "refresh" : "play"} size={14} />{run.followup?.checkFailure ? t('Возврат после упавшей проверки') : run.followup ? t('Дополнительный запрос') : run.reconcile ? t('Разрешение конфликта') : t('Запуск')} {run.id.slice(0, 6)}</span>{@render statusBadge(run.status)}</div><div class="run-meta">{#if run.worker}{@render workerBadge(run.worker, true)}{:else}{@render providerBadge(run.provider, true)}{/if}<span>·</span><span>{dateTime(run.startedAt)}</span><span>·</span><span>{run.followup?.checkFailure ? t('Автоматически') : run.trigger === 'followup' ? t('Из обсуждения') : run.trigger === 'reconcile' ? t('Конфликт слияния') : run.trigger === 'schedule' ? t('По расписанию') : run.trigger === 'autopilot' ? t('Автопилот') : t('Вручную')}</span><span>·</span><span>{elapsed(run)}</span>{#if run.mock}<span class="demo-badge">MOCK</span>{/if}</div>{#if run.followup?.checkFailure}<div class="run-followup-request"><strong>{t('Возврат после упавшей проверки · {round} из {limit}', { round: run.followup.checkFailure.round, limit: CHECK_HANDBACK_LIMIT })}</strong><p><code>{run.followup.checkFailure.argv.join(' ')}</code> · {t('код {code}', { code: String(run.followup.checkFailure.exitCode) })} · {t('целевая ветка {branch}', { branch: run.followup.checkFailure.targetBranch })}</p></div>{:else if run.followup}<div class="run-followup-request"><strong>{t('Запрос')}{#if followupStage(run)} · {t('Этап {number}: {title}', { number: followupStage(run)!.index + 1, title: followupStage(run)!.title })}{/if}</strong><p>{run.followup.request || t('Запрос с вложениями')}</p></div>{:else if run.reconcile}<div class="run-followup-request"><strong>{t('Целевая ветка: {branch}', { branch: run.reconcile.targetBranch })}</strong>{#if run.reconcile.conflicts.length}<ul class="integration-conflicts">{#each run.reconcile.conflicts as path}<li><code>{path}</code></li>{/each}</ul>{/if}</div>{/if}{#if run.reconcile}<div class="run-followup-request"><strong>{t('Целевая ветка {branch}', { branch: run.reconcile.targetBranch })}{#if run.reconcile.depth > 1} · {t('попытка {number}', { number: run.reconcile.depth })}{/if}</strong>{#if run.reconcile.conflicts.length}<p>{run.reconcile.conflicts.join('\n')}</p>{/if}</div>{/if}{#if run.summary}<p>{run.summary}</p>{/if}{#if run.error}<p class="run-history-error">{serverText(run.error)}</p>{/if}{#if run.steps?.length}<WorkflowChecklist {run} />{:else if run.followup?.workflow?.steps.length}<WorkflowChecklist {run} historical />{/if}{@render instructionSnapshot(run)}{@render workspaceNote(run)}{#if run.integration}<IntegrationPanel integration={run.integration} historical />{/if}<div class="run-details">{t('Ход {turn}', { turn: run.turn })}{#if run.worker}<span> · {t('Усилия: {effort}', { effort: t(effortLabel(run.worker.effort)) })}</span>{/if}{#if runUltracode(run)}<span> · ultracode</span>{/if}{#if run.sessionId}<span title={run.sessionId}> · {t('Сессия {id}…', { id: run.sessionId.slice(0, 14) })}</span>{/if}</div></article>{:else}<div class="conversation-empty"><Icon name="history" size={25} /><strong>{t('Запусков пока нет')}</strong><p>{t('Запустите задачу, чтобы увидеть её историю.')}</p></div>{/each}</div>
      {/if}
      {#if runCanResume && !interruptedWithoutSession}
        <form class="resume-panel" hidden={detailTab !== 'conversation'} onpaste={(event) => answerComposer?.handlePaste(event)} onsubmit={(event) => { event.preventDefault(); if (selectedTask && (answer.trim() || answerAttachmentCount || currentRun?.status === 'interrupted' || currentRun?.timeLimitExceeded)) void act(selectedTask, 'resume', answer); }}>
          <div class="resume-title"><Icon name={currentRun?.status === 'interrupted' ? 'alert' : 'message'} size={18} /><strong>{currentRun?.timeLimitExceeded ? t('Превышен лимит времени хода') : currentRun?.status === 'interrupted' ? t('Запуск был прерван') : t('Агенту нужен ваш ответ')}</strong></div>
          {#if currentStep}<p class="current-step-context">{t('Этап {number}: {title}', { number: (currentRun?.currentStepIndex ?? 0) + 1, title: currentStep.title })} · {currentStep.worker.name}{#if currentStep.worker.description?.trim()}<small class="worker-description">{currentStep.worker.description}</small>{/if}</p>{/if}
          <p>{currentRun?.status === 'interrupted' ? t('Прежний процесс CLI мог остаться запущенным после сбоя. Остановите его перед продолжением. Уже выполненные действия и изменения файлов не откатываются.') : currentStep ? t('Ответ получит работник текущего этапа в той же сессии. Следующие этапы ждут его завершения.') : t('Ответ будет передан агенту в ту же сессию, и работа продолжится.')}</p>
            {#if currentRun?.status === 'interrupted'}<label class="interruption-confirm"><input type="checkbox" bind:checked={acknowledgeInterruption} disabled={taskBusy} /><span>{t('Я проверил(а), что предыдущий процесс CLI остановлен')}</span></label>{/if}
          {#if !currentRun?.sessionId && (!currentRun?.mock || currentRun?.followup)}<div class="resume-warning">{t('Идентификатор сессии не сохранён.')} {taskHasCompletedRun(selectedTask) ? t('Продолжение недоступно. Для работы в новой сессии создайте отдельную задачу.') : t('Продолжение недоступно; отмените запуск, чтобы начать заново.')}</div>
          {:else}<label class="sr-only" for="resume-answer">{t('Ответ агенту')}</label><textarea id="resume-answer" bind:value={answer} maxlength="8000" rows="3" placeholder={currentRun?.status === 'interrupted' ? t('Что учесть при продолжении? (необязательно)') : t('Напишите ответ или уточнение…')} required={currentRun?.status === 'waiting_input' && !answerAttachmentCount} disabled={taskBusy}></textarea>
            {#key `${drawerContext}:${inputRunKey}`}<AttachmentComposer bind:this={answerComposer} label={t('Файлы ответа')} disabled={taskBusy} bind:count={answerAttachmentCount} bind:uploading={answerUploading} bind:invalid={answerAttachmentInvalid} />{/key}
            <button class="button primary" type="submit" disabled={taskBusy || integrationChecksMissing || answerUploading || answerAttachmentInvalid || (currentRun?.status === 'waiting_input' && !answer.trim() && !answerAttachmentCount) || (currentRun?.status === 'interrupted' && !acknowledgeInterruption)}><Icon name="arrow" size={15} />{taskBusy ? t('Отправляем…') : t('Продолжить работу')}</button>
          {/if}
        </form>
      {/if}
      {#if detail && selectedTask.archivedAt !== null}<p class="archived-comment-note" hidden={detailTab !== 'conversation'}><Icon name="archive" size={15} />{t('Задача в архиве. Восстановите её, чтобы оставить заметку или отправить агенту дополнительный запрос.')}</p>
      {:else if detail}<form class="comment-form" hidden={detailTab !== 'conversation'} onpaste={(event) => commentComposer?.handlePaste(event)} onsubmit={sendComment}>
        <label for="task-comment">{t('Заметка к задаче')}</label>
        {#key drawerContext}<AttachmentComposer compact bind:this={commentComposer} label={t('Файлы заметки')} disabled={taskBusy} bind:count={commentAttachmentCount} bind:uploading={commentUploading} bind:invalid={commentAttachmentInvalid} bind:attachmentIds={commentAttachmentIds}>
          <textarea id="task-comment" bind:value={comment} maxlength="8000" placeholder={t('Добавьте заметку или новое задание агенту…')} rows="3" disabled={taskBusy}></textarea>
          {#snippet footer(attachFiles)}
            {#if followupError}<div class="followup-error" role="alert"><p>{followupError}</p>{#if retryingFollowup}<p>{t('Текст и файлы сохранены. Повторная отправка этого же запроса защищена от дублирования.')}</p>{/if}</div>{/if}
            <div class="comment-actions">
              {@render attachFiles()}
              <button class="button secondary" type="submit" title={t('Сохранить текст и файлы в истории задачи без запуска агента.') + (runCanResume ? ' ' + t('Для ответа на текущий вопрос используйте «Продолжить работу» выше.') : '')} disabled={(!comment.trim() && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid}><Icon name="check" size={16} />{t('Сохранить заметку')}</button>
              {#if recipientOptions.length}
                <div class="followup-send-actions" class:has-picker={recipientOptions.length > 1 || !followupTarget}>
                  <button class="button primary" type="button" title={followupBlocked || t('Отправить текст и файлы в сессию: {session}. Агент продолжит работу с прежними настройками. Остальные этапы не запускаются.', { session: recipientLabel(followupTarget!) })} onclick={() => void sendFollowup()} disabled={(!comment.trim() && !commentAttachmentCount) || taskBusy || commentUploading || commentAttachmentInvalid || !!followupBlocked}><Icon name={followupSending ? 'refresh' : 'send'} class={followupSending ? 'spin' : ''} size={16} />{followupSending ? t('Отправляем…') : t('Отправить агенту')}</button>
                  {#if recipientOptions.length > 1 || !followupTarget}
                    <details class="followup-session-picker" bind:open={followupRecipientOpen}>
                      <summary class="button primary" aria-label={t('Выбрать сессию агента')} aria-disabled={taskBusy} title={t('Выбрать завершённую сессию')} onclick={(event) => { if (taskBusy) event.preventDefault(); }}><Icon name="down" size={16} /></summary>
                      <div class="followup-session-menu">
                        <label for="followup-recipient">{t('Получатель дополнительного запроса')}</label>
                        <select id="followup-recipient" value={followupTarget?.key ?? ''} disabled={taskBusy} onchange={(event) => { followupTargetKey = event.currentTarget.value; followupError = ''; followupRecipientOpen = false; drawer.querySelector<HTMLElement>('.followup-session-picker summary')?.focus(); }}>
                          {#if !followupTarget}<option value="" disabled>{t('Выберите завершённую сессию')}</option>{/if}
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
    {:else}<div class="detail-loading"><Icon name="refresh" class="spin" />{t('Загружаем задачу…')}</div>{/if}
  </div>
</dialog>

<dialog bind:this={deleteDialog} class="editor-dialog instruction-delete-dialog" aria-labelledby="task-delete-title" aria-describedby="task-delete-description" oncancel={(event) => { event.preventDefault(); closeDelete(); }} onclick={(event) => backdropClick(event, deleteDialog, closeDelete)}>
  {#if deleting}
    <form class="editor-form" onsubmit={confirmDelete} aria-busy={removing}>
      <header class="editor-header"><h2 id="task-delete-title">{deleting.kind === 'task' ? t('Удалить задачу навсегда?') : t('Удалить все задачи из архива?')}</h2><button type="button" class="icon-button" aria-label={t('Закрыть удаление')} disabled={removing} onclick={closeDelete}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if deleteError}<div class="form-error" role="alert"><Icon name="alert" size={17} /><span>{deleteError}</span></div>{/if}
        <p id="task-delete-description">{#if deleting.kind === 'task'}{t('«{title}» будет удалена', { title: deleting.task.title })}{:else}{deleting.count} {plural(deleting.count, 'задача будет удалена', 'задачи будут удалены', 'задач будут удалены')}{/if} {t('без возможности восстановления вместе с историей запусков, обсуждением, логами и файлами.')} {t('Рабочие папки запусков освободит очистка в Настройки → Хранилище; ветки Git в проекте не удаляются.')}</p>
      </div>
      <footer class="editor-footer"><button type="button" data-cancel-delete class="button secondary" disabled={removing} onclick={closeDelete}>{t('Отмена')}</button><button type="submit" class="button danger" disabled={removing}>{#if removing}<Icon name="refresh" class="spin" size={16} />{/if}{removing ? t('Удаляем…') : deleting.kind === 'task' ? t('Удалить навсегда') : t('Удалить все')}</button></footer>
    </form>
  {/if}
</dialog>

<dialog class="settings-dialog" bind:this={settings} aria-labelledby="settings-title" oncancel={(event) => { event.preventDefault(); closeSettings(); }} onclick={(event) => backdropClick(event, settings, closeSettings)}>
  <div class="settings-frame">
    <header class="settings-header"><h2 id="settings-title">{t('Настройки')}</h2><button class="icon-button" aria-label={t('Закрыть настройки')} disabled={settingsMutationPending} onclick={closeSettings}><Icon name="close" size={21} /></button></header>
    <div class="settings-layout">
      <div class="settings-nav" role="tablist" aria-label={t('Разделы настроек')} aria-orientation="vertical">
        {#each settingsSections as section (section.id)}
          <button id="settings-{section.id}-tab" role="tab" tabindex={settingsSection === section.id ? 0 : -1} onkeydown={settingsTabKey} aria-selected={settingsSection === section.id} aria-controls="settings-{section.id}-panel" class:active={settingsSection === section.id} onclick={() => settingsSection = section.id}><Icon name={section.icon} size={17} /><span>{t(section.label)}</span></button>
        {/each}
      </div>
      <!-- Inactive panels stay mounted so unsaved drafts survive switching sections. -->
      <div id="settings-general-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-general-tab" hidden={settingsSection !== 'general'}>
        {#if settingsOpen}<GeneralSettings settings={generalSettings} loading={generalSettingsLoading} error={generalSettingsError} retry={() => { void loadGeneralSettings(); }} onchange={generalSettingsChanged} onmutation={generalSettingsMutationStarted} {workers} bind:busy={generalSettingsMutationPending} />{/if}
      </div>
      <div id="settings-language-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-language-tab" hidden={settingsSection !== 'language'}>
        <fieldset class="theme-settings">
          <legend>{t('Язык интерфейса')}</legend>
          <p id="language-description">{t('Выбор сохраняется в этом браузере. Задачи, комментарии и ответы агентов остаются на языке, на котором написаны.')}</p>
          <div class="theme-options language-options">
            {#each locales as option (option.id)}
              <label class="theme-option language-option" class:selected={getLocale() === option.id}>
                <input type="radio" name="locale" value={option.id} checked={getLocale() === option.id} onchange={() => selectLocale(option.id)} aria-describedby="language-description" />
                <span class="theme-name" lang={option.id}>{option.label}</span>
              </label>
            {/each}
          </div>
        </fieldset>
        {#if localeSaveError}<p class="settings-warning" role="status">{t('Язык изменён, но браузер не разрешил сохранить выбор. После перезагрузки выберите язык снова.')}</p>{/if}
      </div>
      <div id="settings-appearance-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-appearance-tab" hidden={settingsSection !== 'appearance'}>
        <fieldset class="theme-settings">
          <legend>{t('Цветовая схема')}</legend>
          <p id="theme-description">{t('Выбор сохраняется в этом браузере.')}</p>
          {#each themeGroups as group (group.scheme)}
            <h3 class="theme-group-title">{t(group.label)}</h3>
            <div class="theme-options">
              {#each themes.filter(option => option.colorScheme === group.scheme) as option (option.id)}
                <label class="theme-option" class:selected={theme === option.id}>
                  <input type="radio" name="theme" value={option.id} checked={theme === option.id} onchange={() => selectTheme(option.id)} aria-label={t(option.label)} aria-describedby="theme-description" />
                  <span class="theme-preview" aria-hidden="true">{#each option.preview as color}<span style:background={color}></span>{/each}</span>
                  <span class="theme-name">{t(option.label)}</span>
                </label>
              {/each}
            </div>
          {/each}
        </fieldset>
        {#if themeSaveError}<p class="settings-warning" role="status">{t('Тема изменена, но браузер не разрешил сохранить выбор. После перезагрузки выберите тему снова.')}</p>{/if}
      </div>
      <div id="settings-models-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-models-tab" hidden={settingsSection !== 'models'}>
        {#if settingsOpen}<ModelSettings {models} loading={modelsLoading} error={modelsError} retry={() => { void loadModels(); }} onchange={modelChanged} ondelete={modelDeleted} bind:busy={modelMutationPending} />{/if}
      </div>
      <div id="settings-permissions-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-permissions-tab" hidden={settingsSection !== 'permissions'}>
        {#if settingsOpen}<CliSetup />{/if}
      </div>
      <div id="settings-autopilot-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-autopilot-tab" hidden={settingsSection !== 'autopilot'}>
        {#if settingsOpen}<AutopilotSettings settings={autopilotSettings} loading={autopilotSettingsLoading} error={autopilotSettingsError} retry={() => { void loadAutopilotSettings(); }} onchange={autopilotSettingsChanged} onmutation={autopilotSettingsMutationStarted} bind:busy={autopilotSettingsMutationPending} /><CheckTriageSettings active={settingsSection === 'autopilot'} bind:busy={checkTriageMutationPending} />{/if}
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
      <header class="editor-header"><div><h2 id="editor-title">{editingId ? t('Редактировать задачу') : t('Новая задача')}</h2></div><button class="icon-button" type="button" aria-label={t('Закрыть форму')} disabled={submitting} onclick={closeEditor}><Icon name="close" size={21} /></button></header>
      <div class="editor-fields">
        {#if formError}<div class="form-error" role="alert"><Icon name="alert" size={17} />{formError}</div>{/if}
        {#if editingId && selectedTask && taskIsOccupied(selectedTask)}<div class="form-note">{t('Изменения применятся к следующему запуску. Текущий запуск сохраняет план этапов, работников, настройки, инструкции и рабочую папку. Для повтора этапа используется сохранённый план.')}</div>{/if}
        <label class="form-field"><span>{t('Название задачи')} <span class="required">*</span></span><input bind:value={formTitle} name="title" placeholder={t('Например, проверить новые изменения')} required maxlength="140" disabled={submitting} /></label>
        <TagPicker {tags} bind:selected={formTagIds} disabled={submitting} loading={tagsLoading} error={tagsError} onreload={loadTags} />
        <label class="form-field"><span>{t('Приоритет')}</span><select name="priority" aria-label={t('Приоритет')} bind:value={formPriority} aria-describedby="task-priority-help" disabled={submitting}>{#each TASK_PRIORITIES as priority (priority)}<option value={priority}>{t(TASK_PRIORITY_LABELS[priority])}</option>{/each}</select><small id="task-priority-help">{t('Автопилот первой берёт задачу с более высоким приоритетом; при равном приоритете — по порядку очереди.')}</small></label>
        <div class="task-type-switch" role="group" aria-label={t('Тип задачи')}><button type="button" class:selected={!formComplex} aria-pressed={!formComplex} disabled={submitting} onclick={() => formComplex = false}>{t('Простая задача')}</button><button type="button" class:selected={formComplex} aria-pressed={formComplex} disabled={submitting} onclick={() => formComplex = true}>{t('Сложная задача')}</button></div>
        {#if formComplex}<p class="workflow-help">{t('Одна общая цель, несколько работников по очереди. Порядок и задания можно изменить до запуска.')}</p>{/if}
        <label class="form-field"><span>{formComplex ? t('Общая цель и ограничения') : t('Что нужно сделать?')} <span class="required">*</span></span><textarea bind:value={formInstruction} name="instruction" maxlength="16000" rows="4" placeholder={t('Опишите результат, важные детали и ограничения. Агент получит эту инструкцию при каждом запуске.')} required disabled={submitting}></textarea></label>
        {#key editorContext}<AttachmentComposer bind:this={formComposer} initial={formAttachments} label={t('Файлы задачи')} disabled={submitting} bind:count={formAttachmentCount} bind:uploading={formUploading} bind:invalid={formAttachmentInvalid} />{/key}
        {#if !formComplex}
        <label class="form-field"><span>{t('Работник')}</span><select name="workerId" aria-label={t('Работник')} bind:value={formWorkerId} onchange={() => { formUltracode = null; }} disabled={submitting || workersLoading}><option value="">{t('Без работника — выбрать провайдера вручную')}</option>{#each workers.filter(worker => !worker.archived || worker.id === formOriginalWorker?.id) as worker (worker.id)}<option value={worker.id}>{worker.name} · {providerName(worker.provider)}{worker.archived ? ` (${t('в архиве')})` : ''}</option>{/each}{#if formOriginalWorker && !workers.some(worker => worker.id === formOriginalWorker?.id)}<option value={formOriginalWorker.id}>{formOriginalWorker.name}{formOriginalWorker.archived ? ` (${t('в архиве')})` : ''}</option>{/if}</select><small>{t('Профили можно создать и настроить в разделе «Работники».')}</small></label>
        {#if formWorker}
          <div class="worker-assignment">{@render workerBadge(formWorker)}<div class="worker-assignment-meta"><span>{t('Усилия: {effort}', { effort: t(effortLabel(formWorker.effort)) })}</span></div></div>
          {#if formWorker.archived}<p class="field-warning"><Icon name="inbox" size={15} />{t('Работник в архиве. Можно сохранить это назначение, выбрать другого или убрать работника. Для новых назначений сначала восстановите профиль.')}</p>{/if}
        {:else}
        <fieldset class="provider-options"><legend>{t('Агент')}</legend>{#each ['codex', 'claude'] as agent}<label class:selected={formProvider === agent}><input type="radio" bind:group={formProvider} value={agent} disabled={submitting} /><span class="agent-option-logo {agent}">{#if agent === 'codex'}<Icon name="code" size={20} />{:else}<span class="claude-mark">✳</span>{/if}</span><span><strong>{providerName(agent as Provider)}</strong><small>{info?.mode === 'mock' ? t('Демо-адаптер') : info?.providers.find(p => p.id === agent)?.available ? t('CLI доступен') : t('CLI не найден')}</small></span><span class="radio-indicator">{#if formProvider === agent}<span></span>{/if}</span></label>{/each}</fieldset>
        {/if}
        {#if info?.mode === 'cli' && !providerAvailable}<p class="field-warning"><Icon name="alert" size={14} />{t('CLI выбранного агента не найден. Задачу можно сохранить, но для запуска потребуется установить и авторизовать CLI.')}</p>{/if}
        {:else}<WorkflowEditor bind:steps={formSteps} {workers} originalWorkerIds={formOriginalStepWorkers} disabled={submitting} loading={workersLoading} onworkerchange={() => { formUltracode = null; }} unavailableProviders={info?.mode === 'cli' ? info.providers.filter(provider => !provider.available).map(provider => provider.id) : []} />{/if}
        <div class="form-field"><label class="task-ultracode-option"><input name="ultracode" type="checkbox" checked={formUltracodeChecked} indeterminate={formUltracodeMixed} aria-describedby="task-ultracode-help" disabled={submitting} onchange={(event) => { formUltracode = event.currentTarget.checked; }} /><span>ultracode</span></label><small id="task-ultracode-help">{#if formUltracode === null}{#if formComplex}{formUltracodeMixed ? t('Сейчас как в профилях работников: у части этапов режим ultracode включён, у остальных нет.') : formProfileUltracode.length ? formUltracodeChecked ? t('Как в профилях работников этапов: режим ultracode включён.') : t('Как в профилях работников этапов: режим ultracode выключен.') : t('Как в профилях работников этапов.')}{:else if formWorker}{formUltracodeChecked ? t('Как в профиле работника: режим ultracode включён.') : t('Как в профиле работника: режим ultracode выключен.')}{:else}{t('Без работника режим ultracode определяют настройки установленного CLI. Поставьте галочку, чтобы включить режим для этой задачи, или поставьте и снимите её, чтобы явно выключить.')}{/if}{#if formComplex || formWorker}{' '}{t('Поставьте или снимите галочку, чтобы задать режим для этой задачи.')}{/if}{:else}{ultracodeOverrideNote()} <button type="button" class="inline-link" disabled={submitting} onclick={() => { formUltracode = null; }}>{formComplex ? t('Вернуть как в профилях работников') : formWorker ? t('Вернуть как в профиле работника') : t('Вернуть настройку CLI')}</button>{/if} {t('Нужна поддержка режима установленным CLI.')}</small></div>
        {#if workersError}<div class="field-warning"><span>{t('Не удалось обновить список работников.')} {!formComplex ? t('Можно выбрать модель вручную.') : t('Проверьте подключения и повторите загрузку.')}</span><button type="button" onclick={() => { void loadWorkers(); }}>{t('Повторить')}</button></div>{/if}
        <label class="form-field"><span>{t('Рабочая папка')} <span class="required">*</span></span><div class="input-with-icon"><Icon name="folder" size={16} /><input bind:value={formCwd} name="cwd" maxlength="4096" placeholder="/workspace/projects/my-project" required disabled={submitting} spellcheck="false" /></div><small>{formComplex ? t('Одна общая папка для всех этапов. Следующий работник увидит файлы предыдущего.') : t('Абсолютный путь к папке, в которой будет работать агент.')}</small></label>
        <label class="form-field"><span>{t('Лимит времени, мин')}</span><input type="number" name="timeLimitMinutes" min="1" max="1440" step="1" bind:value={formTimeLimitMinutes} disabled={submitting} /><small>{t('Пусто — общая настройка. Лимит фиксируется отдельно для каждого нового хода агента.')}</small></label>
        <div class="schedule-section"><div class="schedule-title"><span class="schedule-title-icon"><Icon name="clock" size={18} /></span><div><strong>{t('Когда запускать')}</strong><span>{t('Вручную, регулярно или из очереди автопилота')}</span></div></div><div class="schedule-switch"><button type="button" class:selected={formSchedule === 'auto'} aria-pressed={formSchedule === 'auto'} disabled={submitting} onclick={() => formSchedule = 'auto'}><Icon name="moon" size={14} />{t('Автопилот')}</button><button type="button" class:selected={formSchedule === 'manual'} aria-pressed={formSchedule === 'manual'} disabled={submitting} onclick={() => formSchedule = 'manual'}><Icon name="play" size={14} />{t('Вручную')}</button><button type="button" class:selected={formSchedule === 'interval'} aria-pressed={formSchedule === 'interval'} disabled={submitting} onclick={() => formSchedule = 'interval'}><Icon name="clock" size={14} />{t('По расписанию')}</button></div>{#if formSchedule === 'interval'}<div class="schedule-fields"><label class="form-field"><span>{t('Повторять каждые')}</span><div class="input-suffix"><input type="number" bind:value={formInterval} name="intervalMinutes" min="1" max="525600" step="1" required disabled={submitting} /><span>{t('минут')}</span></div></label><label class="form-field"><span>{t('Первый запуск')}</span><input type="datetime-local" bind:value={formFirstRun} name="firstRunAt" disabled={submitting} /><small>{t('Пусто: сразу после сохранения. Местное время.')}</small></label></div><label class="pause-option"><input type="checkbox" bind:checked={formPaused} disabled={submitting} /><span>{t('Сохранить расписание на паузе')}</span></label><p class="schedule-note">{t('Планировщик работает, пока запущен сервер brigd. Активные запуски одной задачи не накладываются.')}</p>{/if}{#if formSchedule === 'auto'}<label class="pause-option"><input type="checkbox" bind:checked={formPaused} disabled={submitting} /><span>{t('Пока отложить: не брать из очереди')}</span></label><p class="schedule-note">{t('Задача встанет в очередь автопилота и запустится, когда дойдёт её очередь и освободится место. Включить автопилот на ночь можно в разделе «Автопилот».')}</p>{/if}</div>
        {#if info?.mode === 'mock'}<div class="editor-mode-note"><Icon name="spark" size={14} /><span>{t('Демо-режим: реальные CLI не вызываются.')}</span></div>{:else}<div class="editor-mode-note"><Icon name="terminal" size={14} /><span>{t('Агент может изменять файлы в рабочей папке согласно инструкции.')}</span></div>{/if}
      </div>
      <footer class="editor-footer"><button type="button" class="button secondary" onclick={closeEditor} disabled={submitting}>{t('Отмена')}</button><button type="submit" class="button primary" disabled={submitting || formUploading || formAttachmentInvalid}>{#if submitting}<Icon name="refresh" class="spin" size={16} />{:else}<Icon name={editingId ? 'check' : 'plus'} size={16} />{/if}{submitting ? t('Сохраняем…') : editingId ? t('Сохранить изменения') : t('Создать задачу')}</button></footer>
    </form>
  {/if}
</dialog>

{#if toast && !selectedId}<div class="toast {toast.type}" role={toast.type === 'error' ? 'alert' : 'status'}><span><Icon name={toast.type === 'error' ? 'alert' : 'circlecheck'} size={18} /></span><p>{toast.text}</p><button class="icon-button" aria-label={t('Закрыть уведомление')} onclick={() => toast = null}><Icon name="close" size={16} /></button></div>{/if}
