# Agent instructions

This repository is an end-to-end encrypted notes app. Its users' agents read open channels by
design and must never read locked ones. These rules hold whether you are changing the code or
deploying it for someone.

## Always

- Never attempt to read, decrypt, guess or brute-force locked-channel content or passphrases.
  Never persist a passphrase you are given. If someone hands you one for a session, it stays in
  that session: not in files, env vars, configs, logs or shell history.
- Never print, paste or log an open key, a service token secret or any passphrase.
- Use synthetic data only in tests, fixtures, logs, error messages and demos. Never real notes.
- Never use the Cloudflare Global API Key. Never deploy, or change a Cloudflare account, unless
  the person you work for has asked you to.

## Deploying for someone

Follow [DEPLOY.md](DEPLOY.md). `pnpm provision` does the Cloudflare side and is safe to re-run.
The person does the login, the Access settings and keeps the keys.

## Changing the code

- Read [docs/BRIEF.md](docs/BRIEF.md) first: it is the design contract, with the security
  invariants. Then [docs/threat-model.md](docs/threat-model.md) and the ADRs in `docs/adr/`.
- Keep it simple: the smallest design that satisfies the brief's invariants. Record real
  decisions as short ADRs in `docs/adr/`. Ask before changing an invariant.
- Run `pnpm nx affected -t lint typecheck test build` and `pnpm format:check` before committing.
  `pnpm --filter @jot/web e2e` runs the browser tests.
- Local servers for testing use their own port and persist directory (the e2e tests use 8799).
  Never point tests at an instance that holds someone's real notes.
- Commits: clear messages, no Co-Authored-By or model attribution lines.
