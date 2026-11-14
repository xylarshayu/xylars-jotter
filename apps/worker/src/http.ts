import type { Context } from "hono"
import type { z } from "zod"
import type { AppEnv } from "./env.ts"

export type C = Context<AppEnv>

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429,
    readonly code: string,
  ) {
    super(code)
  }
}

export async function parse<T extends z.ZodType>(c: C, schema: T): Promise<z.output<T>> {
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    throw new HttpError(400, "invalid_json")
  }
  const r = schema.safeParse(json)
  if (!r.success) throw new HttpError(400, "invalid_request")
  return r.data
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
}

/** `n` random bytes as base64url without padding: 16 bytes give 22 characters, 32 give 43. */
export function randomB64url(n: number): string {
  let s = ""
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
