import type { Run } from '../src/lib/types';
import { startAgent, type AgentHandle, type AgentInput, type AgentCallbacks } from './adapter';
import { AppError, Store } from './store';

export type AgentFactory = (input: AgentInput, callbacks: AgentCallbacks) => AgentHandle;
export class Engine {
  private handles = new Map<string, AgentHandle>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  constructor(readonly store: Store, readonly mock = false, private factory: AgentFactory = startAgent) {}
  startScheduler() {
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
    const run = this.store.resume(runId, answer, acknowledgement);
    this.launch(run, answer);
    return this.store.getRun(run.id);
  }
  cancel(runId: string): Run {
    const handle = this.handles.get(runId);
    const result = this.store.cancel(runId, Date.now(), !!handle);
    handle?.cancel();
    return result;
  }
  private launch(run: Run, answer?: string) {
    const isCurrent = () => this.store.getRun(run.id).status === 'running' && this.store.getRun(run.id).turn === run.turn;
    let handle: AgentHandle;
    try {
      handle = this.factory({ provider: run.provider, cwd: run.cwd, instruction: run.instruction, instructions: run.instructions,
        effort: run.worker?.effort ?? 'default', communicationStyle: run.worker?.communicationStyle ?? '',
        sessionId: run.sessionId ?? undefined, answer, mock: run.mock }, {
        onSession: id => { if (isCurrent()) this.store.setSession(run.id, id); },
        onComment: body => { if (isCurrent()) this.store.comment(run.taskId, run.id, 'agent', body.slice(0, 16_000)); }
      });
      this.handles.set(run.id, handle);
    } catch (error) { this.fail(run, error); return; }
    void handle.result.then(({ envelope, sessionId }) => {
      if (!isCurrent()) return;
      this.store.db.transaction(() => {
        this.store.setSession(run.id, sessionId);
        const status = envelope.status === 'needs_input' ? 'waiting_input' : envelope.status;
        this.store.finish(run.id, status, envelope.summary, status === 'blocked' ? envelope.summary : null);
        this.store.comment(run.taskId, run.id, status === 'completed' ? 'result' : 'agent', envelope.summary);
        for (const question of envelope.questions) this.store.comment(run.taskId, run.id, 'question', question);
      }).immediate();
    }).catch(error => this.fail(run, error)).finally(() => {
      this.store.completeCancellation(run.id);
      if (this.handles.get(run.id) === handle) this.handles.delete(run.id);
    });
  }
  private fail(run: Run, error: unknown) {
    if (this.store.getRun(run.id).status !== 'running' || this.store.getRun(run.id).turn !== run.turn) return;
    const message = error instanceof Error ? error.message : String(error);
    this.store.db.transaction(() => {
      this.store.finish(run.id, 'failed', null, message.slice(0, 16_000));
      this.store.comment(run.taskId, run.id, 'system', message.slice(0, 16_000));
    }).immediate();
  }
  async shutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    // Persist uncertainty before terminating. No automatic replay after a restart.
    this.store.reconcile();
    const handles = [...this.handles.values()];
    for (const handle of handles) handle.cancel();
    await Promise.allSettled(handles.map(handle => handle.result));
  }
}
