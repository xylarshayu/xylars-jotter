<script lang="ts">
  import { app } from "../lib/app.svelte.ts"
  import Devices from "./Devices.svelte"
  import { HIDE_CHOICES, IDLE_CHOICES, type EnterMode, type Theme } from "../lib/settings.ts"

  let importInput = $state<HTMLInputElement>()
  let importResult = $state("")
  let importing = $state(false)
  let confirmForget = $state(false)

  const themes: [Theme, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ]
  const enters: [EnterMode, string][] = [
    ["auto", "Automatic"],
    ["on", "Always"],
    ["off", "Never"],
  ]

  async function onImport(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!file) return
    importing = true
    importResult = ""
    try {
      importResult = await app.importJsonl(file)
    } catch {
      importResult = "Import failed."
    }
    importing = false
  }
</script>

<div class="settings">
  <section>
    <h2>Appearance</h2>
    <div class="seg" role="radiogroup" aria-label="Theme">
      {#each themes as [value, label] (value)}
        <button
          role="radio"
          aria-checked={app.settings.theme === value}
          class:on={app.settings.theme === value}
          onclick={() => app.updateSettings({ theme: value })}>{label}</button
        >
      {/each}
    </div>
  </section>

  <section>
    <h2>Enter sends</h2>
    <div class="seg" role="radiogroup" aria-label="Enter sends">
      {#each enters as [value, label] (value)}
        <button
          role="radio"
          aria-checked={app.settings.enterSends === value}
          class:on={app.settings.enterSends === value}
          onclick={() => app.updateSettings({ enterSends: value })}>{label}</button
        >
      {/each}
    </div>
    <p class="hint">
      Automatic: Enter sends with a keyboard and Shift+Enter adds a line. On touch screens Enter
      adds a line and you tap send. Ctrl/⌘+Enter always sends.
    </p>
  </section>

  <section>
    <h2>Auto-lock</h2>
    <label class="line">
      <span>Lock unlocked channels after</span>
      <select
        class="field"
        value={app.settings.idleMinutes}
        onchange={(e) => app.updateSettings({ idleMinutes: Number(e.currentTarget.value) })}
      >
        {#each IDLE_CHOICES as m (m)}<option value={m}>{m} min idle</option>{/each}
      </select>
    </label>
    <label class="line">
      <span>When the app is hidden, lock after</span>
      <select
        class="field"
        value={app.settings.hideGraceSeconds}
        onchange={(e) => app.updateSettings({ hideGraceSeconds: Number(e.currentTarget.value) })}
      >
        {#each HIDE_CHOICES as s (s)}<option value={s}
            >{s === 0 ? "immediately" : s < 60 ? `${s} seconds` : `${s / 60} minutes`}</option
          >{/each}
      </select>
    </label>
    <p class="hint">
      Passphrase-derived keys live only in this tab's memory. Locking forgets them.
    </p>
  </section>

  <section>
    <h2>Import and export</h2>
    <div class="row">
      <button class="btn ghost" disabled={importing} onclick={() => importInput?.click()}
        >{importing ? "Importing…" : "Import JSONL"}</button
      >
      <button class="btn ghost" onclick={() => app.exportJsonl()}>Export open notes (JSONL)</button>
    </div>
    <input
      bind:this={importInput}
      class="hidden"
      type="file"
      accept=".jsonl,.json,application/jsonl,text/plain"
      onchange={onImport}
    />
    {#if importResult}<p class="result" role="status">{importResult}</p>{/if}
    <p class="hint">
      Import is idempotent by <code>source_id</code> and never creates channels. For attachments and
      a full export (Markdown, age files and JSONL), use the CLI: <code>jot import</code>,
      <code>jot export</code>.
    </p>
  </section>

  <section>
    <h2>This device</h2>
    <p class="hint">
      Open key (public part): <code class="wrap"
        >{app.openRecipient.slice(0, 24)}…{app.openRecipient.slice(-8)}</code
      >
    </p>
    {#if app.temporary}
      <p class="hint warn" data-testid="temporary-note">
        Temporary device: nothing is saved in this browser. Closing the tab, or {app.settings
          .idleMinutes} min without use, forgets the key and every note. Sign out too, so the next person
        can't sign in as you.
      </p>
      <div class="row">
        <button class="btn ghost" onclick={() => app.forgetTemporary()}>Forget now</button>
        <button class="btn danger" onclick={() => app.forgetTemporary(true)}
          >Forget and sign out</button
        >
      </div>
    {:else}
      <a class="btn ghost" href="#/pair">Pair a device</a>
      <p class="hint">
        Signs a new device in and sends it your open key. A device with the open key reads every
        open channel; on a borrowed computer, choose Temporary device there first.
      </p>
    {/if}
    {#if app.temporary}
      <!-- forgetting is above -->
    {:else if confirmForget}
      <p class="hint warn">
        This signs this browser out and removes the open key and every local copy from it. Notes
        waiting to upload ({app.pending}) will be lost. Your notes on the server are not affected.
      </p>
      <div class="row">
        <button class="btn ghost" onclick={() => (confirmForget = false)}>Cancel</button>
        <button class="btn danger" onclick={() => app.forgetDevice()}>Forget this device</button>
      </div>
    {:else}
      <button class="btn ghost danger" onclick={() => (confirmForget = true)}
        >Forget this device…</button
      >
    {/if}
  </section>

  {#if !app.temporary}<Devices />{/if}
</div>

<style>
  .settings {
    flex: 1;
    overflow-y: auto;
    padding: 16px 16px calc(32px + env(safe-area-inset-bottom));
    display: grid;
    align-content: start;
    gap: 8px;
  }
  section {
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: 16px;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    display: grid;
    gap: 10px;
  }
  h2 {
    margin: 0;
    font-size: 0.95rem;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .warn {
    color: var(--danger);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .result {
    margin: 0;
    white-space: pre-line;
    font-size: 0.9rem;
  }
  code {
    font-family: var(--mono);
    font-size: 0.85em;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  .hidden {
    display: none;
  }
</style>
