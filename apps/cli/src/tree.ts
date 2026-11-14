/**
 * Writes notes to disk: open channels as Markdown, locked channels as age files.
 * Used by `jot mirror` (with manifest-based cleanup) and `jot export`.
 *
 * Fail closed: plaintext is written only for channels that are open by every
 * check (isOpenChannel). A locked channel is written as ciphertext even if it
 * happens to be unlocked in this process.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fromBase64 } from "@jot/crypto"
import {
  isOpenChannel,
  notePath,
  slugify,
  toImportLine,
  toMarkdown,
  type ChannelRow,
  type NoteRow,
} from "@jot/core"
import type { Context } from "./context.ts"

const MANIFEST = ".jot-mirror.json"

export interface TreeResult {
  written: number
  unchanged: number
  removed: number
  openNotes: number
  lockedNotes: number
}

function writeIfChanged(path: string, data: string | Uint8Array, r: TreeResult): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)
  if (existsSync(path) && readFileSync(path).equals(bytes)) {
    r.unchanged++
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  r.written++
}

function extFor(mime: string): string {
  const m: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
  }
  return m[mime] ?? "bin"
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)
}

const LOCKED_README = `# Locked channels (ciphertext only)

Each folder is one locked channel. Nothing here can be read without that
channel's passphrase.

- key.age: the channel's hybrid age identity, encrypted with its passphrase
  (an age "passphrase-encrypted identity file").
- name.age: the channel name.
- <yyyy>/<mm>/<id>.age: a note (JSON: text, links, attachments).
- <id>.preview.age: link previews. <id>.files/*.age: attachments.

Recover with the Go age CLI (v1.3+), typing the passphrase when asked:

    age -d -i key.age 2026/01/<id>.age
`

export async function writeTree(
  ctx: Context,
  opts: { openDir: string; lockedDir: string; manifest: boolean; jsonl?: string },
): Promise<TreeResult> {
  const nb = ctx.nb
  const r: TreeResult = { written: 0, unchanged: 0, removed: 0, openNotes: 0, lockedNotes: 0 }
  const keep = { open: new Set<string>(), locked: new Set<string>() }
  const put = (kind: "open" | "locked", rel: string, data: string | Uint8Array) => {
    keep[kind].add(rel)
    writeIfChanged(join(kind === "open" ? opts.openDir : opts.lockedDir, rel), data, r)
  }

  const channels = [...nb.replica.channels.values()]
    .filter((c) => c.deletedAt === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  const notesBy = new Map<string, NoteRow[]>()
  for (const n of nb.replica.notes.values()) {
    if (n.deletedAt !== null) continue
    notesBy.set(n.channelId, [...(notesBy.get(n.channelId) ?? []), n])
  }

  const slugs = new Set<string>()
  const jsonl: string[] = []
  for (const ch of channels) {
    const notes = notesBy.get(ch.id) ?? []
    if (isOpenChannel(ch) && (await nb.keys.identityFor(ch))) {
      await writeOpen(ch, notes)
    } else {
      writeLocked(ch, notes)
    }
  }
  if (r.lockedNotes || channels.some((c) => !isOpenChannel(c)))
    put("locked", "README.md", LOCKED_README)

  async function writeOpen(ch: ChannelRow, notes: NoteRow[]) {
    const name = (await nb.channelName(ch)) ?? ch.id
    let slug = slugify(name)
    if (slugs.has(slug)) slug = `${slug}-${ch.id.slice(-6).toLowerCase()}`
    slugs.add(slug)
    for (const row of notes) {
      const view = await nb.noteView(row)
      if (!view) continue
      const rel = notePath(slug, view)
      put("open", rel, toMarkdown(view, { id: ch.id, name }))
      r.openNotes++
      if (opts.jsonl !== undefined) jsonl.push(JSON.stringify(toImportLine(view, name)))
      for (const a of view.attachments) {
        const fileRel = rel.replace(
          /\.md$/,
          `.files/${a.id}-${safeName(a.name ?? "file")}.${extFor(a.mime)}`,
        )
        keep.open.add(fileRel)
        if (!existsSync(join(opts.openDir, fileRel)))
          put("open", fileRel, await nb.readAttachment(ch.id, a))
      }
    }
  }

  function writeLocked(ch: ChannelRow, notes: NoteRow[]) {
    put("locked", `${ch.id}/key.age`, fromBase64(ch.wrappedKey))
    put("locked", `${ch.id}/name.age`, fromBase64(ch.name))
    for (const row of notes) {
      const rel = notePath(ch.id, row, "age")
      put("locked", rel, fromBase64(row.body))
      if (row.preview) put("locked", rel.replace(/\.age$/, ".preview.age"), fromBase64(row.preview))
      r.lockedNotes++
    }
  }

  if (opts.jsonl !== undefined)
    writeIfChanged(opts.jsonl, jsonl.join("\n") + (jsonl.length ? "\n" : ""), r)

  if (opts.manifest) {
    r.removed += cleanup(opts.openDir, keep.open)
    r.removed += cleanup(opts.lockedDir, keep.locked)
  }
  return r
}

/** Removes files this tool wrote last time and no longer wants. Never touches anything else. */
function cleanup(dir: string, keep: Set<string>): number {
  const manifestPath = join(dir, MANIFEST)
  let previous: string[]
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8")) as string[]
  } catch {
    previous = []
  }
  let removed = 0
  for (const rel of previous) {
    if (keep.has(rel) || rel.includes("..") || rel.startsWith("/")) continue
    const p = join(dir, rel)
    if (existsSync(p)) {
      unlinkSync(p)
      removed++
      pruneEmpty(dir, dirname(p))
    }
  }
  if (keep.size || previous.length) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(manifestPath, JSON.stringify([...keep].sort(), null, 0))
  }
  return removed
}

function pruneEmpty(root: string, dir: string): void {
  while (dir.startsWith(root) && dir !== root) {
    if (readdirSync(dir).length) return
    rmdirSync(dir)
    dir = dirname(dir)
  }
}
