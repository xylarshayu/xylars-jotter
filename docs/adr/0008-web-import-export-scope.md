# ADR-0008: Full import/export lives in the CLI; the PWA does JSONL only

Status: accepted (2026-11-12)

## Decision

- `jot import` handles the full JSONL format, including attachment paths, idempotent by
  `source_id` (stored as a SHA-256 hash). Import never creates channels; unknown channels fail
  the whole file before anything is written.
- `jot export <dir>` writes Markdown + JSONL for open channels, age files for locked channels,
  and each open channel's key encrypted to the open key, plus a README with recovery commands.
- The PWA imports JSONL lines without attachments (same validation) and exports open channels
  as JSONL. It points to the CLI for attachments and full export.

## Consequences

The browser never needs file-system access, and no export ever contains locked plaintext.
