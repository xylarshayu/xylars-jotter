/**
 * Link preview fetcher with an SSRF guard.
 *
 * - http(s) only, default ports only, no credentials in the URL.
 * - No IP-literal hosts at all, and no local/internal names.
 * - Redirects followed manually (max 3), each hop re-checked.
 * - Time limit and size limits; HTML and raster images only.
 * - Nothing is logged or stored. The client shrinks a large image (ADR-0020) and encrypts the
 *   result.
 */
import { b64encode } from "./http.ts"

export class UnfurlError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const MAX_HTML = 512 * 1024
const MAX_IMAGE = 256 * 1024
const TIMEOUT_MS = 6000
const MAX_REDIRECTS = 3
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
  ".corp",
]

/** Throws unless the URL is safe to fetch. Exported for tests. */
export function checkUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new UnfurlError("invalid_url")
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnfurlError("unsupported_scheme")
  if (u.username || u.password) throw new UnfurlError("credentials_in_url")
  if (u.port !== "") throw new UnfurlError("non_default_port")
  const host = u.hostname.toLowerCase().replace(/\.$/, "")
  // WHATWG URL parsing normalises decimal/hex/octal IPv4 forms to dotted quads,
  // so these two checks catch every IP literal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":")) {
    throw new UnfurlError("ip_literal")
  }
  if (
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw new UnfurlError("private_host")
  }
  return u
}

async function guardedFetch(
  start: string,
  accept: string,
  signal: AbortSignal,
): Promise<{ res: Response; url: URL }> {
  let url = checkUrl(start)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url.toString(), {
      redirect: "manual",
      signal,
      headers: { accept, "user-agent": "Mozilla/5.0 (compatible; link-preview)" },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      await res.body?.cancel()
      if (!loc) throw new UnfurlError("bad_redirect")
      url = checkUrl(new URL(loc, url).toString())
      continue
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new UnfurlError("upstream_status")
    }
    return { res, url }
  }
  throw new UnfurlError("too_many_redirects")
}

async function readLimited(
  res: Response,
  max: number,
  stopAtHeadEnd: boolean,
): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  const dec = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total >= max) break
    if (stopAtHeadEnd && /<\/head>/i.test(dec.decode(value, { stream: true }))) break
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(total, max))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off)
    out.set(c.subarray(0, take), off)
    off += take
    if (off >= out.length) break
  }
  return out
}

function clean(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined
  const t = s.replace(/\s+/g, " ").trim()
  return t ? t.slice(0, max) : undefined
}

interface Meta {
  title?: string
  description?: string
  site?: string
  image?: string
  docTitle?: string
}

async function parseMeta(html: Uint8Array): Promise<Meta> {
  const meta: Meta = {}
  let inTitle = false
  let docTitle = ""
  const rw = new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase()
        const content = el.getAttribute("content") ?? undefined
        if (!content) return
        if (key === "og:title" || (key === "twitter:title" && !meta.title)) meta.title = content
        else if (
          key === "og:description" ||
          ((key === "twitter:description" || key === "description") && !meta.description)
        )
          meta.description = content
        else if (key === "og:site_name") meta.site = content
        else if (
          key === "og:image" ||
          key === "og:image:url" ||
          (key === "twitter:image" && !meta.image)
        )
          meta.image ??= content
      },
    })
    .on("title", {
      element() {
        inTitle = true
      },
      text(t) {
        if (inTitle) docTitle += t.text
        if (t.lastInTextNode) inTitle = false
      },
    })
  await rw
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .arrayBuffer()
  meta.docTitle = docTitle
  return meta
}

function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return s
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

async function fetchImage(src: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const { res } = await guardedFetch(src, "image/webp,image/png,image/jpeg,image/gif", signal)
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
    if (!IMAGE_TYPES.has(type) || Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE) {
      await res.body?.cancel()
      return undefined
    }
    const bytes = await readLimited(res, MAX_IMAGE + 1, false)
    if (bytes.length > MAX_IMAGE) return undefined
    return `data:${type};base64,${b64encode(bytes)}`
  } catch {
    return undefined
  }
}

export interface UnfurlResult {
  url: string
  title?: string
  description?: string
  site?: string
  image?: string
}

export async function unfurl(raw: string): Promise<UnfurlResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  let url: URL
  try {
    ;({ res, url } = await guardedFetch(raw, "text/html,application/xhtml+xml", signal))
  } catch (e) {
    if (e instanceof UnfurlError) throw e
    throw new UnfurlError("fetch_failed")
  }
  const type = (res.headers.get("content-type") ?? "").toLowerCase()
  if (!type.includes("text/html") && !type.includes("application/xhtml")) {
    await res.body?.cancel()
    return { url: url.toString(), site: url.hostname }
  }
  const meta = await parseMeta(await readLimited(res, MAX_HTML, true))
  const out: UnfurlResult = { url: url.toString() }
  const title = clean(decodeEntities(meta.title ?? meta.docTitle), 300)
  const description = clean(decodeEntities(meta.description), 1000)
  const site = clean(decodeEntities(meta.site), 100) ?? url.hostname.replace(/^www\./, "")
  if (title) out.title = title
  if (description) out.description = description
  out.site = site
  if (meta.image) {
    let img: string | undefined
    try {
      img = new URL(decodeEntities(meta.image)!, url).toString()
    } catch {
      img = undefined
    }
    if (img) {
      const data = await fetchImage(img, signal)
      if (data) out.image = data
    }
  }
  return out
}
