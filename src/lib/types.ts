export type Provider = 'codex' | 'claude';
/** Immutable file metadata. Content is fetched only through the scoped attachment route. */
export interface Attachment {
  id: string;
  taskId: string | null;
  commentId: string | null;
  runId: string | null;
  stepIndex: number | null;
  attemptId: string | null;
  source: 'user' | 'agent';
  name: string;
  mime: string;
  size: number;
  sha256: string;
  previewable: boolean;
  createdAt: number;
}
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ModelCatalogInput {
  provider: Provider;
  modelId: string;
  label: string;
}
/** A selectable preset; worker/run model IDs deliberately have no catalog foreign key. */
export interface ModelCatalogEntry extends ModelCatalogInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
export interface WorkerInput {
  name: string;
  /** Display-only profile text; never passed to the agent as instructions. */
  description?: string | null;
  provider: Provider;
  /** null/omitted keeps the native CLI default; explicit IDs are frozen per run. */
  model?: string | null;
  /** Enables the provider's ultra agent mode; omitted creation inputs default to false. */
  ultracode?: boolean;
  effort: Effort;
  communicationStyle: string;
  avatarUrl: string | null;
  /** The worker that picks up a fresh run when this one's provider reports exhausted usage limits; null follows Настройки → Общие. */
  fallbackWorkerId?: string | null;
}
export interface Worker extends WorkerInput {
  model: string | null;
  description: string;
  ultracode: boolean;
  fallbackWorkerId: string | null;
  id: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
/** Immutable identity and execution settings captured when a run starts. */
export interface WorkerSnapshot extends WorkerInput { id: string; model: string | null; description: string; ultracode: boolean; }
/** How the built-in integrator chooses its CLI: the merged run's settings, or its own saved ones. */
export type IntegratorMode = 'inherit' | 'custom';
export interface IntegratorProfileInput {
  mode: IntegratorMode;
  /** Used only in custom mode; kept in inherit mode so switching back restores the last choice. */
  provider: Provider;
  model?: string | null;
  effort: Effort;
  /** Guidance for conflict resolution, passed to the agent like a worker's personal instructions. */
  communicationStyle: string;
  avatarUrl: string | null;
}
export interface IntegratorProfile extends IntegratorProfileInput { model: string | null; updatedAt: number; }

/** Which worker picks up a fresh run when a provider's CLI reports exhausted usage limits; null leaves the run failed. */
export interface FallbackWorkers { codex: string | null; claude: string | null; }
export interface GeneralSettings {
  webhookUrl: string;
  webhookSecret: string;
  /** null leaves agent turns unlimited; a task may override this value. */
  agentTimeLimitMinutes: number | null;
  /** Per invocation of a merge-check command; null leaves it unlimited. */
  integrationCheckTimeLimitMinutes: number | null;
  defaultCwd: string;
  defaultSchedule: DefaultSchedule;
  /** Preselected in the form of a new single-worker card; an archived profile is skipped there. */
  defaultWorkerId: string | null;
  fallbackWorkers: FallbackWorkers;
}

export interface BackupEntry {
  id: string;
  name: string;
  source: 'manual' | 'upload' | 'update';
  createdAt: number;
  size: number;
  selected: boolean;
  autoUpdate: boolean;
  updatedAt: number;
}
export interface BackupOverview { backups: BackupEntry[]; selectedId: string | null; }

export interface AutopilotSettings {
  integrationChecks: string[][] | null;
  source: 'settings' | 'environment' | null;
}

export interface ConcurrencyLimits {
  /** Agent processes and merge checks running at once across all repositories. */
  maxParallel: number;
  /** Agents working at once in one repository, each in its own worktree. */
  maxPerRepository: number;
}
/** Effective limits: a saved value wins over the service's start-up value. */
export interface ConcurrencySettings extends ConcurrencyLimits {
  /** Values saved in the app; null follows `defaults`. */
  saved: { maxParallel: number | null; maxPerRepository: number | null };
  /** BRIGD_MAX_PARALLEL / BRIGD_MAX_PER_REPOSITORY of the running service, or the built-in 4 and 1. */
  defaults: ConcurrencyLimits;
}
export interface ResultTransferSettings {
  mode: 'automatic' | 'manual';
  manualWait: 'continue' | 'wait';
}

export interface InstructionInput {
  title: string;
  body: string;
  enabled: boolean;
}
export interface Instruction extends InstructionInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
/** Reusable guidance frozen when a run is created, never reloaded on resume. */
export interface InstructionSnapshot { id: string; title: string; body: string; }

export interface TagInput { name: string; color?: string; }
export interface Tag extends TagInput {
  color: string;
  id: string;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = 'queued' | 'preparing' | 'running' | 'cancelling' | 'waiting_input' | 'completed' | 'blocked' | 'failed' | 'interrupted' | 'cancelled';
export type TaskStatus = 'ready' | RunStatus | 'awaiting_manual_transfer' | 'awaiting_merge' | 'integrating' | 'merge_conflict' | 'merge_failed' | 'merge_blocked' | 'merge_interrupted';
export interface TaskStepInput {
  workerId: string;
  title: string;
  instruction: string;
}
export type RunStepStatus = 'pending' | RunStatus;
export interface StepAttempt {
  id: string;
  number: number;
  status: RunStatus;
  sessionId: string | null;
  turn: number;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
}
export interface RunStep extends TaskStepInput {
  worker: WorkerSnapshot;
  status: RunStepStatus;
  sessionId: string | null;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  attempts: StepAttempt[];
}
/** How urgent a card is; the autopilot claims a more urgent card first. */
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';
/** manual waits for a start; interval repeats from the first run; daily runs at a local time on chosen weekdays; auto joins the autopilot queue. */
export type TaskSchedule = 'manual' | 'interval' | 'daily' | 'auto';
/** The launch modes the general settings can preselect; a daily time is always chosen per card. */
export type DefaultSchedule = Exclude<TaskSchedule, 'daily'>;
export interface TaskInput {
  /** Automatic starts wait for a successful and (for worktrees) merged latest result. */
  dependsOnTaskIds?: string[];
  /** null/omitted follows the general agent time limit on each new turn. */
  timeLimitMinutes?: number | null;
  tagIds?: string[];
  attachmentIds?: string[];
  steps?: TaskStepInput[];
  workerId?: string | null;
  title: string;
  instruction: string;
  provider: Provider;
  cwd: string;
  /** true/false forces the provider's ultra agent mode for the task's new runs; null or omitted follows each worker's profile. */
  ultracode?: boolean | null;
  /** Omitted on creation means normal; omitted on update keeps the saved priority. */
  priority?: TaskPriority;
  /** auto: the autopilot starts the task when its turn comes and a slot is free. */
  schedule: TaskSchedule;
  intervalMinutes: number | null;
  firstRunAt: number | null;
  /** daily only: local 24-hour "HH:MM" in timeZone; null for other schedules, and always present in a saved task. */
  timeOfDay?: string | null;
  /** daily only: ISO weekdays in ascending order, 1 is Monday and 7 is Sunday; omitted on input means every day. */
  weekdays?: number[] | null;
  /** daily only: the IANA zone timeOfDay is read in, e.g. Europe/Moscow; omitted on input means the server's zone. */
  timeZone?: string | null;
  paused: boolean;
}
export interface Task extends TaskInput {
  dependsOnTaskIds: string[];
  /** Computed by Store, shared by the scheduler and UI. */
  dependencies: TaskDependency[];
  priority: TaskPriority;
  tagIds: string[];
  tags: Tag[];
  /** Once completed, new work continues a saved session instead of rerunning. */
  hasCompletedRun?: boolean;
  attachments?: Attachment[];
  steps: TaskStepInput[];
  workerId: string | null;
  worker: Worker | null;
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Set while the task is archived: hidden from the board, never scheduled, read-only. */
  archivedAt: number | null;
  nextRunAt: number | null;
  status: TaskStatus;
  /** Why a new execution is waiting for a manual result of this repository. */
  launchWaitReason?: string | null;
  latestRun: Run | null;
  runCount: number;
}
/** A prerequisite and the readiness of its latest result. */
export interface TaskDependency {
  taskId: string;
  title: string;
  satisfied: boolean;
  archived: boolean;
}
/** A deliberately requested new turn in a completed run's exact saved session. */
export interface FollowupInput {
  sourceRunId: string;
  sourceStepIndex: number | null;
  body: string;
  attachmentIds: string[];
  requestId: string;
}
export interface RunFollowup {
  sourceRunId: string;
  sourceStepIndex: number | null;
  request: string;
  /** Historical context only. These stages are never scheduled again. */
  workflow: { steps: RunStep[]; currentStepIndex: number } | null;
  /** Present when brigd itself handed the result back after a failed merge check; the request is then brigd's own text. */
  checkFailure?: RunCheckFailure;
}
/** A merge check that failed on the result, failed again on its rerun and passes on the target branch. */
export interface RunCheckFailure {
  integrationId: string;
  /** This hand-back's number for the result, 1 to CHECK_HANDBACK_LIMIT. */
  round: number;
  targetBranch: string;
  /** The target commit the failing candidate was built on; merged into the worktree before the worker resumes. */
  targetCommit: string;
  argv: string[];
  /** The rerun's exit code. */
  exitCode: number;
  /** The end of the rerun's output with terminal control sequences removed, at most CHECK_HANDBACK_OUTPUT_LIMIT characters. */
  output: string;
  outputTruncated: boolean;
}
/** A built-in integrator turn that resolves a merge conflict of an earlier result in its worktree. */
export interface RunReconcile {
  sourceRunId: string;
  integrationId: string;
  targetBranch: string;
  targetCommit: string | null;
  /** Conflicted paths relative to the worktree root; refreshed when the merge is prepared. */
  conflicts: string[];
  /** 1 for the first resolution of a result; grows when a resolved result conflicts again. */
  depth: number;
}
/** The stage of work the agent reported for its current turn, e.g. «Написание кода». Display-only. */
export interface RunProgress {
  text: string;
  updatedAt: number;
}
/**
 * What one CLI turn reported about its consumption. null means the CLI did not say: Codex reports no cost,
 * older CLIs report nothing. inputTokens counts every input token including those read from the prompt cache;
 * cachedTokens is the cached part of it.
 */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
}
/** One recorded agent turn: its reported usage and the time brigd measured from the CLI start to its end. */
export interface TurnUsage extends TokenUsage {
  runId: string;
  turn: number;
  /** The workflow step and its attempt; null for a run without steps. */
  stepIndex: number | null;
  attemptId: string | null;
  provider: Provider;
  workerId: string | null;
  trigger: Run['trigger'];
  durationMs: number;
  startedAt: number;
  finishedAt: number;
}
/** Sums over recorded turns. A token or cost sum is null when no turn reported it. */
export interface UsageTotals extends TokenUsage {
  turns: number;
  /** Turns whose CLI reported a cost; fewer than `turns` means the cost covers only part of the work. */
  pricedTurns: number;
  durationMs: number;
}
/** A worker's recorded turns, including those of deleted tasks. */
export interface WorkerUsage { workerId: string; recent: UsageTotals | null; total: UsageTotals; }
export interface WorkerUsageOverview {
  /** Start of the recent window: 30 days before the response. */
  recentSince: number;
  workers: WorkerUsage[];
}
export interface Run {
  /** Sums over the run's recorded turns; absent until a turn has ended. */
  usage?: UsageTotals;
  /** Every recorded turn, oldest first; only in task details and the run reading tool. */
  turnUsage?: TurnUsage[];
  /** A failed turn stopped by its saved deadline; its native session may be continued manually. */
  timeLimitExceeded?: boolean;
  /** Effective limit frozen for this turn, including continuations; null means unlimited. */
  timeLimitMinutes?: number | null;
  integration?: Integration | null;
  workspace?: WorkspaceSnapshot | null;
  followup?: RunFollowup | null;
  reconcile?: RunReconcile | null;
  inputAttachments?: Attachment[];
  steps: RunStep[];
  currentStepIndex: number | null;
  instructions: InstructionSnapshot[];
  workerId: string | null;
  worker: WorkerSnapshot | null;
  /** The task's ultracode choice frozen at start; null keeps the worker snapshot's own setting (or the CLI default without a worker). */
  ultracode?: boolean | null;
  /** The turn a replacement worker started after the previous one's usage limits ran out; null when nobody was replaced. */
  fallbackTurn?: number | null;
  /** Set by the agent through set_progress during the current turn; null when the run is not running or a new turn has started. */
  progress?: RunProgress | null;
  id: string;
  taskId: string;
  provider: Provider;
  cwd: string;
  instruction: string;
  trigger: 'manual' | 'schedule' | 'followup' | 'reconcile' | 'autopilot';
  scheduledFor: number | null;
  status: RunStatus;
  sessionId: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  turn: number;
  mock: boolean;
}
/** Persisted before preparation; retained for exact-session continuations. */
export interface WorkspaceSnapshot {
  id: string;
  repositoryId: string;
  projectCwd: string;
  repositoryRoot: string;
  path: string;
  cwd: string;
  branch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  mode: 'worktree' | 'direct';
  prepared: boolean;
  checkCommands?: string[][];
  lastIntegratedCommit?: string | null;
  /** When brigd itself removed the worktree folder; a continuation can recreate its branch from lastIntegratedCommit. */
  removedAt?: number | null;
  /** What removed it: the merge of its result, or the storage clean-up. */
  removedBy?: 'merge' | 'cleanup' | null;
  /** When a continuation last recreated the folder from the branch; untracked and ignored files from before are gone. */
  recreatedAt?: number | null;
}
/** Why a folder under the workspaces root is kept or may be reclaimed. */
export type StorageReason = 'active' | 'interrupted' | 'conflict' | 'failed' | 'unmerged' | 'submodules' | 'moved' | 'foreign' | 'merged' | 'cancelled' | 'deleted' | 'stale' | 'unknown';
export interface StorageEntry {
  path: string;
  kind: 'worktree' | 'candidate' | 'unknown';
  bytes: number;
  files: number;
  retained: boolean;
  reason: StorageReason;
  /** Retained by default, but the clean-up may take it when asked to include candidates of failed checks. */
  optional?: boolean;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  /** When the latest run of the folder started. */
  startedAt: number | null;
}
export interface StorageOverview {
  /** false in demo mode and for injected providers: no worktrees are created, nothing to reclaim. */
  available: boolean;
  /** Why the folder cannot be managed, when it cannot. */
  note: string | null;
  root: string | null;
  totalBytes: number;
  reclaimableBytes: number;
  retainedBytes: number;
  entries: StorageEntry[];
  /** Merged task branches that cleanup can remove, including those whose folders are already gone. */
  reclaimableBranches: string[];
  scannedAt: number;
}
export interface StorageCleanupResult {
  removed: number;
  removedBranches: number;
  freedBytes: number;
  failures: { path: string; error: string }[];
  overview: StorageOverview;
}
export type IntegrationStatus = 'awaiting_manual' | 'skipped' | 'queued' | 'checking' | 'merging' | 'cancelling' | 'merged' | 'conflict' | 'failed' | 'blocked' | 'interrupted' | 'cancelled';
export interface Integration {
  id: string;
  runId: string;
  repositoryId: string;
  status: IntegrationStatus;
  attempt: number;
  rechecks?: number;
  sourceCommit: string | null;
  targetCommit: string | null;
  resultCommit: string | null;
  candidatePath: string | null;
  /** Paths that failed to merge automatically, relative to the repository root. */
  conflicts?: string[];
  checks: IntegrationCheck[];
  /** What brigd did on its own after a check exited non-zero in this attempt; absent when every check passed at once or triage is off. */
  triage?: CheckTriage | null;
  error: string | null;
  updatedAt: number;
}
export interface IntegrationCheck {
  argv: string[];
  exitCode: number;
  /** The end of the command's stdout and stderr in arrival order, at most CHECK_OUTPUT_LIMIT bytes of UTF-8. Absent in records saved before output was kept. */
  output?: string;
  /** The beginning of the output was cut to fit the limit. */
  outputTruncated?: boolean;
}
/** How a failed merge check ended once brigd had rerun it and checked the target branch; decided by exit codes alone, without a model. */
export type CheckTriageOutcome =
  /** The command fails on the current target commit as well: the target branch is broken, the task is not returned. */
  | 'target_failed'
  /** The result was handed back to the worker's saved session. */
  | 'returned'
  /** The result was already handed back CHECK_HANDBACK_LIMIT times; a person decides. */
  | 'limit'
  /** The worker's run has no saved CLI session to continue. */
  | 'no_session'
  /** A multi-stage run: brigd cannot tell which stage to hand the failure to. */
  | 'workflow'
  /** Switched off in the settings after the triage had started. */
  | 'disabled'
  /** The hand-back could not be created, e.g. the task was archived or another run started meanwhile. */
  | 'error'
  /** The rerun and target check together ran past the time limit. */
  | 'timeout'
  /** The service restarted during the triage. */
  | 'interrupted'
  /** The merge was cancelled or blocked before the triage decided. */
  | 'stopped';
export interface CheckTriage {
  /** The step running now; 'done' once the outcome is known or every failed command passed on its rerun. */
  stage: 'retry' | 'target' | 'done';
  startedAt: number;
  /** Reruns and the target check of one attempt share this budget; a command still running past it is stopped. */
  limitMs: number;
  /** Time already spent on reruns and the target check. */
  spentMs: number;
  /** One rerun of each failed command, in the same candidate; exitCode is null while it runs. */
  retries: CheckRetry[];
  /** The failed command, preceded by the commands before it, on the current target commit in a clean worktree. */
  target: TargetCheck | null;
  /** Automatic hand-backs of this result to its worker; null until the outcome needs it. */
  handback: CheckHandback | null;
  /** null while the triage runs, and when every failed command passed on its rerun. */
  outcome: CheckTriageOutcome | null;
}
export interface CheckRetry {
  /** Index of the retried command in `checks`. */
  check: number;
  exitCode: number | null;
  output?: string;
  outputTruncated?: boolean;
}
export interface TargetCheck {
  commit: string;
  /** Commands run on the target so far, in order; the last one decides. */
  checks: TriageCommand[];
  /** null while running or when stopped by the time limit. */
  passed: boolean | null;
}
/** A command run during triage; exitCode is null while it runs or once the time limit stopped it. */
export interface TriageCommand {
  argv: string[];
  exitCode: number | null;
  output?: string;
  outputTruncated?: boolean;
}
export interface CheckHandback {
  /** Automatic hand-backs of this result so far, including the one created now. */
  returns: number;
  limit: number;
  /** The follow-up run created by this hand-back. */
  runId: string | null;
}
/** Outcomes of failed-check triage, by kind. */
export interface CheckTriageCounts {
  /** Results whose failed command passed on its rerun. */
  flaky: number;
  targetFailed: number;
  returned: number;
  /** The limit of automatic hand-backs was reached. */
  exhausted: number;
  /** No saved session, a multi-stage run, switched off, or the hand-back could not be created. */
  notReturned: number;
  /** Time limit, restart or cancellation. */
  stopped: number;
}
export interface CheckTriageSettings {
  enabled: boolean;
  /** The saved choice; null follows `defaultEnabled`. */
  saved: boolean | null;
  defaultEnabled: boolean;
  timeLimitMinutes: number;
  handbackLimit: number;
  /** Since the database was created. */
  counts: CheckTriageCounts;
}
export interface Comment {
  attachments?: Attachment[];
  stepIndex: number | null;
  id: string;
  taskId: string;
  runId: string | null;
  kind: 'user' | 'agent' | 'question' | 'system' | 'result';
  body: string;
  createdAt: number;
}
export interface TaskLog {
  id: string;
  taskId: string;
  runId: string | null;
  stepIndex: number | null;
  kind: string;
  summary: string;
  details: string[];
  error?: string;
  createdAt: number;
}
export type TaskLogInput = Pick<TaskLog, 'kind' | 'summary' | 'details' | 'error'>;
export interface TaskDetail { task: Task; runs: Run[]; comments: Comment[]; logs?: TaskLog[]; attachments?: Attachment[]; }
export interface AppInfo {
  mode: 'mock' | 'cli';
  cwd: string;
  providers: { id: Provider; available: boolean; label: string }[];
  scheduler: 'running';
  startedAt: number;
}
export interface Envelope {
  status: 'needs_input' | 'completed' | 'blocked';
  summary: string;
  questions: string[];
}
/** One CLI's permission setup as brigd sees it in the service user's home. */
export interface CliConfigStatus {
  provider: Provider;
  /** Absolute path of the file the button edits or checks. */
  path: string;
  exists: boolean;
  /** Every required entry is present in the file: allow rules for Claude, the mirrored sandbox settings for Codex. */
  ready: boolean;
  /** Codex: whether auth.json exists. Claude: not checked. */
  login: boolean | null;
  missing: string[];
  present: string[];
  notes: string[];
  error: string | null;
}
export interface CliConfigReport { status: CliConfigStatus; added: string[]; backup: string | null; }
export interface CliConfigOverview { claude: CliConfigStatus; codex: CliConfigStatus; }
export type CliAccessMode = 'standard' | 'full';
export interface CliAccessSettings { mode: CliAccessMode; }
export type AutopilotStopReason = 'manual' | 'until' | 'failures' | 'restart';
export interface AutopilotInput {
  enabled: boolean;
  /** Stop claiming new tasks at this time; running work finishes on its own. null: until switched off. */
  until: number | null;
}
/** The single autopilot switch. A session starts when it is enabled; attempts, the failure counter and the report count from there. */
export interface AutopilotState extends AutopilotInput {
  startedAt: number | null;
  stoppedAt: number | null;
  stopReason: AutopilotStopReason | null;
  /** Consecutive failed or blocked autopilot runs in the current session. */
  failures: number;
  updatedAt: number;
}
export interface AutopilotOverview extends AutopilotState {
  /** Tasks the autopilot will start next, in claim order: higher priority first, then the arranged queue order. */
  pool: Task[];
  /** Runs the autopilot started in the current or last session. */
  attempts: Run[];
  /** Failed-check triage of the session's tasks, over every run of those tasks since the session started. */
  triage: CheckTriageCounts;
  /** Turns of the session's tasks that started during the session; null before the first one ends. */
  usage: UsageTotals | null;
}

export type DocBlockType = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bulleted' | 'numbered' | 'todo' | 'quote' | 'code' | 'divider'
  | 'callout' | 'toggle' | 'table' | 'image' | 'toc' | 'task';
export type DocCalloutColor = 'gray' | 'blue' | 'green' | 'yellow' | 'red';
/** One editable unit of a documentation page. Text is inline Markdown; code blocks keep raw text; an image's text is its caption. */
export interface DocBlock {
  id: string;
  type: DocBlockType;
  text: string;
  /** Nesting level from 0; a collapsed toggle hides the deeper blocks that follow it. Omitted when 0. */
  indent?: number;
  /** todo only. */
  checked?: boolean;
  /** code only: a display hint, never executed. */
  language?: string;
  /** callout only. */
  icon?: string;
  color?: DocCalloutColor;
  /** toggle only. */
  collapsed?: boolean;
  /** table only: rows of inline Markdown cells, every row the same length. */
  rows?: string[][];
  header?: boolean;
  /** image only: a stored page image, or null until the upload finishes. */
  imageId?: string | null;
  /** task only: a task card by full ID, or null until one is chosen. */
  taskId?: string | null;
}
/** Metadata of an image stored with a documentation page; bytes are served by their own route. */
export interface DocImage {
  id: string;
  pageId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}
export interface DocSearchHit {
  id: string;
  parentId: string | null;
  title: string;
  /** Matched fragment with the hits wrapped in square brackets. */
  snippet: string;
}
/** A page attached to a task; the run keeps the id and the title at start, the agent reads the live content. */
export interface DocPageSummary {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Set while the page sits in the trash together with the subtree deleted with it. */
  deletedAt: number | null;
}
export interface DocPage extends DocPageSummary {
  blocks: DocBlock[];
  /** Grows with every content save; a save carrying an older version is rejected. */
  version: number;
}
export interface DocPageCreateInput { title?: string; parentId?: string | null; /** Initial content for API callers; the UI starts empty. */ markdown?: string; }
export interface DocPageContentInput { title: string; blocks: DocBlock[]; version: number; }
/** Reorders among siblings or moves under another page; omitted fields keep their value. */
export interface DocPageMoveInput { parentId?: string | null; position?: number; }
/** Markdown export of a page for agents and files. */
export interface DocPageExport { id: string; parentId: string | null; title: string; childIds: string[]; updatedAt: number; markdown: string; }
/** Whole-content replacement from Markdown; omitted fields keep their value. */
export interface DocPageMarkdownInput { title?: string; markdown?: string; }
