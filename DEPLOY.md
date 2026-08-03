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
openssl rand -hex 32   # CREDENTIALS_ENCRYPTION_KEY   (rotating this re-keys stored creds)
openssl rand -hex 32   # CRON_SECRET
npx tsx scripts/hash-password.ts 'your-admin-password'   # ADMIN_PASSWORD_HASH
```

## 1. Database
Either option works — `DB_DRIVER=pg` (the default) speaks plain Postgres to both.

- **Keep Neon**: reuse the existing `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`
  (direct). Put the Railway service in a region near the Neon project.
- **Railway Postgres**: add a Postgres service, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  on `web`, and follow **Moving the database to Railway** below.

`DATABASE_URL_UNPOOLED` is a Neon concept — Neon serves pooled and direct endpoints at
different hostnames. Railway Postgres has one URL, so leave it unset there; everything
falls back to `DATABASE_URL`.

## 2. The `web` service
1. **New Project → Deploy from GitHub repo** → `arbormanagement/Arbor-Lead-Tracking`.
   Railway reads `railway.json` automatically. Name the service `web`.
2. Set **Variables**:
   - `DATABASE_URL`, `DATABASE_URL_UNPOOLED`
   - `NEXTAUTH_SECRET`, `COOKIE_SIGNING_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`
   - `ADMIN_EMAIL=justin@arbor-mgmt.com`, `ADMIN_PASSWORD_HASH=<hash from step 0>`
   - `APP_BASE_URL` (set after step 3 gives you a domain)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
     `TWILIO_DEFAULT_DESTINATION=+16188368004`, `TWILIO_VOICE_WEBHOOK_BASE`
   - `FACEBOOK_VERIFY_TOKEN` (any string; reused when subscribing the FB webhook)
   - **Platform API keys (HCP / Google Ads / Facebook / Deepgram) can be skipped here** and
     entered later in the app under **Settings → Integrations** (encrypted at rest).
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
     together with `HOST=::` on `web` (Railway's private network is IPv6-only).
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
with verify token = `FACEBOOK_VERIFY_TOKEN`, and set the app secret in
**Settings → Integrations → Facebook → App Secret**.

## 8. First-run verification
1. `curl https://<domain>/api/health` → `{"ok":true,"db":"up",…}`
2. Log in at `https://<domain>` with `ADMIN_EMAIL` + your password.
3. **Settings → Integrations** → paste HCP / Google / FB / Deepgram keys → **Test** each.
4. **Spend** page → **Run sync now** → confirm `sync_runs` + data populate.
5. Place a test call to a tracking number → it should appear under **Calls** / **Leads**.
6. Watch the `cron` logs for the next `reaper` tick (≤5 min) → `✓`.

---

## Cutting over

How careful you need to be depends entirely on what is actually live. Right now the answer
is: **almost nothing**, so take the simple path.

### The simple path — while the app isn't load-bearing yet

Today the only live data path is Facebook lead ads, and that path is unusually forgiving:

- **It's an outbound poll, not a webhook.** `fbleads` pulls from the Graph API on a
  schedule (`lib/sync/facebook-leads.ts`), deliberately so it doesn't touch the page's
  existing Replit webhook subscription. It therefore does **not** depend on this app's URL,
  DNS, or inbound reachability at all.
- **It self-heals.** Leads are deduped on `fb_leadgen_id`, and on a database with no prior
  successful run it cold-starts to a **30-day** window. A gap of hours or days costs
  nothing — the next tick backfills it.
- **Calls and `track.js` aren't in play yet**, so there's nothing to lose while the app is
  down.

So there is no window to plan, no DNS TTL to pre-lower, and no freeze:

1. Stand up `web` + `cron` on Railway (sections 2 and 4), plus a Postgres service with
   backups on.
2. Decide about the existing data (below) — migrate it or start fresh.
3. Point the domain at Railway whenever convenient, set `APP_BASE_URL`, delete the Vercel
   project.
4. Run the Facebook poll once by hand and confirm leads land:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/fbleads
   ```
5. Take a final archival dump of Neon before deleting the project (see **Backups**), then
   delete it.

### Starting fresh instead of migrating the data

Yes, this is a legitimate option — and an empty `sync_runs` is what *triggers* the
cold-start backfills, so a fresh database repopulates itself.

**Rebuilds on its own:**

| Data | How | How far back |
| --- | --- | --- |
| `sources`, `pools` | seeded by `npm run db:deploy` | n/a |
| `facebook_leads` + their `leads` | `fbleads` poll, deduped on `fb_leadgen_id` | 30d automatically; further via `POST /api/sync/fbleads?days=N`, capped by Meta's retention |
| `hcp_customers` / `hcp_jobs` / `hcp_estimates` | `hcp` sync | **30d only** (`MAX_LOOKBACK_DAYS`); further via `?days=N` |
| `ad_spend`, `campaigns` | `spend` sync cold-start | back to that platform's earliest lead (≤365d) |
| `attributions`, `roi_daily` | `attribution` recomputes | from whatever leads exist |

**Does not come back:**

| Data | What it costs you | Mitigation |
| --- | --- | --- |
| `tracking_numbers` | the app forgets which Twilio numbers are its own | the numbers are safe in Twilio — re-register each via **/numbers → Add number → import an owned number** |
| `integration_credentials` | platform API keys | **set them as Railway env vars instead** — `getPlatformCreds` falls back to env, so this costs nothing |
| `settings` | routing, attribution mode, selected FB forms revert to defaults | reconfigure in Settings |
| `spam_rules`, `manual_spend` | custom entries | re-enter |
| `calls`, `visitors`, `web_sessions`, `form_submissions` | history | none — but these are near-empty today |
| `conversion_exports` | **the record of which conversions were already uploaded to Google Ads** | see below |

**The one that actually matters: `conversion_exports`.** The only thing stopping a
conversion being uploaded to Google Ads twice is a `status='sent'` row here. Lose it and
that memory is gone, so a lead that later re-qualifies can be reported a second time and
double-count in your bidding data. Exposure is limited in practice — re-polled leads come
back as `status='new'`, and only qualified/quoted/won leads are candidates — but don't rely
on that if real conversions have already gone out.

You **cannot** carry just this table: `conversion_exports.lead_id` is a hard FK to `leads`,
so it only restores alongside them. If conversions have already been uploaded, do the full
dump/restore.

**So the decision comes down to two questions:**
```bash
psql "$NEON_UNPOOLED_URL" -c "select
  (select count(*) from conversion_exports where status='sent') conversions_already_sent,
  (select count(*) from tracking_numbers) twilio_numbers,
  (select count(*) from calls) calls,
  (select count(*) from leads) leads,
  (select count(*) from settings) settings_rows,
  (select min(created_at)::date from leads) oldest_lead;"
```
- **`conversions_already_sent` = 0 and few/no `twilio_numbers`** → start fresh. Deploy
  against an empty Railway Postgres and let the syncs repopulate. Put the platform API keys
  in Railway's env vars so credentials carry over for free.
- **Otherwise** → do the full dump/restore from **Moving the database to Railway**. It's two
  commands and it's verified; don't hand-pick tables.

> **Don't try a partial carry-over.** It looks cheaper and isn't. Seeded `sources`/`pools`
> get **new ULIDs** in a fresh database, so every row referencing them by id (`manual_spend`,
> `leads.source_id`, `campaigns`, `tracking_numbers.static_source_id`) fails its foreign key.
> Making it work means deleting the freshly-seeded dimensions and carrying `sources` +
> `pools` along too — at which point you've done a messier version of the full restore.

Whichever you pick: **take an archival `pg_dump` of Neon before deleting the project.** One
command, and it's the difference between "we started fresh" and "we lost it."

### Later: once calls are live

The procedure below is what this becomes **after Phase 6**, when tracking numbers carry real
traffic and an untracked call is a lost lead. Skip it for now; come back when the app is
load-bearing.

### The invariant

> **Never let two writable app instances point at two different databases.**

That is the only failure mode here that loses data irrecoverably: writes land in a database
you then walk away from. Everything else — a bad env var, a failed migration, a domain
pointed at the wrong place — is recoverable, because Neon is still sitting there intact.
Every step below exists to hold that line. (Facebook leads are the exception that proves it:
being re-pollable and deduped, they'd survive even that.)

Three properties of this app make a maintenance window cheap:

- **Calls still connect while the app is down.** Every tracking number's Twilio *voice
  fallback* is a Twilio-hosted twimlet that dials the office directly, with no dependency on
  this app. Twilio invokes it whenever the primary webhook errors, times out, or returns
  something that isn't TwiML — which is exactly what a stopped service does. Downtime means
  **untracked calls, not dropped calls**. Confirm the fallbacks are set first (below).
- **Facebook leads self-heal.** `fbleads` polls Meta on a rolling window with a 6-hour
  overlap, so lead-gen submissions during the window get picked up on the next tick
  regardless of missed webhooks.
- **Only the `web` service writes.** The cron worker drives jobs over HTTP through `web`,
  and no script touches the app's database client. Stopping `web` is a clean, total freeze.

What you *do* lose in the window: web/form submissions from `track.js` (the browser posts
once and doesn't retry), and Twilio status/recording callbacks for calls that end during it
— so those calls keep their row but may lack duration or a recording. Run it outside
business hours and that's close to nothing for a tree service.

### One-window cutover (app + database together)

**Days before — no downtime, no risk:**

1. **Lower the DNS TTL** on `app.arbor-mgmt.com` to 60s. This is what turns the domain move
   from an unpredictable propagation window into about a minute. Do it at least as far ahead
   as the *old* TTL (often 24–48h) or it hasn't taken effect yet.
2. **Confirm the Twilio fallbacks** are actually set — this is the safety net the whole plan
   leans on:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<current-domain>/api/cron/twilio-fallback
   ```
   Then spot-check a number in the Twilio console: *Voice Fallback URL* should be a
   `twimlets.com/forward?PhoneNumber=+1618…` pointing at the office line.
3. **Stand up Railway `web` + `cron` pointed at Neon** (sections 2 and 4 above), on the
   temporary `*.up.railway.app` domain. Verify everything there. Vercel and Railway are both
   writing to Neon — the *same* database — so the invariant holds and there is no divergence.
   This gets all the fiddly setup done with zero exposure.
4. **Add the Postgres service** and enable backups on it (see **Backups**).
5. **Rehearse the dump/restore** read-only against live Neon (steps 3–4 of *Moving the
   database*). Then drop the rehearsal copy.

**The window itself — pick an evening:**

6. **Freeze all writers.** Scale Railway `web` and `cron` to 0 replicas, and take the domain
   off the Vercel project (or pause it). Nothing writes now. Calls are hitting the twimlet
   and reaching the office.
7. **Dump and restore for real**, then verify parity — steps 6–7 of *Moving the database*.
8. **Repoint `web`:** `DATABASE_URL=${{Postgres.DATABASE_URL}}`, and **delete
   `DATABASE_URL_UNPOOLED`**. A leftover Neon value silently sends migrations back to the
   old database.
9. **Move the domain** to the Railway `web` service and set `APP_BASE_URL` +
   `TWILIO_VOICE_WEBHOOK_BASE` to it. Scale `web` and `cron` back up.
10. **Verify** — `/api/health` green, log in, place a test call and watch it land under
    **Calls**, and wait for a green `reaper` tick in the `cron` logs.
11. **Re-assert the Twilio webhooks** now that the domain moved:
    ```bash
    curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/twilio-fallback
    ```
    and update the `<script src>` on arbor-mgmt.com if the domain changed.

Realistically 10–20 minutes, most of it DNS and the Railway redeploy rather than the data.

**Rollback.** Until step 10 passes, Neon is untouched and authoritative: put `DATABASE_URL`
back to Neon, move the domain back, redeploy. Your decision point is the first real write to
Railway Postgres — after that, rolling back means losing it, so decide *before* you reopen
traffic, not after. Keep the Neon project (read-only, undeleted) for a week or two, and take
a final dump before you delete it.

### Staged alternative
If you'd rather move one thing at a time — app now, database later:

1. Deploy `web` + `cron` on Railway pointed at Neon and verify, while Vercel still serves
   the live domain. Both point at the same database — safe, and `cron` on Railway is the
   only scheduler at this point (`vercel.json` was deleted in this change, so the Vercel
   deployment no longer has crons of its own).
2. Move the domain: remove `app.arbor-mgmt.com` from the Vercel project, add it to the
   Railway `web` service, and update `APP_BASE_URL` / `TWILIO_VOICE_WEBHOOK_BASE`.
   If you're switching domains rather than moving one, re-point the Twilio voice webhooks
   (or run `twilio-fallback`) and update the `<script src>` on arbor-mgmt.com.
3. Watch a real call land end-to-end under **Calls**.
4. Delete the Vercel project.
5. Days later, follow **Moving the database to Railway** as its own window.

## Moving the database to Railway

> **Dump the WHOLE database, not just the `public` schema.** Drizzle's migration journal
> lives in a separate `drizzle` schema. A `pg_dump -n public` restores every row and still
> leaves you broken: the journal is gone, so the next deploy re-applies migration 0000 onto
> populated tables and dies with `type "lead_status" already exists`. The pre-deploy step
> fails the release rather than corrupting anything, but you cannot ship until it's fixed.

The app is the only writer, so the safe shape is a short window with `web` stopped. The
dump is small (well under a minute at current volume) — the cost is a few minutes where
inbound calls fall back to Twilio's forwarding, not lost data.

1. **Check the size** so you know what you're in for:
   ```bash
   psql "$NEON_UNPOOLED_URL" -c "select pg_size_pretty(pg_database_size(current_database()));"
   ```
2. **Add a Postgres service** to the Railway project (**New → Database → PostgreSQL**) and
   turn on backups now, before it holds anything (see the next section).
3. **Rehearse first, with everything still running.** This is a read-only dump; it changes
   nothing and tells you whether the real run will work:
   ```bash
   pg_dump --no-owner --no-acl --format=custom "$NEON_UNPOOLED_URL" > rehearsal.dump
   pg_restore --no-owner --no-acl --exit-on-error -d "$RAILWAY_DATABASE_URL" rehearsal.dump
   psql "$RAILWAY_DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations;"  # expect 16
   ```
   Then point a local `npm run dev` at `$RAILWAY_DATABASE_URL` and click around.
4. **Drop the rehearsal copy** so the real run starts clean:
   ```bash
   psql "$RAILWAY_DATABASE_URL" -c "drop schema public cascade; create schema public; drop schema if exists drizzle cascade;"
   ```
5. **Quiet the writers.** Scale `web` and `cron` to 0 replicas (or pause the services).
   Calls still reach the office: Twilio falls back to forwarding when the webhook is
   unreachable. They just won't be *tracked* for these few minutes.
6. **Dump and restore for real:**
   ```bash
   pg_dump --no-owner --no-acl --format=custom "$NEON_UNPOOLED_URL" > cutover.dump
   pg_restore --no-owner --no-acl --exit-on-error -d "$RAILWAY_DATABASE_URL" cutover.dump
   ```
   `--exit-on-error` matters: without it pg_restore reports success having skipped
   statements that failed.
7. **Verify parity** before letting anything write again:
   ```bash
   for t in leads calls visitors web_sessions form_submissions sources ad_spend hcp_jobs; do
     echo "$t neon=$(psql -tA "$NEON_UNPOOLED_URL" -c "select count(*) from $t") railway=$(psql -tA "$RAILWAY_DATABASE_URL" -c "select count(*) from $t")"
   done
   psql -tA "$RAILWAY_DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations;"
   ```
   Every pair must match, and the journal count must equal the number of files in
   `lib/db/migrations/`.
8. **Repoint and restart.** On `web`: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, and
   **delete `DATABASE_URL_UNPOOLED`** — a leftover Neon value silently sends migrations
   back to the old database. Scale `web`/`cron` back up.
9. **Confirm:** `/api/health` returns `{"ok":true,"db":"up"}`, a test call lands under
   **Calls**, and the `cron` logs show a green `reaper` tick.
10. **Keep Neon around, read-only, for a week or two.** It is your rollback: if something
    is wrong, put `DATABASE_URL` back. Delete the Neon project only once you're satisfied —
    and take a final dump before you do.

## Backups

**Yes — but they are not on by default, and they are not the same thing Neon gave you.**
Railway backs up the Postgres service's *volume* on a schedule you set. Neon did
point-in-time recovery to any moment. A volume snapshot restores to the snapshot, so your
worst case goes from "seconds of loss" to "up to a day of loss". Decide if that's
acceptable before you cut over; for this app (a handful of leads a day, all of which also
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

Notes:
- A failed run is logged and the worker keeps going; the next tick retries.
- `protect: true` skips a tick if the previous run of that same job is still in flight,
  so a slow sync queues behind itself instead of stacking.
- There is **no execution time limit** on Railway. The old `maxDuration` exports in the
  route files are inert now; long syncs no longer need to fit in 300s.

## Database driver
`DB_DRIVER` selects the transport (see `lib/db/client.ts`):
- **`pg`** (default) — node-postgres over a long-lived pool. Right for Railway: the
  connection is reused instead of paying an HTTPS round-trip per query, and it supports
  the interactive transactions the Phase 4 DNI lease needs.
- **`neon-http`** — Neon's stateless HTTPS driver. Set this if you ever deploy back to a
  serverless host, or from a network that blocks raw Postgres TCP. **Neon only** — it
  derives an HTTPS endpoint from the connection string's hostname, so it cannot reach a
  non-Neon Postgres. Leave it on `pg` unless you are on Neon and need HTTPS.

Every path that touches the schema — the pre-deploy step, `npm run db:seed`, and
`/api/admin/migrate` — resolves the driver through `lib/db/connect.ts`, so they all work
against whichever database you point at. (They previously each hardcoded Neon's driver.)

Each process opens its own pool (`DATABASE_POOL_MAX`, default 5). Keep the sum across
services under the database's connection limit.

## Migrations
`npm run db:deploy` (Railway's pre-deploy step) applies `lib/db/migrations/*` and seeds the
canonical sources/pools. Idempotent — the Drizzle journal tracks what ran and the seeds use
`onConflictDoNothing`. It uses `DATABASE_URL_UNPOOLED` when set, because a transaction
pooler mishandles the session-level statements migrations issue.

Note this moved out of `npm run build`: the build no longer talks to production Postgres.
If you ever redeploy to a host without a pre-deploy hook, run `npm run db:deploy` yourself,
or use the secret-gated route:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/admin/migrate
```

## If you leave Neon
Beyond backups (above), two Neon behaviours don't carry over:
- **Connection pooling.** Neon's `-pooler` endpoint fronts PgBouncer. Railway Postgres is a
  plain instance, so `DATABASE_POOL_MAX` (per process, default 5) is the real limit — keep
  the sum across `web` + `cron` under the server's `max_connections`.
- **Region.** Co-locate the Railway services and the database, or every query pays the gap.

Once the cutover has held for a while, you can drop `@neondatabase/serverless` and the
`neon-http` branch in `lib/db/connect.ts` / `lib/db/client.ts`. No rush — it's inert unless
`DB_DRIVER=neon-http`, and it's what makes going back easy.

## Rollback
Railway keeps previous deployments — **Deployments → ⋯ → Redeploy** on the last good one.
Note that a rollback does **not** revert a migration; migrations are written to be additive
so an older image keeps working against a newer schema.
