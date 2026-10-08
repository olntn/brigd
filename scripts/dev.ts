// One parent process controls both children; Ctrl-C stops the scheduler too.
const children = [
  Bun.spawn([process.execPath, 'server/index.ts'], { env: { ...process.env, TRACKT_DEV: '1' }, stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn([process.execPath, 'x', 'vite'], { stdout: 'inherit', stderr: 'inherit' })
];
let exiting = false;
async function stop(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exited));
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
for (const child of children) void child.exited.then(code => stop(code));
