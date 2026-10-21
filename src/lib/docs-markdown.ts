import type { DocBlock } from './types';
import { createDocBlock, DOC_INDENT_LIMIT, DOC_TABLE_COLUMN_LIMIT, DOC_TABLE_ROW_LIMIT, docListNumbers } from './docs';

export interface DocMarkdownContext { pageId: string; }
const IMAGE_ID = /^[a-f0-9-]{36}$/;
const TASK_ID = /^[a-fA-F0-9-]{36}$/;
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const singleLine = (value: string) => value.replace(/\s*\n\s*/g, ' ').trim();
function fence(text: string): string {
  let marker = '```';
  while (text.includes(marker)) marker += '`';
  return marker;
}

/** Markdown for agents and files. Toggles become <details>, images link to their page route, task cards become @task(id) lines. */
export function docBlocksToMarkdown(blocks: DocBlock[], context: DocMarkdownContext): string {
  const numbers = docListNumbers(blocks);
  const lines: string[] = [];
  const open: number[] = [];
  let previous: DocBlock | null = null;
  const list = (block: DocBlock | null) => !!block && (block.type === 'bulleted' || block.type === 'numbered' || block.type === 'todo');
  const emit = (indent: number, text: string, continuation = '') => {
    const pad = '  '.repeat(indent);
    text.split('\n').forEach((line, index) => lines.push(index === 0 ? pad + line : pad + continuation + line));
  };
  for (const block of blocks) {
    const indent = block.indent ?? 0;
    while (open.length && indent <= open[open.length - 1]!) { open.pop(); lines.push('', '  '.repeat(open.length ? open[open.length - 1]! + 1 : 0) + '</details>'); }
    if (lines.length && !(list(previous) && list(block))) lines.push('');
    switch (block.type) {
      case 'heading1': case 'heading2': case 'heading3': emit(indent, '#'.repeat(Number(block.type.slice(-1))) + ' ' + singleLine(block.text)); break;
      case 'bulleted': emit(indent, '- ' + block.text, '  '); break;
      case 'numbered': { const number = `${numbers.get(block.id) ?? 1}. `; emit(indent, number + block.text, ' '.repeat(number.length)); break; }
      case 'todo': emit(indent, (block.checked ? '- [x] ' : '- [ ] ') + block.text, '      '); break;
      case 'quote': emit(indent, block.text.split('\n').map(line => '> ' + line).join('\n')); break;
      case 'callout': emit(indent, block.text.split('\n').map((line, index) => '> ' + (index === 0 ? `${block.icon ?? ''} ${line}`.trim() : line)).join('\n')); break;
      case 'code': { const marker = fence(block.text); emit(indent, `${marker}${block.language ?? ''}\n${block.text}\n${marker}`); break; }
      case 'divider': emit(indent, '---'); break;
      case 'toggle': emit(indent, `<details>\n<summary>${singleLine(block.text)}</summary>`); open.push(indent); break;
      case 'table': {
        const rows = block.rows?.length ? block.rows : [['']];
        const width = rows[0]!.length;
        emit(indent, [rows[0]!, Array.from({ length: width }, () => '---'), ...rows.slice(1)].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n'));
        break;
      }
      case 'image': emit(indent, `![${singleLine(block.text)}](${block.imageId ? `/api/docs/${context.pageId}/images/${block.imageId}` : ''})`); break;
      case 'toc': emit(indent, '[[toc]]'); break;
      case 'task': emit(indent, `@task(${block.taskId ?? ''})`); break;
      default: emit(indent, block.text);
    }
    previous = block;
  }
  while (open.length) { open.pop(); lines.push('', '  '.repeat(open.length ? open[open.length - 1]! + 1 : 0) + '</details>'); }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + (lines.length ? '\n' : '');
}

const splitCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'));
const isSeparator = (line: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/** Line-based parser for the Markdown subset the editor can show; anything else becomes paragraph text. */
export function markdownToDocBlocks(markdown: string, context: DocMarkdownContext): DocBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let depth = 0;
  let awaitingSummary = false;
  let paragraph: string[] | null = null;
  let quote: string[] | null = null;
  let lastItem: DocBlock | null = null;
  const push = (block: DocBlock, indent = 0) => {
    const level = Math.min(DOC_INDENT_LIMIT, indent + depth);
    if (level) block.indent = level;
    blocks.push(block);
    return block;
  };
  const flush = () => {
    if (paragraph) { push(createDocBlock('paragraph', paragraph.join('\n'))); paragraph = null; }
    if (quote) { push(createDocBlock('quote', quote.join('\n'))); quote = null; }
    lastItem = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\t/g, '  ');
    const trimmed = line.trim();
    const leading = line.length - line.trimStart().length;
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]{0,40})\s*$/);
    if (fenceMatch) {
      flush();
      const marker = fenceMatch[1]!;
      const body: string[] = [];
      for (index++; index < lines.length; index++) {
        const candidate = lines[index]!.trim();
        if (candidate.startsWith(marker) && /^[`~]+\s*$/.test(candidate)) break;
        body.push(lines[index]!.replace(/\t/g, '  ').slice(Math.min(leading, lines[index]!.length - lines[index]!.trimStart().length)));
      }
      const block = push(createDocBlock('code', body.join('\n')), Math.floor(leading / 2));
      block.language = fenceMatch[2] ?? '';
      continue;
    }
    if (!trimmed) { flush(); continue; }
    const details = trimmed.match(/^<details>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i);
    if (details) {
      flush();
      if (details[1] !== undefined) { push(createDocBlock('toggle', details[1].trim())); depth = Math.min(DOC_INDENT_LIMIT, depth + 1); }
      else awaitingSummary = true;
      continue;
    }
    const summary = trimmed.match(/^<summary>(.*?)<\/summary>\s*$/i);
    if (summary && awaitingSummary) { flush(); awaitingSummary = false; push(createDocBlock('toggle', summary[1]!.trim())); depth = Math.min(DOC_INDENT_LIMIT, depth + 1); continue; }
    if (/^<\/details>\s*$/i.test(trimmed)) { flush(); awaitingSummary = false; depth = Math.max(0, depth - 1); continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { flush(); push(createDocBlock(`heading${Math.min(3, heading[1]!.length)}` as DocBlock['type'], heading[2]!), Math.floor(leading / 2)); continue; }
    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) { flush(); push(createDocBlock('divider'), Math.floor(leading / 2)); continue; }
    if (/^\[\[toc\]\]$/i.test(trimmed)) { flush(); push(createDocBlock('toc'), Math.floor(leading / 2)); continue; }
    const task = trimmed.match(/^@task\(([^)]*)\)$/);
    if (task) { flush(); const block = push(createDocBlock('task'), Math.floor(leading / 2)); block.taskId = TASK_ID.test(task[1]!.trim()) ? task[1]!.trim().toLowerCase() : null; continue; }
    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]*)\)$/);
    if (image) {
      const own = image[2]!.match(new RegExp(`^/api/docs/${context.pageId}/images/([a-f0-9-]{36})$`));
      flush();
      if (own && IMAGE_ID.test(own[1]!)) { const block = push(createDocBlock('image', image[1]!), Math.floor(leading / 2)); block.imageId = own[1]!; }
      else push(createDocBlock('paragraph', trimmed), Math.floor(leading / 2));
      continue;
    }
    if (trimmed.startsWith('|') && index + 1 < lines.length && isSeparator(lines[index + 1]!)) {
      flush();
      const rows = [splitCells(trimmed)];
      for (index += 2; index < lines.length && lines[index]!.trim().startsWith('|'); index++) rows.push(splitCells(lines[index]!));
      index--;
      const width = Math.min(DOC_TABLE_COLUMN_LIMIT, Math.max(1, rows[0]!.length));
      const block = push(createDocBlock('table'), Math.floor(leading / 2));
      block.rows = rows.slice(0, DOC_TABLE_ROW_LIMIT).map(row => Array.from({ length: width }, (_, column) => row[column] ?? ''));
      block.header = true;
      continue;
    }
    const item = trimmed.match(/^([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
    if (item && !(item[1] === '*' && /^\*\s*\*/.test(trimmed))) {
      flush();
      const type = item[2] !== undefined ? 'todo' : /\d/.test(item[1]!) ? 'numbered' : 'bulleted';
      const block = push(createDocBlock(type, item[3] ?? ''), Math.floor(leading / 2));
      if (type === 'todo') block.checked = /x/i.test(item[2]!);
      lastItem = block;
      continue;
    }
    const quoted = trimmed.match(/^>\s?(.*)$/);
    if (quoted) {
      if (paragraph) { push(createDocBlock('paragraph', paragraph.join('\n'))); paragraph = null; }
      lastItem = null;
      quote = [...(quote ?? []), quoted[1]!];
      continue;
    }
    if (quote) { push(createDocBlock('quote', quote.join('\n'))); quote = null; }
    if (lastItem && leading >= 2 && !paragraph) { lastItem.text += '\n' + trimmed; continue; }
    lastItem = null;
    paragraph = [...(paragraph ?? []), trimmed];
  }
  flush();
  return blocks;
}
