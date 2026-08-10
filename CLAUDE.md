# Arbor Lead Tracking — Project Context

Internal lead-tracking & ROI app for Arbor Management (tree service, Metro East IL —
Edwardsville + O'Fallon). WhatConverts-style. Single-tenant. Owner: Justin
(justin@arbor-mgmt.com). Companion to the `arbor-general` repo (business context + skills).

## What this app is
- **Native call tracking + DNI on Twilio** — we own the numbers, swap/forward/record/transcribe. Goal: replace CallRail.
- **Inbox + Leads are two different things, deliberately.** The **Inbox** (`/inbox`) is
  everything that came in on any channel — calls, texts, web forms, Facebook lead forms,
  later email — whether or not it turned out to be business. **Leads** (`/leads`) is only
  what has been confirmed to be an estimate request, per the single predicate in
  `lib/leads/qualified.ts`: not spam, nothing explicitly marked not-a-lead (any type), and
  for calls/texts an affirmative `is_lead = true` from the classifier or a human. `null`
  (unclassified) is NOT good enough. Triage — the Lead/Not toggle — lives in the Inbox and
  on lead detail; the Leads list has no toggle, because every row in it already qualifies.
- **The inbox is CONTACT-centric, not channel-centric.** One thread per person
  (`conversations`, unique on `contact_id`), holding every channel they've ever used.
  `contacts` + `contact_identifiers` are the identity spine: a form carrying both a phone
  and an email is what stitches "the number that called" to "the address that emailed".
  Merging is deliberately conservative — when a phone and an email point at *different*
  contacts we keep them separate and log it, because un-merging two real customers who
  share a household phone is far harder than tolerating a duplicate.
- **One thread, many leads.** A returning customer is one conversation with several leads
  over time. A follow-up text joins the lead already in flight (status new/working/
  qualified/quoted); a text arriving after the last one was won/lost starts a new lead, so
  repeat business still counts in ROI.
- **Texts (SMS/MMS) are two-way.** `app/api/twilio/sms/route.ts` attributes inbound texts
  exactly like a call and threads them; replies send from `/inbox/[id]` via
  `lib/messaging/send.ts`. Replies go out **from the tracking number the customer
  contacted** (`conversations.last_endpoint_key`) — replying from a house number would
  start a second thread on their phone and break attribution.
- **Consent is enforced in code, not just at the carrier.** `contacts.sms_opted_out_at` is
  set by STOP in the body and by Twilio error 21610, and blocks sends. It lives on the
  person, so it survives them starting a new thread. Inbound texts are still relayed to a
  human (Settings → Routing → *Text relay number* — separate from call forwarding, which
  points at the voice agent).
- **Web/form tracking** via first-party `track.js` on arbor-mgmt.com.
- **Facebook lead-gen** via the MCP webhook.
- **ROI = attributed HousecallPro won-estimate revenue ÷ ad spend**, per source/campaign/location. Revenue event = a customer-approved (won) estimate, valued at the approved-option amount (`hcp_estimates`); completed jobs are still synced (`hcp_jobs`) for secondary completed/invoiced visibility.
- **Read path is DIRECT to each platform API** (decision 2026-06-26): a background sync needs clean typed data + reliability, so we don't route it through the LLM-oriented MCP gateway. All spend/revenue access is behind `lib/integrations` (`SpendProvider`/`RevenueProvider`) so any provider can be swapped — including back to an MCP-backed impl. The MCP client (`lib/mcp/client.ts`) is retained as an optional per-platform fallback.
- Direct providers: `lib/integrations/housecallpro.ts` (API key), `google-ads.ts` (OAuth refresh → GAQL searchStream), `facebook.ts` (Graph insights). Sync jobs in `lib/sync/{spend,hcp}.ts`, recorded in `sync_runs`; admin trigger `POST /api/sync/{spend|hcp}`, scheduled by the `cron` worker (`scripts/cron.ts`) hitting `GET /api/cron/{job}`.

## Stack & conventions
- Next.js App Router on **Railway** · Postgres (Neon or Railway) · Drizzle ORM (`casing: snake_case`).
- Two Railway services off one repo: `web` (`railway.json`) and `cron` (`railway.cron.json`,
  runs `scripts/cron.ts` — the schedule that replaced Vercel Cron). Migrations run as the
  web service's pre-deploy step (`npm run db:deploy`), NOT during `npm run build`.
  Runbook: `DEPLOY.md`. No serverless execution ceiling — `maxDuration` exports are inert.
- Money in **integer cents**; phones in **E.164** (`lib/phone.ts`); IDs are **ULIDs**.
- Env access only via `lib/env.ts` (validated). Never read `process.env` directly.
- DB client (`lib/db/client.ts`) is driver-switchable via `DB_DRIVER`: `pg` (default,
  long-lived node-postgres pool — supports the interactive txn Phase 4 DNI leasing needs)
  or `neon-http` (stateless HTTPS, for serverless/edge or TCP-blocked networks).
- Auth: HMAC-signed session cookie + scrypt password (`lib/auth.ts`); single admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`. Middleware is a presence gate; the dashboard layout does the authoritative check.

## Key files
- `lib/db/schema.ts` — full data model (visitors, web_sessions, tracking_numbers, number_assignments, sources, campaigns, ad_spend, hcp_customers, hcp_jobs, leads, conversations, calls, messages, form_submissions, facebook_leads, attributions, roi_daily, …).
- `app/api/twilio/voice/route.ts` — inbound call: resolve tracking number → assignment → source, spam check, persist call+lead, return forward TwiML. **Must respond <3s** — fallback-forwards on any error so no call is lost.
- `app/api/twilio/sms/route.ts` — inbound text. Same resolution as `/voice` (shared in `lib/twilio/inbound.ts`) but fails **CLOSED** on an unverifiable signature: dead air loses a customer, an unverified write just lets someone forge leads. Idempotent on `MessageSid`.
- `lib/leads/qualified.ts` — the one definition of "this is really a lead", used by the Leads list, its counters, and the API so they can't disagree.
- `lib/contacts/resolve.ts` — identity resolution (phone/email → one person).
- `lib/contacts/link-hcp.ts` — **this app stores no customer data; it links to HousecallPro.** `contacts.hcp_customer_id` is matched on the same normalized phone/email key the ROI pipeline already uses, so a thread and its revenue agree on who the customer is by construction. Names are read through the join, never copied — a fix in HCP shows up immediately. Linking runs both ways: inline when a contact is first resolved, and as a sweep after each HCP sync (for the stranger who becomes a customer later). A match also **adopts the HCP record's other identifiers**, so someone who only ever texted is still recognized when they first email.
- `lib/messaging/thread.ts` — threading. Attribution snapshotted at thread creation only fills gaps afterwards, so a rotated DNI lease can't rewrite the source that earned the original call. `last_endpoint_key` is the deliberate exception — it must track the newest inbound endpoint because that's the reply-to.
- `lib/messaging/send.ts` — outbound SMS, consent-gated. **A2P 10DLC: brand `BNaaa7ccb11b86fc05a110ef1441fc0025`, campaign `CZPD8CT` (VERIFIED, LOW_VOLUME) on messaging service `MG2fea0b23db4aa369705393147cc857ba`.** A number only sends under that campaign once it's in the service's sender pool — as of 2026-08-09 **all 12 local numbers are in it**. (The unused toll-free `+18334791834` was released the same day; toll-free uses a separate verification track, not 10DLC.) The service has `use_inbound_webhook_on_number: true`, which is what keeps inbound texts arriving at each number's own `smsUrl` rather than being hijacked to the service.
- `lib/mcp/client.ts` — `executeTool`/`executeTools` over MCP JSON-RPC.
- `lib/attribution/classify.ts` — click-id/utm/referrer → source key + DNI pool.

## Inbox channels
Each channel keeps its own rich table and carries a `conversation_id`; the thread view
unions them into one timeline. There is no per-channel inbox table.
- **Calls** → `calls` (recordings, duration, transcripts have no message analogue).
- **Texts** → `messages`, `channel = 'sms'`, both directions.
- **Web forms** → `form_submissions` (jsonb answers).
- **Facebook lead forms** → `facebook_leads`.
- **Email** → the tab ships visible-but-empty. `messages` already stores it (`channel`,
  `subject`, `body`, `media`, RFC-822 `external_id`), so turning it on is an ingest route
  plus a mailbox decision — **not** a schema change. Nothing else should need to move.
- Adding a channel = enum value + `conversation_id` on its table + an ingest route calling
  `upsertThread` / `recordThreadActivity`. `conversations.channels` (a text[]) is what the
  channel tabs filter on, so "Texts" means "threads containing texts", not "threads whose
  newest message is a text".
- **`lib/messaging/channels.ts` is the client-safe half** (icons, labels, `preview`).
  `thread.ts` loads the Postgres driver — importing constants from it into a client
  component drags node-postgres into the browser bundle and fails the build.

## Phases
1. Call tracking on **static** numbers (current scaffold). 2. HCP revenue + spend sync + ROI. 3. `track.js` web/form. 4. Pooled DNI. 5. FB leadgen + LSA + Deepgram transcription + spam. 6. CallRail decommission.

**Phase 6 lives in the `arbor-general` repo** — `callrail-migration/` (plan, number
inventory, transfer mechanics) plus a summary in that repo's CLAUDE.md. It is vendor and
account knowledge, not app documentation, so it sits where every session sees it. Two
things from it that constrain this codebase:

- **✅ Phase 6 cutover DONE 2026-08-08.** All 10 CallRail numbers transferred into Arbor's
  Twilio account and were configured; the website cut over the same day (Arbor-Website
  PR #14 removed `swap.js` **and** `data-shadow` in one deploy). **Shadow mode is over —
  `track.js` now calls `/api/dni/assign` and owns the displayed number.** Verified live:
  session-sticky leases, distinct numbers per visitor, `gclid` frozen onto the lease, and a
  test call to a leased pool number completing cleanly. Pool = the 5 transferred CallRail
  pool numbers; the 5 published numbers plus test line `+16184278164` are static.
- **⚠️ `TWILIO_AUTH_TOKEN` must stay set on the Railway `web` service.** It was unset from
  the Railway migration until 2026-08-08, and because `/api/twilio/status` and
  `/api/twilio/recording` **fail CLOSED** (`sig === "unresolved"` → 403 in production;
  only `/voice` fails open), every status and recording callback was rejected and no
  recording was ever persisted. Calls still connected, so nothing surfaced in the app.
  **Diagnostic:** Twilio's Monitor Alerts API logs every non-2xx webhook response as error
  11200/15003 — `GET https://monitor.twilio.com/v1/Alerts?StartDate=…`. Railway logs showed
  nothing. Check it after any webhook or credential change; zero alerts is the pass
  condition.
- CallRail is **not cancelled** — recordings still need archiving, and the Google Ads + GA4
  conversion integrations still need rebuilding on the app's own actions. See
  `callrail-migration/conversion-signal-gate.md` in `arbor-general`.

## Conversion export → Google Ads (state as of 2026-08-10)

The exporter had **never once succeeded**: Google closed
`ConversionUploadService.UploadClickConversions` to new integrations, so every upload was
rejected on policy rather than on data. Rows sat at 22–26 attempts. The replacement is the
**Data Manager API** (`POST https://datamanager.googleapis.com/v1/events:ingest`,
`lib/integrations/data-manager.ts`), which is better than a like-for-like port in two ways:
a click id and hashed user identifiers may travel on the SAME event (the old API rejected
that pairing, so an organic call exported nothing), and `transactionId` gives real
server-side dedup, which is what the bolted-on attempt cap was standing in for.

- **Scope.** Data Manager needs `.../auth/datamanager`; the original token only had
  `.../auth/adwords`. Re-consent is now self-service: Settings → Integrations → Google Ads
  → **Connect** (`/api/oauth/google/start`). Done 2026-08-10.
- **⚠️ The Google OAuth client is SHARED with the Arbor MCP server**
  (`425178785038-…`, MCP redirect `https://arbor-mcp.up.railway.app/oauth/google/callback`).
  Adding a redirect URI and minting a token are both additive and safe. **Revoking the
  grant is not** — it kills every token on that client, including the MCP server's. Never
  suggest "revoke and retry" as a fix for something in this app.
- **Probes** (`/api/diagnostics/data-manager`, `validateOnly` so nothing is recorded):
  the default mode walks event ages, `?mode=shapes` validates the payload schema itself.
  Verified 2026-08-10: event ages 0/3/30/89 days all accepted, so the **90-day export
  window is usable** and the 72-hour figure in the docs does not bind here.

### The conversion actions, and why nothing bids on them yet
All four are `UPLOAD_CLICKS`, ENABLED, `clickThroughLookbackWindowDays: 90` — which
exactly matches the exporter's 90-day window, so nothing is truncated at the far edge.

| stage | id | Google Ads name | category |
|---|---|---|---|
| lead | 7714104423 | Lead Created | CONTACT |
| qualified | 7695123530 | Estimate Created | QUALIFIED_LEAD |
| scheduled | 7714132224 | Estimate Scheduled | BOOK_APPOINTMENT |
| won | 7695519049 | Estimate Won | CONVERTED_LEAD |

**All four are `includeInConversionsMetric: false` — observation only.** Conversions will
upload and appear in reports, and Smart Bidding will ignore every one of them. Fixing the
transport does not by itself change a single bid.

**Decision (2026-08-10, Justin):** promote **Lead Created** to the biddable signal; leave
Won as observation for now. Volume is the reason — 21 won leads against 211 qualified is
far too thin for Smart Bidding to learn on won revenue, and a value-based strategy fed
that sparsely optimizes noise.

**Sequencing matters, and is deliberate:** promote only AFTER uploads are confirmed
flowing. Flipping first means the 90-day backfill lands as a single spike into a live
bidding signal, which reads as a sudden performance change that has nothing to do with the
ads. Backfill while observation-only, confirm the counts, then promote.

**Revisit when:** won-estimate conversions are sustained (roughly 30+/month) — at that
point Estimate Won becomes a candidate for value-based bidding and this ranking should be
re-argued rather than assumed.

## Defaults (Justin can change)
- v1 channels: calls + web forms + FB leadgen (SMS deferred).
- Call routing: office +16188368004 first (configurable).
- Attribution: last-touch default (first-touch toggle planned).
- CallRail history: start fresh.

## Watch-outs
- Twilio webhook idempotency on `twilio_call_sid`; Meta on `fb_leadgen_id`.
- IL/MO mixed-consent recording → recording notice is played to callers.
- E.164 normalization is load-bearing for lead↔HCP matching/ROI.
- Scheduled jobs are fire-and-log: a failed run is logged and retried on the next tick, so
  the syncs must stay idempotent + self-healing (rolling re-pulls) rather than assume a retry queue.
  **Each job owns its own window policy — `/api/cron/[job]` deliberately passes no `sinceDays`.**
  Passing one short-circuits that policy (a hardcoded 7-day spend window silently disabled both
  the 35-day re-pull and the cold-start backfill until 2026-08-09).
- **One run per job at a time**, enforced by the partial unique index `sync_runs_one_running_uq`:
  `withSyncRun` claims it and returns `{skipped:true}` instead of interleaving. The cron worker's
  `protect` flag is not sufficient — it only serializes the worker's own fetch, so a tick that
  times out client-side leaves the handler running while the next one fires.
- **Anything aggregated by day must bucket with `businessDate()` (America/Chicago), including
  the window boundaries it is compared against.** Ad platforms report spend per account-timezone
  day; deriving a window edge from `toISOString()` while bucketing rows in CT desynchronizes the
  two and, in `roi_daily`, either aborts the rebuild on a unique violation or silently duplicates
  a day. `roi_daily_key_uq` is NULLS NOT DISTINCT because its source/campaign columns are
  nullable and unattributed rows are the common case.
- A text is NOT presumed to be a lead. `/api/twilio/sms` leaves `is_lead` null and the
  `classify-messages` cron decides from the body — same shape as calls, where the
  transcription sync decides. Anything that creates a call/text lead must leave that gate closed.
- Threading in `/voice` is best-effort (wrapped in try/catch — it must never cost a
  forward). The `thread-backfill` cron is the repair path for calls that missed it, and
  backfilled the pre-inbox history on its first runs.
- **Texts only work if the number's Twilio `smsUrl` is set.** `backfillNumberWebhooks`
  (hourly `twilio-fallback` cron) re-asserts it on every active number, which is how the
  ten CallRail-transferred numbers got it. Same Monitor Alerts diagnostic as below applies.
- Not every campaign is customer acquisition. Recruiting/brand campaigns are flagged
  `campaigns.excluded` (Settings → Campaigns) and are kept out of every ROI number —
  `roi_daily`, the overview funnel, the sources page, the `/leads` list — while their spend stays
  on record. **Exclusion is applied when READING, never by refusing to record**: dropping the
  `ad_spend` rows makes the loss permanent, since the re-pull only reaches back 35 days.
  The Facebook ingest also drops submissions from an excluded campaign, so applicants never
  become leads — and *defers* (rather than admitting) a submission whose campaign lookup
  failed, because `fb_leadgen_id` dedupe makes a wrong call irreversible. Predicate helpers
  live in `lib/campaigns.ts`; apply them to any NEW surface that reads `leads` or `ad_spend`
  directly, or recruiting dollars land in an ROAS denominator with no revenue behind them.
  **The inbox is such a surface, deliberately un-excluded:** a recruiting enquiry is still
  someone contacting the business, so it threads and shows in `/inbox` — it just never
  becomes a lead, so it stays out of ROI either way.
- Spend sync is self-healing (`lib/sync/spend.ts`): rolling 35-day re-pull (platforms restate) + automatic cold-start backfill reaching to each platform's earliest lead (≤365d — spend with no leads to match is deliberately not fetched), keyed `(platform, external_campaign_id, date)`. No manual backfills.
- DNI leasing draws only from pools flagged `pools.is_dni`, so a number provisioned for a mailer
  (default pool `reserved`) can't be handed to website visitors before it's marked static.
  `number_assignments_active_idx` is UNIQUE — one active lease per number — and `leaseNumber`
  retries on the conflict rather than double-leasing.
- `/api/dni/assign` requires an `Origin` header; `/api/track` does not. The asymmetry is
  deliberate: a rejected assign just leaves the page on its static number, while a rejected form
  post is a lost lead. Rate limiting keys on the LAST `x-forwarded-for` hop — the first is
  client-supplied and gives a free bucket per request.
