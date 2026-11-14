# ADR-0019: Pairing signs the new device in (device sessions)

Status: accepted (2026-11-14). Amends [ADR-0010](0010-auth-config.md) and
[ADR-0016](0016-device-pairing.md).

## Context

With ADR-0016, a new browser had to sign in through Cloudflare Access before it could even show a
pairing code. On a laptop that isn't the owner's, that means typing their email and a code, or
signing in to their Google account, on someone else's machine. That is the friction pairing was
meant to remove. The owner asked for a true one-scan login: the phone's approval also signs the
laptop in.

## Decision

**Access covers `/api/*` only.** The app shell (open-source static files) is public. The Access
application's path is `api`. The owner's browsers and the CLI's service token keep using `/api`
through Access, unchanged.

**Device sessions at `/device-api/*`.** This prefix is outside Access. The Worker serves the same
routes there as at `/api`, behind its own check: `Authorization: Bearer jotd_…`, a 256-bit random
token whose SHA-256 is in the `devices` table. Dump and restore stay Access-only. No cookies, so no
CSRF. A session slides forward on use: 30 days unused for a normal device. A temporary device's
session ends after 1 hour unused or 12 hours in all, and its tab keeps the token in memory only,
so closing the tab ends it (the app also tells the Worker on `pagehide`). Errors are
`unauthenticated`, `session_expired` and `session_revoked`.

**Pairing, one flow for every new browser:**

1. The new device, signed in to nothing, makes a one-time hybrid key pair and calls
   `POST /device-api/pairings {recipient, temporary}`. It gets an id and a secret. The secret
   stays in its memory; the QR carries only the id and the key's hash, as before.
2. A signed-in device (Access, or a non-temporary device session) scans it,
   `GET /pairings/:id`, checks the hash, and shows the six-digit code, the browser and OS, the city
   Cloudflare places the request in, and whether it is temporary. The browser and OS come from a
   fixed list on the Worker, so the caller can't put words on the approval screen.
3. On approval it seals the open key to the one-time key: `POST /pairings/:id/approve {key}`.
   Temporary sessions can't approve.
4. The new device polls `POST /device-api/pairings/:id/claim {secret}`. Once approved, one D1
   transaction creates its session and deletes the pairing, and it gets the sealed key and the
   token, once. An unknown id, a wrong secret and an expired pairing all get the same 404.

**The public endpoint is bounded.** Pairings last 5 minutes and are swept on each start. At most 3
are in progress per IP address (per /64 for IPv6) and 100 in total, checked in the same statement
as the insert. A row is a few kilobytes, so D1 can't be filled through it. A rejected start writes
nothing. The public routes take JSON only (415 otherwise), which another site can't send
cross-origin without a CORS preflight the Worker never grants, so a web page can't start pairings
from its visitors' browsers.

**Devices.** Settings → Devices lists paired devices, with their browser, city and last use, and
signs any of them out (`DELETE /devices/:id`). Temporary sessions may only sign themselves out. A
device that learns it was signed out (`session_revoked`) deletes its key, replica and outbox. One
whose session expired keeps its data and offers "Pair again". Access sessions and the CLI aren't
listed; they are ended in Zero Trust.

**Dev mode.** `AUTH_MODE=dev` (localhost only) treats a request with the cookie
`jot_dev_signed_out` as not signed in to Access, so the e2e tests can pair a signed-out browser.

## Consequences

- **QR login phishing ("QRLjacking") is now possible.** Before, the new device had to pass Access
  as the owner. Now anyone can start a pairing and send the owner its link or QR ("scan to verify
  your account"). If the owner approves, that person gets the open key and a session. The six-digit
  code doesn't help, because the attacker sees it too. The defences are the approval screen
  (where the device is, what it is, and a plain warning) and the owner's attention. This is the
  same trade WhatsApp Web and Discord make.
- Signing a device out stops it reaching the server. It can't take back the open key already
  sent, or notes already synced: that still needs re-keying the open channels (ADR-0016).
- The Worker now issues sessions, which ADR-0010 avoided. They are only bearer tokens checked by
  hash, created only by an approval from a signed-in session, and listed and revocable in the app.
- Anyone can reach `/device-api/pairings` without signing in. They can use up the Worker's free
  request quota, or keep the pairing caps full to block pairing for a while. The fallback is
  signing in through Access and pasting the key. DEPLOY.md suggests a WAF rate-limiting rule.
- `devices` rows hold coarse metadata the Worker sees anyway (browser family, OS, city, times).
- Access is no longer in front of the static files; they hold no data.
