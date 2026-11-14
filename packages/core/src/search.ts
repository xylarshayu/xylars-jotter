/** Client-side search over decrypted text, links, attachment names and link previews. */

export interface SearchDoc {
  id: string
  createdAt: number
  text: string
}

export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
}

export function tokenize(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Every token must appear (AND). Newest first. */
export function search<T extends SearchDoc>(docs: Iterable<T>, query: string): T[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const out: T[] = []
  for (const d of docs) {
    const hay = normalize(d.text)
    if (tokens.every((t) => hay.includes(t))) out.push(d)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}
