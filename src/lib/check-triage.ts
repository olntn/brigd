import type { CheckTriage, CheckTriageCounts } from './types';

/** Automatic hand-backs of one result after failed merge checks; then a person decides. Matches the integrator's reconcile limit. */
export const CHECK_HANDBACK_LIMIT = 3;
/** Reruns and the target-branch check of one merge attempt together; the merge queue of the repository waits meanwhile. */
export const CHECK_TRIAGE_TIME_LIMIT_MS = 30 * 60_000;
/** Characters of the failed command's output handed to the worker, the same bound as a follow-up request. */
export const CHECK_HANDBACK_OUTPUT_LIMIT = 8_000;
/** Without a saved choice brigd triages failed checks on its own: on green results it costs nothing. */
export const DEFAULT_CHECK_TRIAGE = true;

export const emptyTriageCounts = (): CheckTriageCounts => ({ flaky: 0, targetFailed: 0, returned: 0, exhausted: 0, notReturned: 0, stopped: 0 });

/** A failed command passed on its rerun: the result merged, but the failure may be a race the task itself introduced. */
export const passedOnRetry = (triage: CheckTriage | null | undefined): boolean => !!triage?.retries.some(retry => retry.exitCode === 0);

/** Adds one finished attempt's triage to the counts. */
export function countTriage(counts: CheckTriageCounts, triage: CheckTriage | null | undefined): void {
  if (!triage) return;
  if (passedOnRetry(triage)) counts.flaky++;
  switch (triage.outcome) {
    case 'target_failed': counts.targetFailed++; break;
    case 'returned': counts.returned++; break;
    case 'limit': counts.exhausted++; break;
    case 'no_session': case 'workflow': case 'disabled': case 'error': counts.notReturned++; break;
    case 'timeout': case 'interrupted': case 'stopped': counts.stopped++; break;
  }
}
