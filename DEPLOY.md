# Deployment runbook — Arbor Lead Tracking

Everything below is done **once** to take the app live on Vercel. The code is ready;
these are the dashboard/CLI steps. Order matters.

## 0. Generate secrets (local)
```bash
openssl rand -hex 32   # NEXTAUTH_SECRET
openssl rand -hex 32   # COOKIE_SIGNING_SECRET
openssl rand -hex 32   # CREDENTIALS_ENCRYPTION_KEY   (rotating this re-keys stored creds)
openssl rand -hex 32   # CRON_SECRET
npx tsx scripts/hash-password.ts 'your-admin-password'   # ADMIN_PASSWORD_HASH
```

## 1. Database (Neon)
1. Create a Neon project → a Postgres database.
2. Copy the **pooled** connection string → `DATABASE_URL`.
3. Copy the **unpooled/direct** string → `DATABASE_URL_UNPOOLED` (migrations use this).

## 2. Migrate + seed (local, against Neon)
```bash
cp .env.example .env.local   # fill DATABASE_URL + DATABASE_URL_UNPOOLED at minimum
npm install
npm run db:migrate           # applies lib/db/migrations/* (NOT auto-run on deploy)
npm run db:seed              # canonical sources
```

## 3. Vercel project
1. **New Project** → import `arbormanagement/Arbor-Lead-Tracking` (deploy this branch, or
   merge it to `main` first). Framework: Next.js (auto-detected).
2. Add **Environment Variables** (Production + Preview). Infrastructure secrets:
   - `DATABASE_URL`, `DATABASE_URL_UNPOOLED`
   - `NEXTAUTH_SECRET`, `COOKIE_SIGNING_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`
   - `ADMIN_EMAIL=justin@arbor-mgmt.com`, `ADMIN_PASSWORD_HASH=<hash from step 0>`
   - `APP_BASE_URL` (the deploy URL — update after first deploy)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
     `TWILIO_DEFAULT_DESTINATION=+16188368004`, `TWILIO_VOICE_WEBHOOK_BASE`
   - `FACEBOOK_VERIFY_TOKEN` (any string; reused when subscribing the FB webhook)
   - **Platform API keys (HCP / Google Ads / Facebook / Deepgram) can be skipped here** and
     entered later in the app under **Settings → Integrations** (encrypted at rest).
3. **Deploy.**

## 4. Point things at the deploy URL
1. Grab the deployment URL (or add a custom domain `app.arbor-mgmt.com` — CNAME, then set it).
2. Set `APP_BASE_URL` and `TWILIO_VOICE_WEBHOOK_BASE=https://<domain>/api/twilio`; redeploy.

## 5. Twilio
- For each tracking number, set the **Voice webhook** → `https://<domain>/api/twilio/voice`
  (HTTP POST). Or just use the in-app provisioner (**/numbers → Add number**), which buys a
  number and wires the webhooks automatically.

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
1. Log in at `https://<domain>` with `ADMIN_EMAIL` + your password.
2. **Settings → Integrations** → paste HCP / Google / FB / Deepgram keys → **Test** each.
3. **Spend** page → **Run sync now** → confirm `sync_runs` + data populate.
4. Place a test call to a tracking number → it should appear under **Calls** / **Leads**.

## Scheduled jobs (Vercel Cron)
`vercel.json` defines the cron schedule (reaper 5m, transcribe 10m, hcp/attribution hourly,
spend/lsa daily). Vercel auto-sends `Authorization: Bearer $CRON_SECRET` to `/api/cron/*`.

- **Vercel Pro**: schedules work as-is.
- **Hobby plan** (max 2 crons, daily only): trim `vercel.json` to a single daily entry,
  e.g. `{ "path": "/api/cron/revenue", "schedule": "0 7 * * *" }` (the `revenue` job runs
  hcp → spend → lsa → attribution in one shot). The reaper/transcribe sub-daily jobs then
  need Inngest or an external pinger; or run them via the in-app "Run sync now" button.

Manual trigger (any plan): `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/revenue`
