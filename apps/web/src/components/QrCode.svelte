<script lang="ts">
  import { encode } from "uqr"

  let { text, label }: { text: string; label: string } = $props()

  // One path of 1×1 squares; dark on light whatever the theme, since scanners expect that.
  const qr = $derived(encode(text, { ecc: "M", border: 4 }))
  const d = $derived(
    qr.data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join(""),
  )
</script>

<svg
  class="qr"
  role="img"
  aria-label={label}
  viewBox="0 0 {qr.size} {qr.size}"
  shape-rendering="crispEdges"
>
  <rect width={qr.size} height={qr.size} fill="#fff" />
  <path {d} fill="#000" />
</svg>

<style>
  .qr {
    display: block;
    width: min(100%, 280px);
    aspect-ratio: 1;
    margin: 0 auto;
    border-radius: 12px;
  }
</style>
