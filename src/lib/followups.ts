import type { FollowupInput, Provider, Run, RunStep, Task, WorkerSnapshot } from './types';

export interface FollowupTarget {
  key: string;
  sourceRunId: string;
  sourceStepIndex: number | null;
  worker: WorkerSnapshot | null;
  provider: Provider;
  sessionId: string | null;
  startedAt: number;
  stageIndex: number | null;
  stageTitle: string | null;
  isFollowup: boolean;
}

/** Frozen workflow context is display-only; a follow-up always has zero executable steps. */
export function runWorkflowSteps(run: Run | null | undefined): RunStep[] {
  return run?.steps?.length ? run.steps : run?.followup?.workflow?.steps ?? [];
}

export function followupStage(run: Run): { index: number; title: string } | null {
  const workflow = run.followup?.workflow;
  const step = workflow?.steps[workflow.currentStepIndex];
  return workflow && step ? { index: workflow.currentStepIndex, title: step.title } : null;
}

/** One choice per native session, using its newest completed run and frozen identity. */
export function followupTargets(runs: Run[]): FollowupTarget[] {
  const result: FollowupTarget[] = [];
  const sessions = new Set<string>();
  for (const run of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    if (run.status !== 'completed') continue;
    const add = (target: FollowupTarget) => {
      const session = target.sessionId ? `${target.provider}:${target.sessionId}` : null;
      if (session && sessions.has(session)) return;
      if (session) sessions.add(session);
      result.push(target);
    };
    if (run.steps?.length) {
      // The final completed stage is the natural default for a finished chain.
      for (let index = run.steps.length - 1; index >= 0; index--) {
        const step = run.steps[index];
        if (step.status !== 'completed') continue;
        add({ key: `${run.id}:${index}`, sourceRunId: run.id, sourceStepIndex: index,
          worker: step.worker, provider: step.worker.provider, sessionId: step.sessionId,
          startedAt: run.startedAt, stageIndex: index, stageTitle: step.title, isFollowup: false });
      }
    } else {
      const stage = followupStage(run);
      add({ key: `${run.id}:scalar`, sourceRunId: run.id, sourceStepIndex: null,
        worker: run.worker, provider: run.provider, sessionId: run.sessionId,
        startedAt: run.startedAt, stageIndex: stage?.index ?? null, stageTitle: stage?.title ?? null,
        isFollowup: !!run.followup });
    }
  }
  return result;
}

/** Stable field order, including attachment order, prevents changed drafts reusing a request ID. */
export function followupFingerprint(input: Omit<FollowupInput, 'requestId'>): string {
  return JSON.stringify({ sourceRunId: input.sourceRunId, sourceStepIndex: input.sourceStepIndex,
    body: input.body, attachmentIds: input.attachmentIds });
}

/** Older cached responses lack the persisted flag, but completed/follow-up runs still prove completion. */
export function taskHasCompletedRun(task: Task): boolean {
  return task.hasCompletedRun === true || task.status === 'completed' || task.latestRun?.status === 'completed' || !!task.latestRun?.followup;
}

export function followupSessionKey(target: FollowupTarget): string {
  return target.sessionId ? `${target.provider}:${target.sessionId}` : '';
}

/** A replaced run key must keep an open draft addressed to the same native session. */
export function resolveFollowupTarget(targets: FollowupTarget[], selectedKey: string, selectedSession: string): FollowupTarget | null {
  return targets.find(target => target.key === selectedKey)
    ?? (selectedSession ? targets.find(target => followupSessionKey(target) === selectedSession) : null)
    ?? (!selectedKey && !selectedSession ? targets[0] : null) ?? null;
}
