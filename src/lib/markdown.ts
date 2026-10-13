import MarkdownIt from 'markdown-it';

// Comment bodies are untrusted. Keep raw HTML disabled and retain the parser's
// default URL validation when customizing how links and images are displayed.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  if (/^(?:https?:)?\/\//i.test(String(token.attrGet('href') ?? ''))) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return renderer.renderToken(tokens, index, options);
};

const renderImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('loading', 'lazy');
  return renderImage(tokens, index, options, env, renderer);
};

markdown.renderer.rules.table_open = () => '<div class="comment-table" tabindex="0" role="region" aria-label="Таблица в комментарии"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

export function renderCommentMarkdown(body: string): string {
  return markdown.render(body);
}
