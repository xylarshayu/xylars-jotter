<script lang="ts">
  import { app, type MenuItem } from "../lib/app.svelte.ts"
  import Icon from "./Icon.svelte"

  let { x, y, items }: { x: number; y: number; items: MenuItem[] } = $props()
  let el = $state<HTMLElement>()
  let left = $state(0)
  let top = $state(0)

  // Kept on screen, then the first entry takes focus so the arrow keys work.
  $effect(() => {
    if (!el) return
    const r = el.getBoundingClientRect()
    left = Math.max(8, Math.min(x, innerWidth - r.width - 8))
    top = Math.max(8, Math.min(y, innerHeight - r.height - 8))
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus()
  })

  const close = () => (app.menu = null)

  function pick(item: MenuItem) {
    close()
    item.run()
  }

  function onkeydown(e: KeyboardEvent) {
    const all = [...el!.querySelectorAll<HTMLElement>("[role=menuitem]")]
    const at = all.indexOf(document.activeElement as HTMLElement)
    const to = (i: number) => all[(i + all.length) % all.length]?.focus()
    if (e.key === "ArrowDown") to(at + 1)
    else if (e.key === "ArrowUp") to(at - 1)
    else if (e.key === "Home") to(0)
    else if (e.key === "End") to(-1)
    else if (e.key === "Tab" || e.key === "Escape") close()
    else return
    e.preventDefault()
  }
</script>

<svelte:window onresize={close} />

<div
  class="backdrop"
  role="presentation"
  onclick={close}
  oncontextmenu={(e) => {
    e.preventDefault()
    close()
  }}
  onwheel={close}
></div>
<div
  class="menu"
  role="menu"
  tabindex="-1"
  bind:this={el}
  style:left="{left || x}px"
  style:top="{top || y}px"
  {onkeydown}
>
  {#each items as item (item.label)}
    <button class="entry" class:danger={item.danger} role="menuitem" onclick={() => pick(item)}>
      <Icon name={item.icon} size={18} />{item.label}
    </button>
  {/each}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .menu {
    position: fixed;
    z-index: 61;
    min-width: 190px;
    max-width: calc(100vw - 16px);
    padding: 5px;
    display: grid;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 0.94rem;
    text-align: left;
    cursor: pointer;
  }
  .entry :global(svg) {
    color: var(--muted);
  }
  .entry:hover,
  .entry:focus-visible {
    background: var(--hover);
    outline: none;
  }
  .entry.danger,
  .entry.danger :global(svg) {
    color: var(--danger);
  }
</style>
