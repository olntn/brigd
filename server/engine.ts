import type { FollowupInput, Run } from '../src/lib/types';
import { startAgent, buildPrompt, type AgentHandle, type AgentInput, type AgentCallbacks } from './adapter';
import { AppError, Store, runFence, type RunFence } from './store';
import { validateEnvelope, validateSessionId } from './protocol';
import { workflowContext } from './workflows';
import { createTaskBridge } from './task-mcp';

export type AgentFactory = (input: AgentInput, callbacks: AgentCallbacks) => AgentHandle;
export type TaskBridgeFactory = (store: Store, run: Run, fence: RunFence) => ReturnType<typeof createTaskBridge>;
interface Launch { taskId: string; handle: AgentHandle | null; fence: RunFence; cancelRequested: boolean; bridge?: ReturnType<typeof createTaskBridge>; settled?: Promise<void>; }
export class Engine {
  private handles = new Map<string, Launch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  constructor(readonly store: Store, readonly mock = false, private factory: AgentFactory = startAgent, private bridgeFactory?: TaskBridgeFactory) {}
  startScheduler() {
    if (this.timer || this.closing) return;
    this.store.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1_000);
  }
  tick(now = Date.now()) {
    if (this.closing) return;
    for (const run of this.store.claimDue(this.mock, now, [...this.handles.values()].map(launch => launch.taskId))) this.launch(run);
  }
  private assertTaskSettled(taskId: string) {
    if ([...this.handles.values()].some(launch => launch.taskId === taskId)) throw new AppError('Предыдущий CLI-процесс этой задачи ещё завершается', 409);
  }
  start(taskId: string): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertTaskSettled(taskId);
    const run = this.store.startManual(taskId, this.mock);
    this.launch(run);
    return this.store.getRun(run.id);
  }
  followup(taskId: string, input: FollowupInput): Run {
    // A lost HTTP response is safe to retry even while that run is active or
    // after restart. Only the transaction that created it may launch a process.
    const prior = this.store.getFollowupRequest(taskId, input);
    if (prior) return prior;
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertTaskSettled(taskId);
    const { run, created } = this.store.startFollowup(taskId, input);
    if (created) this.launch(run);
    return this.store.getRun(run.id);
  }
  resume(runId: string, answer: string, acknowledgement: boolean, attachmentIds: string[] = []): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    if (this.handles.has(runId)) throw new AppError('Предыдущий CLI-процесс ещё завершается', 409);
    const run = this.store.resume(runId, answer, acknowledgement, Date.now(), attachmentIds);
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
      launch.bridge?.close();
      launch.handle?.cancel();
    }
    return result;
  }
  private launch(run: Run, answer?: string) {
    const fence = runFence(run);
    if (this.closing || this.handles.has(run.id) || !this.store.isCurrent(run.id, fence)) return;
    // Reserve before invoking a factory: even synchronous callback/cancel paths
    // cannot launch another worker or lose a cancellation before the handle exists.
    const launch: Launch = { taskId: run.taskId, handle: null, fence, cancelRequested: false };
    this.handles.set(run.id, launch);
    const isCurrent = () => this.store.isCurrent(run.id, fence);
    const release = () => {
      launch.bridge?.close();
      if (this.handles.get(run.id) === launch) this.handles.delete(run.id);
    };
    let handle: AgentHandle;
    try {
      const workflow = workflowContext(run.followup?.workflow ?? run);
      // Mock and injected factories need no transport or filesystem authority.
      // An explicit bridge factory lets integration tests exercise the lifecycle.
      if (!run.mock && (this.factory === startAgent || this.bridgeFactory)) {
        launch.bridge = (this.bridgeFactory ?? createTaskBridge)(this.store, run, fence);
      }
      const input: AgentInput = { provider: run.provider, cwd: run.cwd, instruction: run.instruction, instructions: run.instructions,
        ...(run.inputAttachments?.length ? { attachments: run.inputAttachments } : {}), ...(launch.bridge ? { taskBridge: launch.bridge.agentConfig } : {}),
        model: run.worker?.model ?? null, effort: run.worker?.effort ?? 'default', communicationStyle: run.worker?.communicationStyle ?? '',
        sessionId: run.sessionId ?? undefined, answer, mock: run.mock, ...(workflow ? { workflow } : {}),
        ...(run.followup ? { followup: { sourceRunId: run.followup.sourceRunId, sourceStepIndex: run.followup.sourceStepIndex, request: run.followup.request } } : {}) };
      buildPrompt(input); // Enforce the complete UTF-8 bound before even a custom factory.
      if (!isCurrent() || launch.cancelRequested || this.closing) {
        this.store.completeCancellation(run.id, Date.now(), fence);
        release();
        return;
      }
      handle = this.factory(input, {
        onSession: id => {
          if (!isCurrent()) return;
          try { this.store.setSession(run.id, id, fence); }
          catch (error) {
            this.fail(run, fence, error);
            launch.cancelRequested = true;
            launch.bridge?.close();
            launch.handle?.cancel();
            throw error;
          }
        },
        onComment: body => {
          this.store.db.transaction(() => {
            if (isCurrent()) this.store.comment(run.taskId, run.id, 'agent', body.slice(0, 16_000), Date.now(), run.currentStepIndex);
          }).immediate();
        },
        onLog: entry => {
          this.store.db.transaction(() => {
            if (isCurrent()) this.store.log(run.taskId, run.id, entry, Date.now(), run.currentStepIndex);
          }).immediate();
        }
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
      launch.bridge?.close();
      if (!isCurrent()) return;
      const envelope = validateEnvelope(rawEnvelope);
      const sessionId = validateSessionId(rawSessionId);
      let next: Run | null = null;
      this.store.db.transaction(() => {
        if (!isCurrent()) return;
        this.store.setSession(run.id, sessionId, fence);
        const status = envelope.status === 'needs_input' ? 'waiting_input' : envelope.status;
        const result = this.store.finish(run.id, status, envelope.summary, status === 'blocked' ? envelope.summary : null, Date.now(), fence);
        this.store.log(run.taskId, run.id, { kind: 'lifecycle',
          summary: status === 'completed' ? 'Работник завершил выполнение' : status === 'waiting_input' ? 'Работник ожидает ответа пользователя' : 'Выполнение заблокировано',
          details: [`Статус: ${status}.`, `Ход сессии: ${run.turn}.`,
            ...(run.currentStepIndex !== null ? [`Этап: ${run.currentStepIndex + 1} из ${run.steps.length}.`] : []),
            ...(envelope.questions.length ? [`Вопросов пользователю: ${envelope.questions.length}.`] : []),
            result.status === 'running' ? 'Результат сохранён. Начинается следующий этап.' : 'Ответ работника сохранён в комментариях.'],
        }, Date.now(), run.currentStepIndex);
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
      if (!this.store.isCurrent(run.id, fence)) return;
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
    for (const launch of launches) { launch.cancelRequested = true; launch.bridge?.close(); launch.handle?.cancel(); }
    await Promise.allSettled(launches.map(launch => launch.settled ?? launch.handle?.result ?? Promise.resolve()));
  }
}
