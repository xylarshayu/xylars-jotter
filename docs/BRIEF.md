# Design brief

Agreed with the owner on 2026-11-12. This is the build contract for v1. Where it is silent, choose the
simplest option that keeps the security invariants, and note the choice in an ADR.

## What we are building

A personal, end-to-end encrypted jotting app that replaces "Telegram channels with one member"
as its owner's notes system. Fast capture from an Android phone (Chrome) and any laptop
browser; channels; link previews; search; copy; images and files. The owner's AI agents can read and write the
open channels through an API, a CLI and a plaintext mirror on disk. Locked
channels are passphrase-protected and must stay unreadable to every agent and to the server.

Single user for v1. Keep a `user_id` on every server row and keys per user so multi-user is not a
rewrite later. Do not build sign-up, billing, quotas or admin.

## Security invariants (non-negotiable)

1. **The server only ever stores ciphertext** for note bodies, channel names, link previews and
   attachments. Plaintext metadata is limited to ids, timestamps, sizes and a channel's lock kind.
2. **A private-locked channel's passphrase exists only in the owner's head.** It is never stored on
   any disk, keychain, env var, log, config file or server. It is typed into the web app and the
   derived key lives in memory only, cleared on auto-lock (default 5 min idle) and on tab hide
   after a grace period.
3. **Agents never see locked plaintext.** No test, fixture, log, error message or CLI output may
   contain real note content. Development and tests use synthetic data only.
4. **Fail closed.** Anything whose classification is uncertain ends up locked, never open.
5. **Post-quantum.** Asymmetric encryption uses the hybrid ML-KEM-768 + X25519 age recipients
   (`age1pq1…`). Symmetric parts are 256-bit. No classic-only public-key encryption of content.
6. Each locked channel has its own passphrase. Nothing reuses one.

## Crypto design: everything is an age file

Use [age](https://age-encryption.org) via `age-encryption` (typage) in browser, Worker-free
client code and CLI. Verify hybrid PQ support in the pinned version (`generateHybridIdentity`).
Every note, preview and attachment is an age ciphertext. Interop is a feature: if this app
dies, `age -d -i identity.txt` recovers everything.

- **Each channel has one hybrid age identity.** Its recipient (public) is stored on the server in
  plaintext, so any client can **append to any channel without unlocking**, including locked ones.
- **Open channels:** identities are wrapped by the account's *open key*. Devices and agents hold
  the open key (laptops: in a key file, backed up in a password manager; phone/browser: entered once, kept in
  IndexedDB).
- **Locked channels:** identity wrapped with an age scrypt (passphrase) recipient. Unlocking
  decrypts it into memory only.
- **Shared-locked channels** are the same mechanism; the only difference is that the owner may give
  an agent the passphrase. Agents must treat such passphrases as session-only and never persist them.
- Edits create a new ciphertext version; keep the previous version (soft history).
- Write ADR-0001 for this scheme and a `docs/threat-model.md` that lists what the server, a
  laptop agent with shell, a stolen phone and a Cloudflare compromise can and cannot learn.

## Architecture

- **Worker** (Cloudflare Workers, Hono): REST API, sync cursor, D1 for rows (ciphertext inline
  when small), R2 for attachments, static PWA assets. Auth: Cloudflare Access in front of
  the API; the CLI uses an Access service token. No custom password auth in v1. (Amended
  2026-11-14, [ADR-0019](adr/0019-device-sessions.md): the static app is public, and a browser
  paired by QR gets a Worker-issued device session, approved by an already signed-in device,
  listed and revocable in the app.)
- **`/unfurl`** endpoint fetches OpenGraph/Twitter-card metadata for a URL and returns it to the
  client, which encrypts and stores it with the note. SSRF guard: http(s) only, no private or
  link-local IPs, size and time limits, no stored log of URLs. Never unfurl in locked channels
  unless the user taps "fetch preview".
- **Web app (PWA):** local-first. IndexedDB copy of decrypted-open data, outbox for offline
  writes, sync by cursor. Search is client-side over decrypted text **including link preview
  title/description/site**. Locked channels are searchable only while unlocked, and their
  plaintext never goes to IndexedDB.
- **CLI `jot`** (Node/TS, same packages): `add`, `list`, `search`, `read`, `channels`, `export`,
  `import`, `mirror`, `unlock` (passphrase from stdin, never argv). JSON output mode for agents.
- **Mirror:** `jot mirror` (launchd on the owner's laptop, every few minutes) writes open
  channels to `<notesDir>/<channel>/<yyyy>/<mm>/<id>.md` with front matter (id, created, updated,
  links, preview titles) and locked channels as `.age` files to `<lockedNotesDir>`.
  One-way, cloud → disk.

## v1 features

Feed per channel and an "all open" feed; composer that sends on Enter (Shift+Enter newline);
channels with lock kind open / locked; move a note between channels (re-encrypt); link previews;
attachments of any type, up to 95 MB each, with images and GIFs inline (amended 2026-11-14,
ADR-0017); edit/delete with history; one-tap copy; search; Android share target (Web
Share Target API) and installable PWA; offline outbox; lock/unlock with auto-lock; light/dark
theme that follows the system by default with a manual toggle; bulk import (JSONL) and full
export (Markdown + age files + JSONL).

**Import format (JSONL), one note per line:**
`{ "channel": "…", "created_at": "ISO-8601", "text": "…", "links": ["…"], "attachments": [{"path": "…", "mime": "…"}], "source_id": "…" }`.
Import is idempotent by `source_id`.

**Not v1:** the Telegram converter and sorter (separate later task, under `tools/`), local-model
classification, multi-user, sharing, collaborative editing, a native app.

## Build order

1. Crypto package with test vectors and an interop test against the `age` CLI (encrypt in TS,
   decrypt with Go age v1.3+, and the reverse).
2. Worker API + D1 schema + sync + CLI (`add`, `list`, `search`, `read`, `import`, `export`,
   `mirror`) with open channels. Agents can use it from here.
3. Locked channels, unlock/auto-lock, append-without-unlock.
4. PWA: feed, composer, search, copy, previews, images and files, share target, offline, theming.
5. Docs: README quickstart, deploy guide, threat model, ADRs.

Everything must run and be tested locally (`wrangler dev` / Miniflare) without a Cloudflare login.

## Engineering practice

Simple, strong, capable; no over-engineering.

- **pnpm workspaces + Nx** (light: `nx.json`, inferred targets, caching, `nx affected` in CI; no
  custom generators or plugins). Layout: `apps/worker`, `apps/web`, `apps/cli`,
  `packages/crypto`, `packages/core` (types, schemas, sync protocol). Nx is chosen deliberately;
  keep it minimal.
- TypeScript strict everywhere. Vitest; `@cloudflare/vitest-pool-workers` for the Worker;
  Playwright for a few end-to-end flows (capture, search, lock/unlock, offline send).
- ESLint + Prettier. GitHub Actions: `nx affected -t lint typecheck test build` and the age
  interop test.
- Audited, small crypto dependencies only (typage, `@noble/*`). No homemade primitives.
- Strict CSP, no third-party scripts or analytics, no telemetry.
- `SECURITY.md`, `docs/threat-model.md`, `docs/adr/` (short ADRs for real decisions).
- Small, reviewable commits with clear messages. No AI attribution lines.

## UI

Minimal, clean, elegant, very usable; Telegram-level speed for jotting. Svelte 5 + Vite SPA (no
SvelteKit). Use the `impeccable` design skill (`npx skills add pbakaus/impeccable`) or
Anthropic's `frontend-design` as guidance, but usability beats flourish: big tap targets, the
composer always reachable, instant feedback, no modal clutter. System-respecting light/dark with
a toggle.

## Deployment

Each owner deploys their own copy to their own Cloudflare account ([DEPLOY.md](../DEPLOY.md),
`pnpm provision`; amended 2026-11-14). No Deploy-to-Cloudflare button: setup includes Access,
which the owner must configure deliberately. Never use the Cloudflare Global API Key for deploys.
