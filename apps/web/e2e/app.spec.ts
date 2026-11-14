import { readFileSync } from "node:fs"
import { type Browser, expect, test, type Page } from "@playwright/test"

// Synthetic data only. One account per run (fresh local D1); tests run in order.
const PASS = "synthetic-e2e-passphrase"
const BASE = "http://127.0.0.1:8799"
let openKey = ""

test.describe.configure({ mode: "serial" })

const composer = (page: Page) => page.getByRole("textbox", { name: "Note text" })
const feed = (page: Page) => page.locator("main")

async function pasteKey(page: Page) {
  await page.goto("/")
  await page.getByRole("textbox", { name: "Open key" }).fill(openKey)
  await page.getByRole("button", { name: "Use this key" }).click()
  await expect(composer(page)).toBeVisible()
}

/** Every string stored in IndexedDB and localStorage, for plaintext checks. */
async function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: unknown[] = [JSON.stringify(localStorage)]
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!)
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      for (const name of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((res, rej) => {
          const r = db.transaction(name).objectStore(name).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        out.push(all)
      }
      db.close()
    }
    for (const key of await caches.keys()) {
      const cache = await caches.open(key)
      for (const req of await cache.keys()) {
        const res = await cache.match(req)
        if (res && /text|json/.test(res.headers.get("content-type") ?? ""))
          out.push(await res.text())
      }
    }
    return JSON.stringify(out)
  })
}

test("sets up a new key and captures with Enter", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Create a new key" }).click()
  const keyBox = page.getByRole("textbox", { name: "Your new open key" })
  await expect(keyBox).toHaveValue(/^AGE-SECRET-KEY-PQ-1/)
  openKey = await keyBox.inputValue()
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "Continue" }).click()

  await composer(page).fill("synthetic first note https://example.com/page")
  await composer(page).press("Enter")
  await expect(feed(page).getByText("synthetic first note")).toBeVisible()
  await expect(composer(page)).toHaveValue("")
  await composer(page).fill("line one")
  await composer(page).press("Shift+Enter")
  await composer(page).pressSequentially("line two")
  await expect(composer(page)).toHaveValue("line one\nline two")
  await composer(page).press("Enter")
  await expect(feed(page).getByText("line two")).toBeVisible()
  // Notes show instantly but upload in the background: the next test's second device only sees
  // what the server has, so wait until both are uploaded (slow CI runners otherwise race).
  await expect(page.getByTitle("Waiting to upload")).toHaveCount(0)

  await page.reload()
  await expect(feed(page).getByText("synthetic first note")).toBeVisible()
  const link = feed(page).getByRole("link", { name: "https://example.com/page" })
  await expect(link).toHaveAttribute("rel", /noopener/)
})

test("a second device with the same key sees the notes, and search works", async ({ page }) => {
  await pasteKey(page)
  await expect(feed(page).getByText("synthetic first note")).toBeVisible()
  await page.keyboard.press("/")
  await page.getByRole("searchbox", { name: "Search notes" }).fill("line two")
  await expect(feed(page).getByText("line one")).toBeVisible()
  await expect(feed(page).getByText("synthetic first note")).toHaveCount(0)
})

test("attaches any file type: chips download, GIFs stay inline and untouched", async ({ page }) => {
  await pasteKey(page)
  // A synthetic 2x3 GIF (header, empty colour table, one image block) and an opaque archive.
  const gif = Buffer.from("R0lGODlhAgADAIAAAAAAAP///yH5BAEAAAAALAAAAAACAAMAAAIDhI9WADs=", "base64")
  const zip = Buffer.from("PK\u0003\u0004 synthetic archive bytes")
  await page.locator('input[type="file"]').setInputFiles([
    { name: "synthetic.gif", mimeType: "image/gif", buffer: gif },
    { name: "synthetic.zip", mimeType: "application/zip", buffer: zip },
  ])
  // Dropping anywhere on the page adds to the tray instead of navigating away.
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(["synthetic dropped"], "dropped.txt", { type: "text/plain" }))
    document.body.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    )
  })
  await expect(page.getByRole("button", { name: "Remove dropped.txt" })).toBeVisible()
  await composer(page).fill("synthetic files")
  await composer(page).press("Enter")

  const img = feed(page).getByRole("img", { name: "synthetic.gif" })
  await expect(img).toHaveAttribute("src", /^blob:/)
  await expect(img).toHaveAttribute("width", "2")
  // Decoded from the untouched GIF (byte-for-byte passthrough is unit-tested in images.test.ts).
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]))
    .toEqual([2, 3])

  const chip = feed(page).getByRole("button", { name: /synthetic\.zip/ })
  await expect(chip).toContainText("B")
  const [download] = await Promise.all([page.waitForEvent("download"), chip.click()])
  expect(download.suggestedFilename()).toBe("synthetic.zip")
  expect(readFileSync(await download.path())).toEqual(zip)
  await expect(feed(page).getByRole("button", { name: /dropped\.txt/ })).toBeVisible()
})

/** A browser that isn't signed in to Access (dev auth honours this cookie on localhost only). */
async function signedOutBrowser(browser: Browser) {
  const ctx = await browser.newContext()
  await ctx.addCookies([{ name: "jot_dev_signed_out", value: "1", url: BASE }])
  return { ctx, page: await ctx.newPage() }
}

/** Starts pairing on `laptop`; approves it on `phone` (which has the key) after checking the code. */
async function pairWith(phone: Page, laptop: Page, opts: { temporary: boolean }) {
  await laptop.goto("/")
  await expect(
    laptop.getByRole("button", { name: "Sign in to paste or create a key" }),
  ).toBeVisible()
  await expect(laptop.getByRole("textbox", { name: "Open key" })).toHaveCount(0)
  if (opts.temporary) await laptop.getByRole("checkbox", { name: /Temporary device/ }).check()
  await laptop.getByRole("button", { name: "Pair with your phone" }).click()
  await expect(laptop.getByRole("img", { name: /Pairing code/ })).toBeVisible()
  const code = (await laptop.getByTestId("pair-code").textContent())!
  expect(code).toMatch(/^\d{3} \d{3}$/)
  await laptop.getByText("Can't scan?").click()
  const link = (await laptop.getByTestId("pair-link").textContent())!

  // What a scan does: open the link in the app that holds the key.
  await phone.goto(link)
  await expect(phone.getByTestId("offer-code")).toHaveText(code)
  await expect(phone.getByTestId("offer-agent")).toHaveText(/Chrome/)
  await expect(
    phone.getByText(opts.temporary ? /Temporary: forgets/ : "Stays signed in"),
  ).toBeVisible()
  await phone.getByRole("button", { name: "Codes match, approve" }).click()
  await expect(phone.getByText("Approved.")).toBeVisible()
  await expect(feed(laptop).getByText("synthetic first note")).toBeVisible({ timeout: 10_000 })
  return link
}

async function deviceList(phone: Page) {
  await phone.goto("/#/settings")
  await phone.reload()
  return phone.getByTestId("devices")
}

test("pairs a signed-out temporary device with one approval; it stores nothing", async ({
  browser,
  page,
}) => {
  await pasteKey(page) // the phone, signed in through Access
  const { ctx, page: laptop } = await signedOutBrowser(browser)
  const link = await pairWith(page, laptop, { temporary: true })

  const dbs = await laptop.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect(dbs).toEqual([])
  const dump = await storageDump(laptop)
  expect(dump).not.toContain("synthetic first note")
  expect(dump).not.toContain(openKey)
  expect(dump).not.toContain("jotd_")
  await laptop.goto("/#/settings")
  await expect(laptop.getByTestId("temporary-note")).toBeVisible()
  await expect(laptop.getByTestId("devices")).toHaveCount(0)
  await deviceList(page)
  await expect(page.getByTestId("devices").getByText("Temporary")).toBeVisible()

  // The link was one-time.
  await page.goto("/")
  await page.goto(link)
  await expect(page.getByRole("alert")).toContainText(/expired|already/)

  // Closing or reloading the tab forgets everything and ends its session.
  await laptop.reload()
  await expect(laptop.getByRole("button", { name: "Pair with your phone" })).toBeVisible()
  await expect(async () => {
    await deviceList(page)
    await expect(page.getByText("No paired devices.")).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await ctx.close()
})

test("a paired device stays signed in until the phone signs it out; then it wipes itself", async ({
  browser,
  page,
}) => {
  await pasteKey(page)
  const { ctx, page: laptop } = await signedOutBrowser(browser)
  await pairWith(page, laptop, { temporary: false })
  await laptop.reload()
  await expect(feed(laptop).getByText("synthetic first note")).toBeVisible()

  const list = await deviceList(page)
  await expect(list.getByRole("listitem")).toHaveCount(1)
  await list.getByRole("button", { name: "Sign out…" }).click()
  await list.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(page.getByText("No paired devices.")).toBeVisible()

  await laptop.reload()
  await expect(laptop.getByText("signed out from another device")).toBeVisible({ timeout: 10_000 })
  expect(await storageDump(laptop)).not.toContain("synthetic first note")
  await ctx.close()
})

test("rejects a wrong key", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("textbox", { name: "Open key" }).fill("not a key")
  await page.getByRole("button", { name: "Use this key" }).click()
  await expect(page.getByRole("alert").or(page.getByRole("status"))).toContainText(/key/i)
})

test("locked channel: append without unlock, unlock, lock, nothing stored in plaintext", async ({
  page,
}) => {
  await pasteKey(page)
  await page.getByRole("button", { name: "New channel" }).click()
  await page.getByRole("textbox", { name: "Channel name" }).fill("Synthetic vault")
  await page.getByRole("radio", { name: "Locked" }).click()
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS)
  await page.getByLabel("Repeat passphrase").fill(PASS)
  await page.getByRole("button", { name: "Create", exact: true }).click()

  // New locked channel is selected and locked: append without unlocking.
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible()
  await composer(page).fill("synthetic locked secret")
  await composer(page).press("Enter")
  await expect(page.getByText("Added to the locked channel.")).toBeVisible()
  await expect(feed(page).getByText("synthetic locked secret")).toHaveCount(0)

  const pass = page.getByLabel("Passphrase", { exact: true })
  await pass.fill("wrong-synthetic-passphrase")
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(page.getByText("Wrong passphrase.")).toBeVisible()
  await expect(pass).toHaveValue("")

  await pass.fill(PASS)
  await page.getByRole("button", { name: "Unlock" }).click()
  await expect(feed(page).getByText("synthetic locked secret")).toBeVisible()
  await expect(page.getByRole("link", { name: "Synthetic vault" })).toBeVisible()

  const dump = await storageDump(page)
  expect(dump).not.toContain("synthetic locked secret")
  expect(dump).not.toContain(PASS)
  expect(dump).not.toContain("Synthetic vault")
  expect(dump).toContain("synthetic first note") // open plaintext cache works

  await page.getByTitle("Lock now").click()
  await expect(feed(page).getByText("synthetic locked secret")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible()

  // A reload never brings it back.
  await page.reload()
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible()
  await page.goto("/#/")
  await expect(feed(page).getByText("synthetic first note")).toBeVisible()
  await expect(feed(page).getByText("synthetic locked secret")).toHaveCount(0)
})

test("works offline: queued notes upload when back online, shell loads offline", async ({
  page,
  context,
}) => {
  await pasteKey(page)
  // Wait for the service worker to control the page and cache the shell.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true)
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).join(",")))
    .toContain("jot-shell")

  // Access's sign-in callback and logout must reach the network, not the cached shell.
  const shell = await page.goto("/")
  expect(shell?.fromServiceWorker()).toBe(true)
  const callback = await page.goto("/cdn-cgi/access/authorized?synthetic=1")
  expect(callback?.fromServiceWorker()).toBe(false)
  await page.goto("/")

  await context.setOffline(true)
  await composer(page).fill("synthetic offline note")
  await composer(page).press("Enter")
  await expect(feed(page).getByText("synthetic offline note")).toBeVisible()
  await expect(page.getByTitle("Waiting to upload").first()).toBeVisible()

  await page.reload()
  await expect(feed(page).getByText("synthetic offline note")).toBeVisible()
  await expect(page.getByText("Offline").first()).toBeVisible()

  await context.setOffline(false)
  await expect(page.getByTitle("Waiting to upload")).toHaveCount(0, { timeout: 15_000 })

  const other = await context.browser()!.newContext()
  const p2 = await other.newPage()
  await pasteKey(p2)
  await expect(feed(p2).getByText("synthetic offline note")).toBeVisible()
  await other.close()
})

test("serves a strict CSP and no inline script", async ({ request }) => {
  const res = await request.get("/")
  const csp = res.headers()["content-security-policy"] ?? ""
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("default-src 'none'")
  expect(csp).not.toContain("unsafe")
  expect(res.headers()["x-frame-options"]).toBe("DENY")
  const html = await res.text()
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  expect(html).not.toMatch(/<style|style=/)
})

test("no CSP violations while using the app", async ({ page }) => {
  const violations: string[] = []
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text())
  })
  await pasteKey(page)
  await page
    .getByRole("link", { name: "Settings" })
    .or(page.getByRole("button", { name: "Settings" }))
    .first()
    .click()
  await expect(page.getByText("Forget this device")).toBeVisible()
  expect(violations).toEqual([])
})
