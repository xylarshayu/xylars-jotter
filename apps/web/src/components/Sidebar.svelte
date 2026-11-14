<script lang="ts">
  import { ALL, app, channelLabel } from "../lib/app.svelte.ts"
  import Icon from "./Icon.svelte"
  import NewChannel from "./NewChannel.svelte"

  const hiddenIds = $derived(new Set(app.settings.hiddenChannels))
  const listed = $derived(app.channels.filter((c) => !hiddenIds.has(c.id)))
  const open = $derived(listed.filter((c) => c.lock === "open"))
  const locked = $derived(listed.filter((c) => c.lock !== "open"))
  const hidden = $derived(app.hiddenChannels)
  const active = $derived(app.route.view === "feed" ? app.route.channel : null)
  const themeIcon = $derived(
    { system: "system", light: "sun", dark: "moon" }[app.settings.theme] ?? "system",
  )
  let creating = $state(false)
</script>

<nav class="sidebar" aria-label="Channels">
  <div class="brand">
    <span class="mark" aria-hidden="true"></span>
    <span>Xylar's Jotter</span>
  </div>

  <div class="list">
    <a class="item" class:active={active === ALL} href="#/">
      <Icon name="inbox" size={20} />
      <span class="label">All notes</span>
    </a>

    {#if open.length}<div class="section">Channels</div>{/if}
    {#each open as c (c.id)}
      <a class="item" class:active={active === c.id} href="#/c/{c.id}">
        <Icon name="hash" size={18} />
        <span class="label">{channelLabel(c)}</span>
        <span class="count">{c.noteCount || ""}</span>
      </a>
    {/each}

    {#if locked.length}<div class="section">Locked</div>{/if}
    {#each locked as c (c.id)}
      <a
        class="item locked"
        class:active={active === c.id}
        class:unlocked={c.unlocked}
        href="#/c/{c.id}"
      >
        <Icon name={c.unlocked ? "unlock" : "lock"} size={18} />
        <span class="label">{channelLabel(c)}</span>
        <span class="count">{c.noteCount || ""}</span>
      </a>
    {/each}

    {#if hidden.length && app.showHidden}
      <div class="section">Hidden</div>
      {#each hidden as c (c.id)}
        <a
          class="item"
          class:locked={c.lock !== "open"}
          class:active={active === c.id}
          href="#/c/{c.id}"
        >
          <Icon name={c.lock === "open" ? "hash" : c.unlocked ? "unlock" : "lock"} size={18} />
          <span class="label">{channelLabel(c)}</span>
          <span class="count">{c.noteCount || ""}</span>
        </a>
      {/each}
    {/if}
    {#if hidden.length}
      <button
        class="item reveal"
        aria-pressed={app.showHidden}
        onclick={() => app.setShowHidden(!app.showHidden)}
      >
        <Icon name={app.showHidden ? "eye-off" : "eye"} size={18} />
        <span class="label"
          >{app.showHidden ? "Hide" : "Show"}
          {hidden.length} hidden channel{hidden.length === 1 ? "" : "s"}</span
        >
      </button>
    {/if}

    {#if creating}
      <NewChannel onclose={() => (creating = false)} />
    {:else}
      <button class="item add" onclick={() => (creating = true)}>
        <Icon name="plus" size={20} />
        <span class="label">New channel</span>
      </button>
    {/if}
  </div>

  <div class="foot">
    <a class="item" class:active={app.route.view === "settings"} href="#/settings">
      <Icon name="settings" size={20} />
      <span class="label">Settings</span>
    </a>
    <button
      class="icon-btn"
      onclick={() => app.cycleTheme()}
      aria-label="Theme: {app.settings.theme}"
      title="Theme: {app.settings.theme}"
    >
      <Icon name={themeIcon} size={20} />
    </button>
  </div>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100dvh;
    background: var(--surface-2);
    border-right: 1px solid var(--line);
    padding: calc(12px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom));
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 650;
    font-size: 1.1rem;
    letter-spacing: -0.01em;
    padding: 6px 10px 14px;
  }
  .mark {
    width: 22px;
    height: 22px;
    border-radius: 7px;
    background: var(--accent);
    box-shadow: inset 0 -6px 0 rgb(255 255 255 / 0.18);
  }
  .list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .section {
    margin: 14px 10px 4px;
    font-size: 0.74rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--tap);
    padding: 0 10px;
    border-radius: 10px;
    color: var(--text);
    text-decoration: none;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    width: 100%;
    cursor: pointer;
  }
  .item :global(svg) {
    color: var(--muted);
    flex: none;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.active {
    background: var(--surface);
    box-shadow: var(--shadow);
    font-weight: 560;
  }
  .item.active :global(svg) {
    color: var(--accent);
  }
  .locked :global(svg) {
    color: var(--lock);
  }
  .locked.unlocked :global(svg) {
    color: var(--lock);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: 0.8rem;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .add,
  .reveal {
    color: var(--muted);
    margin-top: 8px;
  }
  .reveal {
    font-size: 0.9rem;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 4px;
    border-top: 1px solid var(--line);
    padding-top: 8px;
    margin-top: 8px;
  }
  .foot .item {
    flex: 1;
  }
  @media (max-width: 899px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      width: min(84vw, 320px);
      z-index: 40;
      transform: translateX(-102%);
      transition: transform 0.2s ease;
      box-shadow: var(--shadow-lg);
    }
    :global(.drawer-open) .sidebar {
      transform: none;
    }
  }
</style>
