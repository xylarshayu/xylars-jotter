<script lang="ts">
  import { onDestroy, tick } from "svelte"
  import type { PairingOffer } from "@jot/core"
  import { ALL, app } from "../lib/app.svelte.ts"

  // BarcodeDetector isn't in TypeScript's DOM types yet.
  interface Detector {
    detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
  }
  type DetectorCtor = new (o: { formats: string[] }) => Detector
  const Barcode = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector

  let offer = $state.raw<PairingOffer | null>(null)
  let error = $state("")
  let busy = $state(false)
  let sent = $state(false)
  let pasted = $state("")
  let scanning = $state(false)
  let video = $state<HTMLVideoElement>()
  let stream: MediaStream | undefined
  let scanTimer: ReturnType<typeof setTimeout> | undefined
  let checked = ""

  // A link in the address bar (scanned with the phone's camera app) or from the scanner.
  $effect(() => {
    const r = app.route
    const link = r.view === "pair" ? r.link : null
    if (link && link !== checked) void check(link)
  })

  async function check(link: string) {
    checked = link
    stopCamera()
    busy = true
    error = ""
    offer = null
    const r = await app.pairCheck(link)
    busy = false
    if (typeof r === "string") error = r
    else if (r.approved) error = "That pairing was already used. Start again on the new device."
    else offer = r
  }

  async function confirm() {
    if (!offer) return
    busy = true
    const err = await app.pairApprove(offer)
    busy = false
    if (err) error = err
    else {
      sent = true
      offer = null
    }
  }

  async function startCamera() {
    error = ""
    if (!Barcode) {
      error = "This browser can't scan here. Scan the code with your camera app instead."
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      })
    } catch {
      error = "No camera access. Allow it, or scan with your camera app."
      return
    }
    scanning = true
    const detector = new Barcode({ formats: ["qr_code"] })
    const scan = async () => {
      if (!scanning || !video) return
      try {
        if (video.readyState >= 2) {
          for (const code of await detector.detect(video)) {
            if (/#\/pair\//.test(code.rawValue)) {
              void check(code.rawValue)
              return
            }
          }
        }
      } catch {
        /* keep trying */
      }
      scanTimer = setTimeout(() => void scan(), 250)
    }
    await tick() // the <video> renders once scanning is true
    if (video && stream) {
      video.srcObject = stream
      void video.play().catch(() => {})
    }
    void scan()
  }

  function stopCamera() {
    scanning = false
    clearTimeout(scanTimer)
    for (const t of stream?.getTracks() ?? []) t.stop()
    stream = undefined
  }

  function usePasted(e: SubmitEvent) {
    e.preventDefault()
    void check(pasted)
  }

  function cancel() {
    stopCamera()
    if (offer) app.pairReject(offer) // a QR that doesn't match the screen is never used
    offer = null
    app.go({ view: "settings" })
  }

  onDestroy(stopCamera)
</script>

<div class="pair">
  <section>
    <h2>Pair a device</h2>
    {#if app.temporary}
      <p class="hint">
        This is a temporary device, so it can't sign other devices in. Use your phone, or a browser
        you've set up normally.
      </p>
    {:else if sent}
      <p role="status">Approved. The new device is signing in and opening your notes.</p>
      <button class="btn" onclick={() => app.go({ view: "feed", channel: ALL })}>Done</button>
    {:else if offer}
      <p class="ask">A device wants to sign in as you</p>
      <dl class="who">
        <dt>Device</dt>
        <dd data-testid="offer-agent">{offer.agent}</dd>
        <dt>Where</dt>
        <dd data-testid="offer-place">{offer.place ? `near ${offer.place}` : "unknown"}</dd>
        <dt>Kind</dt>
        <dd>
          {offer.temporary
            ? "Temporary: forgets everything when its tab closes"
            : "Stays signed in"}
        </dd>
      </dl>
      <p class="hint">Check that its screen shows this code:</p>
      <output class="code" data-testid="offer-code">{offer.code}</output>
      <p class="warn" role="note">
        Approve only a device in front of you, where you just chose <b>Pair with your phone</b>. If
        someone sent you this code or link, or asked you to scan it, reject it: approving would give
        them every open channel.
      </p>
      <p class="hint">
        Approving signs that device in and sends it your open key, encrypted to a key only it holds.
        It can read every open channel until you sign it out in Settings → Devices and re-key your
        open channels. Locked channels still need their passphrases.
      </p>
      <div class="row">
        <button class="btn ghost" disabled={busy} onclick={cancel}>Not me, reject</button>
        <button class="btn" disabled={busy} onclick={confirm}
          >{busy ? "Approving…" : "Codes match, approve"}</button
        >
      </div>
    {:else if busy}
      <p class="hint">Checking the code…</p>
    {:else}
      <p class="hint">
        On the new device, open Jotter and choose <b>Pair with your phone</b>. Then scan its code.
      </p>
      {#if scanning}
        <video bind:this={video} playsinline muted></video>
        <button class="btn ghost" onclick={stopCamera}>Stop camera</button>
      {:else}
        <button class="btn" onclick={startCamera}>Scan code</button>
      {/if}
      <form onsubmit={usePasted}>
        <input
          class="field"
          bind:value={pasted}
          placeholder="…or paste the pairing link"
          aria-label="Pairing link"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn ghost" disabled={!pasted.trim()}>Open</button>
      </form>
    {/if}
    <p class="error" role="alert">{error}</p>
  </section>
</div>

<style>
  .pair {
    flex: 1;
    overflow-y: auto;
    padding: 16px 16px calc(32px + env(safe-area-inset-bottom));
  }
  section {
    max-width: 640px;
    margin: 0 auto;
    padding: 16px;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    display: grid;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 0.95rem;
  }
  p {
    margin: 0;
  }
  .hint {
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .ask {
    font-weight: 650;
  }
  .who {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;
  }
  .who dt {
    color: var(--muted);
  }
  .who dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .warn {
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--lock-soft);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .code {
    font-family: var(--mono);
    font-size: 2rem;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-align: center;
  }
  video {
    width: 100%;
    max-height: 50dvh;
    border-radius: 12px;
    background: #000;
    object-fit: cover;
  }
  .row,
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  form .field {
    flex: 1;
    min-width: 0;
  }
  .error {
    min-height: 1.3em;
    color: var(--danger);
  }
</style>
