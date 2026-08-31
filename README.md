# Arbor Lead Tracking & ROI

Internal lead-tracking and ROI app for **Arbor Management** — a WhatConverts-style
system that answers *"what lead sources produce what leads, and what's the ROI of each?"*

- **Native call tracking + DNI** on Twilio (own the numbers, swap/forward/record/transcribe).
- **Web + form tracking** via a first-party `track.js` snippet on arbor-mgmt.com.
- **Facebook lead-gen** ingestion via the existing MCP webhook.
- **Revenue from HousecallPro** job value → ROI per source/campaign/branch.
- **Ad spend** pulled from Google & Facebook through the **Arbor MCP server** (no ad
  credentials live in this app).

## Stack
Next.js (App Router) · Postgres (Neon or Railway) · Drizzle ORM · Twilio · Deepgram ·
Railway. See the full design in the plan and `CLAUDE.md`, and `DEPLOY.md` for the runbook.

Deployed as two Railway services off this repo: `web` (`npm run start`) and `cron`
(`npm run cron` — the scheduler in `scripts/cron.ts`).

## Getting started

```bash
npm install
cp .env.example .env.local        # fill in the values
npx tsx scripts/hash-password.ts 'your-admin-password'   # → ADMIN_PASSWORD_HASH
npm run db:generate               # generate SQL migrations from lib/db/schema.ts
npm run db:migrate                # apply to the database
npm run db:seed                   # seed canonical sources
npm run dev                       # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` + the password you hashed.

## Project layout

```
app/
  (dashboard)/          authed dashboard: overview, leads, calls, roi, spend, numbers, settings
  api/twilio/           voice · status · recording · whisper  (call tracking webhooks)
  api/auth/             login · logout
  login/                login page
lib/
  db/schema.ts          full Postgres schema (the backbone)
  db/client.ts          Neon HTTP drizzle client
  mcp/client.ts         Arbor MCP execute_tools wrapper (ad spend / HCP reads)
  twilio/               client · signature validation · TwiML builders
  attribution/classify.ts   source classification (click-id/utm/referrer → source + pool)
  auth.ts               HMAC session cookie + scrypt password
  phone.ts format.ts env.ts
scripts/                seed · hash-password
```

## Website tracking snippet
Add once to arbor-mgmt.com (e.g. in the root layout `<head>`):

```html
<script async src="https://app.arbor-mgmt.com/track.js"></script>
```

It sets first-party `arbor_vid`/`arbor_sid` cookies, captures UTM/click-ids/referrer/
GA client id, sends a pageview, and captures form submissions (add `data-arbor-ignore`
to any form you want skipped). Web-form submissions become `web_form` leads.

## Phased delivery
1. **Phase 1 (this scaffold):** native call tracking on static numbers — forward + whisper +
   record + voicemail; leads/calls dashboard. *Starts replacing CallRail.*
2. **Phase 2:** HCP revenue + Google/FB spend sync (scheduled) + ROI rollups.
3. **Phase 3:** `track.js` web + form tracking.
4. **Phase 4:** pooled DNI (`/api/dni/assign`, number leases, reaper).
5. **Phase 5:** Facebook lead-gen + LSA + Deepgram transcription + spam scoring.
6. **Phase 6:** full CallRail decommission.

## Prerequisites to go live (Phase 1)
- Twilio account + at least one purchased number (webhook → `/api/twilio/voice`).
- Neon database URL(s).
- `ARBOR_MCP_TOKEN` for the MCP server (Phase 2+).
- App subdomain (e.g. `app.arbor-mgmt.com`) and approval to add `track.js` to the site (Phase 3+).
