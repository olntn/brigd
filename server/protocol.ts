import type { Envelope, Provider } from '../src/lib/types';

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_PROTOCOL_EVENTS = 50000;

/** Provider stdout is a protocol, never a source of heuristic success signals. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

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
  return typeof value === 'string' && /(?:permission|approval) (?:was |is )?(?:denied|required|rejected)|not (?:allowed|permitted) (?:to|by)|operation not permitted|sandbox (?:restriction|denied)|denied by (?:the )?sandbox|requires? (?:user |human )?approval|cannot request (?:user )?approval|approval policy[^\n]*(?:reject|never|denied)/i.test(value);
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (record(value) && typeof value.message === 'string') return value.message;
  return '';
}

export interface ProtocolCallbacks {
  onSession: (id: string) => void;
  onComment: (body: string) => void;
}

/** The same parser is used by live subprocesses and recorded-event tests. */
export class AgentProtocol {
  private sessionId?: string;
  private terminal = false;
  private failure = false;
  private finalResponse: unknown;
  private nativeBlock = false;
  private seenComments = new Set<string>();
  private pending = '';
  private eventCount = 0;
  readonly maxLineBytes = MAX_JSONL_LINE_BYTES;

  constructor(
    readonly provider: Provider,
    private callbacks: ProtocolCallbacks,
    private expectedSessionId?: string,
  ) {
    if (expectedSessionId) validateSessionId(expectedSessionId);
  }

  get permissionBlocked(): boolean { return this.nativeBlock; }

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

  private comment(key: string, body: string): void {
    if (this.seenComments.has(key) || this.seenComments.size >= 6) return;
    this.seenComments.add(key);
    this.callbacks.onComment(body);
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
    }

    if (event.type === 'error' || event.type === 'turn.failed') {
      if (isPermissionDenial(errorText(event.error) || errorText(event.message))) this.nativeBlock = true;
      else this.failure = true;
    }

    if (this.provider === 'codex') {
      if (event.type === 'turn.completed') this.terminal = true;
      if ((event.type === 'item.started' || event.type === 'item.completed') && record(event.item)) {
        const item = event.item;
        if (item.status === 'failed' && isPermissionDenial(errorText(item.error))) this.nativeBlock = true;
        if (event.type === 'item.completed' && item.type === 'agent_message') this.finalResponse = item.text;
        if (item.type === 'command_execution') {
          this.comment('tools', 'Agent is working with local tools.');
          if ((item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)) &&
              isPermissionDenial(errorText(item.aggregated_output) || errorText(item.error))) this.nativeBlock = true;
        }
        if (item.type === 'file_change') this.comment('files', 'Agent is working on project files.');
        if (item.type === 'mcp_tool_call' || item.type === 'web_search') this.comment('lookup', 'Agent is checking an external source.');
        if (item.type === 'error') {
          if (isPermissionDenial(errorText(item.message))) this.nativeBlock = true;
          else this.failure = true;
        }
      }
    } else {
      if (event.type === 'assistant' && record(event.message) && Array.isArray(event.message.content)) {
        if (event.message.content.some(c => record(c) && c.type === 'tool_use')) this.comment('tools', 'Agent is working with local tools.');
      }
      if (event.type === 'user' && record(event.message) && Array.isArray(event.message.content)) {
        for (const content of event.message.content) {
          if (record(content) && content.type === 'tool_result' && content.is_error === true) {
            const text = typeof content.content === 'string' ? content.content :
              Array.isArray(content.content) ? content.content.filter(record).map(c => errorText(c.text)).join('\n') : '';
            if (isPermissionDenial(text)) this.nativeBlock = true;
          }
        }
      }
      if (event.type === 'result') {
        this.terminal = true;
        if (event.subtype !== 'success' || event.is_error === true) {
          const details = [errorText(event.result), ...(Array.isArray(event.errors) ? event.errors.map(errorText) : [])].join('\n');
          if (isPermissionDenial(details)) this.nativeBlock = true;
          else this.failure = true;
        }
        this.finalResponse = event.structured_output ?? event.result;
      }
    }
  }

  finish(exitCode: number): { envelope: Envelope; sessionId: string } {
    // A native prompt is intentionally terminated mid-stream; its unfinished tail is not a result.
    if (!this.nativeBlock) this.end();
    if (!this.sessionId) throw new ProtocolError('The CLI did not return a durable session ID.');
    if (this.failure) throw new ProtocolError('The CLI reported a failed turn. No successful result was accepted.');
    if (this.nativeBlock) return {
      sessionId: this.sessionId,
      envelope: { status: 'blocked', summary: 'The CLI requires native permission approval. brigd cannot grant tool permissions from task comments. Review the session in the provider’s terminal.', questions: [] },
    };
    if (exitCode !== 0) throw new ProtocolError(`The CLI exited with code ${exitCode}. No successful result was accepted.`);
    if (!this.terminal) throw new ProtocolError('The CLI exited without a completed turn event.');
    return { sessionId: this.sessionId, envelope: validateEnvelope(this.finalResponse) };
  }
}
