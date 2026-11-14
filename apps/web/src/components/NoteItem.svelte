<script lang="ts">
  import type { NoteView } from "@jot/core"
  import { app, channelLabel, type MenuItem } from "../lib/app.svelte.ts"
  import { fullDate, timeLabel } from "../lib/dates.ts"
  import { linkify } from "../lib/linkify.ts"
  import { contextMenu } from "../lib/menu.ts"
  import Attachment from "./Attachment.svelte"
  import Icon from "./Icon.svelte"

  let {
    note,
    showChannel,
    inSearch = false,
  }: { note: NoteView; showChannel: boolean; inSearch?: boolean } = $props()

  const selected = $derived(app.selected === note.id)
  const segments = $derived(linkify(note.text))
  const channel = $derived(app.channel(note.channelId))
  let mode = $state<"actions" | "move" | "history" | "delete">("actions")
  let moveTo = $state<string | null>(null)
  let copied = $state(false)
  let history = $state.raw<{ version: number; createdAt: number; text: string }[] | null>(null)

  $effect(() => {
    if (!selected) {
      mode = "actions"
      moveTo = null
      history = null
    }
  })

  function toggle() {
    app.selected = selected ? null : note.id
  }

  async function copy() {
    if (await app.copy(note)) {
      copied = true
      setTimeout(() => (copied = false), 1200)
    }
  }

  async function showHistory() {
    mode = "history"
    try {
      history = await app.history(note)
    } catch {
      history = []
      app.toast("History needs a connection.", "error")
    }
  }

  const targets = $derived(app.shownChannels.filter((c) => c.id !== note.channelId))

  // "Jump to" from search: scroll here and mark the note until the mark fades.
  let el = $state<HTMLElement>()
  const marked = $derived(app.highlight === note.id)
  $effect(() => {
    if (!marked || !el) return
    el.scrollIntoView({ block: "center" })
    const t = setTimeout(() => {
      if (app.highlight === note.id) app.highlight = null
    }, 2500)
    return () => clearTimeout(t)
  })

  /** Opens the note's action row at a step, as if chosen from "More". */
  function openAt(m: typeof mode) {
    app.selected = note.id
    mode = m
  }

  function menu(): MenuItem[] {
    return [
      ...(inSearch ? [{ label: "Jump to", icon: "jump", run: () => app.jumpTo(note) }] : []),
      { label: "Copy", icon: "copy", run: () => void copy() },
      { label: "Edit", icon: "edit", run: () => app.startEdit(note) },
      { label: "Move…", icon: "move", run: () => openAt("move") },
      {
        label: "History",
        icon: "history",
        run: () => {
          app.selected = note.id
          void showHistory()
        },
      },
      ...(note.links.length && !note.previews.length
        ? [{ label: "Fetch preview", icon: "link", run: () => void app.fetchPreview(note) }]
        : []),
      { label: "Delete…", icon: "trash", danger: true, run: () => openAt("delete") },
    ]
  }

  function warning(to: string): string | null {
    const target = app.channel(to)
    if (!target) return null
    const fromOpen = channel?.lock === "open"
    if (fromOpen && target.lock !== "open")
      return "Moves it out of agents' reach. Its earlier versions are deleted."
    if (!fromOpen && target.lock === "open")
      return "Makes it readable with the open key, including by agents."
    return null
  }

  function pickMove(to: string) {
    if (warning(to)) moveTo = to
    else void app.move(note, to)
  }
</script>

<article
  class="note"
  class:selected
  class:pending={note.pending}
  class:marked
  data-note={note.id}
  bind:this={el}
  use:contextMenu={menu}
>
  {#if showChannel && channel}
    <a class="tag" class:locked={channel.lock !== "open"} href="#/c/{note.channelId}">
      {#if channel.lock !== "open"}<Icon name="lock" size={13} />{:else}#{/if}{channelLabel(
        channel,
      )}
    </a>
  {/if}

  {#if note.text}
    <p class="text">
      {#each segments as s, i (i)}{#if s.href}<a
            href={s.href}
            target="_blank"
            rel="noopener noreferrer">{s.text}</a
          >{:else}{s.text}{/if}{/each}
    </p>
  {/if}

  {#each note.attachments as a (a.id)}
    <Attachment channelId={note.channelId} att={a} />
  {/each}

  {#each note.previews as p (p.url)}
    <a class="preview" href={p.url} target="_blank" rel="noopener noreferrer">
      {#if p.image}<img src={p.image} alt="" loading="lazy" />{/if}
      <span class="pv">
        {#if p.site}<span class="site">{p.site}</span>{/if}
        {#if p.title}<span class="ptitle">{p.title}</span>{/if}
        {#if p.description}<span class="desc">{p.description}</span>{/if}
      </span>
    </a>
  {/each}

  <div class="meta">
    {#if inSearch}
      <button class="jump" title="Open the channel at this note" onclick={() => app.jumpTo(note)}>
        <Icon name="jump" size={16} />Jump to
      </button>
    {/if}
    {#if note.pending}
      {#if app.online}
        <span class="spinner" role="img" title="Uploading" aria-label="Uploading"></span>
      {:else}
        <span class="clock" title="Waiting to upload"><Icon name="clock" size={14} /></span>
      {/if}
    {/if}
    {#if note.version > 1}<span>edited</span>{/if}
    <time datetime={new Date(note.createdAt).toISOString()} title={fullDate(note.createdAt)}
      >{timeLabel(note.createdAt)}</time
    >
  </div>

  <div class="tools">
    <button class="tool" aria-label="Copy note" title="Copy" onclick={copy}>
      <Icon name={copied ? "check" : "copy"} size={19} />
    </button>
    <button
      class="tool"
      aria-label="Note actions"
      title="More"
      aria-expanded={selected}
      onclick={toggle}
    >
      <Icon name="more" size={19} />
    </button>
  </div>

  {#if selected}
    <div class="actions">
      {#if mode === "actions"}
        <button class="act" onclick={() => app.startEdit(note)}
          ><Icon name="edit" size={18} />Edit</button
        >
        <button class="act" onclick={() => (mode = "move")}
          ><Icon name="move" size={18} />Move</button
        >
        <button class="act" onclick={showHistory}><Icon name="history" size={18} />History</button>
        {#if note.links.length && !note.previews.length}
          <button class="act" onclick={() => app.fetchPreview(note)}
            ><Icon name="link" size={18} />Fetch preview</button
          >
        {/if}
        <button class="act danger" onclick={() => (mode = "delete")}
          ><Icon name="trash" size={18} />Delete</button
        >
      {:else if mode === "move"}
        {#if moveTo}
          <p class="warn">{warning(moveTo)}</p>
          <button class="btn ghost" onclick={() => (moveTo = null)}>Back</button>
          <button class="btn" onclick={() => moveTo && app.move(note, moveTo)}
            >Move to {channelLabel(app.channel(moveTo))}</button
          >
        {:else}
          <span class="label">Move to</span>
          {#each targets as t (t.id)}
            <button class="act" onclick={() => pickMove(t.id)}>
              <Icon name={t.lock === "open" ? "hash" : "lock"} size={16} />{channelLabel(t)}
            </button>
          {/each}
          {#if !targets.length}<span class="label">No other channels yet.</span>{/if}
        {/if}
      {:else if mode === "history"}
        <div class="history">
          {#if history === null}
            <p class="label">Loading…</p>
          {:else if !history.length}
            <p class="label">No earlier versions.</p>
          {:else}
            {#each [...history].reverse() as h (h.version)}
              <div class="version">
                <span class="label">v{h.version} · {fullDate(h.createdAt)}</span>
                <p>{h.text}</p>
              </div>
            {/each}
          {/if}
        </div>
      {:else}
        <span class="label">Delete this note?</span>
        <button class="btn ghost" onclick={() => (mode = "actions")}>Cancel</button>
        <button class="btn danger" onclick={() => app.remove(note)}>Delete</button>
      {/if}
    </div>
  {/if}
</article>

<style>
  .note {
    position: relative;
    background: var(--surface);
    border-radius: var(--radius);
    padding: 10px 84px 8px 14px;
    box-shadow: var(--shadow);
    border: 1px solid var(--line-soft);
  }
  .note.selected {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .note.pending {
    opacity: 0.86;
  }
  /* A long press opens the note's menu on touch screens, not the browser's callout. */
  @media (hover: none) {
    .note {
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .note .text {
      -webkit-user-select: none;
      user-select: none;
    }
  }
  .note.marked {
    animation: mark 2.5s ease-out;
  }
  @keyframes mark {
    0%,
    40% {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, var(--surface));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .note.marked {
      animation: none;
      border-color: var(--accent);
    }
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.78rem;
    font-weight: 560;
    color: var(--accent);
    text-decoration: none;
    margin-bottom: 2px;
  }
  .tag.locked {
    color: var(--lock);
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 1rem;
    line-height: 1.45;
    user-select: text;
  }
  .text a {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .preview {
    display: flex;
    gap: 10px;
    margin-top: 8px;
    padding: 8px;
    border-radius: 10px;
    background: var(--surface-2);
    border-left: 3px solid var(--accent);
    color: var(--text);
    text-decoration: none;
    max-width: 560px;
  }
  .preview img {
    width: 72px;
    height: 72px;
    object-fit: cover;
    border-radius: 8px;
    flex: none;
  }
  .pv {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .site {
    font-size: 0.78rem;
    color: var(--accent);
    font-weight: 560;
  }
  .ptitle {
    font-weight: 600;
    font-size: 0.93rem;
    line-height: 1.3;
  }
  .desc {
    font-size: 0.86rem;
    color: var(--muted);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    margin-right: -70px;
    font-size: 0.75rem;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }
  .jump {
    margin-right: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 32px;
    padding: 0 10px 0 8px;
    border: 0;
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font: inherit;
    font-size: 0.84rem;
    font-weight: 560;
    cursor: pointer;
  }
  .jump:hover,
  .jump:focus-visible {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
  }
  .clock {
    display: inline-flex;
    color: var(--muted);
  }
  .tools {
    position: absolute;
    top: 2px;
    right: 2px;
    display: flex;
  }
  .tool {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 10px;
    background: none;
    color: var(--faint);
    cursor: pointer;
  }
  .tool:hover,
  .tool:focus-visible {
    color: var(--text);
    background: var(--hover);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 8px -70px 2px 0;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--tap);
    padding: 0 12px;
    border-radius: 10px;
    border: 0;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-size: 0.92rem;
    cursor: pointer;
  }
  .act:hover {
    background: var(--hover);
  }
  .act.danger {
    color: var(--danger);
  }
  .label {
    color: var(--muted);
    font-size: 0.88rem;
    margin: 0 4px;
  }
  .warn {
    flex-basis: 100%;
    margin: 0 0 4px;
    color: var(--lock);
    font-size: 0.88rem;
  }
  .history {
    display: grid;
    gap: 10px;
    width: 100%;
  }
  .version p {
    margin: 2px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--muted);
  }
</style>
