<script lang="ts">
  import { tick } from "svelte"
  import { ALL, app } from "../lib/app.svelte.ts"
  import { dayKey, dayLabel } from "../lib/dates.ts"
  import LockPanel from "./LockPanel.svelte"
  import NoteItem from "./NoteItem.svelte"

  const searching = $derived(app.searching && app.query.trim().length > 0)
  const notes = $derived(searching ? app.results : app.feed)
  const current = $derived(app.current)
  const showChannel = $derived(
    searching || (app.route.view === "feed" && app.route.channel === ALL),
  )
  const locked = $derived(!searching && current !== undefined && !current.readable)

  let feedEl = $state<HTMLElement>()
  let older = $state<HTMLElement>()
  let newer = $state<HTMLElement>()

  /**
   * Loads a page when a sentinel nears the viewport. Not while a jump is scrolling to its note:
   * the observer starts once the mark clears, and its first report says whether one is near.
   */
  function watch(el: HTMLElement | undefined, load: () => Promise<void>) {
    if (!el || app.highlight) return
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) void load()
      },
      { root: feedEl, rootMargin: "600px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }

  $effect(() => watch(older, () => app.loadOlder()))

  // Newer notes go in below the ones on screen. Keep what's in view where it is: the feed is
  // column-reverse, so its scroll position counts from the bottom and would otherwise jump.
  $effect(() =>
    watch(newer, async () => {
      const box = feedEl!
      const ref = box.querySelector<HTMLElement>("[data-note]")
      const top = ref?.getBoundingClientRect().top
      await app.loadNewer()
      await tick()
      if (ref?.isConnected && top !== undefined)
        box.scrollTop += ref.getBoundingClientRect().top - top
    }),
  )
</script>

<!-- column-reverse keeps the newest note at the bottom, next to the composer -->
<section class="feed" aria-label={searching ? "Search results" : "Notes"} bind:this={feedEl}>
  {#if app.feedNewer && !searching && !locked}<div class="sentinel" bind:this={newer}></div>{/if}
  {#if locked && current}
    <LockPanel channel={current} />
  {:else if !notes.length}
    <div class="empty">
      {#if searching}
        <p>No notes match.</p>
        {#if app.searchChannel}
          <button class="btn ghost" onclick={() => app.setSearchAll(true)}
            >Search all channels</button
          >
        {:else}
          <p class="faint">Locked channels are searched only while unlocked.</p>
        {/if}
      {:else if app.channels.length === 0}
        <p>
          {app.online
            ? "No channels yet. Add one with New channel."
            : "Offline. Your notes appear once you're connected."}
        </p>
      {:else}
        <p>Nothing here yet.</p>
        <p class="faint">Type below. Notes are encrypted on this device before they're sent.</p>
      {/if}
    </div>
  {/if}
  {#if !locked}
    {#each notes as note, i (note.id)}
      <NoteItem {note} {showChannel} inSearch={searching} />
      {#if !searching && (i === notes.length - 1 || dayKey(note.createdAt) !== dayKey(notes[i + 1]!.createdAt))}
        <div class="day"><span>{dayLabel(note.createdAt)}</span></div>
      {/if}
    {/each}
    {#if searching && notes.length}
      <div class="day">
        <span
          >{notes.length === 200
            ? "200+ results"
            : `${notes.length} result${notes.length === 1 ? "" : "s"}`}</span
        >
      </div>
    {/if}
    {#if app.feedMore && !searching}<div class="sentinel" bind:this={older}></div>{/if}
  {/if}
</section>

<style>
  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: 6px;
    padding: 12px 12px 8px;
  }
  .feed > :global(*) {
    width: 100%;
    max-width: 760px;
    flex: none;
  }
  .day {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
  }
  .day span {
    font-size: 0.78rem;
    font-weight: 560;
    color: var(--muted);
    background: var(--surface-2);
    padding: 3px 10px;
    border-radius: 999px;
  }
  .empty {
    margin: auto 0;
    text-align: center;
    color: var(--muted);
    padding: 24px;
  }
  .empty p {
    margin: 4px 0;
  }
  .faint {
    color: var(--faint);
    font-size: 0.9rem;
  }
  .sentinel {
    height: 1px;
  }
</style>
