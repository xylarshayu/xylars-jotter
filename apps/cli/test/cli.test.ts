import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import { Api, newChannel } from "@jot/core"
import { run } from "../src/main.ts"
import type { Io } from "../src/context.ts"

// Synthetic data only.
const PASS = "synthetic-passphrase-for-tests-only"
const home = mkdtempSync(join(tmpdir(), "jot-cli-home-"))
const keyFile = join(home, "open-key.txt")

function io(stdin = "", extraEnv: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const i: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => stdin,
    stdinIsTty: false,
    env: {
      HOME: home,
      JOT_SERVER: inject("serverUrl"),
      JOT_OPEN_KEY_FILE: keyFile,
      JOT_NOTES_DIR: join(home, "notes"),
      JOT_LOCKED_NOTES_DIR: join(home, "notes-locked"),
      ...extraEnv,
    },
    cwd: home,
  }
  return { i, out, err }
}

async function jot(args: string[], stdin = "", env: Record<string, string> = {}) {
  const { i, out, err } = io(stdin, env)
  const code = await run(args, i)
  return { code, out: out.join("\n"), err: err.join("\n") }
}

async function ok(args: string[], stdin = "") {
  const r = await jot(args, stdin)
  if (r.code !== 0) throw new Error(`jot ${args[0]} failed: ${r.err}`)
  return r.out
}

let vault = ""

// The Worker's unfurl endpoint refuses local addresses, so previews are stubbed with synthetic
// data. A URL containing "bare" unfurls to nothing (no title or description).
const unfurled: string[] = []
beforeAll(() => {
  vi.spyOn(Api.prototype, "unfurl").mockImplementation(async (url: string) => {
    unfurled.push(url)
    if (url.includes("bare")) return { url }
    const path = new URL(url).pathname.slice(1)
    return { url, title: `Synthetic title ${path}`, description: `synthetic description ${path}` }
  })
})
beforeEach(() => {
  unfurled.length = 0
})

beforeAll(async () => {
  expect((await jot(["keygen", "-o", keyFile])).code).toBe(0)
  expect(statSync(keyFile).mode & 0o777).toBe(0o600)
  expect(await ok(["channels", "create", "Inbox"])).toMatch(/^[0-9A-Z]{26}$/)
  vault = (await ok(["channels", "create", "Vault", "--locked"], PASS + "\n")).trim()
})

describe("jot", () => {
  it("refuses to overwrite a key file", async () => {
    expect((await jot(["keygen", "-o", keyFile])).code).toBe(1)
  })

  it("adds, lists, reads and searches open notes", async () => {
    const id = (
      await ok(["add", "-c", "inbox", "--no-preview", "synthetic", "shopping", "list"])
    ).trim()
    await ok(["add", "-c", "Inbox", "--no-preview", "-"], "multi\nline synthetic note\n")
    const list = JSON.parse(await ok(["list", "--json"])) as {
      id: string
      text: string
      channel: string
    }[]
    expect(list.map((n) => n.text)).toEqual(
      expect.arrayContaining(["synthetic shopping list", "multi\nline synthetic note"]),
    )
    expect(list[0]!.channel).toBe("Inbox")
    expect(await ok(["read", id])).toContain("synthetic shopping list")
    const found = JSON.parse(await ok(["search", "--json", "SHOPPING"])) as { id: string }[]
    expect(found.map((f) => f.id)).toEqual([id])
  })

  it("never creates channels implicitly", async () => {
    const r = await jot(["add", "-c", "Nope", "x"])
    expect(r.code).toBe(1)
    expect(r.err).toContain("no such channel")
  })

  it("appends to a locked channel without the passphrase, but can't read it", async () => {
    const id = (await ok(["add", "-c", vault, "synthetic locked thought"])).trim()
    const channels = JSON.parse(await ok(["channels", "--json"])) as {
      id: string
      name: string | null
    }[]
    // Locked names are readable with the open key (ADR-0014); the notes are not.
    expect(channels.find((c) => c.id === vault)!.name).toBe("Vault")
    const r = await jot(["read", id])
    expect(r.code).toBe(1)
    expect(r.out + r.err).not.toContain("synthetic locked thought")
    expect(await ok(["search", "locked thought"])).toBe("")
    expect(await ok(["list"])).not.toContain("locked thought")
  })

  it("unlock reads the passphrase from stdin and runs one command", async () => {
    const out = await ok(["unlock", vault, "list", "-c", vault, "--json"], PASS + "\n")
    expect(out).toContain("synthetic locked thought")
    const bad = await jot(["unlock", vault, "list", "-c", vault], "wrong-synthetic\n")
    expect(bad.code).toBe(1)
    expect(bad.err).toBe("jot: wrong passphrase or bad key")
    // The passphrase is only on stdin; the rest of stdin is still usable.
    const id = (
      await ok(["unlock", vault, "add", "-c", vault, "-"], PASS + "\nsecond synthetic secret\n")
    ).trim()
    expect(await ok(["unlock", "Vault", "read", id], PASS + "\n")).toContain(
      "second synthetic secret",
    )
  })

  it("never caches locked plaintext on disk", async () => {
    const cacheDir = join(home, ".cache", "jot")
    for (const f of readdirSync(cacheDir)) {
      const text = readFileSync(join(cacheDir, f), "utf8")
      expect(text).not.toContain("locked thought")
      expect(text).not.toContain("second synthetic secret")
      expect(text).not.toContain(PASS)
    }
  })

  it("edits with history, moves and deletes", async () => {
    await ok(["channels", "create", "Archive"])
    const id = (await ok(["add", "-c", "Inbox", "draft A"])).trim()
    await ok(["edit", id, "draft B"])
    const read = JSON.parse(await ok(["read", id, "--json", "--history"])) as {
      text: string
      history: { text: string }[]
    }
    expect(read.text).toBe("draft B")
    expect(read.history.map((h) => h.text)).toEqual(["draft A"])
    await ok(["mv", id, "Archive"])
    expect(JSON.parse(await ok(["read", id, "--json"])).channel).toBe("Archive")
    await ok(["rm", id])
    expect((await jot(["read", id])).code).toBe(1)
  })

  it("imports JSONL idempotently and validates before writing", async () => {
    const dir = join(home, "import")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "pic.png"), new Uint8Array([137, 80, 78, 71]))
    const lines = [
      {
        channel: "Inbox",
        created_at: "2023-03-04T05:06:07Z",
        text: "imported synthetic one",
        source_id: "s-1",
      },
      {
        channel: "Inbox",
        created_at: "2023-03-05T05:06:07Z",
        text: "imported synthetic two",
        links: ["https://example.com/x"],
        source_id: "s-2",
        attachments: [{ path: "pic.png", mime: "image/png" }],
      },
    ]
    writeFileSync(join(dir, "ok.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    expect(await ok(["import", join(dir, "ok.jsonl")])).toBe(
      "imported 2, skipped 0 already present\npreviews: 1 of 1 notes with links",
    )
    expect(await ok(["import", join(dir, "ok.jsonl")])).toBe(
      "imported 0, skipped 2 already present",
    )

    writeFileSync(
      join(dir, "bad.jsonl"),
      JSON.stringify({ ...lines[0], channel: "Missing", source_id: "s-3" }) + "\n{not json\n",
    )
    const bad = await jot(["import", join(dir, "bad.jsonl")])
    expect(bad.code).toBe(1)
    expect(bad.err).toContain("nothing written")
    expect(bad.err).not.toContain("imported synthetic")
  })

  it("mirrors open channels as Markdown and locked channels as age files, and cleans up", async () => {
    const r = await ok(["mirror"])
    expect(r).toMatch(/^mirror: \d+ open, 2 locked/)
    const notes = join(home, "notes")
    const inboxFiles = execFileSync("find", [join(notes, "inbox"), "-name", "*.md"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
    const all = inboxFiles.map((f) => readFileSync(f, "utf8")).join("\n")
    expect(all).toContain("synthetic shopping list")
    expect(all).toContain('channel: "Inbox"')
    expect(all).toMatch(/created: 2023-03-04T05:06:07.000Z/)
    expect(existsSync(join(notes, "inbox", "2023", "03"))).toBe(true)
    // Attachment decrypted next to the note.
    expect(execFileSync("find", [notes, "-name", "*.png"], { encoding: "utf8" })).toContain(
      ".files/",
    )

    const locked = join(home, "notes-locked", vault)
    expect(existsSync(join(locked, "key.age"))).toBe(true)
    const lockedText = execFileSync("find", [locked, "-type", "f"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((f) => readFileSync(f).toString("latin1"))
      .join("")
    expect(lockedText).not.toContain("synthetic locked thought")
    // Nothing locked ever lands in the open tree.
    const openFiles = execFileSync("find", [notes, "-type", "f"], { encoding: "utf8" })
      .trim()
      .split("\n")
    for (const f of openFiles) expect(readFileSync(f, "utf8")).not.toContain("locked thought")
  })

  it("mirror removes notes that were deleted or moved into a locked channel", async () => {
    const id = (await ok(["add", "-c", "Inbox", "soon to be sealed"])).trim()
    await ok(["mirror"])
    const find = () =>
      execFileSync("find", [join(home, "notes"), "-name", `${id}.md`], { encoding: "utf8" }).trim()
    expect(find()).not.toBe("")
    await ok(["mv", id, vault])
    await ok(["mirror"])
    expect(find()).toBe("")
  })

  it("mirror and export refuse to run unlocked", async () => {
    expect((await jot(["unlock", vault, "mirror"], PASS + "\n")).code).toBe(1)
    expect((await jot(["unlock", vault, "export", join(home, "x")], PASS + "\n")).code).toBe(1)
  })

  it("attaches files of any type and saves them back, never overwriting (ADR-0017)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jot-cli-files-"))
    const blob = new Uint8Array(200_000).map((_, i) => (i * 31 + 7) & 0xff)
    writeFileSync(join(dir, "synthetic.bin"), blob)
    writeFileSync(join(dir, "notes.tar.gz"), "synthetic archive")
    // Text is optional with files; stdin is not read.
    const id = (
      await ok(["add", "-c", "Inbox", "-f", join(dir, "synthetic.bin"), join(dir, "notes.tar.gz")])
    ).trim()
    const view = JSON.parse(await ok(["read", id, "--json"])) as {
      text: string
      attachments: { name: string; mime: string; size: number }[]
    }
    expect(view.text).toBe("")
    expect(view.attachments.map((a) => [a.name, a.mime, a.size])).toEqual([
      ["synthetic.bin", "application/octet-stream", 200_000],
      ["notes.tar.gz", "application/gzip", 17],
    ])

    const out = join(dir, "out")
    mkdirSync(out)
    await ok(["files", id, "-o", out])
    await ok(["files", id, "-o", out])
    expect(readdirSync(out).sort()).toEqual([
      "notes.tar (2).gz",
      "notes.tar.gz",
      "synthetic (2).bin",
      "synthetic.bin",
    ])
    expect(new Uint8Array(readFileSync(join(out, "synthetic (2).bin")))).toEqual(blob)
    expect(statSync(join(out, "synthetic.bin")).mode & 0o777).toBe(0o600)

    expect((await jot(["add", "-c", "Inbox", "-f", join(dir, "missing")])).code).toBe(1)
  })

  it("adds files to a locked channel, but never saves them to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jot-cli-files-"))
    writeFileSync(join(dir, "sealed.txt"), "synthetic sealed file")
    const id = (await ok(["add", "-c", vault, "-f", join(dir, "sealed.txt")])).trim()
    const r = await jot(["unlock", vault, "files", id, "-o", dir], PASS + "\n")
    expect(r.code).toBe(1)
    expect(r.err).toContain("locked")
    expect(readdirSync(dir)).toEqual(["sealed.txt"])
  })

  it("exports Markdown, JSONL and age files; Go age can decrypt a locked note with the passphrase", async () => {
    const out = join(home, "export")
    expect(await ok(["export", out])).toMatch(/^exported \d+ open and \d+ locked notes/)
    const jsonl = readFileSync(join(out, "notes.jsonl"), "utf8").trim().split("\n")
    expect(jsonl.some((l) => l.includes("synthetic shopping list"))).toBe(true)
    expect(jsonl.some((l) => l.includes("locked thought"))).toBe(false)
    const age = [process.env.AGE_BIN, join(homedir(), "go", "bin", "age")].find(
      (p) => p && existsSync(p),
    )
    if (!age) return
    const lockedNote = execFileSync(
      "find",
      [join(out, "locked", vault), "-name", "*.age", "-path", "*/20*"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")[0]!
    // Unwrap the channel key with the passphrase (batchpass plugin), then decrypt the note.
    const bin = age.slice(0, age.lastIndexOf("/"))
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGE_PASSPHRASE: PASS }
    const identity = execFileSync(
      age,
      ["-d", "-j", "batchpass", join(out, "locked", vault, "key.age")],
      { env },
    )
    writeFileSync(join(home, "vault-id.txt"), identity, { mode: 0o600 })
    const note = execFileSync(age, ["-d", "-i", join(home, "vault-id.txt"), lockedNote], {
      encoding: "utf8",
    })
    expect(JSON.parse(note).text).toMatch(/synthetic|sealed/)
  })

  describe("link previews", () => {
    const dir = join(home, "previews")
    const line = (channel: string, n: number, links: string[]) =>
      JSON.stringify({
        channel,
        created_at: `2024-01-0${n}T00:00:00Z`,
        text: `preview synthetic ${n}`,
        links,
        source_id: `p-${channel}-${n}`,
      })
    type Listed = { id: string; text: string; previews: { title?: string }[] }
    const listed = async (channel: string, unlock?: string) =>
      JSON.parse(
        unlock
          ? await ok(["unlock", channel, "list", "-c", channel, "-n", "100", "--json"], unlock)
          : await ok(["list", "-c", channel, "-n", "100", "--json"]),
      ) as Listed[]

    beforeAll(async () => {
      mkdirSync(dir, { recursive: true })
      await ok(["channels", "create", "Links"])
      await ok(["channels", "create", "Later"])
    })

    it("import unfurls open channels by default and never locked ones", async () => {
      const file = join(dir, "a.jsonl")
      writeFileSync(
        file,
        [
          line("Links", 1, ["https://example.com/alpha"]),
          line("Links", 2, ["https://example.com/bare"]),
          line("Links", 3, []),
          line(vault, 4, ["https://example.com/sealed"]),
        ].join("\n") + "\n",
      )
      expect(await ok(["import", file])).toBe(
        "imported 4, skipped 0 already present\npreviews: 1 of 2 notes with links",
      )
      expect(unfurled.sort()).toEqual(["https://example.com/alpha", "https://example.com/bare"])
      const notes = await listed("Links")
      expect(notes.find((n) => n.text === "preview synthetic 1")!.previews[0]!.title).toBe(
        "Synthetic title alpha",
      )
      // Searchable by preview title and description.
      const hits = JSON.parse(await ok(["search", "--json", "title alpha"])) as Listed[]
      expect(hits.map((h) => h.text)).toEqual(["preview synthetic 1"])
      expect(JSON.parse(await ok(["search", "--json", "description alpha"]))).toHaveLength(1)
      // The locked note was imported without a preview.
      const locked = await listed(vault, PASS + "\n")
      expect(locked.find((n) => n.text === "preview synthetic 4")!.previews).toEqual([])
    })

    it("import --no-previews skips them; jot previews backfills the missing ones", async () => {
      const file = join(dir, "b.jsonl")
      writeFileSync(
        file,
        [1, 2, 3].map((n) => line("Later", n, [`https://example.com/later${n}`])).join("\n"),
      )
      expect(await ok(["import", "--no-previews", file])).toBe(
        "imported 3, skipped 0 already present",
      )
      expect(unfurled).toEqual([])
      expect((await listed("Later")).every((n) => n.previews.length === 0)).toBe(true)

      // --limit takes a slice; --json reports what is left.
      expect(
        JSON.parse(await ok(["previews", "-c", "Later", "--missing", "-n", "2", "--json"])),
      ).toEqual({ checked: 2, found: 2, remaining: 1 })
      // All open channels: the remaining Later note, plus the "bare" Links note that found nothing.
      unfurled.length = 0
      expect(await ok(["previews"])).toBe("previews: 1 of 2 notes with links")
      expect(unfurled).not.toContain("https://example.com/sealed")
      expect((await listed("Later")).every((n) => n.previews.length === 1)).toBe(true)
      // Nothing left to do, unless --refresh.
      unfurled.length = 0
      expect(await ok(["previews", "-c", "Later"])).toBe("previews: 0 of 0 notes with links")
      expect(unfurled).toEqual([])
      expect(await ok(["previews", "-c", "Later", "--refresh"])).toBe(
        "previews: 3 of 3 notes with links",
      )
      expect((await jot(["previews", "-n", "0"])).code).toBe(1)
    })

    it("locked channels need -c, --locked and an unlock", async () => {
      const without = await jot(["previews", "-c", vault])
      expect(without.code).toBe(1)
      expect(without.err).toContain("--locked")
      const locked = await jot(["previews", "-c", vault, "--locked"])
      expect(locked.code).toBe(1)
      expect(locked.err).toContain("jot unlock")
      expect((await jot(["previews", "--locked"])).code).toBe(1)
      expect(unfurled).toEqual([])

      const out = await ok(["unlock", vault, "previews", "-c", vault, "--locked"], PASS + "\n")
      expect(out).toBe("previews: 1 of 1 notes with links")
      expect(unfurled).toEqual(["https://example.com/sealed"])
      const notes = await listed(vault, PASS + "\n")
      expect(notes.find((n) => n.text === "preview synthetic 4")!.previews).toHaveLength(1)
    })
  })

  describe("migrate (ADR-0015)", () => {
    const target = () => inject("targetUrl")
    const newKey = join(home, "new-open-key.txt")
    const dir = join(home, "previews")
    type Listed = { id: string; text: string; previews: { title?: string }[] }
    const onTarget = (key = newKey) => ({ JOT_SERVER: target(), JOT_OPEN_KEY_FILE: key })
    const migrate = (extra: string[] = []) =>
      jot(
        ["migrate", "--from", inject("serverUrl"), "--from-key-file", keyFile, ...extra],
        "",
        onTarget(),
      )
    let legacy = ""

    beforeAll(async () => {
      // A locked channel from before ADR-0014: its name is sealed to the channel only.
      const { request } = await newChannel({
        name: "Synthetic legacy",
        lock: "locked",
        passphrase: PASS,
        scryptLogN: 10,
      })
      legacy = (await new Api({ baseUrl: inject("serverUrl") }).createChannel(request)).id
      await ok(["add", "-c", legacy, "synthetic legacy note"])
      expect((await jot(["keygen", "-o", newKey])).code).toBe(0)
    })

    it("refuses to keep the old key", async () => {
      const r = await jot(
        ["migrate", "--from", inject("serverUrl"), "--from-key-file", keyFile],
        "",
        onTarget(keyFile),
      )
      expect(r.code).toBe(1)
      expect(r.err).toContain("new open key is the old one")
    })

    it("copies everything as ciphertext and rotates the open key", async () => {
      const source = JSON.parse(await ok(["list", "-n", "1000", "--json"])) as Listed[]
      const dry = await migrate(["--dry-run"])
      expect(dry.code).toBe(0)
      expect(dry.out).toMatch(/^dry run: would migrate \d+ channels/)

      const r = await migrate()
      expect(r.code, r.err).toBe(0)
      expect(r.out).toMatch(/^migrated \d+ channels \(\d+ open re-wrapped to the new key\)/)
      expect(r.out).toContain("locked channel names: 1 re-sealed to the new key, 1 still hidden")
      // Counts only: no names, note text or key material.
      for (const secret of ["Inbox", "Vault", "synthetic", "AGE-SECRET-KEY"])
        expect(r.out + r.err).not.toContain(secret)

      // Same notes, previews and search on the target, read with the new key.
      const t = async (args: string[], stdin = "", key = newKey) => {
        const res = await jot(args, stdin, onTarget(key))
        if (res.code !== 0) throw new Error(`jot ${args[0]} failed: ${res.err}`)
        return res.out
      }
      const copied = JSON.parse(await t(["list", "-n", "1000", "--json"])) as Listed[]
      expect(copied).toEqual(source)
      expect(copied.some((n) => n.previews.length > 0)).toBe(true)
      const hits = JSON.parse(await t(["search", "--json", "title alpha"])) as Listed[]
      expect(hits.map((h) => h.text)).toEqual(["preview synthetic 1"])

      // Locked channels keep their passphrase; the shared name moved to the new key.
      const names = (key: string) =>
        t(["channels", "--json"], "", key).then(
          (o) => JSON.parse(o) as { id: string; name: string | null }[],
        )
      const before = await names(newKey)
      expect(before.find((c) => c.id === vault)!.name).toBe("Vault")
      expect(before.find((c) => c.id === legacy)!.name).toBeNull()
      expect(await t(["unlock", vault, "list", "-c", vault], PASS + "\n")).toContain(
        "synthetic locked thought",
      )
      // Unlocking the legacy channel once shares its name with the (new) open key.
      expect(await t(["unlock", legacy, "list", "-c", legacy], PASS + "\n")).toContain(
        "synthetic legacy note",
      )
      expect((await names(newKey)).find((c) => c.id === legacy)!.name).toBe("Synthetic legacy")

      // The old key reads nothing on the target: no open channel, no name.
      expect((await names(keyFile)).every((c) => c.name === null)).toBe(true)
      expect(await t(["list", "--json"], "", keyFile)).toBe("[]")

      // Import source hashes came along: importing the same file again adds nothing.
      expect(await t(["import", "--no-previews", join(dir, "a.jsonl")])).toBe(
        "imported 0, skipped 4 already present",
      )
    })

    it("refuses to migrate into an account that already has data", async () => {
      const r = await migrate()
      expect(r.code).toBe(1)
      expect(r.err).toContain("account_not_empty")
    })
  })
})
