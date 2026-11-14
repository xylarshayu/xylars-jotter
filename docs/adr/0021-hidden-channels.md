# ADR-0021: Hidden channels are a per-device view setting

Status: accepted (2026-11-14)

## Context

The owner shows the app to other people and wants some channels out of sight while doing so,
without touching their notes. Locked channels already protect content; this is about what the
screen lists, not about who can read what.

## Decision

- Hiding is a device preference, like the theme: a list of channel ids in `localStorage`. Ids are
  random and already in the replica, so no name or content is stored. Nothing goes to the server,
  and the channel, its notes and agents' access are unchanged.
- A hidden channel is left out of the sidebar, "All notes", search results and the channel
  pickers (composer and Move). Opening its address directly still works.
- An eye button at the foot of the sidebar shows them until the app goes to the background or
  reloads. It is always there and shows no count, so it gives away neither whether nor how many
  channels are hidden. Hiding a channel takes effect at once, even while they are shown.
- Hide and Unhide are in the channel's options and in its menu (right click or long press).

## Consequences

- It is a convenience, not a security boundary: anyone holding the unlocked device can show hidden
  channels. Content that must stay private belongs in a locked channel.
- Each device keeps its own list. Syncing it would need an encrypted settings record on the
  server; that can come later if hiding on one device should hide everywhere.
- Forgetting a device clears the list with the rest of `localStorage`.
