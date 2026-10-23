import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Source scanning for translation coverage tests: literal translation keys and leftover Russian text. */

export const root = join(import.meta.dir, '..');
export const cyrillic = /[А-Яа-яЁё]/;

export function sourceFiles(dir: string, extensions: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path, extensions) : extensions.test(name) ? [path] : [];
  }).sort();
}

const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0' };

/** Reads a string literal at `start`; template expressions become `sample`, or the read fails without one. */
export function readLiteral(source: string, start: number, sample?: string): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '\'' && quote !== '"' && quote !== '`') return null;
  let value = '';
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (char === '\\') { const next = source[++index]!; value += escapes[next] ?? next; continue; }
    if (char === quote) return { value, end: index + 1 };
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      if (sample === undefined) return null;
      index = skipExpression(source, index + 2) - 1;
      value += sample;
      continue;
    }
    if (quote !== '`' && char === '\n') return null;
    value += char;
  }
  return null;
}

/** Index just after the `}` that closes an expression starting at `start`. */
function skipExpression(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (char === '\'' || char === '"' || char === '`') { index = (readLiteral(source, index, '')?.end ?? index + 1) - 1; continue; }
    if (char === '{' || char === '(' || char === '[') depth++;
    else if (char === '}' || char === ')' || char === ']') { if (depth === 0) return index + 1; depth--; }
  }
  return source.length;
}

/** Splits call arguments starting after `(`; returns argument ranges and the index after `)`. */
export function callArguments(source: string, start: number): { args: [number, number][]; end: number } {
  const args: [number, number][] = [];
  let depth = 0, from = start;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (char === '\'' || char === '"' || char === '`') { index = (readLiteral(source, index, '')?.end ?? index + 1) - 1; continue; }
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) { if (source.slice(from, index).trim()) args.push([from, index]); return { args, end: index + 1 }; }
      depth--;
    } else if (char === ',' && depth === 0) { args.push([from, index]); from = index + 1; }
  }
  return { args, end: source.length };
}

export interface KeyUse { key: string; file: string; line: number; }

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

/** Literal keys passed to t(), tk(), tc() and plural(), and the source ranges those literals occupy. */
export function translationKeys(source: string, file: string, contextKey: (context: string, text: string) => string) {
  const keys: KeyUse[] = [];
  const ranges: [number, number][] = [];
  for (const match of source.matchAll(/(?<![\w$.])(t|tk|tc|plural)\(/g)) {
    const { args } = callArguments(source, match.index! + match[0].length);
    const literal = (arg: [number, number] | undefined) => {
      if (!arg) return null;
      const offset = arg[0] + (source.slice(arg[0], arg[1]).length - source.slice(arg[0], arg[1]).trimStart().length);
      const read = readLiteral(source, offset);
      if (!read || source.slice(read.end, arg[1]).trim()) return null;
      ranges.push([offset, read.end]);
      return read.value;
    };
    const line = lineOf(source, match.index!);
    if (match[1] === 't' || match[1] === 'tk') {
      const key = literal(args[0]);
      if (key !== null) keys.push({ key, file, line });
    } else if (match[1] === 'tc') {
      const context = literal(args[0]), text = literal(args[1]);
      if (context !== null && text !== null) keys.push({ key: contextKey(context, text), file, line });
    } else {
      // English needs the singular and the «many» form; the «few» form is Russian only.
      const forms = args.slice(1).map(literal);
      for (const key of [forms[0], forms[2]]) if (key != null) keys.push({ key, file, line });
    }
  }
  return { keys, ranges };
}

/** Comment ranges in Svelte markup and scripts; `//` counts only after whitespace or at a line start. */
export function commentRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of source.matchAll(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/[^\n]*/gm)) ranges.push([match.index!, match.index! + match[0].length]);
  return ranges;
}

/** Lines with Russian text outside translation calls, comments and lines marked `i18n-ignore`. */
export function untranslatedLines(source: string, ignored: [number, number][]): { line: number; text: string }[] {
  const hidden = new Uint8Array(source.length);
  for (const [from, to] of ignored) hidden.fill(1, from, to);
  const lines = source.split('\n');
  const result: { line: number; text: string }[] = [];
  let offset = 0;
  lines.forEach((text, index) => {
    if (!text.includes('i18n-ignore')) {
      for (let column = 0; column < text.length; column++) {
        if (!hidden[offset + column] && cyrillic.test(text[column]!)) { result.push({ line: index + 1, text: text.trim().slice(0, 160) }); break; }
      }
    }
    offset += text.length + 1;
  });
  return result;
}

export function read(path: string) { return readFileSync(path, 'utf8'); }
