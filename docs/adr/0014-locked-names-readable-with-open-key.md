# ADR-0014: Locked channel names are readable with the open key

Status: accepted (2026-11-14). Supersedes [ADR-0003](0003-locked-channel-names.md).

## Context

ADR-0003 hid locked channel names from everything without the passphrase, so devices and agents
showed `Locked · <id>`. In use, the owner wants to see which locked channel is which ("the channel
names can/should be public"). The middle ground accepted: names readable by the owner's devices
and agents, still ciphertext to the server.

## Decision

- Every channel name is one age file sealed to two recipients: the channel's own and the account
  open key. Anything with the open key reads every name; the server and Cloudflare still see
  ciphertext only. Note content in locked channels stays behind the passphrase.
- Renaming needs only public keys. With the open key, a locked channel can be renamed while
  locked.
- Names sealed before this change (channel recipient only) are shared on the next unlock: after a
  successful unlock, the client re-seals the name to both recipients. Until then it shows
  `Locked · <id>` with a hint. The owner does this by typing the passphrase in the app, or by
  renaming the channel. No passphrase passes through an agent for it.
- `jot unlock <name>` finds the channel by name directly; it still falls back to trying the
  passphrase on each locked channel for names not shared yet.
- The name size limit is 8 KB (two hybrid stanzas are about 3.3 KB).

## Consequences

Anyone with the open key (agents on the owner's laptop, the phone's IndexedDB) learns locked channel names.
That's a deliberate trade. Names are kept short and descriptive, not secret. Open-key rotation
must also re-seal names ([ADR-0015](0015-store-copy-and-open-key-rotation.md)).
