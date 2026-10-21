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
}
export interface Worker extends WorkerInput {
  model: string | null;
  description: string;
  ultracode: boolean;
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

export interface GeneralSettings {
  defaultCwd: string;
  defaultSchedule: TaskInput['schedule'];
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
export type TaskStatus = 'ready' | RunStatus | 'awaiting_merge' | 'integrating' | 'merge_conflict' | 'merge_failed' | 'merge_blocked' | 'merge_interrupted';
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
export interface TaskInput {
  tagIds?: string[];
  /** Documentation pages the agent should read as reference material. */
  docPageIds?: string[];
  attachmentIds?: string[];
  steps?: TaskStepInput[];
  workerId?: string | null;
  title: string;
  instruction: string;
  provider: Provider;
  cwd: string;
  /** true/false forces the provider's ultra agent mode for the task's new runs; null or omitted follows each worker's profile. */
  ultracode?: boolean | null;
  /** auto: the autopilot starts the task when its turn comes and a slot is free. */
  schedule: 'manual' | 'interval' | 'auto';
  intervalMinutes: number | null;
  firstRunAt: number | null;
  paused: boolean;
}
export interface Task extends TaskInput {
  tagIds: string[];
  tags: Tag[];
  /** Live titles of the attached pages; pages in the trash are left out. */
  docPages?: DocReference[];
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
  latestRun: Run | null;
  runCount: number;
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
export interface Run {
  integration?: Integration | null;
  workspace?: WorkspaceSnapshot | null;
  followup?: RunFollowup | null;
  reconcile?: RunReconcile | null;
  inputAttachments?: Attachment[];
  steps: RunStep[];
  currentStepIndex: number | null;
  instructions: InstructionSnapshot[];
  /** Pages attached to the task when the run started. */
  docs?: DocReference[];
  workerId: string | null;
  worker: WorkerSnapshot | null;
  /** The task's ultracode choice frozen at start; null keeps the worker snapshot's own setting (or the CLI default without a worker). */
  ultracode?: boolean | null;
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
}
export type IntegrationStatus = 'queued' | 'checking' | 'merging' | 'cancelling' | 'merged' | 'conflict' | 'failed' | 'blocked' | 'interrupted' | 'cancelled';
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
  checks: { argv: string[]; exitCode: number }[];
  error: string | null;
  updatedAt: number;
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
  /** Tasks the autopilot will start next, in claim order. */
  pool: Task[];
  /** Runs the autopilot started in the current or last session. */
  attempts: Run[];
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
export interface DocReference { id: string; title: string; }
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
