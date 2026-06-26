# Arbor Lead Tracking — Project Context

Internal lead-tracking & ROI app for Arbor Management (tree service, Metro East IL —
Edwardsville + O'Fallon). WhatConverts-style. Single-tenant. Owner: Justin
(justin@arbor-mgmt.com). Companion to the `arbor-general` repo (business context + skills).

## What this app is
- **Native call tracking + DNI on Twilio** — we own the numbers, swap/forward/record/transcribe. Goal: replace CallRail.
- **Web/form tracking** via first-party `track.js` on arbor-mgmt.com.
- **Facebook lead-gen** via the MCP webhook.
- **ROI = attributed HousecallPro job revenue ÷ ad spend**, per source/campaign/location.
- **Ad spend + HCP reads go through the Arbor MCP server** (`execute_tools`) — this app holds NO Google/Meta/HCP credentials, only an MCP token.

## Stack & conventions
- Next.js App Router on Vercel · Neon Postgres · Drizzle ORM (`casing: snake_case`).
- Money in **integer cents**; phones in **E.164** (`lib/phone.ts`); IDs are **ULIDs**.
- Env access only via `lib/env.ts` (validated). Never read `process.env` directly.
- DB client is Neon **HTTP** (`lib/db/client.ts`). Phase 4 DNI leasing needs an interactive txn → use a short-lived `Pool` there.
- Auth: HMAC-signed session cookie + scrypt password (`lib/auth.ts`); single admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`. Middleware is a presence gate; the dashboard layout does the authoritative check.

## Key files
- `lib/db/schema.ts` — full data model (visitors, web_sessions, tracking_numbers, number_assignments, sources, campaigns, ad_spend, hcp_customers, hcp_jobs, leads, calls, form_submissions, facebook_leads, attributions, roi_daily, …).
- `app/api/twilio/voice/route.ts` — inbound call: resolve tracking number → assignment → source, spam check, persist call+lead, return forward TwiML. **Must respond <3s** — fallback-forwards on any error so no call is lost.
- `lib/mcp/client.ts` — `executeTool`/`executeTools` over MCP JSON-RPC.
- `lib/attribution/classify.ts` — click-id/utm/referrer → source key + DNI pool.

## Phases
1. Call tracking on **static** numbers (current scaffold). 2. HCP revenue + spend sync + ROI (Inngest). 3. `track.js` web/form. 4. Pooled DNI. 5. FB leadgen + LSA + Deepgram transcription + spam. 6. CallRail decommission.

## Defaults (Justin can change)
- v1 channels: calls + web forms + FB leadgen (SMS deferred).
- Call routing: office +16188368004 first (configurable).
- Attribution: last-touch default (first-touch toggle planned).
- CallRail history: start fresh.

## Watch-outs
- Twilio webhook idempotency on `twilio_call_sid`; Meta on `fb_leadgen_id`.
- IL/MO mixed-consent recording → recording notice is played to callers.
- E.164 normalization is load-bearing for lead↔HCP matching/ROI.
- MCP is a hard dependency for spend/revenue — use Inngest retries + rolling re-pulls.
- Re-pull spend on a rolling 7-day window (platforms restate) keyed `(platform, external_campaign_id, date)`.
