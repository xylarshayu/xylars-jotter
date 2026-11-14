/** JSONL import format and Markdown rendering for export and the mirror. */
import { z } from "zod"
import type { NoteView } from "./notebook.ts"

export const ImportLine = z.object({
  channel: z.string().min(1),
  created_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected ISO-8601"),
  text: z.string(),
  links: z.array(z.string()).optional(),
  attachments: z.array(z.object({ path: z.string(), mime: z.string() })).optional(),
  source_id: z.string().min(1),
})
export type ImportLine = z.output<typeof ImportLine>

export function parseImportLine(line: string): ImportLine {
  return ImportLine.parse(JSON.parse(line))
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return s || "channel"
}

function yamlString(s: string): string {
  return JSON.stringify(s) // JSON strings are valid YAML double-quoted scalars
}

/** Path of a note inside a mirror/export tree: <channel>/<yyyy>/<mm>/<id>.md */
export function notePath(
  channelSlug: string,
  note: Pick<NoteView, "id" | "createdAt">,
  ext = "md",
): string {
  const d = new Date(note.createdAt)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${channelSlug}/${yyyy}/${mm}/${note.id}.${ext}`
}

export function toMarkdown(note: NoteView, channel: { id: string; name: string }): string {
  const lines = [
    "---",
    `id: ${note.id}`,
    `channel: ${yamlString(channel.name)}`,
    `channel_id: ${channel.id}`,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
    `version: ${note.version}`,
  ]
  if (note.links.length) {
    lines.push("links:")
    for (const l of note.links) lines.push(`  - ${yamlString(l)}`)
  }
  const titles = note.previews.filter((p) => p.title)
  if (titles.length) {
    lines.push("previews:")
    for (const p of titles) {
      lines.push(`  - url: ${yamlString(p.url)}`, `    title: ${yamlString(p.title!)}`)
      if (p.site) lines.push(`    site: ${yamlString(p.site)}`)
    }
  }
  if (note.attachments.length) {
    lines.push("attachments:")
    for (const a of note.attachments)
      lines.push(`  - ${yamlString(`${a.id} ${a.mime}${a.name ? " " + a.name : ""}`)}`)
  }
  lines.push("---", "", note.text, "")
  return lines.join("\n")
}

export function toImportLine(note: NoteView, channelName: string): ImportLine {
  return {
    channel: channelName,
    created_at: new Date(note.createdAt).toISOString(),
    text: note.text,
    links: note.links,
    source_id: `jot:${note.id}`,
  }
}
