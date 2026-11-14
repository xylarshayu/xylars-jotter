/** Typed HTTP client for the Worker API. Error messages never include request bodies. */
import { z } from "zod"
import {
  AttachmentInfo,
  ChannelRow,
  type DumpRow,
  DumpRows,
  type DumpTable,
  type RestoreBatch,
  type CreateChannel,
  type CreateNote,
  CreateResult,
  NoteRow,
  DeviceRow,
  Me,
  NoteVersion,
  Pairing,
  PairingClaimed,
  PairingStarted,
  SyncPage,
  Unfurl,
  type UpdateChannel,
  type UpdateNote,
} from "./model.ts"

const ok = z.object({}).passthrough()

export class ApiError extends Error {
  override name = "ApiError"
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`)
  }
}

export interface ApiOptions {
  /** Origin of the Worker, e.g. "https://notes.example.com". Empty string = same origin. */
  baseUrl: string
  /** Extra headers, e.g. Cloudflare Access service-token headers for the CLI. */
  headers?: () => Record<string, string>
  fetch?: typeof fetch
  credentials?: "omit" | "same-origin" | "include"
  /**
   * A paired device's session token (ADR-0019). When it returns one, requests go to /device-api
   * with it instead of to /api through Cloudflare Access. Read on every request.
   */
  session?: () => string | null | undefined
}

export class Api {
  constructor(private readonly opts: ApiOptions) {}

  async #req(path: string, init: RequestInit = {}): Promise<Response> {
    const f = this.opts.fetch ?? globalThis.fetch.bind(globalThis)
    const headers = new Headers(init.headers)
    for (const [k, v] of Object.entries(this.opts.headers?.() ?? {})) headers.set(k, v)
    const token = this.opts.session?.()
    if (token) {
      headers.set("authorization", `Bearer ${token}`)
      // Access-only routes (dump, restore) don't exist there and answer 404.
      if (path.startsWith("/api/")) path = `/device-api/${path.slice(5)}`
    }
    let res: Response
    try {
      const req: RequestInit & { credentials?: string } = { ...init, headers, redirect: "manual" }
      // Not every runtime (e.g. Workers) supports `credentials`; only set it when asked.
      if (this.opts.credentials) req.credentials = this.opts.credentials
      res = await f(this.opts.baseUrl.replace(/\/$/, "") + path, req as RequestInit)
    } catch {
      throw new ApiError(0, "network_error")
    }
    if ((res.type as string) === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      // Cloudflare Access redirects to its login page when the session expired.
      throw new ApiError(401, "access_login_required")
    }
    if (!res.ok) {
      let code = "error"
      try {
        const j = (await res.json()) as { error?: unknown }
        if (typeof j.error === "string") code = j.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code)
    }
    return res
  }

  async #json<T extends z.ZodType>(
    schema: T,
    path: string,
    init: RequestInit = {},
  ): Promise<z.output<T>> {
    const headers = new Headers(init.headers)
    if (init.body && typeof init.body === "string") headers.set("content-type", "application/json")
    const res = await this.#req(path, { ...init, headers })
    return schema.parse(await res.json())
  }

  me() {
    return this.#json(Me, "/api/me")
  }

  /** One page of changes after `since`. `count` asks for `remaining`, to show progress. */
  sync(since: number, opts: { limit?: number; count?: boolean } = {}) {
    const q = `since=${since}&limit=${opts.limit ?? 500}${opts.count ? "&count=1" : ""}`
    return this.#json(SyncPage, `/api/sync?${q}`)
  }

  createChannel(req: CreateChannel) {
    return this.#json(ChannelRow, "/api/channels", { method: "POST", body: JSON.stringify(req) })
  }

  updateChannel(id: string, req: UpdateChannel) {
    return this.#json(ChannelRow, `/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(req),
    })
  }

  deleteChannel(id: string) {
    return this.#json(ChannelRow, `/api/channels/${id}`, { method: "DELETE" })
  }

  createNote(req: CreateNote) {
    return this.#json(CreateResult, "/api/notes", { method: "POST", body: JSON.stringify(req) })
  }

  updateNote(id: string, req: UpdateNote) {
    return this.#json(NoteRow, `/api/notes/${id}`, { method: "PUT", body: JSON.stringify(req) })
  }

  updatePreview(id: string, preview: string | null) {
    return this.#json(NoteRow, `/api/notes/${id}/preview`, {
      method: "PUT",
      body: JSON.stringify({ preview }),
    })
  }

  deleteNote(id: string) {
    return this.#json(NoteRow, `/api/notes/${id}`, { method: "DELETE" })
  }

  versions(id: string) {
    return this.#json(z.array(NoteVersion), `/api/notes/${id}/versions`)
  }

  uploadAttachment(id: string, channelId: string, ciphertext: Uint8Array) {
    return this.#json(AttachmentInfo, `/api/attachments/${id}?channelId=${channelId}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: ciphertext as Uint8Array<ArrayBuffer>,
    })
  }

  async downloadAttachment(id: string): Promise<Uint8Array> {
    const res = await this.#req(`/api/attachments/${id}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** One page of a table, exactly as stored (ciphertext). `next` is the cursor, null at the end. */
  async dump<T extends DumpTable>(
    table: T,
    after = 0,
    limit = 200,
  ): Promise<{ rows: DumpRow<T>[]; next: number | null }> {
    const page = z.object({ rows: z.array(DumpRows[table]), next: z.number().int().nullable() })
    return (await this.#json(page, `/api/dump/${table}?after=${after}&limit=${limit}`)) as {
      rows: DumpRow<T>[]
      next: number | null
    }
  }

  /** Writes rows as-is into an account that has never been written to. */
  restore(batch: RestoreBatch) {
    return this.#json(z.object({}).passthrough(), "/api/restore", {
      method: "POST",
      body: JSON.stringify(batch),
    })
  }

  restoreAttachment(info: AttachmentInfo, ciphertext: Uint8Array) {
    return this.#json(
      AttachmentInfo,
      `/api/restore/attachments/${info.id}?channelId=${info.channelId}&createdAt=${info.createdAt}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: ciphertext as Uint8Array<ArrayBuffer>,
      },
    )
  }

  /** Ends a restore: sets the sync counter and closes restore for this account for good. */
  restoreFinish() {
    return this.#json(z.object({ seq: z.number().int() }), "/api/restore/finish", {
      method: "POST",
      body: "{}",
    })
  }

  /* Pairing and device sessions (ADR-0016, ADR-0019). */

  /** Unauthenticated: the new device asks to be paired. Keep `secret` in memory only. */
  startPairing(recipient: string, temporary: boolean) {
    return this.#json(PairingStarted, "/device-api/pairings", {
      method: "POST",
      body: JSON.stringify({ recipient, temporary }),
    })
  }

  /** Unauthenticated: "pending" until approved, then the sealed key and a session, once. */
  claimPairing(id: string, secret: string) {
    return this.#json(PairingClaimed, `/device-api/pairings/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ secret }),
    })
  }

  /** Unauthenticated: the new device gives up. */
  cancelPairing(id: string, secret: string) {
    return this.#json(ok, `/device-api/pairings/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ secret }),
    })
  }

  getPairing(id: string) {
    return this.#json(Pairing, `/api/pairings/${encodeURIComponent(id)}`)
  }

  /** Signs the new device in and hands it the open key, sealed to its one-time key. */
  approvePairing(id: string, key: string) {
    return this.#json(ok, `/api/pairings/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ key }),
    })
  }

  rejectPairing(id: string) {
    return this.#json(ok, `/api/pairings/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: "{}",
    })
  }

  /** Paired devices with a live session. Access sessions and the CLI aren't listed. */
  devices() {
    return this.#json(z.array(DeviceRow), "/api/devices")
  }

  /** Signs a paired device out; it wipes itself the next time it reaches the Worker. */
  revokeDevice(id: string) {
    return this.#json(ok, `/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  unfurl(url: string) {
    return this.#json(Unfurl, `/api/unfurl?url=${encodeURIComponent(url)}`)
  }
}
