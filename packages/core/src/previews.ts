/**
 * Link preview images are kept small (ADR-0020). The feed shows them as 72 px thumbnails, but a
 * site's og:image is often a few hundred KB, and every byte is sealed, synced and checked by the
 * Worker, which has 10 ms of CPU per request on the free plan.
 *
 * The Worker can't re-encode images, so the client does it before sealing: the web app with a
 * canvas, the CLI with sharp. An image that already fits is kept byte for byte.
 */
import type { PreviewItem } from "./model.ts"

/** The largest preview image kept, as data URL characters (about 24 KB of image). */
export const MAX_PREVIEW_IMAGE = 32 * 1024

/**
 * Re-encode attempts, in order, until one fits: the image's short side is scaled down to `side`
 * pixels (never up) and encoded as WebP at `quality` (0 to 1). 256 px covers a 72 px thumbnail
 * on a 3x screen; the last step is for images that barely compress.
 */
export const PREVIEW_IMAGE_STEPS = [
  { side: 256, quality: 0.7 },
  { side: 160, quality: 0.55 },
  { side: 96, quality: 0.5 },
] as const

/**
 * Re-encodes a `data:image/...;base64,` URL, trying each of PREVIEW_IMAGE_STEPS in turn. Returns
 * the first result no longer than `maxLength` characters, or undefined if none fits or the image
 * can't be decoded.
 */
export type ImageShrinker = (dataUrl: string, maxLength: number) => Promise<string | undefined>

/** Splits a base64 image data URL into its type and payload. */
export function parseImageDataUrl(url: string): { mime: string; base64: string } | undefined {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  return m ? { mime: m[1]!, base64: m[2]! } : undefined
}

/**
 * Returns the item with its image within MAX_PREVIEW_IMAGE: kept if it fits, otherwise
 * re-encoded by `shrink`, otherwise dropped (the title and description stay).
 */
export async function fitPreviewImage(
  item: PreviewItem,
  shrink: ImageShrinker | undefined,
): Promise<PreviewItem> {
  if (!item.image || item.image.length <= MAX_PREVIEW_IMAGE) return item
  const { image, ...rest } = item
  const smaller = await shrink?.(image, MAX_PREVIEW_IMAGE).catch(() => undefined)
  return smaller && smaller.length <= MAX_PREVIEW_IMAGE ? { ...rest, image: smaller } : rest
}
