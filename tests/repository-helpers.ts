import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentCallbacks, AgentInput, AgentOutcome } from '../server/adapter';
import type { AgentFactory } from '../server/engine';
import type { Envelope, TaskInput } from '../src/lib/types';

export function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (child.exitCode) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}
export function repository(folder: string, name = 'project') {
  const root = join(folder, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'src/value.txt'), 'base\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.brigd-inputs-*/\n.brigd-outbox-*/\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  return root;
}
export function controlledAgent() {
  const calls: { input: AgentInput; callbacks: AgentCallbacks; resolve: (value: AgentOutcome) => void; reject: (reason: unknown) => void; ignoreCancel: boolean }[] = [];
  const factory: AgentFactory = (input, callbacks) => {
    let resolve!: (value: AgentOutcome) => void, reject!: (reason: unknown) => void;
    const result = new Promise<AgentOutcome>((yes, no) => { resolve = yes; reject = no; });
    const call = { input, callbacks, resolve, reject, ignoreCancel: false };
    calls.push(call);
    return { result, cancel: () => { if (!call.ignoreCancel) reject(new Error('Synthetic cancellation')); } };
  };
  return { factory, calls };
}
export const taskInput = (cwd: string, patch: Partial<TaskInput> = {}): TaskInput => ({ title: 'Isolated work', instruction: 'Update the project.', provider: 'codex', cwd,
  schedule: 'manual', intervalMinutes: null, firstRunAt: null, paused: false, ...patch });
export const outcome = (sessionId = 'saved-session', status: Envelope['status'] = 'completed'): AgentOutcome => ({ sessionId,
  envelope: { status, summary: 'Synthetic result.', questions: status === 'needs_input' ? ['Which outcome?'] : [] } });
export async function until(ready: () => boolean) {
  // A monotonic deadline: the wall clock of a VM or WSL can step by seconds.
  const deadline = performance.now() + 5_000;
  while (!ready()) { if (performance.now() >= deadline) throw new Error('Condition did not settle'); await Bun.sleep(10); }
}
