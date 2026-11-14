/**
 * Inline images for `jot show`, in terminals that draw them: the kitty graphics protocol
 * (Ghostty, kitty) and iTerm2's (iTerm2, WezTerm). Images go to the screen only, never to disk.
 */

export type ImageProtocol = "kitty" | "iterm"

export const IMAGE_TERMINALS = "Ghostty, kitty, WezTerm and iTerm2"

/** Which protocol this terminal speaks, if any. Not when piped, or inside tmux or screen. */
export function imageProtocol(
  env: Record<string, string | undefined>,
  isTty: boolean,
): ImageProtocol | null {
  if (!isTty || env.TMUX || env.STY) return null
  const program = env.TERM_PROGRAM ?? ""
  const term = env.TERM ?? ""
  if (program === "ghostty" || term === "xterm-ghostty") return "kitty"
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty"
  if (program === "WezTerm" || program === "iTerm.app" || env.LC_TERMINAL === "iTerm2")
    return "iterm"
  return null
}

/** Formats sharp decodes into a PNG for the terminal. SVG is left out: it's a document. */
export function isPreviewable(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml"
}

/** Larger files aren't drawn: decoding them would take a while, for a terminal-sized picture. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/**
 * The escape sequence that draws `data` (any image sharp reads) about `maxCols` cells wide at
 * most, keeping its aspect ratio. Undefined if it can't be decoded (e.g. HEIC without a codec).
 */
export async function imageEscape(
  data: Uint8Array,
  protocol: ImageProtocol,
  maxCols: number,
): Promise<string | undefined> {
  const { default: sharp } = await import("sharp")
  let png: Buffer
  let width: number
  try {
    // First frame only; rotate() applies the EXIF orientation. 1600 px is plenty for a terminal.
    const { data: out, info } = await sharp(data, { animated: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true })
    png = out
    width = info.width
  } catch {
    return undefined
  }
  // Roughly 10 px per cell: small images stay small, large ones fit the window.
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(width / 10)))
  const b64 = png.toString("base64")
  if (protocol === "iterm")
    return `\x1b]1337;File=inline=1;size=${png.length};width=${cols};preserveAspectRatio=1:${b64}\x07`
  // kitty: PNG (f=100), sent and shown at once (a=T), no replies (q=2), in 4096-byte chunks.
  const chunks = b64.match(/.{1,4096}/g) ?? []
  return chunks
    .map((c, i) => {
      const more = i < chunks.length - 1 ? 1 : 0
      const head = i === 0 ? `a=T,f=100,q=2,c=${cols},m=${more}` : `m=${more}`
      return `\x1b_G${head};${c}\x1b\\`
    })
    .join("")
}
