import { tk } from './i18n/key';

export interface DiffLine {
  kind: 'context' | 'addition' | 'deletion' | 'hunk' | 'meta';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Interpret unified hunks without confusing code beginning with +++/--- with file headers. */
export function diffLines(patch: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (inHunk && line.startsWith('+')) {
      rows.push({ kind: 'addition', text: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (inHunk && line.startsWith('-')) {
      rows.push({ kind: 'deletion', text: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (inHunk && line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (!/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
      rows.push({ kind: 'meta', text: line === '\\ No newline at end of file' ? tk('Нет перевода строки в конце файла') : line, oldLine: null, newLine: null });
    }
  }
  return rows;
}
