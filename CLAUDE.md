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

### The conversion actions, and what actually bids on them
All four are `UPLOAD_CLICKS`, ENABLED, `clickThroughLookbackWindowDays: 90` — which
exactly matches the exporter's 90-day window, so nothing is truncated at the far edge.

| stage | id | Google Ads name | category | `primaryForGoal` | bids on `Search \| Tree Services`? |
|---|---|---|---|---|---|
| lead | 7714104423 | Lead Created | CONTACT | true | **yes** |
| qualified | 7695123530 | Estimate Created | QUALIFIED_LEAD | true | **yes — double-counts the lead** |
| scheduled | 7714132224 | Estimate Scheduled | BOOK_APPOINTMENT | false | no |
| won | 7695519049 | Estimate Won | CONVERTED_LEAD | false | no |

**⚠️ `includeInConversionsMetric: false` DOES NOT mean observation-only, and believing it
did is what let a double-count run live.** All four actions carry that flag, and two of
them are nevertheless in the Conversions column feeding `MAXIMIZE_CONVERSIONS`. The flag is
the legacy account-goal switch; in the goal-based world what counts is the pair
**(campaign's conversion goal for the action's CATEGORY is biddable) AND
(`conversion_action.primary_for_goal`)**. Neither half is visible on the action row you'd
naturally check.

Verified 2026-08-12 on `Search | Tree Services` (23633267649, `MAXIMIZE_CONVERSIONS`,
LAST_30_DAYS: 403 clicks, $7,352.67, `metrics.conversions` 77.410205). Segmenting by
conversion action sums to that figure EXACTLY — Calls from ads 21 + First Time Phone Call
16.002749 + Form Capture 26 + Estimate Created 7.216106 + Lead Created 7.19135. The three
actions that contribute nothing (Repeat Phone Call, Estimate Scheduled, Estimate Won) are
exactly the three with `primaryForGoal: false`. That correspondence is the proof; the
`includeInConversionsMetric` flag predicts none of it.

**Goals are keyed by CATEGORY, so a new action inherits whatever its category already
had.** This campaign does not use the account defaults — it carries campaign-specific goals
left over from CallRail, which made `CONTACT/WEBSITE` (then "First Time Phone Call") and
`QUALIFIED_LEAD/WEBSITE` (then "Website Phone Call") biddable. Creating Lead Created as
CONTACT and Estimate Created as QUALIFIED_LEAD dropped them straight into two live bidding
goals. The account-level goals are a different set again (`CONVERTED_LEAD/WEBSITE` and
`BOOK_APPOINTMENT/WEBSITE` biddable, `CONTACT`/`QUALIFIED_LEAD` not), so reading the
account tells you nothing about this campaign — **always read
`campaign_conversion_goal` for the campaign in question.**

**The live double-count (2026-08-12):** every exported lead fires Lead Created AND Estimate
Created, both biddable, so one customer counts twice. Daily since the 08-08 cutover —
08-08 1/1, 08-09 1/1, 08-10 2.19/2.22, 08-11 3/3 — a clean 1:1, i.e. ~100% inflation of
the signal `MAXIMIZE_CONVERSIONS` is spending against. A second, smaller overlap sits
beside it: a call to the call-only asset `+16184145907` fires Google's native **Calls from
ads** (biddable) and is ALSO exported by us as Lead Created via
`USER_DATA_FALLBACK_SOURCES`, so those calls count twice too.

None of this is an exporter bug. The exporter reports each stage once, dedupes on
`transactionId`, and is doing exactly what it was built to do — **which stages are allowed
to bid is a Google-side decision, and it was made by inheritance rather than deliberately.**

**Decision (2026-08-10, Justin):** promote **Lead Created** to the biddable signal; leave
Won as observation for now. Volume is the reason — 21 won leads against 211 qualified is
far too thin for Smart Bidding to learn on won revenue, and a value-based strategy fed
that sparsely optimizes noise. That decision is *satisfied* today; the problem is that
Estimate Created came along uninvited.

**✅ Fixed 2026-08-12:** campaign conversion goal `QUALIFIED_LEAD/WEBSITE` set to
`biddable: false` on 23633267649 (`googleads_update_campaign_conversion_goal`). Chosen over
clearing `primary_for_goal` on the action because it is scoped to the one campaign, and it
leaves Estimate Created reporting normally as the funnel-stage observation it was meant to
be. **Historical conversion counts are not restated, so the "Conversions" trend steps DOWN
on 08-12 for reasons that have nothing to do with performance** — and Maximize Conversions
re-learns against a signal roughly half its former size, so expect CPA figures to move
before the campaign settles. Do not read either as an ads problem.

Biddable goals remaining on this campaign: `CONTACT/WEBSITE` (Lead Created — the intended
signal), `PHONE_CALL_LEAD/CALL_FROM_ADS` + `CONTACT/CALL_FROM_ADS` (Calls from ads), and
`SUBMIT_LEAD_FORM/WEBSITE` — that last one is CallRail's Form Capture, biddable but fed
nothing since 08-07, so it is inert rather than wrong. The Calls-from-ads overlap described
above was left in place deliberately: it is Google's own count of a call-asset call, and
dropping it would leave nothing counting those calls whenever our classifier declines to
export one.

**CallRail's actions stopped on their own.** Form Capture (7054757256) and First Time Phone
Call (7054686637) last received data 2026-08-07, the day before cutover — both are still
ENABLED and still `primaryForGoal: true`, so they inflate any trailing-30-day total that
reaches back past 08-07, but they are not an ongoing double-count.

### "Estimate created" is NOT a quality gate in this HCP account
The obvious reading of the stage list — lead is a proxy, an estimate means the office
judged the job worth pricing — is wrong here, and it is worth knowing before anyone
promotes `qualified` on that reasoning (asked and checked 2026-08-12).

An HCP estimate is created **at intake, when the office books the visit**. Its `work_status`
is an appointment lifecycle, not a pricing decision: `needs scheduling`, `scheduled`,
`in progress`, `complete unrated/rated`, `user canceled`, `created job from estimate`.
Sampled 100 estimates spanning 08-06→08-12 — roughly 16/day, and that is a capped page so
it is a floor — of which 17 were `user canceled` and 10 became jobs.

Two independent lines of evidence say Estimate Created carries almost the same information
as Lead Created: the intake semantics above, and the ad data running exactly 1:1 (08-08
1/1, 08-09 1/1, 08-10 2.19/2.22, 08-11 3/3). A real qualification gate would show attrition
between the two stages. There is none. **So bidding on `qualified` buys the same
conversions several hours later, plus a dependency on office data entry** — strictly worse
than `lead`, which is already spam-filtered and (for calls) gated on classifier
`is_lead = true`, so it is not raw call volume either.

**The stage that actually discriminates is `scheduled`** — the customer committed to a
date — and unlike `won` its volume supports bidding: ~1.5/day post-cutover (~45/month)
against `lead`'s ~1.8/day. That makes it the candidate to promote, NOT `qualified`.
Before it can be, fix its timestamp: `scheduled` is dated from the estimate's APPOINTMENT
time and clamped to `now` at `lib/sync/conversions.ts`, so it currently lands at export
time rather than at booking time. Tolerable for an observation signal inside the 90-day
window; not something to bid on.

**Do not re-decide this on <2 weeks of data.** Click-id capture only began at the 08-08
cutover, so nothing before that ever exported — every figure above rests on four days.
All four actions keep reporting regardless of which one bids, so waiting costs nothing,
and changing the biddable signal twice in one week gives Smart Bidding two overlapping
learning periods and no attributable result.

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
  **And anything that READS leads must consult it via `QUALIFICATION_REQUIRED`, never by
  hand.** The predicate was restated as `or(ne(leads.type, "call"), eq(leads.isLead, true))`
  in four places — the overview, `/sources`, `attribution.ts` and the conversion exporter —
  and since `type != 'call'` is already true for a text, `is_lead` was never consulted in any
  of them. Every unclassified AND every classifier-REJECTED text counted as a lead: in the
  dashboard funnel, in `roi_daily`, and — worst — uploaded to Google as a Lead Created
  conversion, which cannot be retracted once sent. Only `/leads` was right, because it alone
  used `isQualifiedLead`. Fixed 2026-08-13; **the counts on those three surfaces step DOWN on
  that date from the correction, not from demand.** This is exactly the drift
  `lib/leads/qualified.ts` exists to prevent, so add a surface by importing from it.
- **A text's DNI lease is copied onto its lead at ingest** (`/api/twilio/sms`), mirroring
  `/api/twilio/voice`. There is no other route to it: neither `messages` nor `leads` carries
  a `number_assignment_id`, and `lib/sync/conversions.ts` reaches leases only by joining
  `calls`. Until 2026-08-13 the SMS route resolved the lease and discarded it, so a paid text
  landed with a NULL campaign and NULL gclid and exported to Google on a hashed phone alone.
  Do NOT reach for `conversations.number_assignment_id` instead — that is a FIRST-TOUCH
  snapshot of the thread, so a returning customer's new text would inherit the click id of a
  visit months ago. Copy on the INSERT path only: a follow-up text joining a lead already in
  flight must not rewrite the attribution that earned it.
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
  mint a parallel source. It also maps `utm_source=adwords` to `google/cpc` on the source
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
