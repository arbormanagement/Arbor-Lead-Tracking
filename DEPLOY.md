# Deployment runbook — Arbor Lead Tracking (Railway)

The app runs on Railway as **two services built from this one repo**:

| Service | Start command | Config file | What it does |
| --- | --- | --- | --- |
| `web` | `npm run start` | `railway.json` | Next.js — dashboard, Twilio webhooks, `track.js`, `/api/cron/*` |
| `cron` | `npm run cron` | `railway.cron.json` | `scripts/cron.ts` — holds the schedule, calls `web`'s `/api/cron/*` |

Splitting them is deliberate: `/api/twilio/voice` must answer in **under 3 seconds**
or a call is lost, and a 5-minute spend sync sharing that event loop is a real risk.

Migrations run as the `web` service's **pre-deploy** step (`npm run db:deploy`), so a
failed migration aborts the release and leaves the previous version serving traffic.

---

## 0. Generate secrets (local)
```bash
openssl rand -hex 32   # NEXTAUTH_SECRET
openssl rand -hex 32   # COOKIE_SIGNING_SECRET
openssl rand -hex 32   # CRON_SECRET
npx tsx scripts/hash-password.ts 'your-admin-password'   # ADMIN_PASSWORD_HASH
```

## 1. Database
**Railway Postgres**, in the same Railway project as `web` and `cron`. On `web`:
`DATABASE_URL=${{Postgres.DATABASE_URL}}`. `DB_DRIVER` stays at its default `pg`.

**Leave `DATABASE_URL_UNPOOLED` unset.** It was a Neon concept (Neon served pooled and direct
endpoints at different hostnames) and the migration runner still prefers it when present — a
leftover value silently sends every migration to a database the app no longer reads.


## 2. The `web` service
1. **New Project → Deploy from GitHub repo** → `arbormanagement/Arbor-Lead-Tracking`.
   Railway reads `railway.json` automatically. Name the service `web`.
2. Set **Variables**:
   - `DATABASE_URL` (Railway reference, section 1)
   - `NEXTAUTH_SECRET`, `COOKIE_SIGNING_SECRET`, `CRON_SECRET`
   - `ADMIN_EMAIL=justin@arbor-mgmt.com`, `ADMIN_PASSWORD_HASH=<hash from step 0>`
   - `APP_BASE_URL` (set after step 3 gives you a domain)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
     `TWILIO_DEFAULT_DESTINATION=+16188368004`, `TWILIO_VOICE_WEBHOOK_BASE`
   - Optional: `TWILIO_SMS_FORWARD_TO` — a mobile that can read texts, for relaying
     inbound SMS. Also settable in-app at **Settings → Routing**. Leave unset and texts
     are still captured in the Inbox, just not relayed anywhere.
   - `FACEBOOK_VERIFY_TOKEN` (any string; reused when subscribing the FB webhook)
   - **Platform API keys (HCP / Google Ads / Facebook / Deepgram / Anthropic) must be set
     HERE.** There is no in-app credential store — Settings → Integrations is read-only
     status plus a Test button. `lib/credentials/spec.ts` maps every field to its env var.
   - Optional: `HOST=::` — only needed for step 4's private-network option.
3. **Deploy.** The pre-deploy step applies migrations and seeds defaults; the healthcheck
   at `/api/health` (which pings Postgres) gates the cutover.

## 3. Domain
**Settings → Networking → Generate Domain**, or add `app.arbor-mgmt.com` as a custom
domain (CNAME to the Railway target). Then set on `web` and redeploy:
- `APP_BASE_URL=https://<domain>`
- `TWILIO_VOICE_WEBHOOK_BASE=https://<domain>/api/twilio`

## 4. The `cron` service
1. In the same project: **New → GitHub Repo** → the same repo. Name it `cron`.
2. **Settings → Config-as-code** → set the path to `railway.cron.json`.
3. **Settings → Networking**: do *not* generate a domain. This service takes no traffic.
4. Variables — it only needs to reach `web`:
   - `CRON_SECRET` — **identical** to `web`'s value
   - `CRON_TARGET_BASE_URL=https://<domain>` (public), **or**, to keep cron traffic inside
     the project, `CRON_TARGET_BASE_URL=http://${{web.RAILWAY_PRIVATE_DOMAIN}}:8080`
     together with `HOST=::` on `web` (Railway's private network is IPv6-only). The URL's
     port must match the port `next start` actually listens on — Railway injects `PORT`,
     so for this option also pin `PORT=8080` in `web`'s variables (or change the URL to
     whatever `PORT` is). A mismatch means connection-refused on every tick.
   - Optional: `CRON_TIMEZONE` (default `UTC`, matching the old Vercel Cron behavior),
     `CRON_JOBS` (comma-separated subset).
5. **Deploy**, then check the logs — on boot it prints every schedule and its next run:
   ```
   [cron] worker up — 9 job(s), tz=UTC, target=…
     reaper           */5 * * * *  next: …
   ```

## 5. Twilio
For each tracking number, set the **Voice webhook** → `https://<domain>/api/twilio/voice`
(HTTP POST). Or use the in-app provisioner (**/numbers → Add number**), which buys a number
and wires the webhooks automatically. The hourly `twilio-fallback` job re-asserts the voice
fallback on every number, so drift self-heals.

## 6. Website snippet
Add to arbor-mgmt.com (root layout `<head>`):
```html
<script async src="https://<domain>/track.js"></script>
```

## 7. Facebook lead-gen webhook (optional, when ready)
In the Meta app dashboard, subscribe the page to `https://<domain>/api/webhooks/facebook`
with verify token = `FACEBOOK_VERIFY_TOKEN`, and set the app secret as `FACEBOOK_APP_SECRET`
on the `web` service.

## 8. First-run verification
1. `curl https://<domain>/api/health` → `{"ok":true,"db":"up",…}`
2. Log in at `https://<domain>` with `ADMIN_EMAIL` + your password.
3. **Settings → Integrations** → confirm each platform reads as configured → **Test** each.
   Test calls the provider, which is the only check that separates a working credential from
   a merely present one — a token can be set, well-formed and revoked.
4. **Spend** page → **Run sync now** → confirm `sync_runs` + data populate.
5. Place a test call to a tracking number → it should appear under **Calls** / **Leads**.
6. Watch the `cron` logs for the next `reaper` tick (≤5 min) → `✓`.

---

## History — the move off Vercel + Neon (August 2026)

The app was first deployed on Vercel with a Neon database provisioned through Vercel's
marketplace. It moved to Railway `web` + `cron` and Railway Postgres in the first week of
August 2026 (`npm run db:transfer`, whole database, parity-verified). The Vercel project was
deleted; the Neon project outlived it because a marketplace install is a **team-level** Vercel
object, so deleting the project left the store behind and Neon's own console then refused to
delete it ("organization is managed by Vercel"). It has to go from the Vercel side: the
team's **Storage** tab, or Arbor-MCP-Server's `vercel_list_storage_stores` /
`vercel_delete_storage_store`.

What survives from that runbook, because it applies to any future database move or restore:

- **The invariant: never let two writable app instances point at two different databases.**
  Writes landing in a database you then walk away from is the only irrecoverable failure here.
  Only the `web` service writes — `cron` drives jobs over HTTP through `web` — so scaling `web`
  to 0 is a clean, total freeze.
- **Downtime means untracked calls, not dropped calls.** Every tracking number's Twilio
  *voice fallback* is a Twilio-hosted twimlet that dials the office with no dependency on this
  app; Twilio invokes it whenever the primary webhook errors, times out, or returns non-TwiML.
  Re-assert the fallbacks after any domain change:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/twilio-fallback
  ```
- **Move data with `npm run db:transfer`, never with hand-rolled `pg_dump -n public`.**
  Drizzle's migration journal lives in a separate `drizzle` schema; a public-only dump restores
  every row and still breaks the next deploy (`type "lead_status" already exists` as 0000
  re-applies onto populated tables). The script dumps the whole database, restores with
  `--exit-on-error`, compares every table's row count plus the journal count, and exits
  non-zero on any disagreement. Pass `--clean` when the target already has the seeded schema.
  ```bash
  SOURCE_DATABASE_URL="$OLD" TARGET_DATABASE_URL="$NEW" npm run db:transfer
  ```
- **Starting fresh instead of carrying data is rarely what you want.** Sources/pools are
  re-seeded with **new ULIDs**, so any hand-picked table referencing them fails its foreign
  keys; `tracking_numbers`, `settings`, `spam_rules`, `manual_spend`, call/web history and
  `conversion_exports` (the record of what was already uploaded to Google Ads — losing it
  risks double-counted conversions) do not rebuild from the platforms.
- After repointing, **delete `DATABASE_URL_UNPOOLED`** (see section 1).

## Renaming a column or table in a migration

`drizzle-kit generate` cannot tell a rename from a drop-and-add, so it asks — and a
migration generated non-interactively silently gets the destructive answer. The prompt
is answerable from a script (this is how `0056_tombstones_and_source_key` was made):

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:55432/arbor_scratch python3 - <<'PY'
import os, pty, select, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp("npx", ["npx", "drizzle-kit", "generate", "--name", "<migration_name>"])
out, answered = b"", False
while True:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        out += chunk
        if not answered and b"rename" in out and b"<new_name>" in out:
            time.sleep(0.5); os.write(fd, b"\x1b[B"); time.sleep(0.3); os.write(fd, b"\r")  # arrow down = "rename"
            answered = True
    elif answered and b"Your SQL migration file" in out: break
print(out.decode("utf8", "replace")[-1500:])
PY
```

Read the generated SQL and confirm it says `RENAME COLUMN` (or `RENAME TO`), never
`DROP COLUMN` + `ADD COLUMN`. Then prove it from an empty database:
`DATABASE_URL=<fresh scratch db> npm run db:deploy`.

## Email transport (Google Workspace)

Transactional mail — Chloe's call summaries to info@, review follow-ups, Facebook
intake notices, failure alerts — goes out through **Google Workspace** via the Gmail
API, with SendGrid kept behind it as a fallback. Set up 2026-09-14.

**Why it moved.** SendGrid's Email API was on a trial that lapsed on 2026-09-14.
Every send 401'd with `Maximum credits exceeded` for seven hours: 30 call summaries,
the review queue, the Facebook intake notices, and — because the alert travels by the
same channel it reports on — all 40+ failure alerts about it. Workspace is already
paid for, already authorized in DNS, and carries ~95% of this traffic to a mailbox on
that same Workspace.

**The newsletter is NOT this.** It goes out as SendGrid *Marketing Campaigns* Single
Sends, billed by stored contact (~8,600), driven from their dashboard. It never passed
through `lib/email` and is unaffected by any of this.

**No DNS work was needed** and none should be added. `arbor-mgmt.com` already publishes
`v=spf1 include:_spf.google.com ~all` and MXes to `smtp.google.com`. (SendGrid was
passing DMARC on its DKIM signature alone, via the `em5670` CNAMEs — SPF never covered
it, and DMARC is `p=none`.)

### Mode 0 — app password over SMTP (in use)

What is actually running. Justin's call on 2026-09-15, after the service-account
route proved to be two consoles too many.

1. **myaccount.google.com/apppasswords**, signed in as the sending mailbox. Name it
   anything; Google shows 16 characters in four groups.
2. Set on the `web` service:
   - `GOOGLE_WORKSPACE_SMTP_USER` — that mailbox
   - `GOOGLE_WORKSPACE_SMTP_APP_PASSWORD` — the 16 characters (spaces are stripped
     in code, so either form works)

That is the whole setup. No GCP project, no service account, no delegation.

⚠️ **`smtp.gmail.com` is not `smtp-relay.gmail.com`.** The relay authorizes by IP and
needs admin configuration; Railway's egress is not static so it was never available.
Plain authenticated SMTP needs neither, which an earlier version of this runbook got
wrong and used to rule SMTP out entirely.

⚠️ **SMTP cannot be tested from a Claude sandbox** — ports 25/465/587 are blocked
there, only HTTPS leaves. Verification happens on Railway: after deploy, watch for
`[email] sent to … via smtp` in the logs on the next inbound call. A wrong mailbox or
a disabled app password shows as a 535 in the same place.

The trade, stated plainly: an app password is a long-lived credential with full send
rights on that mailbox. The service account below can only ever send. Switching is a
variable change — `lib/email/gmail.ts` stays built and tested.

### Mode 1 — service account + domain-wide delegation (preferred, not in use)

One credential sends as any mailbox in the domain. The app needs that: call summaries
go out as `info@` and review follow-ups as `justin@`. Nothing to re-consent later.

1. Google Cloud console → a project → **IAM & Admin → Service Accounts** → create one.
   No project roles are needed; the authority comes from Workspace, not from IAM.
2. On that service account, **Keys → Add key → JSON**. Note its **client ID** (a long
   number, shown as "Unique ID").
3. Workspace **Admin console → Security → Access and data control → API controls →
   Domain-wide delegation → Add new**. Client ID = the number from step 2. Scope =
   `https://www.googleapis.com/auth/gmail.send`, exactly, on its own.
4. Set on the `web` service (and `cron`, if it ever sends):
   - `GOOGLE_WORKSPACE_SENDER=info@arbor-mgmt.com`
   - `GOOGLE_WORKSPACE_SA_EMAIL` — the `client_email` from the JSON
   - `GOOGLE_WORKSPACE_SA_PRIVATE_KEY` — the `private_key` from the JSON. Railway
     cannot hold literal newlines: paste it with `\n` escapes and
     `lib/email/gmail.ts` normalizes them.

⚠️ Delegation is granted to the service account's **client ID**, not its email, and the
scope string must match character for character. A near-miss fails at send time with a
401 naming neither.

### Mode 2 — OAuth refresh token (fallback)

Authenticates ONE mailbox. A `from` other than that mailbox works only if Workspace has
it as a verified *Send mail as* alias, so review follow-ups from `justin@` need that
alias on `info@` (or vice versa). Set `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID`,
`GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET`, `GOOGLE_WORKSPACE_OAUTH_REFRESH_TOKEN`.

⚠️ **Use a separate OAuth client from `GOOGLE_ADS_CLIENT_ID`.** That one is shared with
the Arbor MCP server; revoking its grant kills every token on it. See CLAUDE.md.

### Verifying

```bash
npm run verify:email                              # 33 offline checks, no credentials
npx tsx scripts/verify-email.ts --live you@arbor-mgmt.com   # one real send
```

The offline suite covers MIME assembly, RFC 2047 encoding and transport ordering. Its
sharpest cases are **header injection**: SendGrid took JSON and built the message
itself, while Gmail takes the RAW message, so a CR/LF in a header value ends that header
— and `app/api/webhook/call_summary` builds its subject from a webhook-supplied phone
number. `To`/`From`/`Reply-To` rely on `sanitizeHeaderValue` alone; `Subject` is also
covered by the encoded-word path.

The live flag is not part of the suite because it needs real credentials and puts mail in
someone's inbox. Run it once after setting the variables; `[email] sent to … via gmail`
in the logs is the confirmation.

### Falling back

Both transports stay configured. `EMAIL_TRANSPORT` pins the primary (`gmail` |
`sendgrid`); unset means Workspace when configured, else SendGrid. A transport that is
not fully configured is skipped rather than attempted, so a half-set credential cannot
become the thing that fails. Falling back is safe because a transport only resolves
after a 2xx — every failure path is a thrown error from a non-2xx or a refused
connection, so there is no window where one provider accepted the message and we send
it again.

Workspace's own sending limit is ~2,000 recipients/day, against ~35/day here.

## Backups

**Not on by default.** Railway backs up the Postgres service's *volume* on a schedule you set.
A volume snapshot restores to the snapshot, so the worst case is up to a day of loss (Neon,
which this replaced, did point-in-time recovery). For this app (a handful of leads a day, all of which also
exist in Twilio/HCP/Meta) it usually is.

**Enable them:** Postgres service → **Settings → Backups** → set a schedule (daily is the
sane default) and a retention count. Restores are performed from the same panel; Railway
restores a snapshot into the volume, so treat a restore as a maintenance window.

Two things to do beyond flipping it on:

1. **Actually test a restore.** An untested backup is a hope. Restore a recent snapshot into
   a scratch Postgres service once, confirm `select count(*) from leads` looks right, then
   delete it.
2. **Keep a logical dump too** — portable, inspectable, and *outside* the thing that might
   break. A volume snapshot lives inside the same Railway project:
   ```bash
   npm run db:backup                    # → ./backups/arbor-<utc>.dump, prunes to BACKUP_RETAIN
   pg_restore --no-owner --no-acl --exit-on-error -d "$DATABASE_URL" backups/arbor-<utc>.dump
   ```
   To automate it on Railway: **New → GitHub Repo** (same repo), name it `backup`, set
   config-as-code to `railway.backup.json`, attach a **Volume** mounted at `/data`, and set
   `BACKUP_DIR=/data`, `BACKUP_RETAIN=14`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Give
   the service a **cron schedule** (e.g. `0 8 * * *`) — it runs, writes a dump, and exits
   (`restartPolicyType: NEVER`).

   The dump needs `pg_dump` in the image, which `nixpacks.toml` adds. Verify once from a
   Railway shell with `pg_dump --version`; the script fails loudly with that same hint if
   it's missing.

   For true off-site copies, have that service push to S3/R2 afterwards, or pull the dumps
   down periodically. A backup in the same account as the database is not a disaster plan.

## Scheduled jobs

The schedule lives in `scripts/cron.ts` (ported 1:1 from the old `vercel.json`) and is
interpreted in `CRON_TIMEZONE`, default UTC:

| Job | Schedule | |
| --- | --- | --- |
| `reaper` | `*/5 * * * *` | release expired DNI leases |
| `transcribe` | `*/10 * * * *` | Deepgram transcription |
| `hcp` | `7 * * * *` | HousecallPro revenue |
| `attribution` | `22 * * * *` | lead → source attribution |
| `fbleads` | `9,24,39,54 * * * *` | Facebook lead-gen pull |
| `conversions` | `37 * * * *` | conversion export |
| `spend` | `37 7 * * *` | ad spend (self-healing rolling re-pull) |
| `lsa` | `47 7 * * *` | Local Services Ads |
| `twilio-fallback` | `52 * * * *` | re-assert voice fallback on every number |

To change a schedule, edit `scripts/cron.ts` and redeploy the `cron` service.

Run any job by hand:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/<job>
# `revenue` chains hcp → spend → lsa → attribution → conversions in one shot
```

## Is it actually working? — `/api/diagnostics`

One read-only call answers it, without a database shell:

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" https://<domain>/api/diagnostics | jq
```

`ok: true` and an empty `warnings` array means everything below is healthy. It
reports, and warns on:

| Area | What it catches |
| --- | --- |
| `config` | A trailing slash on `APP_BASE_URL` (invalidates **every** Twilio signature); `TWILIO_AUTH_TOKEN` unset (status + recording callbacks fail closed, so no recording ever persists — the 2026-08 incident) |
| `pool` | Pool size, how many are leased, and `excludedFromRotation` — active non-static numbers sitting in a non-DNI pool that will never be handed to a visitor |
| `jobs` | Last run and last **success** per sync job, with the error text; flags a job that hasn't succeeded in 48h, has never succeeded, or is stuck `running` past the 6h reaper window (its claim blocks every later tick) |
| `volume` | Leads and calls in the last 24h/7d, plus how many calls in the last 7d actually have a recording |
| `credentials` | Which fields are configured per platform — **names only, never values** |

It is deliberately a fixed set of checks rather than a query interface: an
endpoint that runs SQL you hand it would be an arbitrary-read (and one typo
later, arbitrary-write) backdoor into a production database holding customer
contact details, behind a single bearer token. Add a check here instead.

Needs `ADMIN_API_TOKEN` set on the `web` service; an admin session cookie works
too, so the same URL is useful from a logged-in browser.

Notes:
- A failed run is logged and the worker keeps going; the next tick retries.
- `protect: true` skips a tick if the previous run of that same job is still in flight,
  so a slow sync queues behind itself instead of stacking. This only covers the *worker's*
  fetch, though — a tick that times out client-side leaves the web-side handler running.
  The real guard is server-side: `withSyncRun` claims the partial unique index
  `sync_runs_one_running_uq`, so a second concurrent run of the same job is **skipped**
  (`{"skipped": true}` in the response) rather than interleaved.
- The cron routes pass **no window override**. Each job owns its own policy — `spend` is
  a rolling 35-day re-pull plus an automatic cold-start backfill, `conversions` uses 90 days
  to match Google's click lookback. Don't add a `sinceDays` here to "make it cheaper";
  that is what silently disabled spend's self-healing until 2026-08-09.
- There is **no execution time limit** on Railway. The old `maxDuration` exports in the
  route files are inert now; long syncs no longer need to fit in 300s.

## Database driver
`DB_DRIVER` selects the transport (see `lib/db/client.ts`):
- **`pg`** (default, in use) — node-postgres over a long-lived pool. Right for Railway: the
  connection is reused instead of paying an HTTPS round-trip per query, and it supports the
  interactive transactions the DNI lease needs.
- **`neon-http`** — Neon's stateless HTTPS driver, kept from the Vercel era. Inert unless set,
  and **Neon only**: it derives an HTTPS endpoint from the connection string's hostname, so it
  cannot reach a non-Neon Postgres. Nothing on Railway should set it. Dropping the branch and
  `@neondatabase/serverless` is open housekeeping, not urgent.

Every path that touches the schema — the pre-deploy step, `npm run db:seed`, and
`/api/admin/migrate` — resolves the driver through `lib/db/connect.ts`, so they all work
against whichever database you point at.

Each process opens its own pool (`DATABASE_POOL_MAX`, default 5). Keep the sum across
services under the database's connection limit.

## Migrations
`npm run db:deploy` (Railway's pre-deploy step) applies `lib/db/migrations/*` and seeds the
canonical sources/pools. Idempotent — the Drizzle journal tracks what ran and the seeds use
`onConflictDoNothing`. It prefers `DATABASE_URL_UNPOOLED` when set (a transaction pooler mishandles the
session-level statements migrations issue) — which is exactly why that variable must stay
unset on Railway: see section 1.

Note this moved out of `npm run build`: the build no longer talks to production Postgres.
If you ever redeploy to a host without a pre-deploy hook, run `npm run db:deploy` yourself,
or use the secret-gated route:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/admin/migrate
```

**The full history applies to an EMPTY database — since 2026-09-05, because the runner commits
one transaction per FILE** (`lib/db/migrate-per-file.ts`, used by `db:deploy` and
`/api/admin/migrate` on the `pg` driver). Drizzle's own migrator applies every pending file in
a single transaction, and 0011 does `ALTER TYPE lead_status ADD VALUE 'cancelled'` while
0035/0036 use that value — Postgres refuses to use an enum value added in the same transaction
(`unsafe use of new value`), so a from-scratch `drizzle-kit migrate` rolls the whole batch back.
Production never saw it because each deploy applied only its own files. Per FILE, not per
statement: 0027 creates an `ON COMMIT DROP` temp table it reads later in the same file. The
runner keeps Drizzle's bookkeeping table byte-for-byte, so `drizzle-kit migrate` and
`db:deploy` can still be used interchangeably; just don't use `drizzle-kit migrate` on a blank
database.

## Postgres on Railway — two things Neon used to do for you
- **Connection pooling.** Neon's `-pooler` endpoint fronted PgBouncer. Railway Postgres is a
  plain instance, so `DATABASE_POOL_MAX` (per process, default 5) is the real limit — keep
  the sum across `web` + `cron` under the server's `max_connections`.
- **Point-in-time recovery.** Neon restored to any moment; Railway restores a volume snapshot,
  so the worst case is up to a day of loss. See **Backups** for what is enabled and why that
  is acceptable for this app.

## Rollback
Railway keeps previous deployments — **Deployments → ⋯ → Redeploy** on the last good one.
Note that a rollback does **not** revert a migration; migrations are written to be additive
so an older image keeps working against a newer schema.
