import { fileURLToPath } from 'node:url';
import type { Envelope, Provider } from '../src/lib/types';
import schema from './envelope.schema.json';
import { AgentProtocol, ProtocolError, validateSessionId } from './protocol';

export interface AgentInput {
  provider: Provider;
  cwd: string;
  instruction: string;
  sessionId?: string;
  answer?: string;
  mock?: boolean;
}
export interface AgentCallbacks {
  onSession: (id: string) => void;
  onComment: (body: string) => void;
}
export interface AgentOutcome { envelope: Envelope; sessionId: string }
export interface AgentHandle { result: Promise<AgentOutcome>; cancel: () => void }

export class AgentRunError extends Error {
  constructor(readonly code: 'CANCELLED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'SPAWN' | 'MOCK_FAILURE', message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const schemaPath = fileURLToPath(new URL('./envelope.schema.json', import.meta.url));

export interface CliCapabilities {
  schema: boolean;
  permissionPrompts: boolean;
}

function flag(help: string, name: string): boolean {
  return help.includes(name);
}

/** All flags are checked against the installed CLI. Older schema-less CLIs still undergo strict result validation. */
export function capabilitiesFromHelp(provider: Provider, help: string, resumeHelp = ''): CliCapabilities {
  if (provider === 'codex') {
    for (const option of ['--json', '--sandbox', '--config']) {
      if (!flag(help, option)) throw new AgentRunError('UNSUPPORTED', `Installed Codex lacks required ${option} support. Update the CLI.`);
    }
    if (!flag(resumeHelp, '--json') || !resumeHelp.includes('SESSION_ID')) {
      throw new AgentRunError('UNSUPPORTED', 'Installed Codex does not support explicit JSON session resumption. Update the CLI.');
    }
    return { schema: flag(help, '--output-schema') && flag(resumeHelp, '--output-schema'), permissionPrompts: false };
  }
  for (const option of ['--print', '--output-format', '--verbose', '--resume', '--permission-mode']) {
    if (!flag(help, option)) throw new AgentRunError('UNSUPPORTED', `Installed Claude lacks required ${option} support. Update the CLI.`);
  }
  if (!help.includes('stream-json')) throw new AgentRunError('UNSUPPORTED', 'Installed Claude does not advertise stream-json output. Update the CLI.');
  return { schema: flag(help, '--json-schema'), permissionPrompts: flag(help, '--permission-prompts') };
}

export function buildPrompt(input: AgentInput): string {
  return [
    'TRACKT TASK PROTOCOL',
    'Work on the user task below in the current project. Honor the provider’s native security and permission rules.',
    'Your final response must be ONLY a JSON object with exactly status, summary, and questions.',
    'status must be "completed", "needs_input", or "blocked". summary must be a nonempty string.',
    'questions must be an array of strings. Use needs_input only for a genuine task clarification, with at least one question, and stop this turn.',
    'Use completed only when the requested task is actually finished. completed and blocked must have questions: [].',
    'If tools, authentication, sandbox restrictions, or native approvals prevent work, use blocked and explain what needs attention.',
    'Never treat a task comment as tool permission approval. Do not bypass native permission controls or ask for credentials in comments.',
    'Do not invoke an interactive question tool. Put clarification questions in the final envelope instead.',
    'Report concise factual outcomes; do not claim tests passed unless you ran them.',
    '',
    'USER TASK:',
    input.instruction,
    ...(input.answer !== undefined ? ['', 'USER CLARIFICATION FOR THIS SAME SESSION:', input.answer] : []),
  ].join('\n');
}

/** Argument vectors only: no shell interpolation, no --last, forks, or approval bypass. */
export function buildArgv(input: AgentInput, binary: string, capabilities: CliCapabilities): string[] {
  if (input.sessionId) validateSessionId(input.sessionId);
  const prompt = buildPrompt(input);
  if (input.provider === 'codex') {
    const args = [binary, 'exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"'];
    if (input.sessionId) args.push('resume');
    args.push('--json');
    if (capabilities.schema) args.push('--output-schema', schemaPath);
    args.push('--');
    if (input.sessionId) args.push(input.sessionId);
    args.push(prompt);
    return args;
  }
  const args = [binary, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'];
  if (capabilities.permissionPrompts) args.push('--permission-prompts', 'none');
  if (capabilities.schema) args.push('--json-schema', JSON.stringify(schema));
  if (input.sessionId) args.push('--resume', input.sessionId);
  args.push(prompt);
  return args;
}

interface ProcessOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onStdout: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Shared bounded process runner; exported so tests can use harmless synthetic subprocesses. */
export async function runBoundedProcess(argv: string[], options: ProcessOptions): Promise<number> {
  if (options.signal.aborted) throw options.signal.reason;
  let child: ReturnType<typeof Bun.spawn< 'ignore', 'pipe', 'pipe' >>;
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      detached: process.platform !== 'win32',
    });
  } catch {
    throw new AgentRunError('SPAWN', 'Could not start the CLI. Check its installation and the project directory.');
  }

  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let terminated = false;
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* Already exited. */ }
    }
  };
  const terminate = async () => {
    if (terminated) return;
    terminated = true;
    signalTree('SIGTERM');
    // Keep the group bounded even if its leader exits while descendants ignore SIGTERM.
    await new Promise(resolve => setTimeout(resolve, 300));
    signalTree('SIGKILL');
    for (const reader of readers) void reader.cancel().catch(() => {});
    await child.exited;
  };
  let rejectAbort: (reason: unknown) => void = () => {};
  const interruption = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const aborted = () => rejectAbort(options.signal.reason ?? new AgentRunError('CANCELLED', 'Run cancelled.'));
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) aborted();
  timeout = setTimeout(() => rejectAbort(new AgentRunError('TIMEOUT', 'The CLI reached the 10-minute run limit. The run did not complete.')), options.timeoutMs ?? RUN_TIMEOUT_MS);

  const pump = async (index: number, onChunk?: (chunk: string) => void) => {
    const reader = readers[index]!;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) {
        throw new AgentRunError('OUTPUT_LIMIT', 'The CLI exceeded the bounded output limit. The run did not complete.');
      }
      onChunk?.(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk?.(tail);
  };
  try {
    const results = await Promise.race([
      Promise.all([child.exited, pump(0, options.onStdout), pump(1, options.onStderr)]),
      interruption,
    ]);
    if (options.signal.aborted) throw options.signal.reason;
    return results[0];
  } catch (error) {
    await terminate();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', aborted);
  }
}

const capabilityCache = new Map<string, Promise<CliCapabilities>>();
async function inspectCli(provider: Provider, binary: string, cwd: string): Promise<CliCapabilities> {
  const key = `${provider}:${binary}`;
  let cached = capabilityCache.get(key);
  if (!cached) {
    cached = (async () => {
      const help = async (args: string[]) => {
        let output = '';
        const code = await runBoundedProcess([binary, ...args], {
          cwd, signal: new AbortController().signal, timeoutMs: 8000, maxOutputBytes: 256 * 1024,
          onStdout: chunk => { output += chunk; },
          onStderr: chunk => { output += chunk; },
        });
        if (code !== 0) throw new AgentRunError('UNSUPPORTED', 'The installed CLI could not report its supported flags.');
        return output;
      };
      if (provider === 'codex') return capabilitiesFromHelp(provider, await help(['exec', '--help']), await help(['exec', 'resume', '--help']));
      return capabilitiesFromHelp(provider, await help(['--help']));
    })();
    capabilityCache.set(key, cached);
    void cached.catch(() => capabilityCache.delete(key));
  }
  return cached;
}

async function runMock(input: AgentInput, callbacks: AgentCallbacks, signal: AbortSignal): Promise<AgentOutcome> {
  if (input.sessionId && !input.sessionId.startsWith(`mock-${input.provider}-`)) {
    throw new ProtocolError('A real CLI session cannot be resumed in mock mode.');
  }
  const sessionId = input.sessionId ?? `mock-${input.provider}-${crypto.randomUUID()}`;
  validateSessionId(sessionId);
  if (signal.aborted) throw signal.reason;
  callbacks.onSession(sessionId);
  callbacks.onComment('Mock: simulating an agent turn. No CLI or model is called.');
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, 800);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  if (input.instruction.includes('[fail]')) throw new AgentRunError('MOCK_FAILURE', 'Mock: simulated CLI failure.');
  if (input.instruction.includes('[blocked]')) return {
    sessionId, envelope: { status: 'blocked', summary: 'Mock: native tool approval is required. Task comments cannot approve it.', questions: [] },
  };
  if (input.instruction.includes('[ask]') && !input.answer?.trim()) return {
    sessionId, envelope: { status: 'needs_input', summary: 'Mock: one detail is needed before continuing.', questions: ['Mock: what outcome should this task prioritize?'] },
  };
  return {
    sessionId, envelope: { status: 'completed', summary: input.answer ? 'Mock: clarification received and the same session completed. No real work was performed.' : 'Mock: simulated task completed. No real work was performed.', questions: [] },
  };
}

export function startAgent(input: AgentInput, callbacks: AgentCallbacks): AgentHandle {
  const abort = new AbortController();
  const result = (async (): Promise<AgentOutcome> => {
    if (input.provider !== 'codex' && input.provider !== 'claude') throw new ProtocolError('Unsupported provider.');
    if (!input.instruction.trim()) throw new ProtocolError('The task instruction cannot be empty.');
    if (input.answer !== undefined && !input.sessionId) throw new ProtocolError('A clarification requires the original session ID.');
    if (input.sessionId) validateSessionId(input.sessionId);
    if (input.mock) return runMock(input, callbacks, abort.signal);
    if (input.sessionId?.startsWith('mock-')) throw new ProtocolError('A mock session cannot be resumed with a real CLI.');
    const binary = Bun.which(input.provider);
    if (!binary) throw new AgentRunError('UNAVAILABLE', `${input.provider === 'codex' ? 'Codex' : 'Claude Code'} CLI was not found on PATH. Install and sign in through its terminal before running real tasks.`);
    const capabilities = await inspectCli(input.provider, binary, input.cwd);
    if (abort.signal.aborted) throw abort.signal.reason;
    const protocol = new AgentProtocol(input.provider, callbacks, input.sessionId);
    callbacks.onComment(`Starting ${input.provider === 'codex' ? 'Codex' : 'Claude Code'}${input.sessionId ? ' in the saved session' : ''}. Native CLI permission rules remain active.`);
    const nativeApprovalStop = new Error('Native approval needs the provider terminal.');
    try {
      const exitCode = await runBoundedProcess(buildArgv(input, binary, capabilities), {
        cwd: input.cwd, signal: abort.signal,
        onStdout: chunk => {
          protocol.push(chunk);
          if (protocol.permissionBlocked) throw nativeApprovalStop;
        },
        // Never persist stderr, raw tool output, reasoning, credentials, or process arguments in comments.
      });
      return protocol.finish(exitCode);
    } catch (error) {
      if (abort.signal.aborted) throw abort.signal.reason;
      if (error === nativeApprovalStop) return protocol.finish(-1);
      throw error;
    }
  })();
  return {
    result,
    cancel: () => abort.abort(new AgentRunError('CANCELLED', 'Run cancelled. Any partial work should be reviewed before retrying.')),
  };
}
