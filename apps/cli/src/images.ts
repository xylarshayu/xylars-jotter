/**
 * Shrinks large link preview images to WebP thumbnails with sharp (ADR-0020), the same steps
 * the web app takes with a canvas. sharp is loaded only when an image needs it.
 */
import { type ImageShrinker, parseImageDataUrl, PREVIEW_IMAGE_STEPS } from "@jot/core"

export const shrinkPreviewImage: ImageShrinker = async (dataUrl, maxLength) => {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) return undefined
  const { default: sharp } = await import("sharp")
  const input = Buffer.from(parsed.base64, "base64")
  for (const { side, quality } of PREVIEW_IMAGE_STEPS) {
    // "outside" scales the short side to `side`; rotate() applies the EXIF orientation first.
    const out = await sharp(input)
      .rotate()
      .resize({ width: side, height: side, fit: "outside", withoutEnlargement: true })
      .webp({ quality: Math.round(quality * 100) })
      .toBuffer()
    const url = `data:image/webp;base64,${out.toString("base64")}`
    if (url.length <= maxLength) return url
  }
  return undefined
}
