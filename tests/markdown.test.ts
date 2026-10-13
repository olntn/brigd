import { describe, expect, test } from 'bun:test';
import { renderCommentMarkdown } from '../src/lib/markdown';

describe('comment Markdown', () => {
  test('renders inline formatting, links, and existing line breaks', () => {
    const html = renderCommentMarkdown('**Жирный**, *курсив*, ~~удалено~~ и `code`.\n[Сайт](https://example.com) и https://example.org');
    expect(html).toContain('<strong>Жирный</strong>');
    expect(html).toContain('<em>курсив</em>');
    expect(html).toContain('<s>удалено</s>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<br>\n');
    expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.org"');
  });

  test('renders nested lists, quotes, fenced code, and tables', () => {
    const html = renderCommentMarkdown([
      '## Результат', '', '- Первый', '  - Вложенный', '', '1. Шаг', '',
      '> Цитата', '', '```ts', 'const x = "<tag>";', '  console.log(x);', '```', '',
      '| Имя | Статус |', '| --- | --- |', '| UI | **Готово** |',
    ].join('\n'));
    expect(html).toContain('<h2>Результат</h2>');
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-ts">const x = &quot;&lt;tag&gt;&quot;;\n  console.log(x);\n</code></pre>');
    expect(html).toContain('class="comment-table"');
    expect(html).toContain('<th>Имя</th>');
    expect(html).toContain('<td><strong>Готово</strong></td>');
  });

  test('escapes HTML, code contents, titles, and image attributes', () => {
    const html = renderCommentMarkdown([
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '',
      '`<b>literal</b>`', '', '[Link](https://example.com "&quot; onmouseover=&quot;alert(1)")', '',
      '![" onerror="alert(1)](https://example.com/image.png)',
    ].join('\n'));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<code>&lt;b&gt;literal&lt;/b&gt;</code>');
    expect(html).toContain('title="&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(' onerror="');
    expect(html).not.toContain(' onmouseover="');
  });

  test.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)',
    'vbscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd',
  ])('does not create active links or images for %s', url => {
    const html = renderCommentMarkdown(`[Link](${url})\n![Image](${url})`);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img ');
  });

  test('keeps relative and email links usable without a new browsing context', () => {
    const html = renderCommentMarkdown('[File](./README.md) [Mail](mailto:hello@example.com)');
    expect(html).toContain('<a href="./README.md">File</a>');
    expect(html).toContain('<a href="mailto:hello@example.com">Mail</a>');
  });
});
