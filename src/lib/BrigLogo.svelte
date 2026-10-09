<script lang="ts">
  let { size = 28 }: { size?: number } = $props();
</script>

<!-- A brig has two masts, both carrying square sails. Keep the silhouette legible at 24px. -->
<svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" class="brig-logo">
  <path d="M10.5 3v21M21 4.5V24M3 23.5h23l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M6 6h9l-.6 5H6.6L6 6Zm-.5 7h10l-.7 6H6.2l-.7-6ZM17 7.5h8l-.5 4.5h-7L17 7.5Zm-.5 6.5h9l-.7 5.5h-7.6l-.7-5.5ZM3.5 23.5h24l-3.7 4.8H8.3l-4.8-4.8Z" fill="currentColor" />
  <path d="m26 16 3 6M6 30h19" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
</svg>
