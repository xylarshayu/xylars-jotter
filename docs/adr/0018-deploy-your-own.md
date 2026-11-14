# ADR-0018: Deploy your own with a re-runnable script, not a Deploy button

Status: accepted (2026-11-14)

## Context

Others should be able to run their own copy. Cloudflare's Deploy button can create the Worker,
D1 and R2, but not the Access application and service token. Those decide who can reach the
notes. A one-click deploy that comes up without Access would fail closed (the Worker refuses
every request until its Access secrets are set). But it invites people to get Access wrong, or to
switch it off. The repository also carried its first owner's domain, paths and machine names.

## Decision

- No Deploy button. `pnpm provision` (`tools/provision`) does the Cloudflare side, checking before
  each step so it can be re-run any time. It refuses the Global API Key. It keeps the committed
  `wrangler.jsonc` generic and writes the database id and hostname into a gitignored
  `apps/worker/wrangler.deploy.json`. It doesn't create Access objects; that needs an API token
  with Zero Trust rights, which it shouldn't ask for. Instead it prints the dashboard steps, asks
  for the four values (or stops with exit code 2 and lists the flags), sets them as Worker
  secrets, and checks that Access, not only the Worker, stops an unauthenticated request.
  (`pnpm setup` is a pnpm built-in, hence the name.)
- [DEPLOY.md](../../DEPLOY.md) and [AGENTS.md](../../AGENTS.md) are written so that an agent can
  do the deploy for someone. They set out what stays with the person: the login, the Access
  policy, and the keys.
- Personal specifics are gone from code and docs. The CLI's default mirror directories are
  `~/jot/notes` and `~/jot/notes-locked`. The launchd label is `jot.mirror`.
- Tests run the script against a fake wrangler. They never touch an account.

## Consequences

- Updating a deployment is `git pull`, then `pnpm provision`. It rebuilds, applies new migrations
  and redeploys.
- Anyone with an older config that relied on the old default mirror paths must set `notesDir`
  and `lockedNotesDir`.
