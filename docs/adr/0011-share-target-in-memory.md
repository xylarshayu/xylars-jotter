# ADR-0011: Shared content stays in service-worker memory

Status: accepted (2026-11-12)

## Decision

The Web Share Target posts to `/share`. The service worker answers it, keeps the shared text,
URL and images in memory only, and redirects to `/?share`. The app collects them over a
MessageChannel into the composer draft. Nothing is written to IndexedDB, Cache Storage or the
server until the user sends (and then only as ciphertext).

## Consequences

If the browser kills the service worker before the app opens, the share is lost; the user
shares again. A share target only exists for the installed PWA, which always has the service
worker.
