/*
 * Jotter service worker.
 * - App shell: served from cache, refreshed in the background (only ever
 *   caches our own index.html, never an Access login page).
 * - /assets/*: hashed, immutable, cache-first.
 * - /api/attachments/* and /device-api/attachments/*: immutable ciphertext, cache-first (works
 *   offline), except from a temporary device (x-jot-no-store), which leaves nothing behind.
 * - Other /api/*, /device-api/* and /cdn-cgi/* (Access sign-in and logout): always network.
 * - POST /share (Web Share Target): kept in memory until the app takes it.
 *   Shared text is plaintext, so it is never written to storage.
 */
const SHELL = "jot-shell-v1"
const FILES = "jot-files-v1"
let pendingShare = null

function assetsIn(html) {
  return [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
}

async function refreshShell() {
  // "/" rather than "/index.html": the asset server redirects the latter.
  const res = await fetch("/", { cache: "no-store", redirect: "manual" })
  const type = res.headers.get("content-type") || ""
  if (!res.ok || res.type !== "basic" || res.redirected || !type.includes("text/html")) return
  const html = await res.clone().text()
  if (!html.includes('name="jot-shell"')) return
  const cache = await caches.open(SHELL)
  const assets = assetsIn(html)
  await cache.addAll(assets)
  await cache.put("/index.html", res)
  // Drop assets of older builds.
  const keep = new Set(assets)
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (path.startsWith("/assets/") && !keep.has(path)) await cache.delete(req)
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await refreshShell()
        const cache = await caches.open(SHELL)
        await cache.addAll(["/manifest.webmanifest", "/icon.svg", "/icon-192.png"])
      } catch {
        /* first load offline or behind a login: cache on the next visit */
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== SHELL && k !== FILES) await caches.delete(k)
      await self.clients.claim()
    })(),
  )
})

// Attachments above this are fetched when opened, not kept for offline (ADR-0017).
const MAX_CACHED_FILE = 25 * 1024 * 1024

async function cacheFirst(cacheName, request, key = request) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(key)
  if (hit) return hit
  const res = await fetch(request)
  const size = Number(res.headers.get("content-length") ?? Infinity)
  if (res.ok && res.type === "basic" && !res.redirected && size <= MAX_CACHED_FILE)
    await cache.put(key, res.clone())
  return res
}

async function navigate(event) {
  const cache = await caches.open(SHELL)
  const shell = await cache.match("/index.html")
  if (shell) {
    event.waitUntil(refreshShell().catch(() => {}))
    return shell
  }
  return fetch(event.request)
}

async function receiveShare(request) {
  const form = await request.formData()
  const str = (k) => (typeof form.get(k) === "string" ? form.get(k) : "")
  pendingShare = {
    title: str("title"),
    text: str("text"),
    url: str("url"),
    files: form.getAll("files").filter((f) => typeof f !== "string"),
  }
  setTimeout(() => (pendingShare = null), 60_000)
  return Response.redirect("/?share=1", 303)
}

self.addEventListener("fetch", (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (req.method === "POST" && url.pathname === "/share") {
    event.respondWith(receiveShare(req))
    return
  }
  if (req.method !== "GET") return
  const api = /^\/(api|device-api)\//.exec(url.pathname)
  if (api && url.pathname.startsWith(`${api[0]}attachments/`)) {
    if (req.headers.has("x-jot-no-store")) return
    // Keyed by the path without the prefix, so either session finds the same ciphertext.
    event.respondWith(cacheFirst(FILES, req, url.pathname.slice(api[0].length - 1)))
    return
  }
  // Access's sign-in callback and logout: answering them with the cached shell would drop the
  // sign-in cookie, so the installed app could never sign in.
  if (api || url.pathname.startsWith("/cdn-cgi/")) return
  if (req.mode === "navigate") {
    event.respondWith(navigate(event))
    return
  }
  if (url.pathname.startsWith("/assets/") || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(SHELL, req))
  }
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "take-share" && event.ports[0]) {
    event.ports[0].postMessage(pendingShare)
    pendingShare = null
  }
})
