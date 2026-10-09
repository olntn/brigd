<script lang="ts">
  let { name, avatarUrl = null, size = 40 }: { name: string; avatarUrl?: string | null; size?: number } = $props();
  let failedUrl = $state<string | null>(null);
  let initials = $derived(name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0] ?? '').join('').toLocaleUpperCase() || '?');
  let source = $derived(avatarUrl && (avatarUrl.startsWith('/api/avatars/') || avatarUrl.startsWith('blob:')) && avatarUrl !== failedUrl ? avatarUrl : null);
</script>

<span class="worker-avatar" style:width="{size}px" style:height="{size}px" style:font-size="{Math.max(10, size * .34)}px" aria-hidden="true">
  {#if source}<img src={source} alt="" width={size} height={size} onerror={() => failedUrl = avatarUrl} />{:else}{initials}{/if}
</span>
