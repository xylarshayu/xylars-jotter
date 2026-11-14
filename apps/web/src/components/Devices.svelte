<script lang="ts">
  import { onMount } from "svelte"
  import type { DeviceRow } from "@jot/core"
  import { app } from "../lib/app.svelte.ts"
  import { dayLabel, timeLabel } from "../lib/dates.ts"

  let devices = $state.raw<DeviceRow[] | null>(null)
  let error = $state("")
  let confirming = $state<string | null>(null)

  async function load() {
    const r = await app.devices()
    if (typeof r === "string") error = r
    else {
      devices = r
      error = ""
    }
  }

  async function signOut(id: string) {
    confirming = null
    const err = await app.signOutDevice(id)
    if (err) error = err
    else app.toast("Signed out. It deletes its notes the next time it's online.")
    await load()
  }

  const seen = (ms: number) => `${dayLabel(ms)}, ${timeLabel(ms)}`

  onMount(() => void load())
</script>

<section>
  <h2>Devices</h2>
  {#if devices && !devices.length}
    <p class="hint">No paired devices.</p>
  {:else if devices}
    <ul data-testid="devices">
      {#each devices as d (d.id)}
        <li>
          <div class="what">
            <span
              >{d.agent}{#if d.current}<b class="tag">This device</b>{/if}{#if d.temporary}<b
                  class="tag">Temporary</b
                >{/if}</span
            >
            <span class="hint">{d.place ? `${d.place} · ` : ""}last used {seen(d.lastSeenAt)}</span>
          </div>
          {#if d.current}
            <!-- This one signs out with "Forget this device" below. -->
          {:else if confirming === d.id}
            <div class="row">
              <button class="btn ghost small" onclick={() => (confirming = null)}>Cancel</button>
              <button class="btn danger small" onclick={() => signOut(d.id)}>Sign out</button>
            </div>
          {:else}
            <button class="btn ghost small" onclick={() => (confirming = d.id)}>Sign out…</button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !error}
    <p class="hint">Loading…</p>
  {/if}
  <p class="hint">
    Devices you paired by QR. Signing one out stops it reaching your notes, and it deletes its copy
    and key the next time it connects. If it may already have been copied, also move your open notes
    to new channels (see the threat model). Browsers signed in through Cloudflare Access, and the
    CLI, aren't listed: end those in Cloudflare Zero Trust → My Team → Users.
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
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
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: var(--tap);
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
  }
  li:last-child {
    border-bottom: 0;
  }
  .what {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .tag {
    margin-left: 8px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--lock-soft);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .error {
    margin: 0;
    color: var(--danger);
  }
</style>
