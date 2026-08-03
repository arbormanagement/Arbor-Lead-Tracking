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

- **Keep Neon** (nothing to migrate): reuse the existing `DATABASE_URL` (pooled) and
  `DATABASE_URL_UNPOOLED` (direct). Put the Railway service in a region near the Neon
  project to keep round-trips short.
- **Railway Postgres**: add a Postgres service to the project, then set
  `DATABASE_URL=${{Postgres.DATABASE_URL}}` on `web`. `DATABASE_URL_UNPOOLED` is a
  Neon concept (Neon serves pooled and direct endpoints at different hostnames);
  Railway Postgres has one URL, so leave it unset and everything falls back to
  `DATABASE_URL`. Copy existing data first:
  ```bash
  pg_dump --no-owner --no-acl "$NEON_UNPOOLED_URL" > arbor.sql
  psql "$RAILWAY_DATABASE_URL" < arbor.sql
  ```
  Do the dump during a quiet window — anything written to Neon after it is not copied.

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

## Cutting over from Vercel
Do these in order so no inbound event is dropped or double-processed:

1. Deploy `web` + `cron` on Railway and verify with the steps above, while Vercel is still
   serving the live domain. Both point at the same database — safe, because `cron` on
   Railway is the only scheduler at this point (`vercel.json` was deleted in this change,
   so the Vercel deployment no longer has crons of its own).
2. Move the domain: remove `app.arbor-mgmt.com` from the Vercel project, add it to the
   Railway `web` service, and update `APP_BASE_URL` / `TWILIO_VOICE_WEBHOOK_BASE`.
   If you're switching domains rather than moving one, re-point the Twilio voice webhooks
   (or run `twilio-fallback`) and update the `<script src>` on arbor-mgmt.com.
3. Watch a real call land end-to-end under **Calls**.
4. Delete the Vercel project.

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
Neon gives you a few things Railway Postgres does not do identically. Before cutting the
database over, decide about each:
- **Backups / point-in-time restore.** Neon does this by default. On Railway, enable
  backups on the Postgres service — this is the one that bites hardest if skipped.
- **Connection pooling.** Neon's `-pooler` endpoint fronts PgBouncer. Railway Postgres is a
  plain instance, so `DATABASE_POOL_MAX` (per process, default 5) is the real limit — keep
  the sum across `web` + `cron` under the server's `max_connections`.
- **Region.** Co-locate the Railway services and the database, or every query pays the gap.

## Rollback
Railway keeps previous deployments — **Deployments → ⋯ → Redeploy** on the last good one.
Note that a rollback does **not** revert a migration; migrations are written to be additive
so an older image keeps working against a newer schema.
