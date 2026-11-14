/**
 * Cloudflare Access sits in front of /api; the Worker verifies the Access JWT again (defense in
 * depth) and maps the owner's email or the CLI service token to the single user. Paired devices
 * use a device session at /device-api instead (sessions.ts, ADR-0019).
 */
import type { MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"
import { Jwt } from "hono/utils/jwt"
import type { AppEnv, Env } from "./env.ts"

type Jwk = Parameters<typeof Jwt.verifyWithJwks>[1]["keys"]
type JWTPayload = Awaited<ReturnType<typeof Jwt.verifyWithJwks>>
let jwksCache: { url: string; keys: NonNullable<Jwk>; at: number } | undefined

async function accessKeys(team: string): Promise<NonNullable<Jwk>> {
  const url = `${team}/cdn-cgi/access/certs`
  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < 10 * 60_000)
    return jwksCache.keys
  const res = await fetch(url)
  if (!res.ok) throw new Error("jwks fetch failed")
  const body = (await res.json()) as { keys: NonNullable<Jwk> }
  jwksCache = { url, keys: body.keys, at: Date.now() }
  return body.keys
}

export type KeyLoader = (team: string) => Promise<NonNullable<Jwk>>

/** Returns the user id for a valid Access token, or null. Exported for tests. */
export async function userFromAccessToken(
  token: string,
  env: Env,
  loadKeys: KeyLoader = accessKeys,
): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, "")
  if (!team || !env.ACCESS_AUD) return null
  let payload: JWTPayload
  try {
    payload = await Jwt.verifyWithJwks(token, {
      keys: await loadKeys(team),
      allowedAlgorithms: ["RS256"],
      verification: { iss: team, aud: env.ACCESS_AUD },
    })
  } catch {
    return null
  }
  const owner = env.OWNER_USER_ID || "u_owner"
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined
  if (email && env.OWNER_EMAIL && email === env.OWNER_EMAIL.toLowerCase()) return owner
  const cn = typeof payload.common_name === "string" ? payload.common_name : undefined
  if (cn && env.SERVICE_TOKEN_CLIENT_ID && cn === env.SERVICE_TOKEN_CLIENT_ID) return owner
  return null
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export const isLocal = (url: string) => LOCAL_HOSTS.has(new URL(url).hostname)

export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("device", null)
  if (c.env.AUTH_MODE === "dev") {
    // Local development only: refuse dev auth on anything but localhost.
    if (!isLocal(c.req.url)) return c.json({ error: "dev_auth_not_local" }, 403)
    // Lets the e2e tests act as a browser that isn't signed in to Access.
    if (getCookie(c, "jot_dev_signed_out")) return c.json({ error: "unauthenticated" }, 401)
    c.set("userId", "u_dev")
    return next()
  }
  const token = c.req.header("cf-access-jwt-assertion")
  if (!token) return c.json({ error: "unauthenticated" }, 401)
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD)
    return c.json({ error: "auth_not_configured" }, 500)
  const userId = await userFromAccessToken(token, c.env)
  if (!userId) return c.json({ error: "forbidden" }, 403)
  c.set("userId", userId)
  return next()
}
