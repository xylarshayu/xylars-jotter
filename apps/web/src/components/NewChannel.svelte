<script lang="ts">
  import { app } from "../lib/app.svelte.ts"

  let { onclose }: { onclose: () => void } = $props()
  let name = $state("")
  let locked = $state(false)
  let pass = $state("")
  let confirm = $state("")
  let busy = $state(false)
  const mismatch = $derived(locked && confirm.length > 0 && pass !== confirm)
  const ready = $derived(
    name.trim().length > 0 && (!locked || (pass.length >= 8 && pass === confirm)),
  )

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!ready || busy) return
    busy = true
    const p = locked ? pass : undefined
    pass = ""
    confirm = ""
    const ok = await app.createChannel(name.trim(), p)
    busy = false
    if (ok) onclose()
  }
</script>

<form class="new" onsubmit={submit}>
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="field"
    bind:value={name}
    placeholder="Channel name"
    aria-label="Channel name"
    maxlength="80"
    autofocus
  />
  <div class="seg" role="radiogroup" aria-label="Kind">
    <button
      type="button"
      role="radio"
      aria-checked={!locked}
      class:on={!locked}
      onclick={() => (locked = false)}>Open</button
    >
    <button
      type="button"
      role="radio"
      aria-checked={locked}
      class:on={locked}
      onclick={() => (locked = true)}>Locked</button
    >
  </div>
  {#if locked}
    <input
      class="field"
      type="password"
      bind:value={pass}
      placeholder="Passphrase (8+ characters)"
      aria-label="Passphrase"
      autocomplete="off"
      data-1p-ignore
      data-lpignore="true"
    />
    <input
      class="field"
      type="password"
      bind:value={confirm}
      placeholder="Repeat passphrase"
      aria-label="Repeat passphrase"
      autocomplete="off"
      data-1p-ignore
      data-lpignore="true"
    />
    <p class="hint" class:warn={mismatch}>
      {mismatch
        ? "The passphrases don't match."
        : "Only you know this. If you forget it, these notes can't be recovered. Agents can't read this channel."}
    </p>
  {:else}
    <p class="hint">Readable on your devices and by agents that hold your open key.</p>
  {/if}
  <div class="row">
    <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
    <button class="btn" disabled={!ready || busy}>{busy ? "Creating…" : "Create"}</button>
  </div>
</form>

<style>
  .new {
    display: grid;
    gap: 8px;
    padding: 10px;
    margin-top: 8px;
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .hint {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
    line-height: 1.35;
  }
  .warn {
    color: var(--danger);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
