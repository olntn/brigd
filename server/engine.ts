import type { AutopilotInput, AutopilotOverview, AutopilotSettings, CliAccessMode, CliAccessSettings, FollowupInput, Integration, Run } from '../src/lib/types';
import { validateIntegrationChecks } from '../src/lib/integration-checks';
import { startAgent, buildPrompt, type AgentHandle, type AgentInput, type AgentCallbacks } from './adapter';
import { AppError, Store, runFence, type RunFence } from './store';
import { validateEnvelope, validateSessionId } from './protocol';
import { workflowContext } from './workflows';
import { createTaskBridge } from './task-mcp';
import type { TaskAppAccess } from './task-mcp-app';
import { dirname, join, resolve } from 'node:path';
import { DirectWorkspaces, GitWorkspaces, WorkspaceError, type RepositoryLocation, type WorkspaceProvider } from './workspaces';
import { GitIntegrator, type Integrator } from './integration';
import { RunCodeDiffs } from './code-diff';

export type AgentFactory = (input: AgentInput, callbacks: AgentCallbacks) => AgentHandle;
export type TaskBridgeFactory = (store: Store, run: Run, fence: RunFence, appAccess?: TaskAppAccess) => ReturnType<typeof createTaskBridge>;
export interface EngineOptions { workspaces?: WorkspaceProvider; maxParallel?: number; maxPerRepository?: number; integrator?: Integrator; integrationChecks?: string[][]; cliAccess?: CliAccessMode;
  /** Hand every merge conflict to the built-in integrator without waiting for a click. */
  autoReconcile?: boolean; }
interface Launch { taskId: string; handle: AgentHandle | null; fence: RunFence; cancelRequested: boolean; bridge?: ReturnType<typeof createTaskBridge>; settled?: Promise<void>; }
export class Engine {
  readonly codeDiffs: RunCodeDiffs;
  private handles = new Map<string, Launch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private draining = false;
  private readonly workspaces: WorkspaceProvider;
  private readonly maxParallel: number;
  private readonly maxPerRepository: number;
  private readonly integrator: Integrator;
  private readonly autoReconcile: boolean;
  private readonly environmentChecks?: string[][];
  private readonly configuredCliAccess: CliAccessMode;
  private readonly requiresIntegrationChecks: boolean;
  private integrationHandles = new Map<string, { abort: AbortController; settled: Promise<void> }>();
  private taskAppAccess?: TaskAppAccess;
  /** Repository identity per task folder, so a busy pool does not spawn Git every second. */
  private locations = new Map<string, { location: RepositoryLocation; at: number }>();
  constructor(readonly store: Store, readonly mock = false, private factory: AgentFactory = startAgent, private bridgeFactory?: TaskBridgeFactory, options: EngineOptions = {}) {
    this.codeDiffs = new RunCodeDiffs(store);
    this.environmentChecks = options.integrationChecks === undefined ? undefined : validateIntegrationChecks(options.integrationChecks);
    this.configuredCliAccess = options.cliAccess ?? 'standard';
    this.workspaces = options.workspaces ?? (mock || factory !== startAgent ? new DirectWorkspaces() : new GitWorkspaces(join(dirname(resolve(store.db.filename)), 'workspaces'), () => this.integrationChecks()));
    this.requiresIntegrationChecks = !mock && this.workspaces instanceof GitWorkspaces;
    this.maxParallel = options.maxParallel ?? 4;
    this.maxPerRepository = options.maxPerRepository ?? 1;
    this.integrator = options.integrator ?? new GitIntegrator(() => this.integrationChecks());
    this.autoReconcile = options.autoReconcile ?? true;
    if (!Number.isInteger(this.maxParallel) || this.maxParallel < 1 || this.maxParallel > 32) throw new Error('Лимит процессов должен быть 1–32');
    if (!Number.isInteger(this.maxPerRepository) || this.maxPerRepository < 1 || this.maxPerRepository > 32) throw new Error('Лимит агентов на репозиторий должен быть 1–32');
  }
  private integrationChecks(): string[][] | undefined {
    return this.store.getIntegrationChecks() ?? this.environmentChecks;
  }
  setTaskAppAccess(access: TaskAppAccess): void {
    this.taskAppAccess = access;
  }
  getCliAccessSettings(): CliAccessSettings {
    return { mode: this.store.getCliAccessMode() ?? this.configuredCliAccess };
  }
  setCliAccessSettings(input: { mode: unknown }): CliAccessSettings {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.store.setCliAccessMode(input.mode);
    return this.getCliAccessSettings();
  }
  getAutopilotSettings(): AutopilotSettings {
    const saved = this.store.getIntegrationChecks();
    return { integrationChecks: saved ?? this.environmentChecks ?? null, source: saved ? 'settings' : this.environmentChecks ? 'environment' : null };
  }
  setAutopilotSettings(input: { integrationChecks: string[][] | null }): AutopilotSettings {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    if (input.integrationChecks !== null) {
      try { validateIntegrationChecks(input.integrationChecks); }
      catch (error) { throw new AppError(error instanceof Error ? error.message : 'Проверьте команды BRIGD_INTEGRATION_CHECKS'); }
    }
    if (input.integrationChecks === null && !this.environmentChecks && this.requiresIntegrationChecks &&
        (this.store.getAutopilot().enabled || this.handles.size > 0 || this.integrationHandles.size > 0 ||
          this.store.db.query("SELECT id FROM runs WHERE mock=0 AND status IN ('queued','preparing','running','waiting_input','cancelling') LIMIT 1").get() ||
          this.store.db.query("SELECT id FROM integrations WHERE state IN ('queued','checking','merging','cancelling') LIMIT 1").get())) {
      throw new AppError('Сначала выключите автопилот и завершите или отмените активные запуски и слияния, затем очистите BRIGD_INTEGRATION_CHECKS.', 409);
    }
    this.store.setIntegrationChecks(input.integrationChecks);
    return this.getAutopilotSettings();
  }
  private assertIntegrationChecks(run?: Run) {
    if (!this.mock && (this.requiresIntegrationChecks || run?.workspace?.mode === 'worktree') && !this.integrationChecks()?.length) {
      throw new AppError('Перед запуском настройте BRIGD_INTEGRATION_CHECKS в настройках, раздел «Автопилот».', 409);
    }
  }
  startScheduler() {
    if (this.timer || this.closing) return;
    this.store.reconcile();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1_000);
  }
  tick(now = Date.now()) {
    if (this.closing) return;
    // Missing checks must not consume scheduled occurrences or create failed attempts.
    if (this.requiresIntegrationChecks && !this.integrationChecks()?.length) return;
    const settling = [...this.handles.values()].map(launch => launch.taskId);
    this.store.db.transaction(() => {
      for (const run of this.store.claimDue(this.mock, now, settling)) this.enqueue(run);
    }).immediate();
    this.autopilot(now, settling);
    this.drain();
  }
  /** Claims pool tasks lazily: only into a free slot and a free repository, so the pool stays editable until a task actually starts. */
  private autopilot(now: number, settling: readonly string[]) {
    const state = this.store.getAutopilot();
    if (!state.enabled) return;
    if (state.until !== null && now >= state.until) { this.store.stopAutopilot('until', now); return; }
    let capacity = this.store.autopilotCapacity(this.maxParallel);
    for (const task of this.store.autopilotCandidates(state.startedAt)) {
      if (capacity < 1) return;
      if (settling.includes(task.id)) continue;
      let location: RepositoryLocation;
      try { location = this.locate(task.cwd, now); }
      catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        // The attempt is recorded so the task leaves the pool and counts toward the failure limit.
        this.store.db.transaction(() => {
          const run = this.store.startAutopilot(task.id, this.mock, now);
          if (!run) return;
          this.store.log(task.id, run.id, { kind: 'lifecycle', summary: 'Подготовка запуска остановлена', details: [error.message] }, now);
          this.store.finish(run.id, 'blocked', null, error.message, now, runFence(run));
        }).immediate();
        continue;
      }
      if (this.store.claimAutopilot(task.id, location, this.mock, this.maxParallel, this.maxPerRepository, now)) capacity--;
    }
  }
  private locate(cwd: string, now: number): RepositoryLocation {
    const cached = this.locations.get(cwd);
    if (cached && now - cached.at < 60_000) return cached.location;
    const location = this.workspaces.locate({ cwd });
    this.locations.set(cwd, { location, at: now });
    return location;
  }
  setAutopilot(input: AutopilotInput, now = Date.now()): AutopilotOverview {
    if (input.enabled) this.assertIntegrationChecks();
    const state = this.store.setAutopilot(input, now);
    // Claim right away instead of waiting for the next second's tick.
    if (state.enabled) this.tick(now);
    return this.store.autopilotOverview();
  }
  private assertTaskSettled(taskId: string) {
    if ([...this.handles.values()].some(launch => launch.taskId === taskId)) throw new AppError('Предыдущий CLI-процесс этой задачи ещё завершается', 409);
  }
  start(taskId: string): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks();
    this.assertTaskSettled(taskId);
    const run = this.store.db.transaction(() => this.enqueue(this.store.startManual(taskId, this.mock))).immediate();
    this.drain();
    return this.store.getRun(run.id);
  }
  followup(taskId: string, input: FollowupInput): Run {
    // A lost HTTP response is safe to retry even while that run is active or
    // after restart. Only the transaction that created it may launch a process.
    const prior = this.store.getFollowupRequest(taskId, input);
    if (prior) return prior;
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks(this.store.getRun(input.sourceRunId));
    this.assertTaskSettled(taskId);
    const { run, created } = this.store.db.transaction(() => {
      const result = this.store.startFollowup(taskId, input);
      return { run: result.created ? this.enqueue(result.run) : result.run, created: result.created };
    }).immediate();
    if (created) this.drain();
    return this.store.getRun(run.id);
  }
  resume(runId: string, answer: string, acknowledgement: boolean, attachmentIds: string[] = []): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks(this.store.getRun(runId));
    if (this.handles.has(runId)) throw new AppError('Предыдущий CLI-процесс ещё завершается', 409);
    const run = this.store.db.transaction(() => this.enqueue(this.store.resume(runId, answer, acknowledgement, Date.now(), attachmentIds), answer)).immediate();
    this.drain();
    return this.store.getRun(run.id);
  }
  retry(runId: string, acknowledgement = false): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks(this.store.getRun(runId));
    if (this.handles.has(runId)) throw new AppError('Предыдущий CLI-процесс ещё завершается', 409);
    const run = this.store.db.transaction(() => this.enqueue(this.store.retry(runId, acknowledgement))).immediate();
    this.drain();
    return this.store.getRun(run.id);
  }
  /** Starts the built-in integrator for a conflicted result; the merge itself happens when the run is prepared. */
  reconcile(sourceRunId: string): Run {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks(this.store.getRun(sourceRunId));
    this.assertTaskSettled(this.store.getRun(sourceRunId).taskId);
    if (this.integrationHandles.has(sourceRunId)) throw new AppError('Предыдущие процессы слияния ещё завершаются', 409);
    const run = this.store.db.transaction(() => this.enqueue(this.store.startReconcile(sourceRunId))).immediate();
    this.drain();
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
    this.drain();
    return result;
  }
  private enqueue(run: Run, answer?: string): Run {
    try {
      const location = run.workspace ? { repositoryId: run.workspace.repositoryId, repositoryRoot: run.workspace.repositoryRoot, projectCwd: run.workspace.projectCwd } : this.workspaces.locate(run);
      return this.store.enqueueExecution(run, location, answer);
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return this.store.finish(run.id, 'blocked', null, error.message, Date.now(), runFence(run));
    }
  }
  private drain() {
    if (this.closing || this.draining) return;
    if (this.requiresIntegrationChecks && !this.integrationChecks()?.length) return;
    this.draining = true;
    try {
      for (const job of this.store.claimIntegrations(this.maxParallel)) this.integrateJob(job);
      for (const request of this.store.pendingExecutions()) {
        const run = this.store.claimExecution(request, this.maxParallel, this.maxPerRepository);
        if (!run) continue;
        const launch: Launch = { taskId: run.taskId, handle: null, fence: runFence(run), cancelRequested: false };
        this.handles.set(run.id, launch);
        const ready = () => {
          if (launch.cancelRequested || this.closing) { this.release(run, launch); return; }
          // A resumed integrator session keeps the merge it was already working in.
          if (run.trigger === 'reconcile' && run.turn === 1 && !run.sessionId) return this.prepareReconcile(run, launch);
          this.codeDiffs.begin(this.store.getRun(run.id));
          const current = this.store.beginExecution(run.id, launch.fence);
          if (!current) { this.release(run, launch); return; }
          return this.invoke(current, launch, request.answer);
        };
        const failed = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.store.failPreparation(run.id, launch.fence, message.slice(0, 16_000), error instanceof WorkspaceError);
          this.release(run, launch);
        };
        try {
          const planned = this.workspaces.plan(run, request.location);
          const checks = this.integrationChecks();
          const workspace = !run.workspace && planned.mode === 'worktree' && checks
            ? { ...planned, checkCommands: checks } : planned;
          this.store.attachWorkspace(run.id, launch.fence, workspace);
          const preparation = this.workspaces.prepare(workspace);
          if (preparation instanceof Promise) launch.settled = preparation.then(ready).catch(failed);
          else launch.settled = ready() ?? Promise.resolve();
        } catch (error) { failed(error); }
      }
    } finally { this.draining = false; }
  }
  integrate(runId: string, acknowledgement = false): Integration {
    if (this.closing) throw new AppError('Сервис останавливается', 503);
    this.assertIntegrationChecks(this.store.getRun(runId));
    if (this.integrationHandles.has(runId)) throw new AppError('Предыдущие процессы слияния ещё завершаются', 409);
    const job = this.store.queueIntegration(runId, true, acknowledgement);
    if (!job) throw new AppError('Для слияния нужен завершённый запуск в отдельном worktree', 409);
    this.drain(); return this.store.integrationForRun(runId)!;
  }
  cancelIntegration(runId: string, acknowledgement = false): Integration {
    const handle = this.integrationHandles.get(runId);
    const job = this.store.cancelIntegration(runId, !!handle, acknowledgement);
    handle?.abort.abort(new Error('Integration cancelled'));
    this.drain(); return job;
  }
  /** Merges the current target into the saved worktree, then invokes the integrator only if conflicts remain. */
  private async prepareReconcile(run: Run, launch: Launch): Promise<void> {
    let prepared: Awaited<ReturnType<Integrator['prepareReconcile']>>;
    try { prepared = await this.integrator.prepareReconcile(this.store.getRun(run.id), new AbortController().signal); }
    catch (error) {
      this.store.failPreparation(run.id, launch.fence, (error instanceof Error ? error.message : String(error)).slice(0, 16_000), true);
      this.release(run, launch); return;
    }
    if (launch.cancelRequested || this.closing) { this.release(run, launch); return; }
    this.store.attachReconciliation(run.id, launch.fence, prepared);
    this.codeDiffs.begin(this.store.getRun(run.id));
    const current = this.store.beginExecution(run.id, launch.fence);
    if (!current) { this.release(run, launch); return; }
    if (prepared.conflicts.length) return this.invoke(current, launch);
    // The target moved on since the conflict was found; the ordinary candidate check decides again.
    this.store.db.transaction(() => {
      const summary = 'Конфликтов с актуальной целевой веткой больше нет. Результат отправлен на повторную проверку без вызова агента.';
      const result = this.store.finish(run.id, 'completed', summary, null, Date.now(), launch.fence);
      this.store.log(run.taskId, run.id, { kind: 'lifecycle', summary: 'Интегратор не потребовался', details: [summary, `Целевой коммит: ${prepared.targetCommit}.`] }, Date.now());
      this.store.comment(run.taskId, run.id, 'system', summary, Date.now());
      if (result.status === 'completed') this.store.queueIntegration(result.id);
    }).immediate();
    this.release(run, launch);
  }
  private autoReconcileConflict(job: Integration) {
    try {
      this.store.db.transaction(() => this.enqueue(this.store.startReconcile(job.runId))).immediate();
      this.store.noteIntegration(job.id, job.attempt, 'Конфликт передан Интегратору.');
    } catch (error) {
      this.store.noteIntegration(job.id, job.attempt, `Интегратор не запущен автоматически: ${error instanceof Error ? error.message : 'внутренняя ошибка'}`);
    }
  }
  private integrateJob(job: Integration) {
    const abort = new AbortController();
    const settled = this.integrator.execute(this.store.getRun(job.runId), job, abort.signal,
      patch => { this.store.updateIntegration(job.id, job.attempt, patch); })
      .then(result => {
        const finished = this.store.updateIntegration(job.id, job.attempt, result, true);
        if (finished?.status === 'conflict' && this.autoReconcile && !this.closing) this.autoReconcileConflict(finished);
      })
      .catch(error => { this.store.updateIntegration(job.id, job.attempt, { status: 'blocked', error: error instanceof Error ? error.message : 'Слияние остановлено' }, true); })
      .finally(() => { this.integrationHandles.delete(job.runId); this.drain(); });
    this.integrationHandles.set(job.runId, { abort, settled });
  }
  private release(run: Run, launch: Launch) {
    launch.bridge?.close();
    this.store.completeCancellation(run.id, Date.now(), launch.fence);
    const current = this.store.getRun(run.id);
    this.codeDiffs.freeze(current);
    const hold = !current.mock && current.workspace?.mode === 'direct' &&
      (current.status === 'waiting_input' || !!current.steps.length && ['failed', 'blocked'].includes(current.status));
    this.store.settleExecution(run.id, launch.fence.turn, hold);
    if (this.handles.get(run.id) === launch) this.handles.delete(run.id);
    this.drain();
  }
  private invoke(run: Run, launch: Launch, answer?: string): Promise<void> | undefined {
    const fence = runFence(run);
    if (this.closing || !this.store.isCurrent(run.id, fence)) { this.release(run, launch); return; }
    const isCurrent = () => this.store.isCurrent(run.id, fence);
    const release = () => this.release(run, launch);
    let handle: AgentHandle;
    let commentCursor: number;
    try {
      commentCursor = this.store.commentCursor(run.taskId);
      const workflow = workflowContext(run.followup?.workflow ?? run);
      // Mock and injected factories need no transport or filesystem authority.
      // An explicit bridge factory lets integration tests exercise the lifecycle.
      if (!run.mock && (this.factory === startAgent || this.bridgeFactory)) {
        launch.bridge = (this.bridgeFactory ?? createTaskBridge)(this.store, { ...run, cwd: run.workspace?.cwd ?? run.cwd }, fence, this.taskAppAccess);
      }
      const input: AgentInput = { provider: run.provider, cwd: run.workspace?.cwd ?? run.cwd, instruction: run.instruction, instructions: run.instructions, ...(run.docs?.length ? { docs: run.docs } : {}),
        ...(this.getCliAccessSettings().mode === 'full' ? { cliAccess: 'full' as const } : {}),
        ...(run.workspace?.mode === 'worktree' ? { workspace: run.workspace } : {}),
        ...(run.inputAttachments?.length ? { attachments: run.inputAttachments } : {}), ...(launch.bridge ? { taskBridge: launch.bridge.agentConfig } : {}),
        model: run.worker?.model ?? null, effort: run.worker?.effort ?? 'default', communicationStyle: run.worker?.communicationStyle ?? '',
        ...(run.worker ? { ultracode: run.worker.ultracode } : {}),
        sessionId: run.sessionId ?? undefined, answer, mock: run.mock, ...(workflow ? { workflow } : {}),
        ...(run.followup ? { followup: { sourceRunId: run.followup.sourceRunId, sourceStepIndex: run.followup.sourceStepIndex, request: run.followup.request } } : {}),
        ...(run.reconcile ? { reconcile: { targetBranch: run.reconcile.targetBranch, targetCommit: run.reconcile.targetCommit, conflicts: run.reconcile.conflicts,
          checkCommands: this.integrationChecks() ?? run.workspace?.checkCommands ?? [], resultSummary: this.store.getRun(run.reconcile.sourceRunId).summary ?? '' } } : {}) };
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
    return handle.result.then(({ envelope: rawEnvelope, sessionId: rawSessionId }) => {
      launch.bridge?.close();
      if (!isCurrent()) return;
      const envelope = validateEnvelope(rawEnvelope);
      const sessionId = validateSessionId(rawSessionId);
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
          ...(status === 'blocked' ? { error: envelope.summary } : {}),
        }, Date.now(), run.currentStepIndex);
        this.store.recordAgentSummary(run.taskId, run.id, status === 'completed' ? 'result' : 'agent', envelope.summary, commentCursor, Date.now(), run.currentStepIndex);
        for (const question of envelope.questions) this.store.comment(run.taskId, run.id, 'question', question, Date.now(), run.currentStepIndex);
        if (result.status === 'running' && result.turn !== run.turn) this.enqueue(result);
        else if (result.status === 'completed') this.store.queueIntegration(result.id);
      }).immediate();
      // The old process has settled. Its later finally must never remove or
      // complete cancellation of a newer step/attempt occupying this same run.
      release();
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
      this.store.log(run.taskId, run.id, { kind: 'lifecycle', summary: 'Ошибка запуска работника', details: [], error: message }, Date.now(), run.currentStepIndex);
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
    const integrations = [...this.integrationHandles.values()];
    for (const integration of integrations) integration.abort.abort(new Error('Service stopped'));
    await Promise.allSettled([...launches.map(launch => launch.settled ?? launch.handle?.result ?? Promise.resolve()), ...integrations.map(integration => integration.settled)]);
  }
}
