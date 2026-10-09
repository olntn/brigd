export type Provider = 'codex' | 'claude';
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface WorkerInput {
  name: string;
  provider: Provider;
  effort: Effort;
  communicationStyle: string;
  avatarUrl: string | null;
}
export interface Worker extends WorkerInput {
  id: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
/** Immutable identity and execution settings captured when a run starts. */
export interface WorkerSnapshot extends WorkerInput { id: string; }

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
export interface TaskInput {
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
  workerId: string | null;
  worker: Worker | null;
  id: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  status: TaskStatus;
  latestRun: Run | null;
  runCount: number;
}
export interface Run {
  instructions: InstructionSnapshot[];
  workerId: string | null;
  worker: WorkerSnapshot | null;
  id: string;
  taskId: string;
  provider: Provider;
  cwd: string;
  instruction: string;
  trigger: 'manual' | 'schedule';
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
  id: string;
  taskId: string;
  runId: string | null;
  kind: 'user' | 'agent' | 'question' | 'system' | 'result';
  body: string;
  createdAt: number;
}
export interface TaskDetail { task: Task; runs: Run[]; comments: Comment[]; }
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
