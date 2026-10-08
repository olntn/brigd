import { describe, expect, test } from 'bun:test';
import { AgentProtocol, ProtocolError, validateEnvelope } from '../server/protocol';
import { AgentRunError, buildArgv, capabilitiesFromHelp, runBoundedProcess, startAgent } from '../server/adapter';
import type { Envelope, Provider } from '../src/lib/types';

const sid = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const completed: Envelope = { status: 'completed', summary: 'Task finished.', questions: [] };
const asks: Envelope = { status: 'needs_input', summary: 'Need a task detail.', questions: ['Which project?'] };
const capture = () => {
  const sessions: string[] = [], comments: string[] = [];
  return { sessions, comments, onSession: (id: string) => { sessions.push(id); }, onComment: (body: string) => { comments.push(body); } };
};
const codex = (envelope: unknown = completed) => [
  { type: 'thread.started', thread_id: sid },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: typeof envelope === 'string' ? envelope : JSON.stringify(envelope) } },
  { type: 'turn.completed', usage: {} },
];
const claude = (envelope: unknown = completed) => [
  { type: 'system', subtype: 'init', session_id: sid },
  { type: 'result', subtype: 'success', session_id: sid, is_error: false, structured_output: envelope },
];
const parse = (provider: Provider, events: unknown[], code = 0, expected?: string) => {
  const callbacks = capture(), parser = new AgentProtocol(provider, callbacks, expected);
  for (const event of events) parser.accept(event);
  return { outcome: parser.finish(code), callbacks };
};

describe('strict final envelope', () => {
  test('accepts only explicit completed, clarification, or blocked', () => {
    expect(validateEnvelope(completed)).toEqual(completed);
    expect(validateEnvelope(JSON.stringify(asks))).toEqual(asks);
    expect(validateEnvelope({ status: 'blocked', summary: 'Authentication is missing.', questions: [] }).status).toBe('blocked');
  });
  test.each([
    {}, null, [], 'Everything is done!', '```json\n{"status":"completed"}\n```',
    { ...completed, extra: true }, { ...completed, status: 'success' },
    { ...completed, summary: '' }, { ...completed, summary: 'x'.repeat(16001) },
    { ...completed, questions: ['What now?'] }, { ...asks, questions: [] },
    { ...asks, questions: [' '] }, { ...asks, questions: [7] },
    { ...asks, questions: Array(21).fill('Question?') },
  ].map(value => ({ value })))('rejects invalid envelopes %#', ({ value }) => {
    expect(() => validateEnvelope(value)).toThrow(ProtocolError);
  });
});

describe('provider protocol', () => {
  test('Codex session is persisted at its first event, before the result', () => {
    const callbacks = capture(), parser = new AgentProtocol('codex', callbacks);
    parser.accept(codex()[0]);
    expect(callbacks.sessions).toEqual([sid]);
    for (const event of codex().slice(1)) parser.accept(event);
    expect(parser.finish(0).envelope).toEqual(completed);
  });
  test('Claude accepts structured_output and persists init session', () => {
    expect(parse('claude', claude()).outcome).toEqual({ sessionId: sid, envelope: completed });
  });
  test('Claude fallback final result must be strict JSON', () => {
    const events = claude();
    events[1] = { type: 'result', subtype: 'success', session_id: sid, is_error: false, result: JSON.stringify(asks) } as never;
    expect(parse('claude', events).outcome.envelope).toEqual(asks);
  });
  test('chunk boundaries, CRLF, and missing last newline are handled', () => {
    const parser = new AgentProtocol('codex', capture());
    const wire = codex().map(e => JSON.stringify(e)).join('\r\n');
    for (let i = 0; i < wire.length; i += 7) parser.push(wire.slice(i, i + 7));
    expect(parser.finish(0).envelope).toEqual(completed);
  });
  test('same-session resume is exact, and new or changing sessions fail', () => {
    expect(parse('codex', codex(), 0, sid).outcome.sessionId).toBe(sid);
    expect(() => parse('codex', codex(), 0, 'different-session')).toThrow('changed session');
    const callbacks = capture(), parser = new AgentProtocol('claude', callbacks);
    parser.accept(claude()[0]);
    expect(() => parser.accept({ type: 'system', session_id: 'new-session' })).toThrow('changed session');
    expect(callbacks.sessions).toEqual([sid]);
  });
  test('process exit zero alone never means successful completion', () => {
    expect(() => parse('codex', codex().slice(0, 2))).toThrow('completed turn');
    expect(() => parse('codex', [codex()[0], codex()[3]])).toThrow('exactly status');
    expect(() => parse('claude', [claude()[0]])).toThrow('completed turn');
    expect(() => parse('codex', codex('All done.'))).toThrow('not a JSON');
  });
  test('nonzero exit and error events cannot become success', () => {
    expect(() => parse('codex', codex(), 1)).toThrow('code 1');
    expect(() => parse('codex', [...codex(), { type: 'turn.failed', error: { message: 'Server error' } }])).toThrow('failed turn');
    expect(() => parse('codex', [...codex(), { type: 'error', message: 'Authentication required' }])).toThrow('failed turn');
    expect(() => parse('claude', [claude()[0], { ...claude()[1], is_error: true }])).toThrow('failed turn');
    expect(() => parse('claude', [claude()[0], { ...claude()[1], subtype: 'error_max_turns' }])).toThrow('failed turn');
  });
  test('a durable session ID is mandatory even after a good envelope', () => {
    expect(() => parse('codex', codex().slice(1))).toThrow('durable session');
  });
  test('malformed stdout fails closed', () => {
    const parser = new AgentProtocol('codex', capture());
    expect(() => parser.push('not json\n')).toThrow('malformed JSONL');
    expect(() => new AgentProtocol('codex', capture()).accept({ hello: true })).toThrow('invalid event');
    expect(() => new AgentProtocol('codex', capture()).push('x'.repeat(1024 * 1024 + 1))).toThrow('line limit');
  });
  test('questions in prose do not manufacture needs_input', () => {
    const result = parse('codex', codex({ ...completed, summary: 'Documented the FAQ: How do I sign in?' }));
    expect(result.outcome.envelope.status).toBe('completed');
  });
  test('native permission denials override even a completed envelope', () => {
    const result = parse('claude', [claude()[0], { ...claude()[1], permission_denials: [{ tool_name: 'Bash' }] }]);
    expect(result.outcome.envelope.status).toBe('blocked');
    expect(result.outcome.envelope.questions).toEqual([]);
  });
  test('pending native control requests block without pretending to ask a task question', () => {
    const result = parse('claude', [claude()[0], { type: 'control_request', request: { subtype: 'can_use_tool' } }], 143);
    expect(result.outcome.envelope.status).toBe('blocked');
    expect(result.outcome.envelope.summary).toContain('cannot grant tool permissions');
  });
  test('intentional native approval stop ignores a truncated subsequent event', () => {
    const parser = new AgentProtocol('claude', capture());
    parser.accept(claude()[0]);
    parser.push(JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } }) + '\n{"type":');
    expect(parser.finish(143).envelope.status).toBe('blocked');
  });
  test('Codex permission failures are blocked, ordinary command failures can recover', () => {
    const permission = { type: 'item.completed', item: { type: 'command_execution', status: 'failed', exit_code: 1, aggregated_output: 'Approval denied' } };
    expect(parse('codex', [...codex(), permission]).outcome.envelope.status).toBe('blocked');
    const ordinary = { ...permission, item: { ...permission.item, aggregated_output: 'Test assertion failed' } };
    expect(parse('codex', [...codex(), ordinary]).outcome.envelope.status).toBe('completed');
  });
  test('Claude tool permission error is blocked', () => {
    const denied = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission was denied.' }] } };
    expect(parse('claude', [...claude(), denied]).outcome.envelope.status).toBe('blocked');
  });
  test('progress is sparse and does not leak tool output or reasoning', () => {
    const events = Array(25).fill({ type: 'item.started', item: { type: 'command_execution', command: 'SECRET', aggregated_output: 'SECRET' } });
    const result = parse('codex', [...codex(), ...events, { type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE REASONING' } }]);
    expect(result.callbacks.comments).toEqual(['Agent is working with local tools.']);
  });
  test('nested Claude results cannot replace the parent session or result', () => {
    const events = [...claude(), { type: 'result', parent_tool_use_id: 'tool-1', session_id: 'other', subtype: 'success', structured_output: asks }];
    expect(parse('claude', events).outcome.envelope).toEqual(completed);
  });
});

describe('CLI argument safety and compatibility', () => {
  const base = { cwd: process.cwd(), instruction: 'a; echo $(oops)\n"quoted"', provider: 'codex' as const };
  const caps = { schema: true, permissionPrompts: true };
  test('Codex uses exact resume ID, schema, and safe sandbox without bypass', () => {
    const args = buildArgv({ ...base, sessionId: sid, answer: 'this one' }, 'codex', caps);
    expect(args.slice(0, 7)).toEqual(['codex', 'exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"', 'resume']);
    expect(args).toContain('--json');
    expect(args).toContain('--output-schema');
    expect(args[args.indexOf('--') + 1]).toBe(sid);
    expect(args.at(-1)).toContain(base.instruction);
    expect(args).not.toContain('--last');
    expect(args.some(a => a.startsWith('--dangerously') || a === '--approve-for-me' || a === '--full-auto')).toBe(false);
  });
  test('Claude has print streaming, explicit exact resume, safe default permissions', () => {
    const args = buildArgv({ ...base, provider: 'claude', sessionId: sid }, 'claude', caps);
    expect(args).toContain('-p');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--resume') + 1]).toBe(sid);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
  test('optional flags are omitted unless installed help supports them', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const args = buildArgv({ ...base, provider }, provider, { schema: false, permissionPrompts: false });
      expect(args).not.toContain('--output-schema');
      expect(args).not.toContain('--json-schema');
      expect(args).not.toContain('--permission-prompts');
    }
  });
  test('help probing rejects unsafe or incompatible CLI versions', () => {
    expect(() => capabilitiesFromHelp('codex', '--json --sandbox --config', '--json SESSION_ID')).not.toThrow();
    expect(capabilitiesFromHelp('codex', '--json --sandbox --config --output-schema', '--json SESSION_ID --output-schema').schema).toBe(true);
    expect(() => capabilitiesFromHelp('codex', '--json', '--json SESSION_ID')).toThrow('sandbox');
    expect(() => capabilitiesFromHelp('claude', '--print --output-format stream-json --verbose --resume')).toThrow('permission-mode');
  });
  test('session IDs cannot be CLI flags or injected argv', () => {
    expect(() => buildArgv({ ...base, sessionId: '--last' }, 'codex', caps)).toThrow('invalid session');
    expect(() => buildArgv({ ...base, sessionId: 'a b' }, 'codex', caps)).toThrow('invalid session');
  });
});

describe('bounded subprocess runner (synthetic processes, no real model calls)', () => {
  const synthetic = (source: string) => [process.execPath, '-e', source];
  test('uses literal argv and consumes both output streams', async () => {
    let stdout = '', stderr = '';
    const args = synthetic('console.log(process.argv.at(-1)); console.error("diagnostic")');
    args.push('$(echo should-not-execute); & literal');
    const code = await runBoundedProcess(args, {
      cwd: process.cwd(), signal: new AbortController().signal,
      onStdout: chunk => { stdout += chunk; }, onStderr: chunk => { stderr += chunk; },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('$(echo should-not-execute); & literal');
    expect(stderr).toContain('diagnostic');
  });
  test('times out and terminates a stuck child', async () => {
    await expect(runBoundedProcess(synthetic('setInterval(() => {}, 1000)'), {
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 50, onStdout: () => {},
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  test('oversized output fails instead of buffering indefinitely', async () => {
    await expect(runBoundedProcess(synthetic('console.log("x".repeat(10000))'), {
      cwd: process.cwd(), signal: new AbortController().signal, maxOutputBytes: 1000, onStdout: () => {},
    })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });
  test('cancellation rejects explicitly', async () => {
    const abort = new AbortController();
    const result = runBoundedProcess(synthetic('setInterval(() => {}, 1000)'), {
      cwd: process.cwd(), signal: abort.signal, onStdout: () => {},
    });
    abort.abort(new AgentRunError('CANCELLED', 'cancelled'));
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  test('already cancelled process never starts', async () => {
    const abort = new AbortController();
    abort.abort(new AgentRunError('CANCELLED', 'cancelled'));
    await expect(runBoundedProcess(['does-not-exist'], {
      cwd: process.cwd(), signal: abort.signal, onStdout: () => {},
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  test.skipIf(process.platform === 'win32' || !Bun.which('ps'))('cancellation kills descendants that ignore SIGTERM on POSIX', async () => {
    let output = '';
    const descendant = 'process.on("SIGTERM", () => {}); console.log("descendant=" + process.pid); setInterval(() => {}, 1000);';
    const parent = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(descendant)}], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }); setInterval(() => {}, 1000);`;
    await expect(runBoundedProcess(synthetic(parent), {
      cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 150,
      onStdout: chunk => { output += chunk; },
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pid = output.match(/descendant=(\d+)/)?.[1];
    expect(pid).toBeDefined();
    const statusProcess = Bun.spawn(['ps', '-o', 'stat=', '-p', pid!], { stdout: 'pipe', stderr: 'ignore' });
    const state = (await new Response(statusProcess.stdout).text()).trim();
    await statusProcess.exited;
    // A zombie has terminated and awaits the container init process reaping it.
    expect(state === '' || state.startsWith('Z')).toBe(true);
  });
});

describe('clearly labelled mock adapter', () => {
  const input = { provider: 'codex' as const, cwd: process.cwd(), instruction: '[ask] help', mock: true };
  test('clarification continues exactly the same mock session', async () => {
    const callbacks = capture();
    const first = await startAgent(input, callbacks).result;
    expect(first.envelope.status).toBe('needs_input');
    expect(first.sessionId).toStartWith('mock-codex-');
    const resumed = await startAgent({ ...input, sessionId: first.sessionId, answer: 'Prioritize tests.' }, callbacks).result;
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.envelope.status).toBe('completed');
    expect(resumed.envelope.summary).toStartWith('Mock:');
    expect(callbacks.comments.every(c => c.startsWith('Mock:'))).toBe(true);
  });
  test('blocked and failed are separate outcomes', async () => {
    expect((await startAgent({ ...input, instruction: '[blocked]' }, capture()).result).envelope.status).toBe('blocked');
    await expect(startAgent({ ...input, instruction: '[fail]' }, capture()).result).rejects.toMatchObject({ code: 'MOCK_FAILURE' });
  });
  test('mock cancellation is explicit and prevents completion', async () => {
    const handle = startAgent(input, capture());
    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  test('real and mock sessions cannot mix and answers need original sessions', async () => {
    await expect(startAgent({ ...input, sessionId: sid }, capture()).result).rejects.toThrow('real CLI session');
    await expect(startAgent({ ...input, mock: false, sessionId: 'mock-codex-simulated' }, capture()).result).rejects.toThrow('mock session');
    await expect(startAgent({ ...input, answer: 'Yes' }, capture()).result).rejects.toThrow('original session');
  });
});
