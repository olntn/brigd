<script lang="ts">
  let { name, size = 18, stroke = 1.7, class: className = '' }: { name: string; size?: number; stroke?: number; class?: string } = $props();
  const paths: Record<string, string> = {
    plus: 'M12 5v14M5 12h14',
    close: 'm6 6 12 12M18 6 6 18',
    search: 'm21 21-4.3-4.3M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z',
    board: 'M4 4h6v16H4zM14 4h6v10h-6z',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    chevron: 'm9 5 7 7-7 7',
    down: 'm6 9 6 6 6-6',
    terminal: 'm5 7 5 5-5 5M13 17h6',
    check: 'm5 12 4 4L19 6',
    circlecheck: 'm8 12 3 3 5-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    play: 'm8 5 11 7-11 7V5Z',
    pause: 'M8 5v14M16 5v14',
    stop: 'M6 6h12v12H6z',
    edit: 'm16 3 5 5M4 20l4-1L21 6a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0L5 16l-1 4Z',
    message: 'M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z',
    alert: 'M12 8v5M12 17h.01M10.3 3.7 2.1 18a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z',
    spark: 'm12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8L12 3Z',
    inbox: 'M4 4h16l2 12v4H2v-4L4 4ZM2 16h6l2 3h4l2-3h6',
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13.2 3M4.7 15a8 8 0 0 0 13.2 3',
    send: 'm22 2-7 20-4-9-9-4L22 2ZM22 2 11 13',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    history: 'M3 4v5h5M3.5 9A9 9 0 1 1 3 15M12 7v5l3 2',
    code: 'm8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18',
    bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
    circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    external: 'M14 3h7v7M10 14 21 3M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6',
    moon: 'M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6',
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" class={className} aria-hidden="true"><path d={paths[name] || paths.circle} /></svg>
