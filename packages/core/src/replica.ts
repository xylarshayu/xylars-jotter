/** Ciphertext replica of the server state, synced by cursor. Safe to persist anywhere. */
import type { ChannelRow, NoteRow, SyncPage } from "./model.ts"

export interface ReplicaSnapshot {
  cursor: number
  channels: ChannelRow[]
  notes: NoteRow[]
}

/** Rows created locally and not yet confirmed by the server carry seq = -1. */
export const PENDING_SEQ = -1

export class Replica {
  cursor = 0
  readonly channels = new Map<string, ChannelRow>()
  readonly notes = new Map<string, NoteRow>()

  static from(s: ReplicaSnapshot | undefined): Replica {
    const r = new Replica()
    if (!s) return r
    r.cursor = s.cursor
    for (const c of s.channels) r.channels.set(c.id, c)
    for (const n of s.notes) r.notes.set(n.id, n)
    return r
  }

  snapshot(): ReplicaSnapshot {
    return {
      cursor: this.cursor,
      channels: [...this.channels.values()],
      notes: [...this.notes.values()],
    }
  }

  /** Applies server rows. Returns the ids that changed. */
  apply(page: Pick<SyncPage, "channels" | "notes">): { channels: string[]; notes: string[] } {
    const changed = { channels: [] as string[], notes: [] as string[] }
    for (const c of page.channels) {
      const cur = this.channels.get(c.id)
      if (!cur || cur.seq === PENDING_SEQ || c.seq >= cur.seq) {
        this.channels.set(c.id, c)
        changed.channels.push(c.id)
      }
    }
    for (const n of page.notes) {
      const cur = this.notes.get(n.id)
      if (!cur || cur.seq === PENDING_SEQ || n.seq >= cur.seq) {
        this.notes.set(n.id, n)
        changed.notes.push(n.id)
      }
    }
    return changed
  }

  /** Inserts or replaces a local optimistic row. */
  putPending(row: NoteRow): void {
    this.notes.set(row.id, { ...row, seq: PENDING_SEQ })
  }
}
