# Arbor Lead Tracking — Project Context

Internal lead-tracking & ROI app for Arbor Management (tree service, Metro East IL —
Edwardsville + O'Fallon). WhatConverts-style. Single-tenant. Owner: Justin
(justin@arbor-mgmt.com). Companion to the `arbor-general` repo (business context + skills).

## What this app is
- **Native call tracking + DNI on Twilio** — we own the numbers, swap/forward/record/transcribe. Goal: replace CallRail.
- **Inbox + Estimates are two different things, deliberately.** The **Inbox** (`/inbox`) is
  everything that came in on any channel — calls, texts, web forms, Facebook lead forms,
  later email — whether or not it turned out to be business. **Estimates** (`/estimates`) is
  the OPPORTUNITY list, counted from HousecallPro rather than from what we managed to track,
  per the single predicate in `lib/estimates/countable.ts`: **scheduled, and not cancelled**.
  - **This replaced a lead-anchored `/leads` page (2026-08-14, P3), and the unit is the
    point.** That page listed `leads` rows passing `isQualifiedLead`, so it could only ever
    show opportunities that arrived through a TRACKED CONTACT — and ~41% of estimate
    customers have no lead on any channel (repeat business, referrals, canvassing, estimates
    written in the field). Those were absent, not merely unattributed. `/leads` now redirects;
    `/leads/[id]` still exists as contact detail and estimate rows link to it.
  - **Conversion is computed off SCHEDULED estimates only** (confirmed by Justin
    2026-08-14). Estimates created and never scheduled are excluded and are not a working
    population — there were 34 in the last 30 days, none of them priced. `isQualifiedLead`
    still exists for Inbox triage (the Lead/Not toggle) but **no metric reads it**.
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
- **Credentials are ENV-ONLY (2026-08-12). There is no in-app credential store — don't add one
  back without reading this.** `lib/credentials` resolves purely from `lib/env.ts`; the DB
  store, its AES-GCM envelope (`lib/crypto.ts`), `CREDENTIALS_ENCRYPTION_KEY`, the write route
  and the Google Connect OAuth flow are all deleted. The reason is precedence, not encryption:
  a stored row silently outranked the variable a deploy sets, so the two could disagree with
  nothing on screen saying which was live. The Railway move carried the rows over but not the
  key, leaving 8 undecryptable rows that pinned `/api/diagnostics` to `ok:false` for weeks
  while the app ran on env fallbacks, plus `google_ads.refresh_token` which decrypted and
  shadowed env. **Side effect worth keeping: credential resolution no longer touches the DB,
  so it cannot fail on a blip — which matters because `/api/twilio/voice` must answer in <3s
  and `/status` + `/sms` fail CLOSED on an unresolvable auth token.**
  The `integration_credentials` table is still in the schema, empty, and read by nothing.
  **Re-consent for Google is now manual**: OAuth Playground against the shared client with
  `.../auth/adwords` + `.../auth/datamanager` typed into "Input your own scopes" (Data Manager
  is not in its product list), then paste into `GOOGLE_ADS_REFRESH_TOKEN`. Verify with a
  `grant_type=refresh_token` exchange and READ the returned `scope` — a consent that silently
  omits `datamanager` still returns a valid-looking token, and the exporter only fails later.
  Then confirm end-to-end with `/api/diagnostics/data-manager` (validateOnly, records nothing).
  **Never revoke the grant** to force a fresh token: the OAuth client is shared with the Arbor
  MCP server. Settings → Integrations is read-only status plus **Test**, which calls each
  provider — the only way to tell a working credential from a merely present one.
- DB client (`lib/db/client.ts`) is driver-switchable via `DB_DRIVER`: `pg` (default,
  long-lived node-postgres pool — supports the interactive txn Phase 4 DNI leasing needs)
  or `neon-http` (stateless HTTPS, for serverless/edge or TCP-blocked networks).
- Auth: HMAC-signed session cookie + scrypt password (`lib/auth.ts`); single admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD_HASH`. Middleware is a presence gate; the dashboard layout does the authoritative check.

## Key files
- `lib/db/schema.ts` — full data model (visitors, web_sessions, tracking_numbers, number_assignments, sources, campaigns, ad_spend, hcp_customers, hcp_jobs, leads, conversations, calls, messages, form_submissions, facebook_leads, attributions, roi_daily, …).
- `app/api/twilio/voice/route.ts` — inbound call: resolve tracking number → assignment → source, spam check, persist call+lead, return forward TwiML. **Must respond <3s** — fallback-forwards on any error so no call is lost.
- `app/api/twilio/sms/route.ts` — inbound text. Same resolution as `/voice` (shared in `lib/twilio/inbound.ts`) but fails **CLOSED** on an unverifiable signature: dead air loses a customer, an unverified write just lets someone forge leads. Idempotent on `MessageSid`.
- `lib/estimates/countable.ts` — the ONE definition of an opportunity (`isCountableEstimate`: scheduled, not cancelled), plus `isCancelledEstimate` as its exact complement so "Estimates" and "Cancelled" on `/sources` cannot drift. Copied from `arbor-reporting`, not invented: the same wins give a 25% close rate without it and 48% with it.
- `lib/leads/qualified.ts` — Inbox triage only. No metric reads it any more (P2/P3); it survives so the Lead/Not toggle keeps working.
- `lib/landing-page.ts` — `landingPathSql`, so `/sources` and `/pages` cannot disagree about what a page is. SQL rather than TS on purpose: grouping and display must use the same value, and normalising only at render is exactly how they came apart.
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
1. Call tracking on **static** numbers (current scaffold). 2. HCP revenue + spend sync + ROI. 3. `track.js` web/form. 4. Pooled DNI. 5. FB leadgen + Deepgram transcription + spam. 6. CallRail decommission.

**Surfaces (all estimate-anchored as of 2026-08-14):** `/` overview · `/inbox` threads ·
`/estimates` opportunities · `/sources` channels + campaigns + landing pages.
`/leads`, `/calls`, `/numbers`, `/spend`, `/roi`, `/pages` are redirects to their new homes.

**`/sources` is one page with three VIEWS** (`?view=channel|campaign|page`, 2026-08-15).
Campaigns and Landing pages were their own nav items; they are one question at three
grains, and three tabs meant three timeframes to keep in step by hand. **The views share
a shell, not a table, deliberately:** channel + campaign read `roi_daily` and carry spend,
while the page view reads `web_sessions` + `leads` and has none — cost attaches to a
campaign, not a page, and its whole point is a RATE, which needs the visitors who did NOT
convert in the denominator (`roi_daily` holds outcomes only, so they aren't in it).
Forcing one table would have meant an empty Spend column or dropping that rate. Note the
two windows differ: channel/campaign use `roi_daily`'s BUSINESS date, the page view uses
raw session/lead timestamps, so totals won't reconcile at a window edge. Views live in
`app/(dashboard)/sources/{channel,campaign,page}-view.tsx` with the shell in `page.tsx`.

**The two pages are two DIRECTIONS through one join** (`leads.hcp_estimate_id` →
`leads.source_id`), and both are now navigable. Every `/sources` row links to the
estimates behind it (`sources/drilldown.ts`), and `/estimates` accepts
`?source=&campaign=&page=&location=&type=` (`estimates/filters.ts`), rendering active
filters as removable chips. **`none` is a real value on every filter** — ~41% of
estimates have no lead at all, so "show me the unattributed ones" has to be askable
directly rather than by elimination. Each estimate row also shows its full chain
inline (source → campaign → landing page → keyword → self-reported), every value
linking to the list filtered by it. Two gotchas, both verified against the schema:
the drill-down counts won't match `/sources` exactly (different date buckets, as
above), and `leads.location` DEFAULTS to `'unknown'` rather than null, so a matched
contact with unknown location beats the estimate's own — the filter inherits that
from the column it filters, deliberately.

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
  nothing. Check it after any webhook or credential change. **The pass condition is zero
  11200/15003, not zero alerts.** A steady trickle of **32021** (SHAKEN/STIR: "'dest' value
  specified in PASSporT claim does not match SIP To header value") is expected and is not
  actionable: it fires on the INBOUND leg, where the originating carrier signed the call for
  the number the caller actually dialed. When an intermediary forwards that call on to a
  tracking number, the SIP To header no longer matches what was signed — a mismatch by
  construction. Hence most of them landing on the LSA number (Google forwards LSA calls) and
  a few on the ported published numbers. Verified 2026-08-12 against the four most recent:
  every one `completed`, 35–354s. Nothing in this codebase signs those legs.
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
  Use them before changing the payload — Google's parser is the authority, and its
  rejections are often generic enough that guessing costs more than probing.
  **Schema as confirmed 2026-08-10:**
  - event ages 0/3/30/89 days all accepted → the **90-day export window is usable**, and
    the 72-hour figure in the docs does not bind here.
  - click ids live at `adIdentifiers.{gclid,gbraid,wbraid}`. A flat `gclid` is
    `Cannot find field` — i.e. the obvious shape fails, and would have failed silently.
  - a click id and hashed `userData` validate **on the same event**, which the old upload
    endpoint refused. `userData` alone also validates, so leads with no click id are
    exportable for the first time (not yet enabled — see below).
  - `eventSource` ∈ {`WEB`,`APP`,`IN_STORE`,`PHONE`,`OTHER`}. `PHONE_CALL`, `OFFLINE` and
    `CRM` all read as plausible and are all rejected; one bad value fails the whole batch.
    Calls map to `PHONE`.
  - **`eventTimestamp` may not be in the future** — +1h and +7d are both rejected with a
    generic "There was a problem with the request" that names no field. This bit the
    `scheduled` stage, which is dated from the estimate's *appointment* time. Clamped to
    `now` at the transport boundary in `lib/sync/conversions.ts`.
- **A 200 from ingest means accepted for processing, not attributed.** Matching is
  asynchronous, so `sent` in `sync_runs` proves the payload was valid and the destination
  exists — only the Google Ads UI confirms a conversion actually landed.
- **First successful uploads: 2026-08-10** (8 events; the exporter had never once succeeded
  before that). `failingExports` / `abandonedExports` in `/api/diagnostics` are the place to
  look when that changes — the former exists because waiting for the attempt cap to expose
  an error means seeing it only after the row is out of retries.
- **Not yet done:** eligibility still requires a click id. Widening to `userData`-only
  (Enhanced Conversions for Leads) would make organic calls exportable, but needs the
  account's customer-data terms accepted and the setting enabled on each conversion action
  first — uploads are accepted either way, so getting this wrong is invisible.

### The conversion actions, and why nothing bids on them yet
All four are `UPLOAD_CLICKS`, ENABLED, `clickThroughLookbackWindowDays: 90` — which
exactly matches the exporter's 90-day window, so nothing is truncated at the far edge.

| stage | id | Google Ads name | category |
|---|---|---|---|
| lead | 7714104423 | Lead Created | CONTACT |
| qualified | 7695123530 | Estimate Created | QUALIFIED_LEAD |
| scheduled | 7714132224 | Estimate Scheduled | BOOK_APPOINTMENT |
| won | 7695519049 | Estimate Won | CONVERTED_LEAD |

**✅ DONE — `Lead Created` is live as the biddable signal on `Search | Tree Services`**
(verified 2026-08-13). The 2026-08-10 decision below has been carried out.

**⚠️ Do NOT read `conversion_action.include_in_conversions_metric` to answer "is this
bidding?" — it is false on all four and is not the whole story.** That field reflects the
ACCOUNT-level goal configuration. Bidding is decided by the **conversion goal**
`(category, origin)`, which a campaign can override, and campaign overrides do not write
back to the action. Read `campaign_conversion_goal.biddable` for the campaign that spends,
together with `conversion_action.primary_for_goal`. All four actions are `origin: WEBSITE`.

| goal (category ~ origin) | action | account | campaign 23633267649 | bidding? |
|---|---|---|---|---|
| `CONTACT ~ WEBSITE` | Lead Created (`primary_for_goal: true`) | secondary | **biddable** | **YES** |
| `QUALIFIED_LEAD ~ WEBSITE` | Estimate Created (`primary: true`) | secondary | not biddable | no |
| `BOOK_APPOINTMENT ~ WEBSITE` | Estimate Scheduled (`primary: false`) | biddable | not biddable | no |
| `CONVERTED_LEAD ~ WEBSITE` | Estimate Won (`primary: false`) | biddable | not biddable | no |

**The account defaults are the INVERSE of what is wanted, so a new campaign is a trap.**
A campaign created without its own goal overrides inherits the account's: it will bid on
Estimate Won and Estimate Scheduled — both far too thin to learn on — and will NOT bid on
Lead Created. Set campaign goals explicitly on anything new. Same shape as the tracking-
template trap above, where an account-level default silently governs a new campaign.

**Uploads are confirmed landing** (first end-to-end proof, 2026-08-13 — previously only
`sent` in `sync_runs`, which proves a valid payload and nothing about attribution). Last
30 days on campaign 23633267649, via `segments.conversion_action_name` on `campaign`:
Lead Created 7.39 · Estimate Created 7.22 ($1,400) · Estimate Scheduled 6.00 ($6,300) ·
**Estimate Won absent (zero)** — the estimates-staleness bug in the watch-outs, which
froze ~5 in 6 wins at `qualified` so almost nothing ever reached the `won` export stage.
That row is the check that the fix worked.

**Decision (2026-08-10, Justin):** promote **Lead Created** to the biddable signal; leave
Won as observation for now. Volume is the reason — 21 won leads against 211 qualified is
far too thin for Smart Bidding to learn on won revenue, and a value-based strategy fed
that sparsely optimizes noise.

**Sequencing mattered, and was deliberate:** promote only AFTER uploads are confirmed
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
  `roi_daily`, the overview funnel, the sources page, `/estimates`, `/roi` — while their spend stays
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
- **A Google Ads `DATE_TIME` field is a bare "yyyy-MM-dd HH:mm:ss" in the ACCOUNT'S
  timezone, with no offset.** `new Date()` on an offset-less string reads it as the SERVER's
  local time — UTC on Railway — so every value lands 5 hours early in summer, 6 in winter.
  Use `parseWallTime` (`lib/tz.ts`). Found 2026-08-14 because a Local Services lead and the
  call it produced showed as two contacts five hours apart; they match to the MINUTE once
  the offset is undone, which is what identified the cause rather than leaving it a guess.
  Display was the visible half — the load-bearing half is that `occurred_at` is what
  `roi_daily` buckets on, so anything between midnight and ~5am CT was counted on the
  previous business day. Verified the account reports `America/Chicago` rather than assuming.
- **Identity collapsed to ONE phone number in three places, and that was the single biggest
  source of false "unattributed" (fixed 2026-08-14).** `hcp_estimates.customer_phone_e164`
  and `hcp_customers.phone_e164` are both `mobile ?? home ?? work`, and matching was exact
  equality against them — but people ring from whichever handset they are holding. Of eleven
  estimates whose customer had a second number, THREE had real calls only on the number the
  app was ignoring. `hcp_customers.phones_e164` (text[], GIN) now holds every normalized
  number, `link-hcp` matches on overlap and adopts all of them, and `matchLeadsToEstimates`
  resolves the customer to a CONTACT and matches on `contact_id` with phone/email as the
  fallback. **Any new match key should go through the contact spine, not a column.**
- **The LSA leads pull is gone (2026-08-14) and should not come back without new evidence.**
  Every reason for it failed against the data: since the CallRail cutover the tracking line
  records LSA phone calls *more* completely than Google bills them (24 vs 19 over the first
  six days) and carries a transcript so they can be classified, which an API row never could;
  `MESSAGE` has produced nothing since 2024 and `BOOKING` nothing since 2026-04-05. **LSA cost
  is unaffected** — it comes from the campaign report (`advertising_channel_type =
  LOCAL_SERVICES`), never from that pull. `google/lsa` is still a source and `+16183669977`
  still its number, so calls attribute exactly as before. The 157 pre-cutover rows were
  deleted at Justin's direction; that history is to be re-imported from CallRail, and until
  it is, **Local Services shows near-zero attributed revenue for July/early August**.
- **The "~41% of estimates have no lead" figure was a WINDOW ARTEFACT — the real rate is
  ~18% (`/api/diagnostics/attribution`, measured 2026-08-15).** The original number was taken
  over "80 recent estimates" by appointment date, most of which were CREATED before the
  8 August CallRail cutover and so could never have been attributed. Over a 7-day created
  window (entirely post-cutover): **85 estimates, 70 attributed (82%)**, and `leadButNoSource`
  is **0** — there has never been a case where we tracked someone and failed to classify their
  source, so the DNI swap and `classifySource` are working. Any window reaching past 8 August
  measures the cutover, not the tracking: at 30d, 269 of 285 unattributed are pre-tracking; at
  365d, 2,501 of 2,517.
  - **The number that actually matters is not "attributed" but "attributed to a channel you
    can act on".** `direct` and `other` are real `sources` rows, so a call to a static published
    number counts as attributed while saying nothing. Week of 2026-08-15: `google/cpc` 14,
    `direct` 13, `gbp` 13, `google/lsa` 13, `facebook/paid` 10, `organic/seo` 5. So **26 of 85
    (31%) — 12 with no contact at all plus 13 `direct` plus 1 `other` — cannot be traced to a
    spendable channel.** That is the real target for a self-reported-source process, and the
    baseline to measure it against.
  - **`reachedUsButUnlinked` is small and is NOT accruing damage** (3 when checked). All three
    were explained: one was an estimate created 20 minutes earlier still waiting for the hourly
    `attribution` tick, and two were customers who generated more estimates than tracked
    enquiries — see the `matchLeadsToEstimates` note below. Expect a couple of in-flight rows
    in this bucket at any moment; it is a rolling window, not a leak.
- **One enquiry can only ever credit ONE estimate**, because `matchLeadsToEstimates` claims each
  lead exactly once. A customer who submits one form and gets two estimates from it leaves the
  second unattributed by construction (observed: a Google Ads form lead at 15:03 producing
  estimates at 15:03 and 22:22, only the first credited). This systematically understates paid
  channels wherever one visit produces several estimates. Not fixed — relaxing it risks
  double-counting revenue against a single click, so it needs a deliberate decision rather than
  a quiet change.
- Repeat customers are the other half of the unattributed tail and are genuinely unreachable by
  tracking: one customer in the sample had **20 estimates going back to 2018**. `self_reported_source`
  is the only instrument that does; it is now captured from web and Meta forms as well as call
  transcripts, deliberately before the website has the field. Note also that under LAST touch a
  repeat customer is unattributed BY DESIGN; both models are stored, so switching to first
  touch is a display filter and the drop in Unattributed is the repeat-business share.
- **An HCP estimate's `updated_at` does NOT move when an option is priced, approved,
  declined or expired** — all of that lives on `options[]`, which carries its own
  `updated_at`. Found 2026-08-13: `listEstimates` windowed on the header timestamp, so
  every estimate was read exactly once, at creation, when it is unpriced
  (`total_amount: 0`) and undecided (`approval_status: null`), and never again. Approvals
  were invisible — ~5 in 6 won estimates sat frozen at `qualified`, and the funnel showed
  a ~6% close rate against a real one near 30%. `estimateTouchedAt()` is the option-aware
  "when did this really change", and feeds `updated_at_hcp` so `attribution.run` re-derives
  late approvals. **Nothing about this was visible from inside the app** — the sync reported
  success, row counts looked healthy, and only comparing a lead against its estimate in HCP
  showed it. Treat "is this field really the last-modified?" as a thing to verify per
  endpoint, not assume.
- **Estimates sync in two zones, and there is no server-side delta to be had (probed
  2026-08-15, don't re-litigate without new evidence).** `updated_at[gte]`, `updated_at_min`,
  `updated_at_after`, `modified_since` and `since` all return the full 15,249 rows —
  identical to a parameter invented for the test — against a `scheduled_start_min` control
  returning 47. **HCP silently ignores unknown query params**, which is why `arbor-reporting`
  added `updated_at[gte]` and ripped it out 19h later, and why its `sort_field=updated_at` is
  also inert (HCP's param is `sort_by`; reporting therefore pages `created_at`, not what its
  docs claim). Options are not listable or sortable either (`sort_by=options.updated_at` →
  *"You may not sort by"*), and there is no change feed — `/events` is the crew calendar.
  - **Hot zone** (`ESTIMATE_HOT_PAGES`, 7 pages ≈ 1,400 newest ≈ 90 days), re-read every run.
    Sized from the measured decay curve, not a guess: cohorts sampled across 2017–2026 show
    100% of 26-day-old estimates changed in the last 30 days, 74% at 49d, 18% at 72d, then
    ~1% from 113d onward. **The cliff is ~60 days, not the 120 the old window assumed.**
  - **Cold zone** — `crawlEstimates`, a cursor walking the ENTIRE history a couple of pages
    per run (`ESTIMATE_CRAWL_PAGES_PER_RUN`), wrapping forever; full pass ~1.6 days. It exists
    because the change rate does NOT decay to zero: a 2017 estimate is as likely to move in a
    given month as a 2024 one (~2% vs ~3%), which across ~10k aged rows is 100–300 changes a
    month. No window of any width covers that. **Ascending on purpose** — `created_at` is
    immutable so new rows append at the END and the cursor is stable; crawling descending
    shifts rows between pages mid-pass and drops them silently. Cursor lives in `settings`
    under `hcp.estimates.crawl`.
  - Writes are skipped when nothing meaningful moved (`setWhere` on the upsert), so a pass
    costs ~77 reads and a handful of writes rather than 15k. `raw` is deliberately excluded
    from that comparison — HCP reshapes it during its own backend work, so diffing it would
    mark nearly every row changed.
  - **`estimateSync` on `/api/diagnostics` is the check that the above is actually working**:
    our row count vs HCP's `total_items` (recorded by the crawl, so the endpoint stays a pure
    DB read), plus hours since the last completed pass. Deletions are SOFT upstream, so drift
    should sit at 0 forever and any divergence is a real gap, not noise.
- **Deleting an estimate in HCP is a soft delete and it stays in the API forever.** There is
  no `deleted` work_status and no header `deleted_at` — the only trace is every
  `options[].status` being `deleted` (measured: 120 of 2,048 rows, 5.9%). In practice HCP
  also sets the work_status to `user canceled`/`pro canceled`, so `CANCELLED_STATUSES` was
  already excluding these from the RATE; `isDeletedEstimate` in `lib/estimates/countable.ts`
  now tests the marker directly so a deleted estimate left at `needs scheduling` cannot be
  LISTED as an open opportunity either. **Do not add a prune/delete path** — nothing legitimately
  disappears upstream, so there is nothing to reconcile away, and the diagnostics drift number
  is what would tell us if that ever changed. If it does: tombstone, never hard delete.
- Spend sync is self-healing (`lib/sync/spend.ts`): rolling 35-day re-pull (platforms restate) + automatic cold-start backfill reaching to each platform's earliest lead (≤365d — spend with no leads to match is deliberately not fetched), keyed `(platform, external_campaign_id, date)`. No manual backfills.
- **The ad platforms' UTM templates are part of this app's input contract, and they drifted
  (audited + fixed 2026-08-12).** Google Ads applies the most specific tracking template only —
  ad > ad group > campaign > account — so an ad-group template silently defeats a correct
  campaign one. Arbor's four ad groups emitted `utm_source=adwords&utm_medium=<ad group prose>`
  and the account default emitted `utm_medium={adname}`, which is not a real ValueTrack
  parameter and passed through literally. All five are now consolidated into one campaign-level
  template on `Search | Tree Services` (23633267649). **`utm_campaign` must carry
  `{campaignname}`, NOT `{campaignid}`** — `/api/twilio/voice` links a lease to a campaign by
  matching `campaigns.name`, so an id there resolves to null. The account-level default still
  holds the old `{adname}` string and can only be edited in the Google Ads UI (no API tool);
  it is shadowed for every live campaign, so it bites only a campaign created without its own.
- Both Google Business Profiles link to the site as `utm_source=google+my+business` — which
  arrives as `"google my business"`, since `+` decodes to a space. `classifySource` therefore
  compares utm values **squashed** to letters and digits, so a spelling change in a tag can't
  mint a parallel source. **They are NOT otherwise identical, and an earlier reading of this
  note that assumed so was wrong (corrected 2026-08-14 against the live GBP API):** each
  profile tags its own link `utm_campaign=edwardsville` / `ofallon`, and each has its own
  tracking number ((618) 368-2902 / (618) 350-4451, both labelled on `tracking_numbers`). So
  GBP *is* separable per profile — calls via the number, web clicks via `utm_campaign`, both
  landing on `leads.location`, which `roi_daily` already keys on. It also maps `utm_source=adwords` to `google/cpc` on the source
  alone: the mediums beside it are prose, and those URLs stay bookmarked and cached long after
  the templates that minted them are fixed.
- **Pool capacity is set by HOLD TIME, not pool size** — `LEASE_MINUTES` ÷ numbers is how many
  visitors an hour the pool can serve, and the lease window is pushed forward on every pageview,
  so it is idle time after the LAST one. At 30 minutes the 5 numbers served ~7.5 visitors/hour
  against a measured peak of 9 (GA4, 14 days), so the pool sat exhausted through busy hours and
  those visitors got the static fallback — which is the site's own published number, so their
  sessions are indistinguishable from untracked direct traffic. Cut to 15 on 2026-08-12.
  **Reach for hold time before buying numbers:** CallRail's published rule (pool = peak hourly
  visitors ÷ 4, min 4) returns 4 for Arbor, so 5 numbers was never the constraint — it ran the
  same 5 for the same traffic without exhausting. `exhausted` in `/api/diagnostics` is the
  signal; if it returns, `MAX_ACTIVE_LEASES_PER_VISITOR = 2` is the next lever (CallRail
  assigns one per session).
- **Two visitors with IDENTICAL attribution share one number** (`findShareableLease`, checked
  before leasing). The pool exists to tell sources apart, and `roi_daily` keys on
  (date, source, campaign, location) — so two `direct` visitors with no click id already land
  on the same row and separate numbers buy nothing, while consuming capacity a gclid visitor
  can't do without. **A click id is never shared in either direction**: it identifies one
  specific ad click, so two visitors behind it is a wrong answer rather than a coarse one.
  The cost is that a shared caller's lead carries the other session's `landing_page` (`/voice`
  resolves the newest assignment), so same-landing-page candidates are preferred first. Sharing
  extends the lease window like a real pageview, or the number could lapse mid-visit and be
  re-leased to someone else — the one way this could turn coarse into wrong. Comparisons use
  `IS NOT DISTINCT FROM`, since these columns are usually null and `= null` would match nothing
  and silently disable the whole thing.
- **Crawlers are refused a lease** (`lib/bot.ts`, applied in `/api/dni/assign` only). A bot
  never dials the number but holds one for the full window. GA4 filters known bots from its
  reporting and `track.js` does not, which is the likely explanation for GA4 showing 3 active
  users against 5 leases in 13 minutes on 2026-08-12. An absent user-agent counts as a bot: a
  false positive costs one visitor their attribution, a false negative costs a pool slot for
  15 minutes and can cost several. `/api/track` is deliberately NOT gated — pageview capture is
  cheap and unbounded, and filtering there would change what the site records, not what the
  pool spends.
- DNI leasing draws only from pools flagged `pools.is_dni`, so a number provisioned for a mailer
  (default pool `reserved`) can't be handed to website visitors before it's marked static.
  `number_assignments_active_idx` is UNIQUE — one active lease per number — and `leaseNumber`
  retries on the conflict rather than double-leasing.
- `/api/dni/assign` requires an `Origin` header; `/api/track` does not. The asymmetry is
  deliberate: a rejected assign just leaves the page on its static number, while a rejected form
  post is a lost lead. Rate limiting keys on the LAST `x-forwarded-for` hop — the first is
  client-supplied and gives a free bucket per request.
