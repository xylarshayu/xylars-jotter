# Deploy your own

You run your own copy on your own Cloudflare account: one Worker, one D1 database and one R2
bucket, with the API behind Cloudflare Access. Nobody else operates it or can help you recover it. This guide
and `pnpm provision` make it convenient; getting it right (who Access lets in, where your keys
live) is up to you.

Everything fits Cloudflare's free plans for one person: Workers, D1, R2 (10 GB) and Access (up
to 50 users).

## What you need

- A Cloudflare account with a domain on it. You'll serve the app on a hostname in that zone, e.g.
  `notes.example.com`. Cloudflare creates the DNS record and certificate.
- Node 24+, pnpm (`corepack enable`) and git.
- A browser for `wrangler login` and the Access settings in the dashboard.

## If you are an agent doing this for someone

You can run every command here. Some steps need the person:

- **Login.** `wrangler login` opens a browser. Or they give you a scoped API token as
  `CLOUDFLARE_API_TOKEN` (permissions under [Scoped API token](#scoped-api-token)).
- **Access.** They set up the Access application and service token in the dashboard (step 4).
  It decides who can reach their notes, so they make that choice, not you.
- **Hostname.** They choose it.
- **Keys.** They keep the open key and the service token's secret.

Rules:

- Never use the Global API Key. `pnpm provision` refuses to run when `CLOUDFLARE_API_KEY` is set.
- Never print, paste or log the open key, the service token secret or any passphrase. Write keys
  to files with mode 600 (`jot keygen -o` does).
- Never ask for a locked channel's passphrase. Never read someone's notes to check that it
  works: use `jot channels`, counts, or a synthetic note you delete afterwards.
- The four values `pnpm provision` asks for are not secrets, but the owner email is personal.
  Pass them as flags or environment variables. Don't commit them anywhere.
- `pnpm provision` is safe to re-run. Exit codes:
  - `0`: done;
  - `1`: error;
  - `2`: input needed (it lists the flags);
  - `3`: deployed, but a check failed (it says which).

## 1. Get the code and check it

```sh
git clone <this repository> jot && cd jot
corepack enable
pnpm install --frozen-lockfile
pnpm check            # lint, typecheck, test and build everything
```

## 2. Log in to Cloudflare

```sh
pnpm --filter @jot/worker exec wrangler login
pnpm --filter @jot/worker exec wrangler whoami
```

If the account has several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID` to the one to use.

## 3. Provision

```sh
pnpm provision --host notes.example.com
```

It does, skipping anything already done:

1. Creates the D1 database `jot` and the R2 bucket `jot-files` if they don't exist.
2. Writes `apps/worker/wrangler.deploy.json` (gitignored): the committed `wrangler.jsonc` with
   your database id and hostname filled in. The committed config stays generic.
3. Builds the web app, applies D1 migrations and deploys the Worker to your hostname only.
   `workers.dev` and preview URLs are off.
4. Sets the four Access secrets the Worker checks requests against. On the first run you don't
   have them yet. In a terminal it prints step 4 and asks for them. Without a terminal it stops
   with exit code 2. Until they are set, the API answers `auth_not_configured`: it fails closed.

## 4. Cloudflare Access (dashboard)

In Cloudflare One (Zero Trust):

1. **Team domain:** Settings → Team name. Your team domain is
   `https://<team>.cloudflareaccess.com`.
2. **Service token for the CLI:** Access → Service credentials → Service Tokens → Create, name
   `jot-cli`. Copy the Client ID and Client Secret now; the secret is shown only once. Only the
   Client ID goes to the Worker. The secret stays with the CLI.
3. **Application:** Access → Applications → Add → Self-hosted.
   - Domain: your hostname, path `api`. That protects `/api/*`, which the phone and the CLI use.
     The app's static files stay public (they are this repository's code, and hold no data), and
     so does `/device-api/*`, where browsers you pair by QR use their own device session, which
     the Worker checks ([ADR-0019](docs/adr/0019-device-sessions.md)).
   - Session duration: up to you; a month means the phone rarely asks.
   - Policy "Owner": Action **Allow**, Include → Emails → your email. Add MFA if you like. See
     [Signing in on your own computers](#signing-in-on-your-own-computers) for a quicker login
     than emailed codes.
   - Policy "CLI": Action **Service Auth**, Include → Service Token → `jot-cli`.
   - Save, then copy the **Application Audience (AUD) Tag** from the Overview tab.

## 5. Provision again with the Access values

```sh
CF_ACCESS_CLIENT_ID=<client id> CF_ACCESS_CLIENT_SECRET=<client secret> \
pnpm provision \
  --team-domain https://<team>.cloudflareaccess.com \
  --aud <AUD tag> \
  --owner-email <the email in the Owner policy> \
  --service-token-id <client id>
```

It sets the secrets, then checks three things:

- that an unauthenticated request to `/api/me` is stopped by Access, not just by the Worker;
- that `/device-api/me` reaches the Worker, which asks for a device session. If Access answers
  instead, the application's path isn't `api`, and new browsers can't pair without signing in;
- that the service token gets `{"userId":"u_owner"}`. This check runs only when the two
  `CF_ACCESS_CLIENT_*` variables are set.

A new hostname can take a few minutes to answer. Re-run to check again.

To change a secret later: `pnpm provision --reset-secrets` plus the four flags.

## 6. The open key and the CLI

The open key decrypts every open channel. Locked channels don't use it.

```sh
pnpm nx build @jot/cli
node apps/cli/dist/jot.mjs keygen -o ~/.config/jot/open-key.txt   # mode 600; never overwrites
```

Keep a copy in your password manager. Lose every copy and the open channels are gone.

`~/.config/jot/config.json`:

```json
{
  "server": "https://notes.example.com",
  "openKeyFile": "~/.config/jot/open-key.txt",
  "notesDir": "~/jot/notes",
  "lockedNotesDir": "~/jot/notes-locked",
  "defaultChannel": "Inbox"
}
```

`~/.config/jot/env` (`chmod 600`), read by your shell and the mirror job:

```sh
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
```

```sh
set -a; . ~/.config/jot/env; set +a
alias jot="node $PWD/apps/cli/dist/jot.mjs"   # on macOS see README, "The jot command on macOS"
jot channels create Inbox
jot add "hello from the CLI"
jot list
```

## 7. Phone and browsers

On the phone:

1. Open your hostname in Chrome and choose **Sign in to paste or create a key**. Access signs you
   in.
2. Paste the open key ("Use this key"). It stays in that browser's IndexedDB.
3. Chrome menu → **Install app**. The app then shows up in Android's share sheet.

On any other browser, nothing to sign in to:

1. Open the site and choose **Pair with your phone**. Tick **Temporary device** first on a
   computer that isn't yours.
2. On the phone, go to Settings → **Pair a device** and scan the code.
3. Check that both screens show the same six digits, and that the phone shows the browser and
   city you expect. Then approve. The new browser is signed in and opens your notes.

Approve only a browser in front of you that you just started pairing. Anyone can show a pairing
code, so a code someone sends you, or asks you to scan, is a phishing attempt: approving it gives
them your open channels ([threat model](docs/threat-model.md#someone-on-the-internet-not-signed-in)).

Settings → **Devices** lists paired browsers and signs any of them out. A signed-out browser deletes
its copy the next time it connects, but it keeps whatever it already had, so pair only devices
you control, and use Temporary otherwise. A temporary device forgets everything and signs itself
out when its tab closes or sits idle.

Create locked channels in the app: New channel → Locked. Each one has its own passphrase, which
is stored nowhere. Forget it and that channel is gone.

## Signing in on your own computers

Pairing works on any browser. On your own laptops you can also sign in through Access directly
(**Sign in to paste or create a key**), which is a single click with these settings:

1. Zero Trust → Settings → Authentication → Login methods → **Add new**: Google or GitHub. The
   dashboard walks you through creating its OAuth client. The email it reports must be the one in
   the "Owner" policy.
2. In the application → Login methods (or Authentication): select only that provider and turn on
   **Instant Auth**, so Access goes straight to it instead of showing a chooser.
3. Protect that Google or GitHub account with a passkey and keep the browser signed in to it.
4. Session duration: a month.

Then Access signs a browser in with one click, and you paste the key from your password manager.
Don't do this on someone else's computer: it signs your Google or GitHub account in there. Pair
instead.

## Rate-limit pairing (optional)

`/device-api/pairings` answers anyone. The Worker caps pairings in progress (3 per IP, 100 in
all), but each request still counts toward the Workers free plan's daily requests. A rate-limiting
rule stops a flood before the Worker runs: Security → WAF → Rate limiting rules → Create, if URI
Path contains `/device-api/pairings`, counted per IP, 15 requests per 10 seconds, action Block.
The free plan includes one such rule. A device that is pairing polls every 2 seconds, so don't go
much lower.

## Updating

```sh
git pull && pnpm install --frozen-lockfile && pnpm check
pnpm provision     # rebuilds, applies new migrations, deploys; the rest is already done
```

**Deployed before device sessions?** Deploy first, then change the Access application's path
from empty to `api` (step 4), then run `pnpm provision` again to check. In between, everything
keeps working; browsers just can't pair without signing in until the path changes.

## Mirror to disk on a schedule (macOS)

`jot mirror` writes open channels as Markdown to `notesDir`, and locked channels as age files to
`lockedNotesDir`. To run it every 5 minutes:

1. Fill in `apps/cli/launchd/jot.mirror.plist`:
   - `__HOME__`;
   - `__NODE__`: the output of `command -v node`;
   - `__JOT__`: the absolute path to `apps/cli/dist/jot.mjs`.
2. Install it:

```sh
cp apps/cli/launchd/jot.mirror.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/jot.mirror.plist
tail -f ~/Library/Logs/jot-mirror.log
```

## Moving from another instance

`jot migrate` copies a whole account to a fresh one, as ciphertext. That covers every channel,
note, preview, earlier version and attachment. It re-wraps the open channels to a new open key on
the way ([ADR-0015](docs/adr/0015-store-copy-and-open-key-rotation.md)). It only works on an
account that was never written to. So run it right after step 6, before the phone, a browser or
the CLI writes anything.

```sh
set -a; . ~/.config/jot/env; set +a
jot migrate --from <old server URL> --from-key-file <old open key file> --dry-run
jot migrate --from <old server URL> --from-key-file <old open key file>
```

Afterwards, delete the old open key, the old store and any CLI caches (`~/.cache/jot`). The old
key plus an old wrapped channel key still opens today's open channels.

## Doing it by hand

What `pnpm provision` runs, if you'd rather. All commands run in `apps/worker`.

1. `wrangler d1 create jot` and `wrangler r2 bucket create jot-files`.
2. Make a copy of `wrangler.jsonc`, then in the copy:
   - set `database_id`;
   - add `"routes": [{ "pattern": "<host>", "custom_domain": true }]`.
3. `pnpm nx build @jot/web` (from the repo root).
4. `wrangler d1 migrations apply jot --remote -c <copy>`.
5. `wrangler deploy -c <copy>`.
6. `wrangler secret put <NAME> -c <copy>` for each of:
   - `ACCESS_TEAM_DOMAIN`;
   - `ACCESS_AUD`;
   - `OWNER_EMAIL`;
   - `SERVICE_TOKEN_CLIENT_ID`.

## Scoped API token

For CI or an agent without a browser: My Profile → API Tokens → Create Token → the **Edit
Cloudflare Workers** template. Add **D1: Edit**, and limit it to your account and your zone.

Pass it as `CLOUDFLARE_API_TOKEN`. Never use the Global API Key.

## If something goes wrong

- **A phone is lost:** Zero Trust → My Team → Users → revoke its sessions. A browser paired by
  QR: Settings → Devices → Sign out. Then read
  [the threat model](docs/threat-model.md#a-stolen-phone).
- **A new browser shows the Access login instead of the setup screen:** the Access application
  still covers the whole hostname. Set its path to `api`.
- **`auth_not_configured`:** a secret is missing. Run `pnpm provision` and it says which.
- **`{"error":"forbidden"}`:** the Worker got a request without a valid Access token. Either
  the Access application doesn't cover the hostname, or the AUD tag or owner email is wrong.
