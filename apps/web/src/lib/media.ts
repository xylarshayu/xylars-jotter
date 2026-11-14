/** Decrypted attachments as blob: URLs, in memory only. Released when a channel locks. */
import type { AttachmentRef, Notebook } from "@jot/core"

const urls = new Map<string, { url: string; channelId: string }>()
const inflight = new Map<string, Promise<string>>()

export function attachmentUrl(
  nb: Notebook,
  channelId: string,
  ref: AttachmentRef,
): Promise<string> {
  const key = `${channelId}:${ref.id}`
  const hit = urls.get(key)
  if (hit) return Promise.resolve(hit.url)
  let p = inflight.get(key)
  if (!p) {
    p = nb
      .readAttachment(channelId, ref)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mime }))
        urls.set(key, { url, channelId })
        return url
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

export function releaseUnreadable(readable: (channelId: string) => boolean): void {
  for (const [key, { url, channelId }] of urls) {
    if (readable(channelId)) continue
    URL.revokeObjectURL(url)
    urls.delete(key)
  }
}

export function releaseAll(): void {
  releaseUnreadable(() => false)
}

export function download(data: Uint8Array | string, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
