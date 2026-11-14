<script lang="ts">
  import type { ChannelView } from "@jot/core"
  import { app, channelLabel } from "../lib/app.svelte.ts"
  import Icon from "./Icon.svelte"

  let { channel }: { channel: ChannelView } = $props()
  let pass = $state("")
  let busy = $state(false)
  let failed = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!pass || busy) return
    busy = true
    failed = false
    const p = pass
    pass = "" // don't keep it in the input
    failed = !(await app.unlock(channel.id, p))
    busy = false
  }
</script>

<div class="lockpanel">
  <div class="badge"><Icon name="lock" size={28} /></div>
  <h2>{channelLabel(channel)}</h2>
  <p class="muted">
    {channel.noteCount} note{channel.noteCount === 1 ? "" : "s"}, encrypted with this channel's
    passphrase. You can add notes below without unlocking.
  </p>
  <form onsubmit={submit}>
    <input
      class="field"
      type="password"
      bind:value={pass}
      placeholder="Passphrase"
      aria-label="Passphrase"
      autocomplete="off"
      data-1p-ignore
      data-lpignore="true"
      aria-invalid={failed}
    />
    <button class="btn" disabled={busy || !pass}>{busy ? "Unlocking…" : "Unlock"}</button>
  </form>
  <p class="status" role="status">
    {failed ? "Wrong passphrase." : busy ? "Checking the passphrase and decrypting…" : ""}
  </p>
  {#if channel.name === null}
    <p class="faint">
      Its name is hidden from your other devices until you unlock it once (or rename it).
    </p>
  {/if}
  <p class="faint">
    Locks again after {app.settings.idleMinutes} min idle, or when you leave the app.
  </p>
</div>

<style>
  .lockpanel {
    margin: auto 0;
    max-width: 420px !important;
    text-align: center;
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 24px 8px;
  }
  .badge {
    width: 64px;
    height: 64px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    background: var(--lock-soft);
    color: var(--lock);
  }
  h2 {
    margin: 6px 0 0;
    font-size: 1.15rem;
  }
  .muted {
    color: var(--muted);
    margin: 0;
    line-height: 1.45;
  }
  form {
    display: flex;
    gap: 8px;
    width: 100%;
    margin-top: 8px;
  }
  form .field {
    flex: 1;
  }
  .status {
    min-height: 1.2em;
    margin: 0;
    color: var(--danger);
    font-size: 0.9rem;
  }
  .faint {
    color: var(--faint);
    font-size: 0.82rem;
    margin: 0;
  }
</style>
