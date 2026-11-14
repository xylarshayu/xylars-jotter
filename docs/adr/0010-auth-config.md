# ADR-0010: Cloudflare Access only; Access settings are Worker secrets

Status: accepted (2026-11-12). Amended by [ADR-0019](0019-device-sessions.md): Access now
covers `/api/*` only, and devices paired by QR use a device session at `/device-api/*`.

## Decision

- Cloudflare Access protects the whole hostname. The Worker verifies the
  `Cf-Access-Jwt-Assertion` JWT again against the team's JWKS (RS256, issuer and audience) and
  accepts only the owner's email or the CLI service token's client ID.
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` and `SERVICE_TOKEN_CLIENT_ID` are Worker
  secrets, so nothing personal is committed. If any is missing, the API fails closed
  (`auth_not_configured`).
- `AUTH_MODE=dev` (local only) is honoured only for `localhost`/`127.0.0.1` requests.
- When the Access session expires, API calls get a redirect; the PWA shows a banner whose
  "Sign in" goes to `/api/login`, which Access intercepts, then returns to `/`.

## Consequences

No passwords or sessions of our own. Access policies (MFA, session length) are configured in
Cloudflare.
