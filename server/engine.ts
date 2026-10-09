import type { Run } from '../src/lib/types';
import { startAgent, buildPrompt, type AgentHandle, type AgentInput, type AgentCallbacks } from './adapter';
import { AppError, Store, runFence, type RunFence } from './store';
import { validateEnvelope, validateSessionId } from './protocol';
import { workflowContext } from './workflows';

export type AgentFactory = (input: AgentInput, callbacks: AgentCallbacks) => AgentHandle;
interface Launch { handle: AgentHandle | null; fence: RunFence; cancelRequested: boolean; settled?: Promise<void>; }
export class Engine {
  private handles = new Map<string, Launch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  constructor(readonly store: Store, readonly mock = false, private factory: AgentFactory = startAgent) {}
  startScheduler() {
    if (this.timer || this.closing) return;
    this.store.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1_000);
  }
  tick(now = Date.now()) {
    if (this.closing) return;
    for (const run of this.store.claimDue(this.mock, now)) this.launch(run);
  }
  start(taskId: string): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    const run = this.store.startManual(taskId, this.mock);
    this.launch(run);
    return this.store.getRun(run.id);
  }
  resume(runId: string, answer: string, acknowledgement: boolean): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    if (this.handles.has(runId)) throw new AppError('Предыдущий CLI-процесс ещё завершается', 409);
    const run = this.store.resume(runId, answer, acknowledgement);
    this.launch(run, answer);
    return this.store.getRun(run.id);
  }
  retry(runId: string, acknowledgement = false): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    if (this.handles.has(runId)) throw new AppError('Предыдущий CLI-процесс ещё завершается', 409);
    const run = this.store.retry(runId, acknowledgement);
    this.launch(run);
    return this.store.getRun(run.id);
  }
  cancel(runId: string, acknowledgement = false): Run {
    const launch = this.handles.get(runId);
    const result = this.store.cancel(runId, Date.now(), !!launch, acknowledgement);
    if (launch) {
      launch.cancelRequested = true;
      launch.handle?.cancel();
    }
    return result;
  }
  private launch(run: Run, answer?: string) {
    const fence = runFence(run);
    if (this.closing || this.handles.has(run.id) || !this.store.isCurrent(run.id, fence)) return;
    // Reserve before invoking a factory: even synchronous callback/cancel paths
    // cannot launch another worker or lose a cancellation before the handle exists.
    const launch: Launch = { handle: null, fence, cancelRequested: false };
    this.handles.set(run.id, launch);
    const isCurrent = () => this.store.isCurrent(run.id, fence);
    const release = () => { if (this.handles.get(run.id) === launch) this.handles.delete(run.id); };
    let handle: AgentHandle;
    try {
      const workflow = workflowContext(run);
      const input: AgentInput = { provider: run.provider, cwd: run.cwd, instruction: run.instruction, instructions: run.instructions,
        effort: run.worker?.effort ?? 'default', communicationStyle: run.worker?.communicationStyle ?? '',
        sessionId: run.sessionId ?? undefined, answer, mock: run.mock, ...(workflow ? { workflow } : {}) };
      buildPrompt(input); // Enforce the complete UTF-8 bound before even a custom factory.
      if (!isCurrent() || launch.cancelRequested || this.closing) {
        this.store.completeCancellation(run.id, Date.now(), fence);
        release();
        return;
      }
      handle = this.factory(input, {
        onSession: id => { if (isCurrent()) this.store.setSession(run.id, id, fence); },
        onComment: body => { if (isCurrent()) this.store.comment(run.taskId, run.id, 'agent', body.slice(0, 16_000), Date.now(), run.currentStepIndex); }
      });
      launch.handle = handle;
      if (launch.cancelRequested || this.closing || !isCurrent()) handle.cancel();
    } catch (error) {
      this.fail(run, fence, error);
      this.store.completeCancellation(run.id, Date.now(), fence);
      release();
      return;
    }
    launch.settled = handle.result.then(({ envelope: rawEnvelope, sessionId: rawSessionId }) => {
      if (!isCurrent()) return;
      const envelope = validateEnvelope(rawEnvelope);
      const sessionId = validateSessionId(rawSessionId);
      let next: Run | null = null;
      this.store.db.transaction(() => {
        if (!isCurrent()) return;
        this.store.setSession(run.id, sessionId, fence);
        const status = envelope.status === 'needs_input' ? 'waiting_input' : envelope.status;
        const result = this.store.finish(run.id, status, envelope.summary, status === 'blocked' ? envelope.summary : null, Date.now(), fence);
        this.store.comment(run.taskId, run.id, status === 'completed' ? 'result' : 'agent', envelope.summary, Date.now(), run.currentStepIndex);
        for (const question of envelope.questions) this.store.comment(run.taskId, run.id, 'question', question, Date.now(), run.currentStepIndex);
        if (result.status === 'running' && result.turn !== run.turn) next = result;
      }).immediate();
      // The old process has settled. Its later finally must never remove or
      // complete cancellation of a newer step/attempt occupying this same run.
      release();
      if (next) this.launch(next);
    }).catch(error => this.fail(run, fence, error)).finally(() => {
      this.store.completeCancellation(run.id, Date.now(), fence);
      release();
    });
  }
  private fail(run: Run, fence: RunFence, error: unknown) {
    if (!this.store.isCurrent(run.id, fence)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.store.db.transaction(() => {
      this.store.finish(run.id, 'failed', null, message.slice(0, 16_000), Date.now(), fence);
      this.store.comment(run.taskId, run.id, 'system', message.slice(0, 16_000), Date.now(), run.currentStepIndex);
    }).immediate();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    // Persist uncertainty before terminating. No automatic replay after restart.
    this.store.reconcile();
    const launches = [...this.handles.values()];
    for (const launch of launches) { launch.cancelRequested = true; launch.handle?.cancel(); }
    await Promise.allSettled(launches.map(launch => launch.settled ?? launch.handle?.result ?? Promise.resolve()));
  }
}
