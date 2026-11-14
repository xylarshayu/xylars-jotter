export interface Segment {
  text: string
  href?: string
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const TRAILING = /[.,;:!?'"»”’]+$/

function trim(url: string): string {
  let u = url.replace(TRAILING, "")
  // Drop unbalanced closing brackets: "(see https://x.y/a)" -> "https://x.y/a"
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (u.endsWith(close) && u.split(open).length < u.split(close).length) {
      u = u.slice(0, -1).replace(TRAILING, "")
    }
  }
  return u
}

/** Splits text into plain and link segments. Only http(s) URLs become links. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = trim(m[0])
    const start = m.index
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, href: url })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
