import type { CliAccessMode, Envelope, Provider, TaskLogInput } from '../src/lib/types';
import { claudeToolLog, codexActionLog } from './worker-logs';
import { sanitizeLogError } from './log-errors';

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_PROTOCOL_EVENTS = 50000;

/** Provider stdout is a protocol, never a source of heuristic success signals. */
export class ProtocolError extends Error {
  /**
   * Redacted, bounded CLI output explaining a failure the events did not (a stderr tail,
   * a non-JSON stdout line). It belongs in the task log's error block only, never in comments.
   */
  constructor(message: string, readonly diagnostic?: string) {
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
/** Characters of CLI stderr kept for the failure diagnostic; successful turns never surface it. */
const STDERR_TAIL_LENGTH = 4000;
const MALFORMED_LINE_EXCERPT_LENGTH = 500;
const MAX_LOGS_PER_TURN = 1000;
/** Failure entries are kept past the ordinary cap, so a long turn still records why it failed. */
const MAX_FAILURE_LOGS_PER_TURN = 200;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const utf8Length = (text: string): number => Buffer.byteLength(text, 'utf8');

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
  private failureLogs = 0;
  private pendingTools = new Map<string, TaskLogInput>();
  private pending = '';
  /** Bytes of the oversized line being discarded unread, or 0 while a line is still being collected. */
  private skipping = 0;
  private discarded = 0;
  private droppedLines = 0;
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
  private get cliName(): string { return this.provider === 'claude' ? 'Claude Code' : 'Codex'; }
  /** The exhausted-limit message seen so far, if any. */
  get usageLimitDetail(): string | null { return this.usageLimit; }
  /** Bytes of oversized lines dropped unread so far, including the one still streaming in; the bounded runner leaves them out of its output limit. */
  get discardedBytes(): number { return this.discarded + this.skipping; }

  private noteLimit(text: string): void {
    if (this.usageLimit !== null) return;
    // Judge each line on its own: an unrelated cap mentioned nearby in the stderr tail must not mask a real limit.
    const line = text.split('\n').find(candidate => isUsageLimit(candidate)) ?? (isUsageLimit(text) ? text : undefined);
    if (line === undefined) return;
    this.usageLimit = (sanitizeLogError(line) ?? '').slice(0, USAGE_LIMIT_DETAIL_LENGTH);
  }

  /** Stderr stays out of comments and successful turns: a bounded tail serves only the exhausted-limit check and the failure diagnostic. */
  noteStderr(chunk: string): void {
    const text = this.stderrTail + chunk;
    this.noteLimit(text);
    this.stderrTail = text.slice(-STDERR_TAIL_LENGTH);
  }

  /** The stderr tail and, for a protocol violation, the offending stdout excerpt, redacted and bounded. */
  private diagnostic(excerpt?: string): string | undefined {
    const parts = [
      excerpt ? `Фрагмент строки stdout без JSON: ${excerpt}` : '',
      this.stderrTail.trim() ? `Последние строки stderr CLI:\n${this.stderrTail.trim()}` : '',
    ].filter(Boolean);
    return parts.length ? sanitizeLogError(parts.join('\n\n')) : undefined;
  }

  private protocolError(message: string, excerpt?: string): ProtocolError {
    return new ProtocolError(message, this.diagnostic(excerpt));
  }

  push(chunk: string): void {
    if (this.skipping) {
      // The rest of an oversized line is discarded as it streams in, never buffered.
      const newline = chunk.indexOf('\n');
      if (newline === -1) { this.skipping += utf8Length(chunk); return; }
      const bytes = this.skipping + utf8Length(chunk.slice(0, newline));
      this.skipping = 0;
      this.dropLine(bytes);
      chunk = chunk.slice(newline + 1);
    }
    this.pending += chunk;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    const size = utf8Length(this.pending);
    if (size > this.maxLineBytes) { this.skipping = size; this.pending = ''; }
  }

  end(): void {
    const bytes = this.skipping, tail = this.pending;
    this.skipping = 0;
    this.pending = '';
    if (bytes) this.dropLine(bytes);
    else if (tail.trim()) this.line(tail);
  }

  /**
   * A line over the limit is almost always one huge tool result, such as a project-wide
   * search. Dropping it unparsed keeps memory bounded without failing the whole turn;
   * a turn's session, result and permission events stay far below the limit.
   */
  private dropLine(bytes: number): void {
    this.discarded += bytes;
    this.log(`oversized:${++this.droppedLines}`, { kind: 'lifecycle', summary: 'Пропущено слишком длинное событие CLI', details: [
      `Строка JSONL длиннее ${this.maxLineBytes / 1024 / 1024} МиБ не разбирается и не сохраняется: ${bytes} байт.`,
      'Обычно это большой вывод инструмента, например поиск по всему проекту. Запуск продолжается; само событие в логах не отражено.',
    ] });
  }

  private line(line: string): void {
    if (!line.trim()) return;
    const size = utf8Length(line);
    if (size > this.maxLineBytes) { this.dropLine(size); return; }
    let event: unknown;
    try { event = JSON.parse(line); }
    catch {
      const excerpt = line.length > MALFORMED_LINE_EXCERPT_LENGTH ? `${line.slice(0, MALFORMED_LINE_EXCERPT_LENGTH)}…` : line;
      throw this.protocolError('The CLI emitted malformed JSONL output.', excerpt);
    }
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
    if (this.seenLogs.has(key)) return;
    const failure = entry.error !== undefined || entry.summary.startsWith('Ошибка ');
    if (failure ? this.failureLogs >= MAX_FAILURE_LOGS_PER_TURN : this.seenLogs.size - this.failureLogs >= MAX_LOGS_PER_TURN) return;
    this.seenLogs.add(key);
    if (failure) this.failureLogs++;
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
    if (!record(event) || typeof event.type !== 'string') throw this.protocolError('The CLI emitted an invalid event.');
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
      this.log(`error:${this.eventCount}`, { kind: 'lifecycle', summary: `Ошибка ${this.cliName}`, details: [`Событие CLI: ${event.type}.`],
        error: sanitizeLogError(text) ?? `${this.cliName} прислал событие ${event.type} без текста ошибки.` });
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
          this.log(`error:${typeof item.id === 'string' ? item.id : this.eventCount}`, { kind: 'lifecycle', summary: 'Ошибка Codex', details: [`Событие CLI: ${event.type}, элемент error.`],
            error: sanitizeLogError(errorText(item.message)) ?? 'Codex прислал элемент error без текста ошибки.' });
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
          const details = [errorText(event.result), ...(Array.isArray(event.errors) ? event.errors.map(errorText) : [])].filter(Boolean).join('\n');
          const subtype = typeof event.subtype === 'string' && event.subtype ? event.subtype.slice(0, 100) : 'unknown';
          this.log(`result-error:${this.eventCount}`, { kind: 'lifecycle', summary: 'Ошибка Claude Code', details: [`Результат Claude Code: ${subtype}${event.is_error === true ? ', is_error' : ''}.`],
            error: sanitizeLogError(details) ?? `Claude Code завершил ход с результатом ${subtype} без текста ошибки.` });
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
    if (!this.sessionId) throw this.protocolError('The CLI did not return a durable session ID.');
    if (this.failure) throw this.protocolError('The CLI reported a failed turn. No successful result was accepted.');
    if (this.nativeBlock) return {
      sessionId: this.sessionId,
      envelope: { status: 'blocked', summary: this.blockedSummary(), questions: [] },
    };
    if (exitCode !== 0) throw this.protocolError(`The CLI exited with code ${exitCode}. No successful result was accepted.`);
    if (!this.terminal) throw this.protocolError('The CLI exited without a completed turn event.');
    return { sessionId: this.sessionId, envelope: validateEnvelope(this.finalResponse) };
  }
}
