import { buildArgv, capabilitiesFromHelp, runBoundedProcess } from '../server/adapter';
import { effortOptions, modelPresets } from '../src/lib/workers';
import type { Provider } from '../src/lib/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskBridgeConfig } from '../server/task-mcp-protocol';

// Parse/help probes only: this script NEVER submits a prompt or makes model calls.
const probe = async (argv: string[], env?: Record<string, string | undefined>) => {
  let text = '', errors = '';
  const code = await runBoundedProcess(argv, { cwd: process.cwd(), signal: new AbortController().signal,
    env, timeoutMs: 8000, maxOutputBytes: 262144, onStdout: chunk => { text += chunk; }, onStderr: chunk => { errors += chunk; } });
  if (code !== 0) throw new Error(`CLI flag/help probe failed (${code}): ${argv[0]} ${errors.slice(0, 1000)}`);
  return text;
};
const bridge: TaskBridgeConfig = {
  name: 'brigd_task_0123456789abcdef', command: process.execPath, args: [join(process.cwd(), 'dist/task-mcp-stdio.js')],
  env: { BRIGD_TASK_SOCKET: '/tmp/brigd-never-connected-probe.sock', BRIGD_TASK_CAPABILITY: '0'.repeat(64) },
  context: { taskId: 'probe-task', runId: 'probe-run', turn: 1, stepIndex: null, attachments: [], outputDirectory: '/tmp/brigd-never-created-outbox' },
};
for (const provider of ['codex', 'claude'] as Provider[]) {
  const binary = Bun.which(provider);
  if (!binary) throw new Error(`${provider} is missing; this check requires the pinned container CLIs.`);
  const capabilities = provider === 'codex'
    ? capabilitiesFromHelp(provider, await probe([binary, 'exec', '--help']), await probe([binary, 'exec', 'resume', '--help']))
    : capabilitiesFromHelp(provider, await probe([binary, '--help']));
  if (!capabilities.model) throw new Error(`${provider} does not advertise --model on new and resumed paths`);
  for (const effort of effortOptions[provider]) {
    if (effort !== 'default' && !capabilities.efforts?.includes(effort)) throw new Error(`${provider} does not advertise the configured effort ${effort}`);
    for (const model of [null, modelPresets[provider][0]!.id]) for (const resumed of [false, true]) for (const taskBridge of [undefined, bridge]) {
      const argv = buildArgv({ provider, cwd: process.cwd(), instruction: 'Never submitted: help probe only.', model, effort,
        ...(taskBridge ? { taskBridge } : {}),
        ...(resumed ? { sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53', answer: 'Never submitted.' } : {}) }, binary, capabilities);
      // Drop every positional prompt/session argument in Codex. Claude's explicit
      // --resume ID remains a flag value, but its prompt is removed before --help.
      const help = provider === 'codex' ? [...argv.slice(0, argv.indexOf('--')), '--help'] : [...argv.slice(0, -1), '--help'];
      await probe(help);
    }
  }
  if (provider === 'codex') {
    // --help alone does not deserialize TOML. The read-only mcp get command
    // validates every generated server/tool option without starting a server.
    const argv = buildArgv({ provider, cwd: process.cwd(), instruction: 'Never submitted.', taskBridge: bridge }, binary, capabilities);
    const config: string[] = [];
    for (let index = 0; index < argv.indexOf('--'); index++) if (argv[index] === '-c') config.push('-c', argv[++index]!);
    const home = mkdtempSync(join(tmpdir(), 'brigd-cli-config-'));
    try {
      const parsed = JSON.parse(await probe([binary, ...config, 'mcp', 'get', bridge.name, '--json'], { ...process.env, CODEX_HOME: home }));
      if (!parsed || JSON.stringify(parsed).includes(bridge.env.BRIGD_TASK_CAPABILITY)) throw new Error('Invalid or credential-bearing MCP config');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  console.log(`PASS: ${provider} native new/resume flag parsing for default/explicit model and ${effortOptions[provider].join(', ')} with and without task MCP${provider === 'codex' ? ', including TOML server/tool config deserialization' : ''}; no model calls.`);
}
