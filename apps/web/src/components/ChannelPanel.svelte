<script lang="ts">
  import type { ChannelView } from "@jot/core"
  import { app, channelLabel } from "../lib/app.svelte.ts"

  let { channel }: { channel: ChannelView } = $props()
  let mode = $state<"menu" | "rename" | "passphrase" | "delete">("menu")
  let name = $state("")
  let oldPass = $state("")
  let newPass = $state("")
  let busy = $state(false)

  function start(m: typeof mode) {
    mode = m
    name = channel.name ?? ""
  }

  async function rename(e: SubmitEvent) {
    e.preventDefault()
    if (!name.trim()) return
    busy = true
    if (await app.renameChannel(channel.id, name.trim())) app.panel = null
    busy = false
  }

  async function changePass(e: SubmitEvent) {
    e.preventDefault()
    busy = true
    const [o, n] = [oldPass, newPass]
    oldPass = ""
    newPass = ""
    if (await app.changePassphrase(channel.id, o, n)) app.panel = null
    busy = false
  }

  async function remove() {
    busy = true
    if (await app.deleteChannel(channel.id)) app.panel = null
    busy = false
  }
</script>

<div class="panel">
  {#if mode === "menu"}
    <div class="row">
      <!-- Names are sealed to the open key too, so a locked channel can be renamed while locked. -->
      <button class="btn ghost" onclick={() => start("rename")}>Rename</button>
      {#if channel.lock !== "open"}
        {#if channel.unlocked}
          <button class="btn ghost" onclick={() => start("passphrase")}>Change passphrase</button>
          <button class="btn ghost" onclick={() => app.lock(channel.id)}>Lock</button>
        {/if}
      {/if}
      <button class="btn ghost danger" onclick={() => start("delete")}>Delete channel</button>
    </div>
    <p class="hint">
      {channel.lock === "open"
        ? "Open channel: readable by your devices and agents with the open key."
        : "Locked channel: notes readable only with its passphrase. Its name is readable with the open key. Anyone with access can still add notes."}
    </p>
  {:else if mode === "rename"}
    <form class="row" onsubmit={rename}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="field grow"
        bind:value={name}
        aria-label="Channel name"
        maxlength="80"
        autofocus
      />
      <button type="button" class="btn ghost" onclick={() => (mode = "menu")}>Cancel</button>
      <button class="btn" disabled={busy || !name.trim()}>Save</button>
    </form>
  {:else if mode === "passphrase"}
    <form class="col" onsubmit={changePass}>
      <input
        class="field"
        type="password"
        bind:value={oldPass}
        placeholder="Current passphrase"
        aria-label="Current passphrase"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
      <input
        class="field"
        type="password"
        bind:value={newPass}
        placeholder="New passphrase (8+ characters)"
        aria-label="New passphrase"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
      />
      <div class="row end">
        <button type="button" class="btn ghost" onclick={() => (mode = "menu")}>Cancel</button>
        <button class="btn" disabled={busy || !oldPass || newPass.length < 8}
          >{busy ? "Changing…" : "Change"}</button
        >
      </div>
    </form>
  {:else}
    <div class="col">
      <p class="hint">
        {channel.noteCount
          ? `Move or delete the ${channel.noteCount} notes in ${channelLabel(channel)} first. Only empty channels can be deleted.`
          : `Delete ${channelLabel(channel)}?`}
      </p>
      <div class="row end">
        <button class="btn ghost" onclick={() => (mode = "menu")}>Cancel</button>
        <button class="btn danger" disabled={busy || channel.noteCount > 0} onclick={remove}
          >Delete</button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .panel {
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
    display: grid;
    gap: 8px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .end {
    justify-content: flex-end;
  }
  .col {
    display: grid;
    gap: 8px;
    max-width: 520px;
  }
  .grow {
    flex: 1;
    min-width: 160px;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.86rem;
  }
</style>
