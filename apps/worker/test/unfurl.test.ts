import { afterEach, describe, expect, it, vi } from "vitest"
import { checkUrl, unfurl, UnfurlError } from "../src/unfurl.ts"

describe("SSRF guard", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://intranet/",
    "http://user:pw@example.com/",
    "http://example.com:8080/",
  ])("blocks %s", (u) => {
    expect(() => checkUrl(u)).toThrow(UnfurlError)
  })

  it("allows ordinary public URLs", () => {
    expect(checkUrl("https://example.com/a?b=c").hostname).toBe("example.com")
  })
})

describe("unfurl", () => {
  afterEach(() => vi.restoreAllMocks())

  it("extracts OpenGraph metadata and inlines a small image", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === "https://example.com/post") {
        return new Response(
          `<html><head><title>Fallback</title>
           <meta property="og:title" content="Synthetic &amp; Title">
           <meta name="description" content="A synthetic description">
           <meta property="og:site_name" content="Example">
           <meta property="og:image" content="/img.png"></head><body>x</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        )
      }
      if (url === "https://example.com/img.png")
        return new Response(png, { headers: { "content-type": "image/png" } })
      return new Response("no", { status: 404 })
    })
    const r = await unfurl("https://example.com/post")
    expect(r).toMatchObject({
      title: "Synthetic & Title",
      description: "A synthetic description",
      site: "Example",
    })
    expect(r.image).toMatch(/^data:image\/png;base64,/)
  })

  it("re-checks every redirect hop", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    )
    await expect(unfurl("https://example.com/r")).rejects.toMatchObject({ code: "ip_literal" })
  })

  it("does not inline SVG images", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith(".svg"))
        return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
      return new Response(
        `<meta property="og:image" content="https://example.com/x.svg"><title>T</title>`,
        {
          headers: { "content-type": "text/html" },
        },
      )
    })
    const r = await unfurl("https://example.com/")
    expect(r.title).toBe("T")
    expect(r.image).toBeUndefined()
  })
})
