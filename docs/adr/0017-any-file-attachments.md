# ADR-0017: Attachments of any type, up to 95 MB, streamed through the Worker

Status: accepted (2026-11-14)

## Context

v1 handled image attachments. The owner wants any file (PDFs, archives, audio, documents) and GIFs
that animate in the feed. Workers accept request bodies up to 100 MB on the Free and Pro plans and
have 128 MB of memory, so a large upload can't be buffered in the Worker.

## Decision

- **Any type.** The composer, drag and drop (anywhere in the window), the Android share target
  (`*/*`) and `jot add -f` take any file. The file's name and type travel inside the encrypted
  note body, as before; the server still sees only the size.
- **Cap.** One attachment is one request. The ciphertext may be at most 95 MiB
  (`MAX_ATTACHMENT_BYTES`), leaving room under the 100 MB body limit. The plaintext cap is 256 KiB
  less, which covers age's per-chunk overhead (16 bytes per 64 KiB) and header. Clients refuse a
  larger file before encrypting it. Chunked or multipart uploads are not built; they can come
  later if the cap proves too small.
- **Streaming.** The Worker requires `Content-Length`, reads the first 16 KiB to check it is a
  hybrid-PQ age file (ADR-0004), then pipes the head and the rest through a `FixedLengthStream`
  into R2. A body shorter or longer than declared fails the put.
- **Outbox.** Pending uploads are stored as bytes, not base64, so a 90 MB file costs 90 MB of
  IndexedDB, not 120 MB. Older base64 entries are still read.
- **Display.** Images up to 25 MB show inline; GIFs are kept byte for byte (never re-encoded or
  resized), so they animate, with their size read from the header. SVGs, larger images and every
  other type show as a chip with the name and size; tapping it decrypts and downloads the file,
  always as `application/octet-stream` so nothing renders in the app's origin. The service worker
  keeps attachments up to 25 MB for offline use; larger ones are fetched each time.
- **CLI.** `jot add -f <path...>` attaches files (text becomes optional). `jot files <note-id>
[-o dir]` saves a note's attachments with mode 600, never overwriting (it adds " (2)"). Like
  `mirror` and `export`, it refuses locked channels: the CLI never writes locked plaintext to disk.

## Consequences

- R2 storage grows faster; a single upload can take a while on a slow connection, and a failed
  one is retried whole from the outbox.
- Downloading a file from a locked channel in the browser writes its plaintext wherever the
  browser saves downloads. That is the user's explicit action, as before for non-image files.
- The 95 MB cap is below what paid Workers plans accept; raising it means changing one constant
  and accepting more memory pressure on the client, which encrypts in memory.
