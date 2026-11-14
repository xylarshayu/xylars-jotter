<script lang="ts">
  import { app } from "../lib/app.svelte.ts"
  import PairNew from "./PairNew.svelte"

  let key = $state("")
  let error = $state("")
  let busy = $state(false)
  let created = $state<{ identity: string; recipient: string } | null>(null)
  let saved = $state(false)
  let pairing = $state(false)
  let temporary = $state(false)
  // Set when another device signed this one out and it wiped itself (ADR-0019).
  const signedOut = new URLSearchParams(location.search).has("signed-out")
  if (signedOut) history.replaceState(null, "", "/" + location.hash)

  async function useKey(e: SubmitEvent) {
    e.preventDefault()
    busy = true
    error = ""
    const err = await app.useKey(key, { temporary })
    if (err) error = err
    else key = ""
    busy = false
  }

  async function newKey() {
    busy = true
    error = ""
    const r = await app.newKey()
    if (typeof r === "string") error = r
    else created = r
    busy = false
  }

  async function finish() {
    if (!created) return
    busy = true
    const err = await app.finishNewKey(created.identity)
    if (err) error = err
    busy = false
  }

  async function copyKey() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.identity)
      app.toast("Key copied. Store it in your password manager or vault.")
    } catch {
      app.toast("Couldn't copy; select the text instead.", "error")
    }
  }
</script>

<div class="setup">
  <div class="card">
    <div class="brand"><span class="mark" aria-hidden="true"></span>Xylar's Jotter</div>

    {#if pairing}
      <PairNew {temporary} onclose={() => (pairing = false)} />
    {:else if created}
      <h1>Save your open key</h1>
      <p class="muted">
        This key opens your open channels on every device, and lets agents read them. Keep it in
        your vault. Locked channels use their own passphrases and never this key.
      </p>
      <textarea
        class="key"
        readonly
        rows="4"
        aria-label="Your new open key"
        value={created.identity}></textarea>
      <div class="row">
        <button class="btn ghost" onclick={copyKey}>Copy key</button>
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={saved} />
        <span>I've saved this key somewhere safe</span>
      </label>
      <button class="btn wide" disabled={!saved || busy} onclick={finish}>
        {busy ? "Setting up…" : "Continue"}
      </button>
    {:else}
      <h1>Set up this device</h1>
      {#if app.route.view === "pair"}
        <p class="note" role="status">
          This browser isn't set up, so it can't send your key. Scan the code from Jotter where you
          already use it: Settings → Pair a device.
        </p>
      {/if}
      {#if signedOut}
        <p class="note" role="status">
          This device was signed out from another device, so it removed your notes and key.
        </p>
      {/if}
      <p class="muted">
        Notes are encrypted on your device before they're sent. Pair with your phone to sign in and
        read your open channels here: no password, no email.
      </p>
      <label class="check">
        <!-- Once a temporary attempt has started, this tab stays temporary until reloaded. -->
        <input type="checkbox" bind:checked={temporary} disabled={app.temporary} />
        <span
          >Temporary device <span class="muted small"
            >(borrowed computer): nothing is saved here. Closing the tab or leaving it idle forgets
            everything and signs it out.</span
          ></span
        >
      </label>
      <button class="btn wide" disabled={busy} onclick={() => (pairing = true)}
        >Pair with your phone</button
      >
      {#if app.accessSignedIn}
        <div class="or"><span>or paste your open key</span></div>
        <form onsubmit={useKey}>
          <textarea
            class="key"
            bind:value={key}
            rows="3"
            placeholder="AGE-SECRET-KEY-PQ-1…"
            aria-label="Open key"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"></textarea>
          <button class="btn ghost wide" disabled={busy || !key.trim()}
            >{busy ? "Setting up…" : "Use this key"}</button
          >
        </form>
        {#if !temporary}
          <div class="or"><span>first time?</span></div>
          <button class="btn ghost wide" disabled={busy} onclick={newKey}>Create a new key</button>
        {/if}
      {:else if app.accessSignedIn === false}
        <div class="or"><span>no phone set up yet?</span></div>
        <button class="btn ghost wide" onclick={() => app.signIn()}
          >Sign in to paste or create a key</button
        >
      {/if}
    {/if}

    {#if app.setupProgress}
      {@const p = app.setupProgress}
      <div class="progress" role="status">
        <progress max={p.total || 1} value={p.received} aria-label="Downloading notes"></progress>
        <span
          >Downloading your notes… {p.received.toLocaleString()}
          {#if p.total}of {p.total.toLocaleString()}{/if}</span
        >
      </div>
    {/if}

    <p class="error" role="alert">{error}</p>
  </div>
</div>

<style>
  .setup {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 24px 16px;
  }
  .card {
    width: min(100%, 460px);
    display: grid;
    gap: 14px;
  }
  .progress {
    display: grid;
    gap: 6px;
    font-size: 0.9rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .progress progress {
    width: 100%;
    height: 6px;
    appearance: none;
    border: 0;
    border-radius: 999px;
    overflow: hidden;
    background: var(--surface-2);
    accent-color: var(--accent);
  }
  .progress progress::-webkit-progress-bar {
    background: var(--surface-2);
  }
  .progress progress::-webkit-progress-value {
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.2s ease;
  }
  .progress progress::-moz-progress-bar {
    background: var(--accent);
    border-radius: 999px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 650;
    font-size: 1.2rem;
  }
  .mark {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    background: var(--accent);
  }
  h1 {
    margin: 12px 0 0;
    font-size: 1.5rem;
    letter-spacing: -0.015em;
  }
  .muted {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  form {
    display: grid;
    gap: 10px;
  }
  .key {
    width: 100%;
    font-family: var(--mono);
    font-size: 0.85rem;
    line-height: 1.4;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--text);
    resize: vertical;
    overflow-wrap: anywhere;
  }
  .wide {
    width: 100%;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--tap);
    cursor: pointer;
  }
  .small {
    font-size: 0.88rem;
  }
  .note {
    margin: 0;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--surface);
    line-height: 1.45;
  }
  .check input {
    flex: none;
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
  .or {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--faint);
    font-size: 0.85rem;
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .error {
    min-height: 1.3em;
    margin: 0;
    color: var(--danger);
  }
</style>
