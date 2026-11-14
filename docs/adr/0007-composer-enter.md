# ADR-0007: Enter sends on keyboards, inserts a newline on touch keyboards by default

Status: accepted (2026-11-12)

## Context

The brief says the composer sends on Enter and uses Shift+Enter for a newline. On Android
keyboards there is no Shift+Enter, so Enter-sends would make multi-line notes impossible.

## Decision

Setting **Enter sends**: `auto` (default), `on`, `off`.

- `auto`: Enter sends unless the primary pointer is coarse (a touchscreen phone), where Enter
  inserts a newline and the send button sends.
- Shift+Enter always inserts a newline; Ctrl/Cmd+Enter always sends. IME composition is never
  interrupted.

## Consequences

Laptops behave exactly as the brief says; the phone can still write multi-line notes. Choose
`on` in Settings for Telegram-style Enter-sends on the phone too.
