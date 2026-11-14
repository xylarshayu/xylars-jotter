import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { Command, CommanderError } from "commander"
import { ApiError, LockedError } from "@jot/core"
import { CryptoError } from "@jot/crypto"
import * as cmd from "./commands.ts"
import { CliError, Context, type Io, writePrivate } from "./context.ts"
import { migrate } from "./migrate.ts"
import { writeTree } from "./tree.ts"

const EXPORT_README = `# jot export

- notes.jsonl: open notes in the jot import format.
- open/<channel>/<yyyy>/<mm>/<id>.md: open notes as Markdown with front matter;
  attachments in <id>.files/.
- locked/<channel-id>/: locked channels, still encrypted (see locked/README.md).
- keys/<channel-id>.age: each open channel's age identity, encrypted to your
  open key. Recover with: age -d -i open-key.txt keys/<id>.age > channel.txt
`

/** Reads one line for a passphrase: hidden prompt on a TTY, else the first line of stdin. */
async function readPassphrase(io: Io, prompt: string): Promise<string> {
  let pass: string
  if (io.stdinIsTty) {
    const muted = new Writable({ write: (_c, _e, cb) => cb() })
    process.stderr.write(prompt)
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
    pass = await new Promise<string>((res) => rl.question("", (a) => (rl.close(), res(a))))
    process.stderr.write("\n")
  } else {
    // First line is the passphrase; the rest stays available (e.g. note text).
    const all = await io.readStdin()
    const nl = all.search(/\r?\n/)
    pass = nl === -1 ? all : all.slice(0, nl)
    const rest = nl === -1 ? "" : all.slice(nl).replace(/^\r?\n/, "")
    io.readStdin = async () => rest
  }
  if (!pass) throw new CliError("empty passphrase")
  return pass
}

async function readText(io: Io, words: string[]): Promise<string> {
  if (words.length && !(words.length === 1 && words[0] === "-")) return words.join(" ")
  if (io.stdinIsTty) throw new CliError("no text given")
  return (await io.readStdin()).replace(/\n$/, "")
}

interface Session {
  /** Channel to unlock for this one command (from `jot unlock`). */
  unlock?: { channel: string; passphrase: string }
}

function build(io: Io, session: Session, ctxs: Context[]): Command {
  const program = new Command("jot")
    .description(
      "End-to-end encrypted notes. Open channels are agent-readable; locked channels never are.",
    )
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .showHelpAfterError()

  const open = async (opts: { requireOpenKey?: boolean } = {}) => {
    const ctx = await Context.create(io, opts)
    ctxs.push(ctx)
    if (session.unlock) {
      const { channel, passphrase } = session.unlock
      session.unlock.passphrase = "" // drop it as soon as a key is unwrapped
      const row = await ctx.nb.findChannel(channel)
      if (row) {
        await ctx.nb.unlock(row.id, passphrase)
      } else {
        // A locked name not yet sealed to the open key (ADR-0014) can't be found above: try
        // the passphrase on each locked channel and keep only the one whose name matches.
        const opened = await ctx.nb.unlockAny(passphrase)
        const match = await ctx.nb.findChannel(channel)
        for (const id of opened) if (id !== match?.id) ctx.nb.keys.lock(id)
        if (!match || !opened.includes(match.id))
          throw new CliError("no such channel, or wrong passphrase")
      }
    }
    return ctx
  }

  program
    .command("keygen")
    .description("generate a new account open key (hybrid post-quantum age identity)")
    .option("-o, --output <file>", "write to a file (mode 600) instead of stdout")
    .action(async (o: { output?: string }) => cmd.keygen(io, o.output))

  const channels = program
    .command("channels")
    .description("list channels")
    .option("--json", "JSON output")
    .action(async (o: { json?: boolean }) => cmd.channels(await open(), o))
  channels
    .command("create <name>")
    .description("create a channel (locked: passphrase on stdin, never in argv)")
    .option("--locked", "passphrase-locked channel")
    .action(async (name: string, o: { locked?: boolean }) => {
      const passphrase = o.locked
        ? await readPassphrase(io, "New passphrase for this channel: ")
        : undefined
      await cmd.createChannel(await open({ requireOpenKey: !o.locked }), name, o, passphrase)
    })

  program
    .command("add [text...]")
    .description("add a note (text from args, or stdin)")
    .option("-c, --channel <channel>", "channel name or id")
    .option("--preview", "fetch link previews (always on for open channels)")
    .option("--no-preview", "skip link previews")
    .option("-f, --file <path...>", "attach files of any type (up to 95 MB each)")
    .option("--json", "JSON output")
    .action(
      async (
        words: string[],
        o: { channel?: string; preview?: boolean; json?: boolean; file?: string[] },
      ) => {
        // With files, the text is optional and stdin is left alone.
        const text = o.file?.length && !words.length ? "" : await readText(io, words)
        const ctx = await open({ requireOpenKey: false })
        await cmd.add(ctx, text, o)
      },
    )

  program
    .command("files <id>")
    .description("save a note's attachments to a directory (open channels only; never overwrites)")
    .option("-o, --out <dir>", "directory (default: current)")
    .option("--json", "JSON output")
    .action(async (id: string, o: { out?: string; json?: boolean }) =>
      cmd.files(await open(), id, o),
    )

  program
    .command("list")
    .description("list recent notes (all open channels by default)")
    .option("-c, --channel <channel>", "channel name or id")
    .option("-n, --limit <n>", "number of notes", "20")
    .option("--json", "JSON output")
    .action(async (o: { channel?: string; limit?: string; json?: boolean }) =>
      cmd.list(await open(), o),
    )

  program
    .command("search <query...>")
    .description("search readable notes, including link preview titles and descriptions")
    .option("-c, --channel <channel>", "channel name or id")
    .option("-n, --limit <n>", "max results", "50")
    .option("--json", "JSON output")
    .action(async (q: string[], o: { channel?: string; limit?: string; json?: boolean }) =>
      cmd.searchCmd(await open(), q.join(" "), o),
    )

  program
    .command("read <id>")
    .description("print one note")
    .option("--history", "include previous versions")
    .option("--json", "JSON output")
    .action(async (id: string, o: { json?: boolean; history?: boolean }) =>
      cmd.read(await open(), id, o),
    )

  program
    .command("show <id>")
    .description(
      "show a note with its images, drawn in the terminal (Ghostty, kitty, WezTerm, iTerm2)",
    )
    .action(async (id: string) => cmd.show(await open(), id))

  program
    .command("edit <id> [text...]")
    .description("replace a note's text (keeps the old version in history)")
    .action(async (id: string, words: string[]) =>
      cmd.edit(await open(), id, await readText(io, words)),
    )

  program
    .command("mv <id> <channel>")
    .description("move a note to another channel (re-encrypts it)")
    .action(async (id: string, channel: string) => cmd.move(await open(), id, channel))

  program
    .command("rm <id>")
    .description("delete a note (kept in history)")
    .action(async (id: string) => cmd.remove(await open(), id))

  program
    .command("import <file>")
    .description("import JSONL (idempotent by source_id; never creates channels)")
    .option("--dry-run", "validate only")
    .option("--previews", "fetch link previews for open channels (default)")
    .option("--no-previews", "skip link previews")
    .action(async (file: string, o: { dryRun?: boolean; previews?: boolean }) =>
      cmd.importJsonl(await open({ requireOpenKey: false }), file, o),
    )

  program
    .command("migrate")
    .description(
      "copy every channel, note, preview, version and attachment from another server into this " +
        "fresh one, as ciphertext, re-wrapping open channels to this config's (new) open key",
    )
    .requiredOption("--from <url>", "source server, e.g. http://127.0.0.1:8787")
    .requiredOption("--from-key-file <file>", "the source's (old) open key file")
    .option("--dry-run", "read and check everything, write nothing")
    .action(async (o: { from: string; fromKeyFile: string; dryRun?: boolean }) => migrate(io, o))

  program
    .command("previews")
    .description("fetch missing link previews (all open channels by default)")
    .option("-c, --channel <channel>", "one channel, by name or id")
    .option("--missing", "only notes with links but no previews (default)")
    .option("--refresh", "also re-fetch notes that already have previews")
    .option("--shrink", "shrink stored preview images that are too large; fetches nothing")
    .option("--locked", "allow a locked channel given with -c (needs `jot unlock`)")
    .option("-n, --limit <n>", "at most this many notes")
    .option("--json", "JSON output")
    .action(
      async (o: {
        channel?: string
        locked?: boolean
        refresh?: boolean
        shrink?: boolean
        limit?: string
        json?: boolean
      }) => cmd.previewsCmd(await open({ requireOpenKey: false }), o),
    )

  program
    .command("export <dir>")
    .description("full export: Markdown + JSONL for open channels, age files for locked ones")
    .action(async (dir: string) => {
      if (session.unlock)
        throw new CliError("export never writes locked plaintext; run it without unlock")
      const out = resolve(io.cwd, dir)
      if (existsSync(out) && readdirSync(out).length)
        throw new CliError("export directory must be empty")
      const ctx = await open()
      const r = await writeTree(ctx, {
        openDir: join(out, "open"),
        lockedDir: join(out, "locked"),
        manifest: false,
        jsonl: join(out, "notes.jsonl"),
      })
      for (const ch of ctx.nb.replica.channels.values()) {
        if (ch.deletedAt === null && ch.lock === "open")
          writePrivate(join(out, "keys", `${ch.id}.age`), Buffer.from(ch.wrappedKey, "base64"))
      }
      writePrivate(join(out, "README.md"), EXPORT_README)
      io.out(`exported ${r.openNotes} open and ${r.lockedNotes} locked notes to ${out}`)
    })

  program
    .command("mirror")
    .description("one-way mirror: open channels as Markdown, locked channels as age files")
    .option("--notes-dir <dir>", "open notes directory")
    .option("--locked-dir <dir>", "locked notes directory")
    .action(async (o: { notesDir?: string; lockedDir?: string }) => {
      if (session.unlock)
        throw new CliError("mirror never writes locked plaintext; run it without unlock")
      const ctx = await open()
      const r = await writeTree(ctx, {
        openDir: o.notesDir ? resolve(io.cwd, o.notesDir) : ctx.cfg.notesDir,
        lockedDir: o.lockedDir ? resolve(io.cwd, o.lockedDir) : ctx.cfg.lockedNotesDir,
        manifest: true,
      })
      io.out(
        `mirror: ${r.openNotes} open, ${r.lockedNotes} locked; ${r.written} written, ${r.removed} removed`,
      )
    })

  program
    .command("unlock <channel> <command...>")
    .description("run one command with a locked channel unlocked (passphrase on stdin, never argv)")
    .allowUnknownOption()
    .action(() => {
      /* handled in run() */
    })

  return program
}

export async function run(argv: string[], baseIo: Io): Promise<number> {
  // stdin can only be read once; buffer it.
  let stdin: Promise<string> | undefined
  const io: Io = { ...baseIo, readStdin: () => (stdin ??= baseIo.readStdin()) }
  const session: Session = {}
  const ctxs: Context[] = []
  let args = argv
  try {
    if (args[0] === "unlock") {
      const [, channel, ...rest] = args
      if (!channel || rest.length === 0)
        throw new CliError("usage: jot unlock <channel> <command...>")
      if (rest[0] === "unlock") throw new CliError("nested unlock")
      session.unlock = {
        channel,
        passphrase: await readPassphrase(io, `Passphrase for ${channel}: `),
      }
      args = rest
    }
    await build(io, session, ctxs).parseAsync(args, { from: "user" })
    for (const c of ctxs) c.save()
    return 0
  } catch (e) {
    for (const c of ctxs) {
      try {
        c.save()
      } catch {
        /* ignore */
      }
    }
    if (e instanceof CommanderError) return e.exitCode
    // Stack frames only: messages can contain input snippets (e.g. JSON parse errors).
    if (io.env.JOT_DEBUG === "1" && e instanceof Error)
      io.err(`${e.name}\n${(e.stack ?? "").split("\n").slice(1).join("\n")}`)
    io.err(`jot: ${explain(e)}`)
    return 1
  } finally {
    if (session.unlock) session.unlock.passphrase = ""
    for (const c of ctxs) c.nb.keys.clear()
  }
}

/** Error messages never include note content or passphrases. */
function explain(e: unknown): string {
  if (e instanceof CliError) return e.message
  if (e instanceof LockedError) return "channel is locked"
  if (e instanceof CryptoError) return "wrong passphrase or bad key"
  if (e instanceof ApiError) {
    if (e.status === 0) return "cannot reach the server"
    if (e.status === 401 || e.status === 403)
      return `not authorized (${e.code}); check CF_ACCESS_CLIENT_ID/SECRET`
    return `server rejected the request (${e.status} ${e.code})`
  }
  if (e instanceof Error && /^(unknown note|unknown channel)$/.test(e.message)) return e.message
  return "unexpected error"
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/jot") ||
  process.argv[1]?.endsWith("jot.mjs")
) {
  const io: Io = {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const c of process.stdin) chunks.push(c as Buffer)
      return Buffer.concat(chunks).toString("utf8")
    },
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns,
    env: process.env,
    cwd: process.cwd(),
  }
  process.exitCode = await run(process.argv.slice(2), io)
}
