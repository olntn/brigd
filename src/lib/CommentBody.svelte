<script lang="ts">
  import { renderCommentMarkdown } from './markdown';

  let { body }: { body: string } = $props();
  const html = $derived(renderCommentMarkdown(body));
</script>

<div class="comment-body">{@html html}</div>
