let latest = 0;
/** Wall-clock milliseconds for stored timestamps; each call returns more than the previous one in this process.
 * NTP, WSL and VM clock corrections can step Date.now() back by seconds, while the order of runs, the newest run of a task and
 * the retention of shared worktrees compare stored timestamps: a step back would make a new run look older than the result it
 * continues, and a merge look older than the conflict it resolved. A backward step is absorbed by advancing 1 ms per call until
 * the wall clock catches up. */
export function clock(): number {
  const now = Date.now();
  latest = now > latest ? now : latest + 1;
  return latest;
}
