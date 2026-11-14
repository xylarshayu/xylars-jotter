# ADR-0020: Small preview images, byte-bounded pages and native base64

Status: accepted (2026-11-14)

## Context

The deployment runs on the Workers free plan, where a request gets 10 ms of CPU. Copying a real
store to it (ADR-0015) failed with `exceededCpu` on single rows. Note bodies were small (the
largest a few KB). Link previews were not: the Worker unfurls an image of up to 256 KB and returns
it as a data URL, which the client seals into the preview. Hundreds of previews were over 64 KB
and the largest about 450 KB. In the feed, the image is a 72 px thumbnail.

Every byte of ciphertext is base64 in JSON, so its cost is paid on each write, sync page and dump
page. The Worker decoded and encoded it with JavaScript loops, and the shared schemas ran a regex
over every byte.

## Decision

- **Clients shrink large preview images before sealing.** An image whose data URL is over
  `MAX_PREVIEW_IMAGE` (12 K characters, about 9 KB) is re-encoded with its short side scaled to
  256 px, then 160 px, then 96 px, as WebP, until it fits. If none fits, or it can't be decoded,
  the image is dropped and the title and description stay. An image that already fits is kept
  byte for byte. The steps live in `@jot/core` (`PREVIEW_IMAGE_STEPS`, `fitPreviewImage`). The
  web app encodes with a canvas, as JPEG on white where the browser can't encode WebP (Safari);
  the CLI uses sharp, loaded only when an image needs it. The Worker can't decode images, and the
  client is where the plaintext is.
- **`jot migrate` applies the same rule** to previews in open channels, which the migrating key
  can open. Locked channels' previews are copied as they are. `jot previews --shrink` applies it
  to previews already stored, through the normal API, and fetches nothing.
- **Ciphertext is read from D1 as hex text** (`hex(col)`), converted with the native
  `Uint8Array.fromHex` and `toBase64`. D1 hands blobs to the Worker at about 25 ms of CPU per MB
  (measured on the deployment: 1 MB sync pages took 20 to 60 ms); as text, a 250 KB page takes
  2 to 5 ms.
- **Pages are bounded by bytes, not only rows.** Sync and dump pages stop once about 192 KB of
  ciphertext is in (always at least one row). SQLite adds up the sizes from row headers, so only
  the rows sent are read in full. Restore requests from `jot migrate` are split the same way on
  the client (25 rows or about 96 KB).
- **Base64 uses the runtime's native codec** (`Uint8Array.fromBase64` and `toBase64` in workerd),
  and decoding is the validation: malformed input gets 422 `invalid_base64`. The shared `b64`
  schema no longer runs a regex. Oversized payloads are refused from their length before decoding.

## Measured

Per-request CPU from `wrangler tail --format json` (`cpuTime`), on the deployment:

- Before: copying the store failed with `exceededCpu` on single rows, and 1 MB sync pages took 20
  to 60 ms.
- After, a full first sync of the whole store: 58 pages, 15.9 MB, 42.5 s. CPU median 2 ms, p90
  4 ms, max 6 ms; no request over 10 ms and none failed.
- The first-sync progress count (`/api/sync?count=1`, asked once per sync) is a `count(*)` over
  the `(user_id, seq)` index, in the same D1 batch as the page.

New endpoints that move ciphertext follow the same rules: read it as hex, bound pages by bytes,
use the native codecs, and check `cpuTime` with `wrangler tail` against the real data.

## Consequences

Preview images are thumbnails: a large image can't be viewed at full size from the preview.
The linked page has it. Server limits (`MAX_PREVIEW_BYTES`) are unchanged, so an older client's
larger previews are still accepted.
