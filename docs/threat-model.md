# Threat model

What each party can and cannot learn or do. Crypto details: [ADR-0001](adr/0001-everything-is-an-age-file.md).

## Assets

- **Locked content**: note text, links, previews and attachments in locked channels. Must stay
  unreadable to the server, Cloudflare and every agent.
- **Channel names**, open and locked: readable with the open key, ciphertext to the server
  ([ADR-0014](adr/0014-locked-names-readable-with-open-key.md)).
- **Open content**: the same for open channels. Readable by the owner's devices and agents by design.
- **Open key**: an age hybrid identity that unwraps every open channel's key. Every set-up
  device holds it: pasted, or sent by pairing ([ADR-0016](adr/0016-device-pairing.md)).
- **Locked passphrases**: exist only in the owner's head. Each locked channel has its own.

## What the server stores

| Data                                                       | Form                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Note bodies, previews, attachments                         | age ciphertext (hybrid PQ recipients only, checked by the Worker)  |
| Channel names                                              | age ciphertext to the channel and the open key                     |
| Open channel keys                                          | age ciphertext to the open key                                     |
| Locked channel keys                                        | age passphrase files (scrypt, work factor 2^18)                    |
| Channel recipients (`age1pq1…`)                            | plaintext public keys, so anyone can append                        |
| Ids, timestamps, sizes, versions, sync sequence, lock kind | plaintext                                                          |
| Import `source_id`                                         | SHA-256 of `jot-source:v1:<source_id>` (unsalted, for idempotency) |
| Old note versions                                          | ciphertext, kept as soft history                                   |
| Pairings (5 minutes at most)                               | a one-time public key, then the open key sealed to it (age)        |
| Pairings and paired devices (ADR-0019)                     | browser family, OS, city, times; SHA-256 of secrets and tokens     |

The Worker never holds a decryption key and logs no request bodies or URLs (observability is
off).

## Actors

### The server (Worker, D1, R2) or anyone with a copy of its data

Can learn:

- How many channels and notes exist, which channels are locked, note and attachment sizes,
  when notes were created, edited, moved and deleted, and which notes are in which channel.
- That two imported notes share a source if the source ids are guessable (e.g. message
  numbers), via the unsalted hash.
- URLs sent to `/api/unfurl` while they are fetched. The web app and the CLI (`add`, `import`,
  `previews`) ask for previews automatically in open channels only. In locked channels they do so
  only on an explicit request: tapping "Fetch preview", or `--preview`/`--locked` under
  `jot unlock`. The Worker doesn't store or log them.

- When a device pairs: a pairing's timing and its one-time public key. For each paired device,
  its browser family, OS, city (from Cloudflare's geolocation) and when it was last used. It
  sees these on every request anyway. A pairing in progress also holds a hash of the IP address
  it came from, for at most 5 minutes.
- With a copy of the database, not a live server: nothing that lets it sign in. Device session
  tokens and pairing secrets are stored only as SHA-256 hashes of 256-bit random values.

Cannot learn: any note text, link, preview, attachment content or channel name, open or locked,
or the open key relayed during pairing. It's sealed to a key that never leaves the new device's
memory. If the relay swaps in its own key, the sending device sees the hash in the QR mismatch
and refuses.

Can do: delete or withhold data, serve old data, refuse writes. It can't forge readable notes in
a channel without that channel's key, but anyone can _append_ to any channel with its public
recipient. Notes are encrypted, not signed, so an appended note's author is unauthenticated
(see "Laptop agent").

### Cloudflare compromise (or a malicious Worker deploy)

Everything above, and in addition:

- **It can serve modified web app code.** Modified code could capture the open key, a locked
  passphrase the next time it is typed, and anything decrypted in the browser. This is the
  basic limit of any end-to-end encrypted web app. The service worker caches the app shell,
  but it updates from the server, so it is no defence against this.
- It can bypass or reconfigure Access, mint device sessions, and read the ciphertext.

Not affected: the CLI and the Go age recovery path don't run code served by the Worker. If
Cloudflare is suspected, unlock locked channels only from the CLI or with `age` on a trusted
machine until a clean deploy is confirmed.

### A laptop agent with shell (with the open key and Access service token)

Can:

- Read and write every open channel (by design), and read the mirror (`notesDir`).
- Read every channel's name, locked ones included (ADR-0014), and rename them.
- Append to locked channels, and soft-delete, move or overwrite notes (the server keeps prior
  versions as ciphertext). It can make a locked channel unusable, for example by replacing its
  wrapped key with garbage. These are integrity and availability attacks, not confidentiality.
- Approve a pairing, giving another device a session. Its service token already gives it the
  same access.
- Read a locked channel **only** if given that channel's passphrase for a session
  (`jot unlock`). It must not persist it; the CLI keeps it in memory for a single command and
  never writes locked plaintext to disk (mirror and export refuse to run under `unlock`).

Cannot, without the passphrase: read any locked note, preview or attachment.
The locked mirror (`lockedNotesDir`) holds only age files.

Out of scope: an agent that can control the same browser or keyboard where the owner types
a passphrase (keylogging, screen capture, reading browser memory). Don't type locked passphrases on
a machine where an agent has that kind of access unless you accept it.

### A stolen phone

If the screen lock holds, the thief gets the device's encrypted storage protections and
nothing more.

If the phone is unlocked or its storage is extracted:

- The open key is in IndexedDB (stored as the brief requires: "entered once, kept in
  IndexedDB"), along with the ciphertext replica and the decrypted open-channel cache. All open
  content and every channel name are exposed.
- Locked content needs the passphrase. If a locked channel was unlocked when the phone was
  taken, it stays readable until auto-lock: 5 minutes idle by default, or 30 seconds after the
  app is hidden (configurable, including immediately). Locked plaintext is never written to
  IndexedDB, Cache Storage or localStorage (checked by tests).
- The wrapped locked keys allow an offline guessing attack at scrypt 2^18 per guess. A long,
  unique passphrase (e.g. 5+ random words) makes this infeasible; the app enforces only 8
  characters minimum.

Response:

1. Revoke the phone's Access sessions in Cloudflare Zero Trust. If it was a device paired by QR
   rather than signed in through Access, sign it out in Settings → Devices instead. If it is
   still online it then deletes its own copy and key, but count on it having been copied.
2. Treat open content as exposed. To rotate the open key, migrate to a fresh deployment with a
   new key (`jot migrate`, [ADR-0015](adr/0015-store-copy-and-open-key-rotation.md)). That
   re-wraps channel keys but doesn't re-key them, so for a stolen key also move the open notes
   into new open channels (which re-encrypts them), then delete the old channels.
3. Change locked passphrases (Channel options → Change passphrase). Note that this re-wraps the
   same channel key, so it does not protect against someone who already extracted that key.

### A borrowed laptop, or any paired device

Pairing ([ADR-0016](adr/0016-device-pairing.md), [ADR-0019](adr/0019-device-sessions.md)) signs
the new device in with a device session and sends it the open key. Once there:

- A normal device keeps both in IndexedDB, exactly like the phone (see "A stolen phone").
- A **temporary device** keeps them in memory only. Nothing is written to IndexedDB. The service
  worker and the HTTP cache don't keep attachment ciphertext. The tab forgets everything, and
  ends its session, on close, reload, or after the auto-lock idle time. The Worker also ends a
  temporary session after 1 hour unused or 12 hours in all. While the tab is open, the key and
  the decrypted open notes are in memory. Anyone using that laptop meanwhile, or malware on it,
  can read them.
- No Access session is created on that browser, so there is nothing to sign out of in Access.
  (If the owner did sign in through Access there, "Forget and sign out" also ends that.)
- **Signing a device out** (Settings → Devices) stops it reaching the server at once, and an
  online device then deletes its local copy and key. It can't take back the open key or notes
  already synced. Every device with the open key can read every open channel from a copy of the
  ciphertext, so for a device you don't trust, re-key the open channels as well (new channel
  identities, notes re-encrypted). That isn't built yet; until then, use the temporary option on
  machines you don't control.

The six-digit code on both screens protects against scanning the wrong QR, such as one on another
screen nearby.

### Someone on the internet, not signed in

`/device-api/*` is outside Access (ADR-0019). Without a session, a stranger can only start, claim
or cancel pairings:

- **QR login phishing (QRLjacking).** They start a pairing on their own machine and get the
  owner to scan or open it ("scan to verify your account"). If the owner approves, they get the
  open key and a device session: every open channel. The six-digit code doesn't help, since
  they see it too. Defences: the approval screen says what the device is, roughly where it is
  (Cloudflare's city for its IP; a VPN can fake this) and whether it is temporary, and warns in
  plain words to approve only a device in front of you that you just started pairing. Browser
  and OS come from a fixed list, so the attacker can't put their own text on that screen.
  Rejecting deletes the pairing. Never approve a code someone sent you.
- **Claiming someone else's pairing** needs its secret, which only the device that started it
  holds (it is not in the QR). Wrong secrets, unknown ids and expired pairings get the same answer.
- **Filling storage:** at most 3 pairings in progress per IP (per /64 for IPv6) and 100 in total,
  each a few kilobytes and gone after 5 minutes.
- **Denial of service:** they can spend the Worker's free daily request quota, or keep the
  pairing caps full so the owner can't pair for a while (signing in through Access and pasting
  the key still works). A WAF rate-limiting rule on `/device-api/` (DEPLOY.md) blunts both.
- **Guessing a session token:** 256 random bits.

### A network attacker

Sees TLS traffic to Cloudflare only. Access stops unauthenticated requests to `/api` before they
reach the Worker, and the Worker verifies the Access JWT again. `/device-api` requests need a
device session, checked by the Worker.

### A future quantum computer

Content is encrypted to hybrid ML-KEM-768 + X25519 recipients, so harvested ciphertext stays
protected unless both are broken. Passphrase-wrapped keys use scrypt and ChaCha20-Poly1305
(symmetric). age's file key is 128 bits (see ADR-0001).

## Known limitations (v1)

- Web app code is trusted on each load (see "Cloudflare compromise").
- No in-place open-key rotation; `jot migrate` to a fresh deployment re-wraps (not re-keys) open
  channels.
- Signing a paired device out ends its server access but can't take back the open key it already
  has: it can still read any open-channel ciphertext it obtained until those channels are re-keyed
  ([ADR-0016](adr/0016-device-pairing.md), [ADR-0019](adr/0019-device-sessions.md)).
- Pairing can be phished (see "Someone on the internet"): the owner's attention at the approval
  screen is the defence.
- Appended notes are not authenticated: anyone signed in can append to any channel.
- Moving a note into a locked channel does not delete its old attachment blobs in R2; they stay
  encrypted to the open channel they came from.
- Metadata (counts, sizes, timing, channel membership) is visible to the server.
- Drafts in the composer stay in memory until sent or the tab closes, including drafts aimed
  at a locked channel. They are never stored.
- A web share is held in service-worker memory until the app picks it up
  ([ADR-0011](adr/0011-share-target-in-memory.md)).
