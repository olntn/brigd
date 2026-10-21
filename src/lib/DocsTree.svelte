<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { docPageTitle, type DocHeading, type DocTreeNode } from './docs';
  import type { DocPageMoveInput } from './types';

  let { nodes, selectedId, headings, disabled = false, onselect, oncreate, onmove, ondelete, onheading }: {
    nodes: DocTreeNode[];
    selectedId: string | null;
    headings: DocHeading[];
    disabled?: boolean;
    onselect: (id: string) => void;
    oncreate: (parentId: string) => void;
    onmove: (id: string, input: DocPageMoveInput) => void;
    ondelete: (id: string) => void;
    onheading: (id: string) => void;
  } = $props();
  const storageKey = 'brigd-docs-expanded';
  let expanded = $state<Set<string>>(readExpanded());
  let menuId = $state<string | null>(null);
  let tree = $state<HTMLElement>();
  let parents = $derived(parentMap(nodes));

  function readExpanded(): Set<string> {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
    } catch { return new Set(); }
  }
  function remember(next: Set<string>) {
    expanded = next;
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Per-browser convenience only. */ }
  }
  function setExpanded(id: string, open: boolean) {
    const next = new Set(expanded);
    if (open) next.add(id); else next.delete(id);
    remember(next);
  }
  function parentMap(items: DocTreeNode[]): Map<string, { parent: DocTreeNode | null; siblings: DocTreeNode[]; index: number }> {
    const map = new Map<string, { parent: DocTreeNode | null; siblings: DocTreeNode[]; index: number }>();
    const walk = (siblings: DocTreeNode[], parent: DocTreeNode | null) => siblings.forEach((node, index) => { map.set(node.page.id, { parent, siblings, index }); walk(node.children, node); });
    walk(items, null);
    return map;
  }
  // Reveal the open page even when its ancestors were collapsed in another session.
  $effect(() => {
    if (!selectedId) return;
    const missing: string[] = [];
    for (let entry = parents.get(selectedId); entry?.parent; entry = parents.get(entry.parent.page.id)) {
      if (!expanded.has(entry.parent.page.id)) missing.push(entry.parent.page.id);
    }
    if (missing.length) { const next = new Set(expanded); for (const id of missing) next.add(id); remember(next); }
  });

  function moveUp(id: string) { const entry = parents.get(id); if (entry && entry.index > 0) onmove(id, { position: entry.index - 1 }); }
  function moveDown(id: string) { const entry = parents.get(id); if (entry && entry.index < entry.siblings.length - 1) onmove(id, { position: entry.index + 1 }); }
  function nest(id: string) {
    const entry = parents.get(id);
    const previous = entry && entry.index > 0 ? entry.siblings[entry.index - 1] : null;
    if (!previous) return;
    setExpanded(previous.page.id, true);
    onmove(id, { parentId: previous.page.id, position: previous.children.length });
  }
  function lift(id: string) {
    const entry = parents.get(id);
    if (!entry?.parent) return;
    const grand = parents.get(entry.parent.page.id);
    onmove(id, { parentId: entry.parent.page.parentId, position: (grand?.index ?? 0) + 1 });
  }
  async function openMenu(id: string) {
    menuId = menuId === id ? null : id;
    await tick();
    tree?.querySelector<HTMLButtonElement>('.docs-menu button:not(:disabled)')?.focus();
  }
  function closeMenu(restore = true) {
    const id = menuId;
    menuId = null;
    if (restore && id) tree?.querySelector<HTMLButtonElement>(`[data-doc-menu="${CSS.escape(id)}"]`)?.focus();
  }
  function menuKey(event: KeyboardEvent) {
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
    else if (event.key === 'Tab') closeMenu(false);
  }
  function pick(action: () => void) { closeMenu(); action(); }
  function outside(event: PointerEvent) {
    if (menuId && !(event.target instanceof Node && tree?.querySelector('.docs-menu')?.contains(event.target)) && !(event.target instanceof HTMLElement && event.target.closest('[data-doc-menu]'))) closeMenu(false);
  }
  /** Arrow keys walk the visible page titles so the outline can be browsed without leaving the keyboard. */
  function titleKey(event: KeyboardEvent, node: DocTreeNode) {
    const titles = [...(tree?.querySelectorAll<HTMLButtonElement>('.docs-tree-title') ?? [])];
    const index = titles.indexOf(event.currentTarget as HTMLButtonElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); titles[index + 1]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); titles[index - 1]?.focus(); }
    else if (event.key === 'ArrowRight' && node.children.length && !expanded.has(node.page.id)) { event.preventDefault(); setExpanded(node.page.id, true); }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.children.length && expanded.has(node.page.id)) setExpanded(node.page.id, false);
      else { const parent = parents.get(node.page.id)?.parent; if (parent) tree?.querySelector<HTMLButtonElement>(`[data-doc-title="${CSS.escape(parent.page.id)}"]`)?.focus(); }
    }
  }
</script>

<svelte:window onpointerdown={outside} />

{#snippet item(node: DocTreeNode)}
  {@const id = node.page.id}
  {@const selected = id === selectedId}
  {@const entry = parents.get(id)}
  {@const open = expanded.has(id)}
  <li>
    <div class="docs-tree-row" class:selected style:--depth={node.depth}>
      {#if node.children.length}
        <button type="button" class="docs-tree-toggle" aria-expanded={open} aria-label={(open ? 'Свернуть: ' : 'Развернуть: ') + docPageTitle(node.page)} onclick={() => setExpanded(id, !open)}><Icon name={open ? 'down' : 'chevron'} size={14} /></button>
      {:else}<span class="docs-tree-toggle docs-tree-leaf" aria-hidden="true"><Icon name="file" size={13} /></span>{/if}
      <button type="button" class="docs-tree-title" data-doc-title={id} aria-current={selected ? 'page' : undefined} onclick={() => onselect(id)} onkeydown={(event) => titleKey(event, node)}>{docPageTitle(node.page)}</button>
      <button type="button" class="docs-tree-menu-button icon-button" data-doc-menu={id} aria-label={'Действия: ' + docPageTitle(node.page)} aria-haspopup="menu" aria-expanded={menuId === id} {disabled} onclick={() => openMenu(id)}><Icon name="dots" size={15} /></button>
      {#if menuId === id}
        <div class="docs-menu" role="menu" tabindex="-1" aria-label={'Действия со страницей: ' + docPageTitle(node.page)} onkeydown={menuKey}>
          <button type="button" role="menuitem" onclick={() => pick(() => oncreate(id))}><Icon name="plus" size={14} />Добавить подстраницу</button>
          <hr />
          <button type="button" role="menuitem" disabled={!entry || entry.index === 0} onclick={() => pick(() => moveUp(id))}>Переместить выше</button>
          <button type="button" role="menuitem" disabled={!entry || entry.index >= entry.siblings.length - 1} onclick={() => pick(() => moveDown(id))}>Переместить ниже</button>
          <button type="button" role="menuitem" disabled={!entry || entry.index === 0} onclick={() => pick(() => nest(id))}>Вложить в предыдущую</button>
          <button type="button" role="menuitem" disabled={!entry?.parent} onclick={() => pick(() => lift(id))}>Вынести на уровень выше</button>
          <hr />
          <button type="button" role="menuitem" class="danger" onclick={() => pick(() => ondelete(id))}><Icon name="trash" size={14} />В корзину</button>
        </div>
      {/if}
    </div>
    {#if selected && headings.length}
      <ol class="docs-outline" aria-label="Заголовки страницы" style:--depth={node.depth}>
        {#each headings as heading (heading.id)}<li><button type="button" style:--level={heading.level} onclick={() => onheading(heading.id)}>{heading.text}</button></li>{/each}
      </ol>
    {/if}
    {#if node.children.length && open}<ul>{#each node.children as child (child.page.id)}{@render item(child)}{/each}</ul>{/if}
  </li>
{/snippet}

<nav bind:this={tree} class="docs-tree" aria-label="Страницы документации">
  {#if nodes.length}<ul>{#each nodes as node (node.page.id)}{@render item(node)}{/each}</ul>
  {:else}<p class="docs-tree-empty">Страниц пока нет.</p>{/if}
</nav>
