import type { CliAccessMode, Envelope, Provider, TaskLogInput } from '../src/lib/types';
import { claudeToolLog, codexActionLog } from './worker-logs';
import { sanitizeLogError } from './log-errors';

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_PROTOCOL_EVENTS = 50000;

/** Provider stdout is a protocol, never a source of heuristic success signals. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The provider refused the turn because the account's usage, rate or quota limit is exhausted: a different account may still work. */
export class UsageLimitError extends ProtocolError {
  readonly code = 'USAGE_LIMIT';
  constructor(readonly provider: Provider, readonly detail: string) {
    super(`${provider === 'claude' ? 'Claude Code' : 'Codex'} reported that its usage limit is exhausted. No successful result was accepted.${detail ? ` ${detail}` : ''}`);
    this.name = 'UsageLimitError';
  }
}

// Phrases both CLIs use for exhausted plans, rate limits and billing, e.g. Codex
// "You've hit your usage limit. Try again at …" and Claude Code "Claude AI usage limit reached|<ts>".
const STRONG_LIMIT = /usage[ _-]?limits?|rate[ _-]?limit|usage_limit|quota|too many requests|\b429\b|insufficient[ _-]credits?|credit balance|out of credits|usage cap/i;
const WEAK_LIMIT = /(?:hit|reached|exceeded) (?:your |the |its )?(?:[\w-]+ ){0,3}limit\b|limit (?:has been |was |is )?(?:reached|exceeded|exhausted)/i;
// Caps brigd or the CLI put on one turn are not account limits: another account would hit them too.
const UNRELATED_LIMIT = /max(?:imum)?[ _-]?turns?|context (?:window|length)|output limit|line limit|event limit|size limit|time limit/i;
/** Only CLI-level error text is inspected: tool failures and ordinary prose never reach this check. */
export function isUsageLimit(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return STRONG_LIMIT.test(value) || (WEAK_LIMIT.test(value) && !UNRELATED_LIMIT.test(value));
}
const USAGE_LIMIT_DETAIL_LENGTH = 500;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) {
    throw new ProtocolError('The CLI returned an invalid session ID.');
  }
  return value;
}

export function validateEnvelope(value: unknown): Envelope {
  if (typeof value === 'string') {
    try { value = JSON.parse(value.trim()); }
    catch { throw new ProtocolError('The final response was not a JSON result envelope.'); }
  }
  if (!record(value) || Object.keys(value).sort().join(',') !== 'questions,status,summary') {
    throw new ProtocolError('The final response must contain exactly status, summary, and questions.');
  }
  if (typeof value.status !== 'string' || !['needs_input', 'completed', 'blocked'].includes(value.status)) {
    throw new ProtocolError('The final response has an invalid status.');
  }
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 16000) {
    throw new ProtocolError('The final response needs a nonempty summary of at most 16,000 characters.');
  }
  if (!Array.isArray(value.questions) || value.questions.length > 20 ||
      value.questions.some(q => typeof q !== 'string' || !q.trim() || q.length > 4000)) {
    throw new ProtocolError('The final response has invalid questions.');
  }
  if ((value.status === 'needs_input') !== (value.questions.length > 0)) {
    throw new ProtocolError('Only needs_input may include questions, and it must include at least one.');
  }
  return {
    status: value.status as Envelope['status'],
    summary: value.summary.trim(),
    questions: value.questions.map((q: string) => q.trim()),
  };
}

// Only inspect error/permission fields, never ordinary prose or reasoning.
export function isPermissionDenial(value: unknown): boolean {
  return typeof value === 'string' && /permission for this tool use was denied|(?:permission|approval) (?:was |is )?(?:denied|required|rejected)|not (?:allowed|permitted) (?:to|by)|operation not permitted|sandbox (?:restriction|denied)|denied by (?:the )?sandbox|requires? (?:user |human )?approval|cannot request (?:user )?approval|approval policy[^\n]*(?:reject|never|denied)/i.test(value);
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (record(value) && typeof value.message === 'string') return value.message;
  return '';
}

function isNativeApprovalRequired(text: string): boolean {
  return /permission for this tool use was denied|requires? (?:user |human )?approval|no approval surface|(?:approval|permission) (?:was |is )?(?:required|rejected)|cannot request (?:user )?approval/i.test(text);
}

export interface ProtocolCallbacks {
  onSession: (id: string) => void;
  onComment: (body: string) => void;
  onLog?: (entry: TaskLogInput) => void;
}

/** The same parser is used by live subprocesses and recorded-event tests. */
export class AgentProtocol {
  private sessionId?: string;
  private terminal = false;
  private failure = false;
  private finalResponse: unknown;
  private nativeBlock = false;
  private nativePermissionRequest = false;
  /** The first exhausted-limit message, already redacted and bounded; null until one is seen. */
  private usageLimit: string | null = null;
  private stderrTail = '';
  private blockedTools = new Set<string>();
  private seenLogs = new Set<string>();
  private pendingTools = new Map<string, TaskLogInput>();
  private pending = '';
  private eventCount = 0;
  readonly maxLineBytes = MAX_JSONL_LINE_BYTES;

  constructor(
    readonly provider: Provider,
    private callbacks: ProtocolCallbacks,
    private expectedSessionId?: string,
    private cliAccess: CliAccessMode = 'standard',
  ) {
    if (expectedSessionId) validateSessionId(expectedSessionId);
  }

  get permissionBlocked(): boolean { return this.nativeBlock; }
  /** The exhausted-limit message seen so far, if any. */
  get usageLimitDetail(): string | null { return this.usageLimit; }

  private noteLimit(text: string): void {
    if (this.usageLimit !== null || !isUsageLimit(text)) return;
    const line = text.split('\n').find(candidate => isUsageLimit(candidate)) ?? text;
    this.usageLimit = (sanitizeLogError(line) ?? '').slice(0, USAGE_LIMIT_DETAIL_LENGTH);
  }

  /** Stderr stays private: only an exhausted-limit line is kept, and only when the turn fails anyway. */
  noteStderr(chunk: string): void {
    const text = this.stderrTail + chunk;
    this.noteLimit(text);
    this.stderrTail = text.slice(-USAGE_LIMIT_DETAIL_LENGTH);
  }

  push(chunk: string): void {
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    if (new TextEncoder().encode(this.pending).byteLength > this.maxLineBytes) throw new ProtocolError('CLI output exceeded the line limit.');
  }

  end(): void {
    if (this.pending.trim()) this.line(this.pending);
    this.pending = '';
  }

  private line(line: string): void {
    if (!line.trim()) return;
    if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) throw new ProtocolError('CLI output exceeded the line limit.');
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw new ProtocolError('The CLI emitted malformed JSONL output.'); }
    this.accept(event);
  }

  private rememberSession(value: unknown): void {
    const id = validateSessionId(value);
    if ((this.expectedSessionId && id !== this.expectedSessionId) || (this.sessionId && id !== this.sessionId)) {
      throw new ProtocolError('The CLI changed session IDs. The requested session was not resumed.');
    }
    if (!this.sessionId) {
      this.sessionId = id;
      // Persist immediately, even if the CLI crashes before a final answer.
      this.callbacks.onSession(id);
    }
  }

  private log(key: string, entry: TaskLogInput): void {
    if (this.seenLogs.has(key) || this.seenLogs.size >= 1000) return;
    this.seenLogs.add(key);
    this.callbacks.onLog?.(entry);
  }

  private blockClaudeTool(tool: unknown, input: unknown): void {
    // Reuse the operation metadata filter; never persist the raw denied input or error.
    const log = claudeToolLog(tool, input);
    this.recordBlockedTool(log);
  }

  private recordBlockedTool(log: TaskLogInput, explicit = true): void {
    const name = log.details[0]?.match(/^Инструмент: (.+)\.$/)?.[1];
    if (name && name !== 'локальный инструмент' && this.blockedTools.size < 20) this.blockedTools.add(name);
    const details = log.details.filter(line => !line.startsWith('Состояние:'));
    details.push(explicit ? 'Состояние: доступ отклонён CLI.' : 'Состояние: ошибка доступа.');
    const summary = `${explicit ? 'CLI отклонил инструмент' : 'Ошибка доступа при вызове инструмента'}: ${name ?? 'локальный инструмент'}`;
    this.log(`permission:${JSON.stringify(details)}`, { kind: 'tool', summary, details });
  }

  private blockedSummary(): string {
    if (this.cliAccess === 'full') {
      return `${this.provider === 'claude' ? 'Claude Code' : 'Codex'} сообщил об отказе доступа. Полный доступ уже выбран: подтверждения и песочница CLI отключены. Проверьте текст ошибки в логах, права пользователя сервиса и ограничения ОС, контейнера или провайдера. Изменение allow-правил ограниченного режима здесь не требуется.`;
    }
    if (this.provider !== 'claude') return 'The CLI requires native permission approval. brigd cannot grant tool permissions from task comments. Review the session in the provider’s terminal.';
    const reason = this.nativePermissionRequest
      ? 'Claude Code не разрешил использование инструмента.'
      : 'Claude Code сообщил об отказе доступа или ограничении среды.';
    const tools = this.blockedTools.size ? ` Инструменты: ${[...this.blockedTools].join(', ')}.` : '';
    const next = this.nativePermissionRequest
      ? 'Откройте Настройки → Разрешения → Настроить разрешения Claude Code. Если базовые правила уже добавлены, проверьте отклонённую операцию в логах и правила ask/deny через /permissions в терминале Claude Code: они имеют приоритет над allow.'
      : 'Проверьте отклонённую операцию в логах и права доступа в рабочей папке; добавление allow-правила не устраняет ограничения файловой системы или песочницы.';
    return `${reason}${tools} ${next} Сессию можно открыть из рабочей папки запуска: claude --resume ${this.sessionId}. Комментарий в задаче не выдаёт разрешений CLI. После устранения причины отправьте «Продолжи задачу» через «Отправить агенту»; для этапа сложной задачи используйте повтор этапа.`;
  }

  accept(event: unknown): void {
    if (!record(event) || typeof event.type !== 'string') throw new ProtocolError('The CLI emitted an invalid event.');
    if (++this.eventCount > MAX_PROTOCOL_EVENTS) throw new ProtocolError('CLI output exceeded the event limit.');
    if (this.provider === 'claude' && event.parent_tool_use_id) return; // Nested agent events are not the parent result.

    if (this.provider === 'codex' && event.type === 'thread.started') this.rememberSession(event.thread_id);
    if (this.provider === 'claude' && event.session_id !== undefined) this.rememberSession(event.session_id);

    if ((Array.isArray(event.permission_denials) && event.permission_denials.length > 0) ||
        ['approval_request', 'permission_request', 'approval.required', 'permission.denied'].includes(event.type) ||
        (event.type === 'control_request' && record(event.request) && event.request.subtype === 'can_use_tool')) {
      this.nativeBlock = true;
      this.nativePermissionRequest = true;
      if (this.provider === 'claude') {
        if (Array.isArray(event.permission_denials)) {
          for (const denial of event.permission_denials.slice(0, 20)) {
            if (record(denial)) this.blockClaudeTool(denial.tool_name, denial.tool_input);
          }
        }
        if (event.type === 'control_request' && record(event.request)) this.blockClaudeTool(event.request.tool_name, event.request.input);
      }
    }

    if (event.type === 'error' || event.type === 'turn.failed') {
      const text = errorText(event.error) || errorText(event.message);
      this.log(`error:${this.eventCount}`, { kind: 'lifecycle', summary: `Ошибка ${this.provider === 'claude' ? 'Claude Code' : 'Codex'}`, details: [], error: sanitizeLogError(text) });
      if (isPermissionDenial(text)) {
        this.nativeBlock = true;
        if (isNativeApprovalRequired(text)) this.nativePermissionRequest = true;
      }
      else { this.failure = true; this.noteLimit(text); }
    }

    if (this.provider === 'codex') {
      if (event.type === 'turn.completed') this.terminal = true;
      if ((event.type === 'item.started' || event.type === 'item.completed') && record(event.item)) {
        const item = event.item;
        const log = codexActionLog(item, event.type === 'item.completed');
        if (log) this.log(`${event.type}:${typeof item.id === 'string' ? item.id : JSON.stringify(log)}`, log);
        if (item.status === 'failed' && isPermissionDenial(errorText(item.error))) this.nativeBlock = true;
        if (event.type === 'item.completed' && item.type === 'agent_message') this.finalResponse = item.text;
        if (item.type === 'command_execution') {
          if ((item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)) &&
              isPermissionDenial(errorText(item.aggregated_output) || errorText(item.error))) this.nativeBlock = true;
        }
        if (item.type === 'error') {
          this.log(`error:${typeof item.id === 'string' ? item.id : this.eventCount}`, { kind: 'lifecycle', summary: 'Ошибка Codex', details: [], error: sanitizeLogError(errorText(item.message)) });
          if (isPermissionDenial(errorText(item.message))) this.nativeBlock = true;
          else { this.failure = true; this.noteLimit(errorText(item.message)); }
        }
      }
    } else {
      if (event.type === 'assistant' && record(event.message) && Array.isArray(event.message.content)) {
        for (const content of event.message.content) {
          if (!record(content) || content.type !== 'tool_use') continue;
          const log = claudeToolLog(content.name, content.input);
          if (typeof content.id === 'string' && this.pendingTools.size < 500) this.pendingTools.set(content.id, log);
          this.log(`started:${typeof content.id === 'string' ? content.id : JSON.stringify(log)}`, log);
        }
      }
      if (event.type === 'user' && record(event.message) && Array.isArray(event.message.content)) {
        for (const content of event.message.content) {
          if (record(content) && content.type === 'tool_result') {
            const prior = typeof content.tool_use_id === 'string' ? this.pendingTools.get(content.tool_use_id) : undefined;
            const log = claudeToolLog(undefined, undefined, true, content.is_error === true);
            const text = typeof content.content === 'string' ? content.content :
              Array.isArray(content.content) ? content.content.filter(record).map(c => errorText(c.text)).filter(Boolean).join('\n') : '';
            if (content.is_error === true) log.error = sanitizeLogError(text);
            if (prior) {
              log.summary = prior.summary.replace('Вызывает инструмент', content.is_error === true ? 'Ошибка инструмента' : 'Инструмент завершён');
              log.details.push(...prior.details.filter(line => !line.startsWith('Состояние:') && !line.startsWith('Инструмент:')));
              log.details[0] = prior.details[0]!;
            }
            if (typeof content.content === 'string') log.details.push(`Объём результата: ${new TextEncoder().encode(content.content).byteLength} байт.`);
            else if (Array.isArray(content.content)) log.details.push(`Блоков результата: ${content.content.length}.`);
            this.log(`completed:${typeof content.tool_use_id === 'string' ? content.tool_use_id : JSON.stringify(log)}`, log);
            if (content.is_error === true) {
              if (isPermissionDenial(text)) {
                this.nativeBlock = true;
                const explicit = isNativeApprovalRequired(text);
                if (explicit) this.nativePermissionRequest = true;
                if (prior) this.recordBlockedTool(prior, explicit);
              }
            }
            if (typeof content.tool_use_id === 'string') this.pendingTools.delete(content.tool_use_id);
          }
        }
      }
      if (event.type === 'result') {
        this.terminal = true;
        if (event.subtype !== 'success' || event.is_error === true) {
          const details = [errorText(event.result), ...(Array.isArray(event.errors) ? event.errors.map(errorText) : [])].join('\n');
          this.log(`result-error:${this.eventCount}`, { kind: 'lifecycle', summary: 'Ошибка Claude Code', details: [], error: sanitizeLogError(details) });
          if (isPermissionDenial(details)) {
            this.nativeBlock = true;
            if (isNativeApprovalRequired(details)) this.nativePermissionRequest = true;
          }
          else { this.failure = true; this.noteLimit(details); }
        }
        this.finalResponse = event.structured_output ?? event.result;
      }
    }
  }

  finish(exitCode: number): { envelope: Envelope; sessionId: string } {
    // A native prompt is intentionally terminated mid-stream; its unfinished tail is not a result.
    if (!this.nativeBlock) this.end();
    // An exhausted limit may stop the CLI before any session exists; a replacement account can still take the work.
    if (this.usageLimit !== null && !this.nativeBlock && (this.failure || exitCode !== 0 || !this.terminal)) throw new UsageLimitError(this.provider, this.usageLimit);
    if (!this.sessionId) throw new ProtocolError('The CLI did not return a durable session ID.');
    if (this.failure) throw new ProtocolError('The CLI reported a failed turn. No successful result was accepted.');
    if (this.nativeBlock) return {
      sessionId: this.sessionId,
      envelope: { status: 'blocked', summary: this.blockedSummary(), questions: [] },
    };
    if (exitCode !== 0) throw new ProtocolError(`The CLI exited with code ${exitCode}. No successful result was accepted.`);
    if (!this.terminal) throw new ProtocolError('The CLI exited without a completed turn event.');
    return { sessionId: this.sessionId, envelope: validateEnvelope(this.finalResponse) };
  }
}
