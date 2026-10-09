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
  effort: Effort;
  communicationStyle: string;
  avatarUrl: string | null;
}
export interface Worker extends WorkerInput {
  model: string | null;
  description: string;
  id: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
/** Immutable identity and execution settings captured when a run starts. */
export interface WorkerSnapshot extends WorkerInput { id: string; model: string | null; description: string; }

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

export type RunStatus = 'running' | 'cancelling' | 'waiting_input' | 'completed' | 'blocked' | 'failed' | 'interrupted' | 'cancelled';
export type TaskStatus = 'ready' | RunStatus;
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
  attachmentIds?: string[];
  steps?: TaskStepInput[];
  workerId?: string | null;
  title: string;
  instruction: string;
  provider: Provider;
  cwd: string;
  schedule: 'manual' | 'interval';
  intervalMinutes: number | null;
  firstRunAt: number | null;
  paused: boolean;
}
export interface Task extends TaskInput {
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
export interface Run {
  followup?: RunFollowup | null;
  inputAttachments?: Attachment[];
  steps: RunStep[];
  currentStepIndex: number | null;
  instructions: InstructionSnapshot[];
  workerId: string | null;
  worker: WorkerSnapshot | null;
  id: string;
  taskId: string;
  provider: Provider;
  cwd: string;
  instruction: string;
  trigger: 'manual' | 'schedule' | 'followup';
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
  createdAt: number;
}
export type TaskLogInput = Pick<TaskLog, 'kind' | 'summary' | 'details'>;
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
