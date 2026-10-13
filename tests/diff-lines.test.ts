import { describe, expect, test } from 'bun:test';
import { diffLines } from '../src/lib/diff-lines';

describe('unified diff rows', () => {
  test('tracks both line numbers through replacements and separate hunks', () => {
    const rows = diffLines('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,3 @@ function f()\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-last\n+changed\n');
    expect(rows.filter(row => row.kind !== 'hunk')).toEqual([
      { kind: 'context', text: 'same', oldLine: 3, newLine: 3 },
      { kind: 'deletion', text: 'old', oldLine: 4, newLine: null },
      { kind: 'addition', text: 'new', oldLine: null, newLine: 4 },
      { kind: 'addition', text: 'extra', oldLine: null, newLine: 5 },
      { kind: 'deletion', text: 'last', oldLine: 20, newLine: null },
      { kind: 'addition', text: 'changed', oldLine: null, newLine: 21 },
    ]);
  });
  test('retains code resembling patch headers and empty added lines', () => {
    const rows = diffLines('@@ -1 +1,3 @@\n--- value\n+++ value\n+\n+<script>alert(1)</script>\n');
    expect(rows.slice(1).map(row => [row.kind, row.text])).toEqual([
      ['deletion', '-- value'], ['addition', '++ value'], ['addition', ''], ['addition', '<script>alert(1)</script>'],
    ]);
  });
  test('does not advance numbers for missing newline notices', () => {
    const rows = diffLines('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file');
    expect(rows[3]).toMatchObject({ kind: 'addition', newLine: 1 });
    expect(rows.filter(row => row.kind === 'meta').every(row => row.oldLine === null && row.newLine === null)).toBe(true);
    expect(diffLines('')).toEqual([]);
  });
});
