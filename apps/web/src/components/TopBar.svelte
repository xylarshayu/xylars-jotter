<script lang="ts">
  import { app, channelLabel } from "../lib/app.svelte.ts"
  import ChannelPanel from "./ChannelPanel.svelte"
  import Icon from "./Icon.svelte"

  const current = $derived(app.current)
  const title = $derived(
    app.route.view === "settings"
      ? "Settings"
      : app.route.view === "pair"
        ? "Pair a device"
        : current
          ? channelLabel(current)
          : "All notes",
  )
  const sub = $derived(
    app.route.view !== "feed"
      ? ""
      : current
        ? current.lock === "open"
          ? "Open"
          : current.unlocked
            ? "Unlocked"
            : "Locked"
        : "Every open channel",
  )
  let input = $state<HTMLInputElement>()
  $effect(() => {
    if (app.searching) input?.focus()
  })
</script>

<header class="topbar">
  <button class="icon-btn mobile" aria-label="Channels" onclick={() => (app.drawer = true)}>
    <Icon name="menu" />
  </button>

  {#if app.searching}
    <div class="search">
      <Icon name="search" size={20} />
      <input
        bind:this={input}
        bind:value={app.query}
        oninput={() => app.searchSoon()}
        type="search"
        placeholder={app.searchChannel
          ? `Search ${channelLabel(app.searchChannel)}`
          : "Search all notes and link previews"}
        aria-label="Search notes"
        enterkeyhint="search"
      />
      {#if current}
        <div class="scope" role="group" aria-label="Search in">
          <button
            aria-pressed={!app.searchAll}
            title="Search {channelLabel(current)}"
            onclick={() => {
              app.setSearchAll(false)
              input?.focus()
            }}>This<span class="wide"> channel</span></button
          >
          <button
            aria-pressed={app.searchAll}
            title="Search every channel"
            onclick={() => {
              app.setSearchAll(true)
              input?.focus()
            }}>All</button
          >
        </div>
      {/if}
    </div>
    <button class="icon-btn" aria-label="Close search" onclick={() => app.closeSearch()}>
      <Icon name="x" />
    </button>
  {:else}
    <div class="title">
      {#if current && current.lock !== "open"}
        <span class="lockmark"><Icon name={current.unlocked ? "unlock" : "lock"} size={18} /></span>
      {/if}
      <h1>{title}</h1>
      {#if sub}<span class="sub">{sub}</span>{/if}
    </div>

    {#if !app.online}
      <span class="pill" title="Offline"
        ><Icon name="offline" size={16} /><span class="wide">Offline</span></span
      >
    {/if}
    {#if app.pending}
      <span class="pill" title="Waiting to upload"
        ><Icon name="clock" size={16} />{app.pending}</span
      >
    {/if}
    {#if app.unlocked.length}
      <button class="pill lock" onclick={() => app.lockAll()} title="Lock now">
        <Icon name="lock" size={16} /><span>Lock</span>
      </button>
    {/if}
    {#if app.route.view === "feed"}
      <button
        class="icon-btn"
        aria-label="Search"
        title="Search (/)"
        onclick={() => app.openSearch()}
      >
        <Icon name="search" />
      </button>
    {/if}
    {#if current}
      <button
        class="icon-btn"
        aria-label="Channel options"
        aria-expanded={app.panel === "channel"}
        onclick={() => (app.panel = app.panel === "channel" ? null : "channel")}
      >
        <Icon name="more" />
      </button>
    {/if}
  {/if}
</header>

{#if app.panel === "channel" && current && !app.searching}
  <ChannelPanel channel={current} />
{/if}

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 56px;
    padding: env(safe-area-inset-top) 8px 0;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(12px);
    position: relative;
    z-index: 5;
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding-left: 8px;
  }
  h1 {
    margin: 0;
    font-size: 1.06rem;
    font-weight: 620;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 0.82rem;
    color: var(--faint);
    white-space: nowrap;
  }
  .lockmark {
    color: var(--lock);
    align-self: center;
    display: inline-flex;
  }
  .search {
    flex: 1;
    /* without this the input's default width pushes the bar, and the page, past the screen */
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    min-height: 42px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: none;
    font: inherit;
    font-size: 1rem;
    color: var(--text);
  }
  .scope {
    display: flex;
    flex: none;
    padding: 2px;
    border-radius: 9px;
    background: var(--surface-2);
  }
  .scope button {
    min-height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.82rem;
    white-space: nowrap;
    cursor: pointer;
  }
  .scope button[aria-pressed="true"] {
    background: var(--surface);
    color: var(--text);
    font-weight: 560;
    box-shadow: var(--shadow);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.85rem;
    border: 0;
    font-variant-numeric: tabular-nums;
  }
  .pill.lock {
    background: var(--lock-soft);
    color: var(--lock);
    cursor: pointer;
    min-height: 36px;
    font-weight: 560;
  }
  @media (min-width: 900px) {
    .mobile {
      display: none;
    }
  }
  @media (max-width: 480px) {
    .wide {
      display: none;
    }
  }
</style>
