import { Hono, type MiddlewareHandler } from "hono"
import { accessOnly, api, onError } from "./api.ts"
import { accessAuth } from "./auth.ts"
import type { AppEnv } from "./env.ts"
import { deviceAuth, publicPairing, sessionRoutes } from "./sessions.ts"

const headers: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store")
  c.header("x-content-type-options", "nosniff")
}

// Two ways in (ADR-0019). Cloudflare Access guards /api: the owner's browsers and the CLI's
// service token. /device-api is outside Access; the Worker checks a paired device's session
// itself. Starting and claiming a pairing are the only routes that need neither.
const app = new Hono<AppEnv>()
app.use("/api/*", headers)
app.use("/device-api/*", headers)
app.route("/device-api", publicPairing)
app.use("/api/*", accessAuth)
app.use("/device-api/*", deviceAuth)
for (const base of ["/api", "/device-api"]) {
  if (base === "/api") app.route(base, accessOnly)
  app.route(base, api)
  app.route(base, sessionRoutes)
  app.all(`${base}/*`, (c) => c.json({ error: "not_found" }, 404))
}
app.onError(onError)
// Static assets (the PWA) are served by Workers Static Assets before the Worker runs; only
// /api/* and /device-api/* reach this code. Anything else falls through to ASSETS.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
