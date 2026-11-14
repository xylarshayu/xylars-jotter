<script lang="ts">
  import { onDestroy, onMount } from "svelte"
  import type { PairingRequest } from "@jot/core"
  import { app } from "../lib/app.svelte.ts"
  import QrCode from "./QrCode.svelte"

  let { temporary, onclose }: { temporary: boolean; onclose: () => void } = $props()

  let req = $state.raw<PairingRequest | null>(null)
  let error = $state("")
  let expired = $state(false)
  let now = $state(Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let ticker: ReturnType<typeof setInterval> | undefined
  let done = false

  const left = $derived(req ? Math.max(0, Math.ceil((req.expiresAt - now) / 1000)) : 0)

  async function begin() {
    stop()
    error = ""
    expired = false
    req = null
    const r = await app.pairStart(temporary)
    if (typeof r === "string") {
      error = r
      return
    }
    req = r
    poll()
  }

  function poll() {
    timer = setTimeout(async () => {
      const r = req
      if (!r || done) return
      if (Date.now() >= r.expiresAt) {
        expired = true
        app.pairCancel(r)
        return
      }
      const res = await app.pairPoll(r)
      if (res === null) poll()
      else if (res === "")
        done = true // set up; the app moves on
      else {
        error = res
        req = null
      }
    }, 2000)
  }

  function stop() {
    clearTimeout(timer)
    if (req && !done) app.pairCancel(req)
  }

  async function copyLink() {
    if (!req) return
    try {
      await navigator.clipboard.writeText(req.link)
      app.toast("Link copied.")
    } catch {
      app.toast("Couldn't copy; select the text instead.", "error")
    }
  }

  onMount(() => {
    ticker = setInterval(() => (now = Date.now()), 1000)
    void begin()
  })
  onDestroy(() => {
    clearInterval(ticker)
    stop()
    // The one-time identity goes with the component.
    req = null
  })
</script>

<h1>Pair with your phone</h1>
{#if req && !expired}
  <p class="muted">
    On your phone, open Jotter → Settings → <b>Pair a device</b>, and scan this code. Approving it
    there signs this browser in.
  </p>
  <QrCode text={req.link} label="Pairing code to scan with your phone" />
  <div class="code" aria-label="Confirmation code">
    <span class="muted">Your phone must show</span>
    <output data-testid="pair-code">{req.code}</output>
  </div>
  <p class="muted small">
    Waiting for your phone… {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    {#if temporary}· Temporary: nothing is saved in this browser.{/if}
  </p>
  <details>
    <summary>Can't scan?</summary>
    <p class="muted small">
      Open this link on a device where you already use Jotter. It only works there, and only for the
      next few minutes. Never send it to anyone.
    </p>
    <code class="link" data-testid="pair-link">{req.link}</code>
    <button class="btn ghost small" onclick={copyLink}>Copy link</button>
  </details>
{:else if expired}
  <p class="muted">That code expired.</p>
  <button class="btn wide" onclick={begin}>New code</button>
{:else if !error}
  <p class="muted">Preparing a code…</p>
{/if}
<p class="error" role="alert">{error}</p>
{#if error}<button class="btn wide" onclick={begin}>Try again</button>{/if}
<button class="btn ghost wide" onclick={onclose}>Back</button>

<style>
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
  .small {
    font-size: 0.88rem;
  }
  .code {
    display: grid;
    justify-items: center;
    gap: 4px;
  }
  output {
    font-family: var(--mono);
    font-size: 1.8rem;
    font-weight: 650;
    letter-spacing: 0.08em;
  }
  details {
    display: grid;
    gap: 8px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  .link {
    display: block;
    margin: 8px 0;
    font-family: var(--mono);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .wide {
    width: 100%;
  }
  .error {
    min-height: 1.3em;
    margin: 0;
    color: var(--danger);
  }
</style>
