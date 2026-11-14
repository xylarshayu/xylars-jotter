# ADR-0009: Worker tests use @cloudflare/vitest-plugin

Status: accepted (2026-11-12)

## Context

The brief names `@cloudflare/vitest-pool-workers`. In current releases that package is
deprecated in favour of `@cloudflare/vitest-plugin`, the same workerd-based runner packaged as
a Vitest plugin.

## Decision

Use `@cloudflare/vitest-plugin` 1.8.0 with the real `wrangler.jsonc` and D1 migrations
applied in test setup. End-to-end tests run `wrangler dev` (Miniflare).

## Consequences

Same intent as the brief (tests run in workerd, no Cloudflare login).
