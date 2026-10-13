/** A bounded, read-only view of the changes made during one task run. */
export interface CodeDiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'typechanged';
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  patch: string;
}

export interface RunCodeDiff {
  runId: string;
  state: 'available' | 'unavailable';
  reason: string | null;
  files: CodeDiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  baseCommit: string | null;
  headCommit: string | null;
  capturedAt: number;
  live: boolean;
}
