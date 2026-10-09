import { buildArgv, capabilitiesFromHelp, runBoundedProcess } from '../server/adapter';
import { effortOptions } from '../src/lib/workers';
import type { Provider } from '../src/lib/types';

// Parse/help probes only: this script NEVER submits a prompt or makes model calls.
const probe = async (argv: string[]) => {
  let text = '';
  const code = await runBoundedProcess(argv, { cwd: process.cwd(), signal: new AbortController().signal,
    timeoutMs: 8000, maxOutputBytes: 262144, onStdout: chunk => { text += chunk; }, onStderr: chunk => { text += chunk; } });
  if (code !== 0) throw new Error(`CLI flag/help probe failed (${code}): ${argv[0]}`);
  return text;
};
for (const provider of ['codex', 'claude'] as Provider[]) {
  const binary = Bun.which(provider);
  if (!binary) throw new Error(`${provider} is missing; this check requires the pinned container CLIs.`);
  const capabilities = provider === 'codex'
    ? capabilitiesFromHelp(provider, await probe([binary, 'exec', '--help']), await probe([binary, 'exec', 'resume', '--help']))
    : capabilitiesFromHelp(provider, await probe([binary, '--help']));
  for (const effort of effortOptions[provider]) {
    if (effort !== 'default' && !capabilities.efforts?.includes(effort)) throw new Error(`${provider} does not advertise the configured effort ${effort}`);
    for (const resumed of [false, true]) {
      const argv = buildArgv({ provider, cwd: process.cwd(), instruction: 'Never submitted: help probe only.', effort,
        ...(resumed ? { sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53', answer: 'Never submitted.' } : {}) }, binary, capabilities);
      // Drop every positional prompt/session argument in Codex. Claude's explicit
      // --resume ID remains a flag value, but its prompt is removed before --help.
      const help = provider === 'codex' ? [...argv.slice(0, argv.indexOf('--')), '--help'] : [...argv.slice(0, -1), '--help'];
      await probe(help);
    }
  }
  console.log(`PASS: ${provider} native new/resume flag parsing for ${effortOptions[provider].join(', ')}; no model calls.`);
}
