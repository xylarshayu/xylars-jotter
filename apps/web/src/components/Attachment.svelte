<script lang="ts">
  import type { AttachmentRef } from "@jot/core"
  import { app } from "../lib/app.svelte.ts"
  import { bytes } from "../lib/dates.ts"
  import { attachmentUrl, download } from "../lib/media.ts"
  import Icon from "./Icon.svelte"

  let { channelId, att }: { channelId: string; att: AttachmentRef } = $props()
  // Images and GIFs (animated) show inline; anything else, SVGs and very large images are a
  // chip that downloads. Inline images load when scrolled near, so cap what that fetches.
  const INLINE_MAX = 25 * 1024 * 1024
  const image = $derived(
    att.mime.startsWith("image/") && att.mime !== "image/svg+xml" && att.size <= INLINE_MAX,
  )
  const w = $derived(att.width ?? 4)
  const h = $derived(att.height ?? 3)
  const placeholder = $derived(
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"/>`)}`,
  )
  let url = $state<string | null>(null)
  let failed = $state(false)
  let el = $state<HTMLElement>()

  $effect(() => {
    if (!el || !image) return
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return
        io.disconnect()
        attachmentUrl(app.nb, channelId, att).then(
          (u) => (url = u),
          () => (failed = true),
        )
      },
      { rootMargin: "800px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  })

  async function save() {
    try {
      const data = await app.nb.readAttachment(channelId, att)
      // Always a download, never rendered: the blob is same-origin, so an HTML file must not open.
      download(data, att.name ?? "file", "application/octet-stream")
    } catch {
      app.toast("Couldn't open that file.", "error")
    }
  }
</script>

{#if image}
  <button
    class="img"
    bind:this={el}
    onclick={() => url && (app.lightbox = url)}
    aria-label="Open image {att.name ?? ''}"
  >
    <img
      src={url ?? placeholder}
      width={w}
      height={h}
      alt={att.name ?? "Image"}
      class:loading={!url}
    />
    {#if failed}<span class="err">Image unavailable offline</span>{/if}
  </button>
{:else}
  <button class="file" onclick={save}>
    <Icon name="file" size={20} />
    <span class="name">{att.name ?? "File"}</span>
    <span class="size">{bytes(att.size)}</span>
  </button>
{/if}

<style>
  .img {
    display: block;
    position: relative;
    border: 0;
    padding: 0;
    margin-top: 8px;
    background: none;
    cursor: zoom-in;
    max-width: min(100%, 420px);
  }
  img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 60vh;
    object-fit: contain;
    border-radius: 10px;
    background: var(--surface-2);
  }
  img.loading {
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.6;
    }
  }
  .err {
    position: absolute;
    inset: auto 8px 8px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 8px 12px;
    min-height: var(--tap);
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    max-width: 100%;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--faint);
    font-size: 0.85rem;
  }
</style>
