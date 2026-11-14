<script lang="ts">
  import { ALL, app, channelLabel } from "../lib/app.svelte.ts"
  import { bytes } from "../lib/dates.ts"
  import Icon from "./Icon.svelte"

  let area = $state<HTMLTextAreaElement>()
  let fileInput = $state<HTMLInputElement>()
  let picking = $state(false)
  let previews = $state.raw<{ file: File; url: string | null }[]>([])

  const target = $derived(app.target)
  const inAll = $derived(app.route.view === "feed" && app.route.channel === ALL)
  const canSend = $derived(app.draft.trim().length > 0 || app.draftFiles.length > 0)
  const lockedTarget = $derived(target && target.lock !== "open" && !target.unlocked)

  // Object URLs for image thumbnails, released when files leave the tray.
  $effect(() => {
    const items = app.draftFiles.map((file) => ({
      file,
      url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }))
    previews = items
    return () => items.forEach((i) => i.url && URL.revokeObjectURL(i.url))
  })

  // Grow with the text (CSSOM, allowed by the CSP).
  $effect(() => {
    void app.draft
    const el = area
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  })

  $effect(() => {
    if (app.editing) area?.focus()
  })

  async function submit() {
    if (app.editing) {
      await app.saveEdit(app.draft)
      return
    }
    if (!canSend) return
    const text = app.draft.trim()
    const files = app.draftFiles
    app.draft = ""
    app.draftFiles = []
    area?.focus()
    if (!(await app.send(text, files)) && !app.draft) {
      app.draft = text
      app.draftFiles = files
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.isComposing) return
    const force = e.metaKey || e.ctrlKey
    if (force || (app.enterSends && !e.shiftKey)) {
      e.preventDefault()
      void submit()
    }
  }

  function addFiles(list: FileList | File[] | null | undefined) {
    const files = [...(list ?? [])]
    if (files.length) app.draftFiles = [...app.draftFiles, ...files]
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }
</script>

<div class="composer" role="group" aria-label="New note">
  {#if app.editing}
    <div class="bar">
      <Icon name="edit" size={16} />
      <span>Editing note</span>
      <button class="link" onclick={() => app.cancelEdit()}>Cancel</button>
    </div>
  {:else if inAll || lockedTarget}
    <div class="bar">
      {#if inAll}
        <button class="chip" aria-expanded={picking} onclick={() => (picking = !picking)}>
          <Icon name={target && target.lock !== "open" ? "lock" : "hash"} size={14} />
          {target ? channelLabel(target) : "Choose channel"}
          <Icon name="chevron" size={14} />
        </button>
      {/if}
      {#if lockedTarget}
        <span class="locked-hint">Locked. Your note is added without unlocking.</span>
      {/if}
    </div>
    {#if picking}
      <div class="picker">
        {#each app.channels as c (c.id)}
          <button
            class="chip"
            class:on={target?.id === c.id}
            onclick={() => {
              app.setComposeTo(c.id)
              picking = false
            }}
          >
            <Icon name={c.lock === "open" ? "hash" : "lock"} size={14} />{channelLabel(c)}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if previews.length}
    <div class="tray">
      {#each previews as p, i (p.file)}
        <div class="thumb" class:file={!p.url}>
          {#if p.url}<img src={p.url} alt={p.file.name} />{:else}
            <Icon name="file" />
            <span class="fname">{p.file.name || "File"}</span>
            <span class="fsize">{bytes(p.file.size)}</span>
          {/if}
          <button
            class="remove"
            aria-label="Remove {p.file.name}"
            onclick={() => (app.draftFiles = app.draftFiles.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="row">
    {#if !app.editing}
      <button
        class="icon-btn"
        aria-label="Attach files"
        title="Attach files (any type, up to 95 MB each)"
        onclick={() => fileInput?.click()}
      >
        <Icon name="attach" />
      </button>
      <input
        bind:this={fileInput}
        class="hidden"
        type="file"
        multiple
        onchange={(e) => {
          addFiles(e.currentTarget.files)
          e.currentTarget.value = ""
        }}
      />
    {/if}
    <textarea
      bind:this={area}
      bind:value={app.draft}
      {onkeydown}
      {onpaste}
      rows="1"
      placeholder={app.editing
        ? "Edit note"
        : target
          ? `Note to ${channelLabel(target)}`
          : "Write a note"}
      aria-label="Note text"
      enterkeyhint={app.enterSends ? "send" : "enter"}
      autocomplete="off"
      spellcheck="true"></textarea>
    <button
      class="send"
      aria-label={app.editing ? "Save edit" : "Send note"}
      disabled={!app.editing && !canSend}
      onclick={submit}
    >
      <Icon name={app.editing ? "check" : "send"} />
    </button>
  </div>
</div>

<style>
  .composer {
    border-top: 1px solid var(--line);
    background: var(--bg);
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    display: grid;
    gap: 6px;
  }
  .composer > * {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.86rem;
    color: var(--muted);
    min-height: 32px;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    padding: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 34px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.86rem;
    cursor: pointer;
  }
  .chip.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .locked-hint {
    color: var(--lock);
  }
  .tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
  }
  .thumb {
    position: relative;
    width: 64px;
    height: 64px;
    flex: none;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface-2);
    display: grid;
    place-items: center;
  }
  .thumb.file {
    width: 132px;
    padding: 6px 28px 6px 8px;
    place-items: start;
    align-content: center;
    gap: 2px;
    font-size: 0.78rem;
  }
  .fname {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fsize {
    color: var(--faint);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.6);
    color: #fff;
    cursor: pointer;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    border-radius: 20px;
    padding: 11px 16px;
    font: inherit;
    font-size: 1rem;
    line-height: 1.4;
    min-height: var(--tap);
    max-height: 40vh;
    outline: none;
  }
  textarea:focus {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
  }
  .send {
    width: var(--tap);
    height: var(--tap);
    flex: none;
    border-radius: 50%;
    border: 0;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-ink);
    cursor: pointer;
    transition: opacity 0.12s;
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .hidden {
    display: none;
  }
</style>
