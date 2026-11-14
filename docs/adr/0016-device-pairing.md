# ADR-0016: Pair a new device by QR; temporary devices keep the key in memory

Status: accepted (2026-11-14). Amended by [ADR-0019](0019-device-sessions.md): pairing now
starts without signing in, and the approval also signs the new device in. The endpoints below are
the original ones.

## Context

Setting up a browser meant pasting the open key. On a laptop that means getting a random
`AGE-SECRET-KEY-PQ-1…` string from a vault or another device, which is slow and puts the key on a
clipboard. Borrowed laptops need a way to read notes without leaving the key behind. The open key
stays random; nothing here derives it from something typed.

## Decision

**Pairing.** It works like WhatsApp Web:

1. The new device (already signed in through Access) makes a one-time hybrid age key pair and
   registers the public half: `POST /api/pairings`. It shows a QR of
   `https://<host>/#/pair/<id>.<hash>`, where `hash` is SHA-256 of the one-time public key, and a
   six-digit code derived from the id and that key.
2. A device that has the open key scans it, in the app (Settings → Pair a device, using
   `BarcodeDetector`) or with the camera app, which opens the link. It fetches the pairing
   (`GET /api/pairings/:id`) and refuses unless the returned public key matches the QR's hash.
   It shows the code, and the user checks it against the new device's screen.
3. On confirmation it seals the open key to the one-time key (hybrid PQ age, invariant 5) and
   uploads that (`PUT /api/pairings/:id/key`). The Worker accepts only an age file with exactly one
   `mlkem768x25519` stanza, and only once.
4. The new device polls `GET /api/pairings/:id/key` every 2 seconds. The Worker returns the file
   and deletes the row in one statement. The new device decrypts the file, checks the key opens the
   account, and drops the one-time identity.

The QR carries a hash rather than the key itself (about 2,000 characters) to keep it small. The
hash still lets the scanning device detect a relay that swaps in its own key. The code only
catches a QR that isn't the one on the user's screen. That needs someone else signed in as the
owner, because pairings are per user and Access guards every endpoint.

The relay is a D1 table, `pairings`, outside sync, dump/restore and the change counter. Rows
expire after 5 minutes and are swept on each pairing request. A user can have at most 5 open
pairings. Nothing is logged.

**Temporary device.** The setup screen has a "Temporary device" option, for pairing or pasting a
key. With it, the key, the replica and the outbox live in memory only. The app deletes this
browser's (still empty) IndexedDB database. It skips localStorage writes beyond display settings,
and attachment fetches carry `x-jot-no-store`, so neither the service worker nor the HTTP cache
keeps their ciphertext. A reload or closed tab loses everything. So does the auto-lock idle time
(default 5 minutes, hidden or not). Settings offers "Forget now" and "Forget and sign out", which
also ends the Access session (`/cdn-cgi/access/logout`). Notes not yet uploaded are lost with it.

**Fallback.** Keep the open key in a password manager and paste it. That still works.

`Permissions-Policy` now allows `camera=(self)` for the in-app scanner.

## Consequences

- Any device with the open key reads every open channel and every channel name. Pairing makes
  adding devices easier, not safer. There is no per-device key to revoke. Taking access back means
  re-keying the open channels: new channel identities, with the open notes re-encrypted into them.
  Rotating the open key (`jot migrate`, ADR-0015) only re-wraps, and a device that has synced
  already holds the wrapped channel keys. Neither re-keying nor in-place rotation is built.
- A server or Cloudflare compromise can't read the relayed key (it's sealed to a key it never
  sees). But it could serve app code that does, as with any web code (see the threat model).
- D1 point-in-time recovery may keep a sealed key for its retention window. That copy is useless
  once the one-time identity is gone, which happens when the tab moves on.
- A temporary device still has a signed-in Access session until it signs out or the session
  expires. Before the forget runs, the key is in that tab's memory like on any device.
- Locked channels are unaffected: their passphrases are never paired or sent.
