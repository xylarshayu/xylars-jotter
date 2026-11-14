/**
 * Images are re-encoded before encryption: scaled to at most 2048 px and
 * stripped of metadata (EXIF, including GPS). GIFs (so they stay animated),
 * SVGs, formats the browser can't decode and every other file type are kept
 * byte for byte (ADR-0017).
 */
export interface PreparedFile {
  data: Uint8Array
  mime: string
  name: string
  width?: number
  height?: number
}

const MAX_SIDE = 2048

async function original(file: File): Promise<PreparedFile> {
  return {
    data: new Uint8Array(await file.arrayBuffer()),
    mime: file.type || "application/octet-stream",
    name: file.name || "file",
  }
}

/** A GIF's size from its header, so the feed reserves the right space. Never re-encoded. */
export function gifSize(data: Uint8Array): { width: number; height: number } | undefined {
  const magic = String.fromCharCode(...data.subarray(0, 6))
  if (data.length < 10 || (magic !== "GIF87a" && magic !== "GIF89a")) return undefined
  const v = new DataView(data.buffer, data.byteOffset, 10)
  const width = v.getUint16(6, true)
  const height = v.getUint16(8, true)
  return width && height ? { width, height } : undefined
}

export async function prepareFile(file: File): Promise<PreparedFile> {
  if (file.type === "image/gif") {
    const f = await original(file)
    return { ...f, ...gifSize(f.data) }
  }
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    file.type === "image/svg+xml"
  ) {
    return original(file)
  }
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" })
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const width = Math.max(1, Math.round(bmp.width * scale))
    const height = Math.max(1, Math.round(bmp.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, width, height)
    bmp.close()
    // Keep transparency for PNG/WebP sources; photos become JPEG.
    const mime =
      file.type === "image/png" || file.type === "image/webp" ? "image/png" : "image/jpeg"
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.86))
    if (!blob) throw new Error("encode")
    const base = (file.name || "image").replace(/\.[^.]+$/, "")
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      mime,
      name: `${base}.${mime === "image/png" ? "png" : "jpg"}`,
      width,
      height,
    }
  } catch {
    return original(file)
  }
}
