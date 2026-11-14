# Security

This is a personal project. Please report security issues privately through GitHub's
"Report a vulnerability" (private security advisory) on this repository, not in public issues.

Design and limits: [docs/threat-model.md](docs/threat-model.md) and
[ADR-0001](docs/adr/0001-everything-is-an-age-file.md).

## Rules for contributors and agents

- Never read, decrypt, guess or brute-force locked-channel content or passphrases.
- Never persist a passphrase: not in files, env vars, keychains, logs, configs or shell history.
  The CLI reads passphrases from stdin only, never from argv.
- Tests, fixtures, logs, error messages and demos use synthetic data only.
- No third-party scripts, analytics or telemetry. Keep the CSP in `apps/web/public/_headers`
  strict (no `unsafe-*`).
- Crypto comes from audited libraries only (`age-encryption`/typage, `@noble/*`).
- Deploys use a scoped API token or `wrangler login`, never the Cloudflare Global API Key.
