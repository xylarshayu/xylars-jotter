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
  `MAX_PREVIEW_IMAGE` (32 K characters, about 24 KB) is re-encoded with its short side scaled to
  256 px, then 160 px, then 96 px, as WebP, until it fits. If none fits, or it can't be decoded,
  the image is dropped and the title and description stay. An image that already fits is kept
  byte for byte. The steps live in `@jot/core` (`PREVIEW_IMAGE_STEPS`, `fitPreviewImage`). The
  web app encodes with a canvas, as JPEG on white where the browser can't encode WebP (Safari);
  the CLI uses sharp, loaded only when an image needs it. The Worker can't decode images, and the
  client is where the plaintext is.
- **`jot migrate` applies the same rule** to previews in open channels, which the migrating key
  can open. Locked channels' previews are copied as they are.
- **Pages are bounded by bytes, not only rows.** Sync and dump pages stop once about 192 KB of
  ciphertext is in (always at least one row). Measured on the deployment, reading blobs from D1
  and encoding them costs about 25 ms of CPU per MB: 1 MB pages took 20 to 60 ms. SQLite adds up the sizes from row headers, so only
  the rows sent are read in full. Restore requests from `jot migrate` are split the same way on
  the client (25 rows or about 96 KB).
- **Base64 uses the runtime's native codec** (`Uint8Array.fromBase64` and `toBase64` in workerd),
  and decoding is the validation: malformed input gets 422 `invalid_base64`. The shared `b64`
  schema no longer runs a regex. Oversized payloads are refused from their length before decoding.

## Consequences

Preview images are thumbnails: a large image can't be viewed at full size from the preview.
The linked page has it. Server limits (`MAX_PREVIEW_BYTES`) are unchanged, so an older client's
larger previews are still accepted.
