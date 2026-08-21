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
  pool numbers; the 5 published numbers are static. **`+16184278164` is no longer the static
  test line — it is now `Pool: Website 1`, making the DNI pool SIX numbers** (verified against
  `/api/diagnostics` 2026-08-21; check `pool.numbers` there rather than trusting this count).
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
- **✅ `userData`-only export is LIVE and the account is eligible** (verified 2026-08-17:
  `customer.conversion_tracking_setting.accepted_customer_data_terms: true` and
  `enhanced_conversions_for_leads_enabled: true`). This supersedes the earlier "not yet
  done" note. It is deliberately NOT a blanket widening: `USER_DATA_FALLBACK_SOURCES` in
  `lib/sync/conversions.ts` holds `google/cpc` alone, because "no click id ⇒ not from the
  ad" is false for exactly one shape of traffic — a STATIC number wired to a Google ad.
  Confirmed both ends of that chain: campaign 23633267649's CALL asset is `+16184145907`
  (ENABLED), which holds no DNI lease and so can never carry a gclid. Organic/GBP/direct
  stay out — uploading them invites Google to credit itself for traffic it never sent.
  **Check the two account flags before blaming the exporter for a missing call**: uploads
  are accepted whether or not they are set, so a wrong answer here is invisible.

### The conversion actions, and why nothing bids on them yet
All four are `UPLOAD_CLICKS`, ENABLED, `clickThroughLookbackWindowDays: 90` — which
exactly matches the exporter's 90-day window, so nothing is truncated at the far edge.

| stage | id | Google Ads name | category |
|---|---|---|---|
| lead | 7714104423 | Lead Created | CONTACT |
| qualified | 7695123530 | Estimate Created | QUALIFIED_LEAD |
| scheduled | 7714132224 | Estimate Scheduled | BOOK_APPOINTMENT |
| won | 7695519049 | Estimate Won | CONVERTED_LEAD |

**✅ `Estimate Created` is THE biddable signal on `Search | Tree Services` — and the ONLY
one** (switched and verified 2026-08-17; it was `Lead Created` from 2026-08-13). The
campaign now has exactly one biddable goal, `QUALIFIED_LEAD ~ WEBSITE`. Rationale and the
four goals that were switched off are below.

**⚠️ Do NOT read `conversion_action.include_in_conversions_metric` to answer "is this
bidding?" — it is false on all four and is not the whole story.** That field reflects the
ACCOUNT-level goal configuration. Bidding is decided by the **conversion goal**
`(category, origin)`, which a campaign can override, and campaign overrides do not write
back to the action. Read `campaign_conversion_goal.biddable` for the campaign that spends,
together with `conversion_action.primary_for_goal`. All four actions are `origin: WEBSITE`.

| goal (category ~ origin) | action | account | campaign 23633267649 | bidding? |
|---|---|---|---|---|
| `QUALIFIED_LEAD ~ WEBSITE` | Estimate Created (`primary: true`) | secondary | **biddable** | **YES** |
| `CONTACT ~ WEBSITE` | Lead Created (`primary_for_goal: true`) | secondary | not biddable | no |
| `BOOK_APPOINTMENT ~ WEBSITE` | Estimate Scheduled (`primary: false`) | biddable | not biddable | no |
| `CONVERTED_LEAD ~ WEBSITE` | Estimate Won (`primary: false`) | biddable | not biddable | no |

**⚠️ That table is the four UPLOAD actions only, and they were never the whole biddable
set — the trap that hid for four days.** Until 2026-08-17 campaign 23633267649 had **four**
biddable goals, three of them nothing to do with this app: `PHONE_CALL_LEAD ~
CALL_FROM_ADS` ("Calls from ads"), `CONTACT ~ CALL_FROM_ADS` (a Smart-campaign action; no
Smart campaigns run, so zero), and `SUBMIT_LEAD_FORM ~ WEBSITE` (only REMOVED actions
behind it — CallRail's Form Capture — so dead weight). Bidding optimizes the SUM of the
biddable goals, so **an ad caller was worth ~2 conversions and a form lead ~1**: the caller
fired "Calls from ads" at the click AND reached `+16184145907`, which exports as our own
lead. All three are now off. **Always enumerate `campaign_conversion_goal` rather than
reasoning from this app's four actions** — "we promoted Lead Created" was true and still
described only half of what was bidding.
  - **Size "Calls from ads" on a POST-cutover window, not `LAST_30_DAYS`.** Over 30 days it
    reads 21 and looks larger than Lead Created; over 8/08–8/16 it is **4.0** against Lead
    Created's 14.4 on this campaign. The difference is that most of the 30-day figure
    predates 8 Aug, when the old campaigns and their call assets were still serving. Any
    `LAST_30_DAYS` number straddles the cutover and describes two different setups.

**Stage volumes and lag, measured 2026-08-17** over 8/08–8/16 (there is no earlier data —
DNI went live at the cutover), by CONVERSION date, account-wide: Lead Created 16 ·
Estimate Created 15 · Estimate Scheduled 14 · Estimate Won 1. **Estimate Created is a
strict SUBSET of Lead Created by construction** — every lead that emits `qualified` also
emits `lead` — so the office writes an estimate for ~15 of every 16 exported leads. The
filtering a "real lead" signal would buy is already done upstream by the `isLead`/`isSpam`
gate. **Lag is not the differentiator either: 99.6% of Estimate Created lands <1 day from
the click** (`segments.conversion_lag_bucket` on `campaign`), indistinguishable from Lead
Created's 100%. The office writes the estimate during or right after the call. So choosing
between them is a question of WHO confirms the lead — a classifier or a human — not of
volume or delay.

**✅ The account defaults were the INVERSE of what is wanted; FIXED 2026-08-17.** They now
mirror the campaign: `QUALIFIED_LEAD ~ WEBSITE` is the account's only biddable goal, so a
campaign created without its own overrides inherits the right one. Before the fix the
biddable set was `PHONE_CALL_LEAD ~ CALL_FROM_ADS`, `SUBMIT_LEAD_FORM ~ WEBSITE`,
`BOOK_APPOINTMENT ~ WEBSITE`, `CONTACT ~ CALL_FROM_ADS`, `CONVERTED_LEAD ~ WEBSITE` — i.e.
a new campaign would have bid on Estimate Won and Estimate Scheduled, both far too thin to
learn on, and not on Estimate Created at all. Same shape as the tracking-template trap
above, where an account-level default silently governs a new campaign. **Still set campaign
goals explicitly on anything new** rather than trusting the inherited default to stay put.
  - Fixed with `googleads_update_customer_conversion_goal`, added to the Arbor MCP for this
    (`arbor-mcp-server` #212) — the catalog could read and write `campaign_conversion_goal`
    but had nothing for `customer_conversion_goal`, so this had been a UI-only job. Same
    ordering rule as the campaign switch: `QUALIFIED_LEAD ~ WEBSITE` was made biddable
    first, so the account was never left with zero biddable goals.
  - **Verified LSA is untouched**, as the paragraph below predicts: campaign 21142513191 is
    still ENABLED on MAXIMIZE_CONVERSIONS with zero `campaign_conversion_goal` rows.

**The LSA campaign does NOT run through the conversion-goal system, so account-level goal
changes cannot touch it** (established 2026-08-17, because it was the one thing blocking a
fix to the defaults above). Three independent checks agree: campaign 21142513191 has
**zero** `campaign_conversion_goal` rows (not zero biddable — zero), no
`customer_conversion_goal` exists with a `LOCAL_SERVICES_ADS` origin at all, and its
Conversions column over 8/08–8/16 is `local_services_phone_lead` 27 and nothing else. The
decisive one is the third: our `Estimate Scheduled` and `Estimate Won` uploads DO get
attributed to that campaign (1.0 each in `all_conversions`) and their categories
`BOOK_APPOINTMENT ~ WEBSITE` / `CONVERTED_LEAD ~ WEBSITE` **are** account-biddable — yet
both report `conversions: 0` there. If LSA inherited the account goals they would be
counted. It doesn't, so they aren't.
  - Worth knowing separately: Google cross-attributes some of our uploads to the LSA
    campaign (Lead Created 1.6, Estimate Created 0.8 over that window). That is Google's
    attribution, not our exporter — `google/lsa` is excluded from
    `USER_DATA_FALLBACK_SOURCES`. It muddies per-campaign ROI in the Ads UI only; the
    app's own `roi_daily` uses its own attribution and is unaffected.

**⚠️ A conversion action cannot be PAUSED.** The status enum is ENABLED / REMOVED / HIDDEN
— the API rejects `PAUSED` outright, and REMOVED is irreversible. So there is no cheap way
to tidy a dead-but-harmless action away; leave zero-volume ones ENABLED rather than
removing something a future campaign might need (the four Smart-campaign actions are in
exactly this state: ENABLED, 0 conversions over 90 days, no Smart campaigns running).

**⚠️ Goal changes apply FORWARD from the date they are made, never retroactively** —
verified 2026-08-17 by re-reading dates either side of two changes. `Estimate Created`
still reports `conversions: 0` for 8/13–8/16 although it is biddable now, and `Lead
Created` still reports 1–3/day for those same dates although it is switched off. **So the
"Conversions" column across the last two weeks is three different metrics stitched
together** (8/08–8/12 both actions · 8/13–8/16 Lead Created · 8/17+ Estimate Created), and
no cleanup can repair it — the history is frozen at whatever the config was on each day.
For any window spanning a change, segment `all_conversions` by `segments.conversion_action`
and read one action at a time.

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

**Decision (2026-08-17, Justin): ONLY `won` reports a dollar value.** `qualified` and
`scheduled` now send 0 — they used to send `leads.quote_value_cents`. A quote is not
revenue, and those stages could not have reported it honestly anyway: **HCP creates
estimates UNPRICED** (`total_amount: 0`; pricing lands on `options[]` later, per the
estimates-staleness watch-out) and **an export row only ever reaches `sent` once**, so
whatever the value was at cron time is frozen there forever. Measured result was $1,400
across 15 real estimates — a $93 average, i.e. mostly zeros with a couple of priced
stragglers. That is noise, not a conservative valuation. It was harmless while the
campaign bids on conversion COUNT (Maximize Conversions ignores value) and a live trap the
moment anyone selects Maximize Conversion Value or tROAS — which is why it is zeroed at
the source in `lib/sync/conversions.ts` rather than left for the bidder to find. Note this
also zeroes Meta's `Schedule` event value; `Purchase` (won) still carries `sales_value_cents`.
**Already-`sent` rows keep their old value** — the fix is forward-only, so the historical
$1,400 stays in the Ads UI and is not evidence of a regression.

**Decision (2026-08-17, Justin): `Estimate Created` replaces `Lead Created` as the biddable
signal, and it is now the ONLY biddable goal on the campaign.** The reasoning that settled
it: an estimate being written is a HUMAN confirming this was real business, where
`Lead Created` trusts the transcription classifier's `isLead` verdict — and a human
confirmation cannot drift the way a classifier can. The two objections both died against
measurement (see the stage volumes above): it is not thinner (~50/month vs ~53) and it is
not slower (99.6% inside a day). The residual costs are real but accepted — it couples the
bidding signal to how promptly the office writes estimates, and it puts the HCP sync and
`matchLeadsToEstimates` in the path, whose known gaps under-report repeat customers.

**Dropping "Calls from ads" was gated on one fact, and the check is worth repeating.**
Those callers reach a STATIC number, so they carry no gclid and can only export through the
`user_data` fallback — which matches `sources.key` against the literal string `google/cpc`.
If that mapping were anything else, turning the goal off would have deleted ~30 calls/month
from bidding silently. Verified via `GET /api/leads?type=call&hasClickId=false` (admin
token; the route exists for exactly this question): **7 of 7 callers to `+16184145907` in
the window came back `google/cpc`, none spam, 3 already carrying estimates.** Note the
population that query returns is dominated by `direct` (46) and `gbp` (24) — those are
static published numbers and are correctly NOT exportable; only the `google/cpc` slice is.
`/api/diagnostics` cannot answer this (it covers `is_static = false` numbers only) and the
Railway Postgres has no public TCP proxy, so the leads route is the reachable check.

**Sequencing mattered, and was deliberate:** promote only AFTER uploads are confirmed
flowing. Flipping first means the 90-day backfill lands as a single spike into a live
bidding signal, which reads as a sudden performance change that has nothing to do with the
ads. Backfill while observation-only, confirm the counts, then promote. **Same rule applied
to the goal switch itself:** `QUALIFIED_LEAD ~ WEBSITE` was made biddable BEFORE the other
four were switched off, so the campaign was never left with zero biddable goals.

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
- **An HCP `created_at` is truncated to WHOLE SECONDS, and `leads.occurred_at` is not.**
  `matchLeadsToEstimates` requires the lead to precede the estimate, so comparing the two
  directly makes an enquiry read as LATER than the estimate it produced whenever the
  estimate is written inside the same second — which the web-form automation does routinely
  (measured gaps of 0.5–1s). The lead is then never claimed, the estimate is unattributed
  forever, and the lead sits frozen at `new`. Found 2026-08-19: Jim Wiemers (+16183776379)
  submitted at 15:57:58.050 and `csr_ab13fcb79a104e8386b333959024e223` is stamped 15:57:58 —
  same phone, same email, 50 ms apart. Nine siblings from the same batch matched only because
  their estimate landed in the next second. The bound is now the END of the stamped second
  (`HCP_CREATED_AT_GRANULARITY_MS`, `lib/sync/attribution.ts`), which is still strictly under
  a second so no unrelated later enquiry can steal an old job. **Assume any HCP timestamp is
  second-granular before comparing it to something that carries milliseconds.**
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
- **A promoted channel does NOT reclassify the leads already in `other`.** `classifySource`
  runs once, at ingest, and the key is frozen onto the lead — so adding a mapping fixes every
  future lead and none of the rows that prompted the mapping. `lib/sources/reclassify.ts`
  re-runs the classifier over leads currently on `other` and moves the ones it now recognises —
  as `npm run db:reclassify-sources` (dry run; `-- --apply` to write) for a local DB, and as
  **`POST /api/admin/reclassify-sources?apply=true`** for production, which is the only way to
  run it there: the Railway Postgres has no public TCP proxy, so nothing outside the project's
  private network can reach the database. GET is always a dry run; writing needs BOTH a POST and
  the flag. It only ever moves a lead OFF `other`, never between
  mapped sources, so it cannot rewrite the source that earned a call. First use: the 18 Aug
  2026 SendGrid newsletter (`utm_source=newsletter&utm_medium=email`), 10 leads and 9
  estimates that were sitting in "Other / Unmapped" — now `email/newsletter`.
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
- **A short lease needs a LONG grace window, and the two are set independently** (2026-08-21).
  `LEASE_MINUTES` is a capacity control; `GRACE_MS` in `lib/twilio/inbound.ts` is how long after
  a lease ends a call on that number still resolves to it. They were both 15, so a visitor had
  ~30 minutes from their last pageview to dial before the call matched NO assignment — and pool
  numbers carry no `static_source_id`, so there is nothing to fall back to and the lead is
  written with a **null source**. That produced the first `leadButNoSource` this app has ever
  recorded (a call on 8/20 that self-reported "google search" and became an estimate). Grace is
  now **120 minutes**. Widening it further is cheap in one direction only: it changes nothing
  once the number has been re-leased, because the newest assignment wins, so the only thing a
  wide window buys is the risk of crediting a stale cached page to an hours-old lease — a WRONG
  answer where null is merely a coarse one.
  - **It is keyed on `expires_at`, not `released_at`, and that is load-bearing.** `released_at`
    is stamped by `releaseExpired()`, which runs opportunistically at the top of each
    `/api/dni/assign` request — so it lands seconds after expiry on a busy afternoon and can stay
    NULL for hours on a quiet evening, matching forever. The grace window was therefore a
    function of how much OTHER traffic the site got, which is unreproducible by construction.
  - The lookup this feeds is on the `/voice` hot path and both existing indexes are partial on
    `released_at IS NULL`, which this query deliberately does not filter on. Hence
    `number_assignments_number_expiry_idx` (migration 0038) — without it, a sequential scan on a
    table that grows with every lease.
- **The DNI rate limit is TWO limits, and neither is "10/min per IP"** (2026-08-21). That single
  limit conflated "a page needs one lease" with "one address is one visitor". Carrier CGNAT puts
  thousands of subscribers behind one address and an office is one address for everyone in it, so
  the first ten won and the rest got a 429 — and **a refused visitor keeps the published number,
  rings a static line, and lands in `direct`**, which reads as word of mouth. Measured over the
  7 days to 2026-08-21: **42 `rate_limited` exits against 317 non-bot requests, ~13% of real
  visitors**, none abusive. Now a generous per-IP flood ceiling (120/min) plus the real budget
  keyed on `vid` (10/min). `vid` is client-supplied and forgeable, which is why it cannot be the
  only limit — but the Origin gate, the bot check, `MAX_ACTIVE_LEASES_PER_VISITOR` and the IP
  ceiling all still stand in front of it.
  - **`coveredPct` in `swapCoverage` counts bots in its denominator, so it reads far worse than
    reality.** 64.5% over that window was `bot` 106 (correctly refused — a crawler never dials),
    `rate_limited` 42, `static_fallback` 2. Excluding bots it is 86%. Read the `byOutcome`
    breakdown, not the percentage.
  - The per-IP ceiling is what used to bound how much body the route would read. Raising it moved
    that guarantee, so `MAX_BODY_BYTES` now bounds it explicitly — the zod schema caps what is
    ACCEPTED, but only after `req.text()` has already buffered whatever was sent.
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
- **What `/api/dni/assign` decided is now COUNTED (`dni_outcomes`, `lib/dni/outcomes.ts`), because
  part of `direct` is not word of mouth — it is a failed swap.** The endpoint has eight exits and
  recorded none of them, and it cannot be reconstructed afterwards: `findShareableLease` hands a
  second visitor an EXISTING lease without writing a row, so a shared visitor and a refused one
  look identical in `number_assignments`. `swapCoverage` on `/api/diagnostics` splits a 7-day
  window into `leased` / `session_reuse` / `visitor_capped` / `shared` (covered) against `bot` /
  `rate_limited` / `origin_rejected` / `invalid_payload` / `static_fallback` / `none` / `error`.
  - **`coveredPct` is an UPPER BOUND, not a measurement**, and the note on the endpoint says so.
    It proves a pool number was handed out, never that it reached the page. The client-side half
    that would close that gap was deliberately NOT built: a browser beacon is blocked by exactly
    the things that break the swap, so its failures go unreported and coverage would read BETTER
    the more broken it got. Same shape as the Twilio webhooks failing closed for weeks while calls
    still connected. Do not add it without solving that.
  - **Counts are BUFFERED in-process and flushed on time/size, not written per request.** This is a
    public unauthenticated endpoint and the `bot` / `origin_rejected` exits sit in FRONT of the
    rate limiter, so a row per request would let a stranger drive our write volume. A redeploy
    drops up to a minute of counts; that is the right trade for a diagnostic rate and the wrong one
    for anything billable, so put nothing billable there.
  - The canary identifies itself with `CRON_SECRET` via `x-arbor-canary` and is counted as
    `canary`, excluded from the rate — a magic visitor id would let anyone label traffic synthetic.
- **`dni.canary` (hourly, `lib/sync/dni-canary.ts`) is the check that the swap still happens at
  all.** Four assertions: the site serves HTML referencing our `track.js`, `track.js` is served and
  still calls `/api/dni/assign`, that endpoint answers a browser-shaped POST with a number, and the
  number is a rotating POOL number rather than the static fallback. The fourth matters most —
  assign returns the static number rather than an error when the pool is dry, so a "successful"
  request can still mean every visitor is seeing a published number. **Being SYNTHETIC is the
  point:** it still fires when scripts are being blocked, which is exactly when a client-side
  measurement goes quiet. Copied from CallRail, which runs a daily fetch of one nominated URL and
  alerts when the snippet looks wrong; hourly here because the breakage arrives with a website
  deploy. It leases a real number each run and releases it in a `finally` — an unreleased canary
  lease would push a real visitor onto the fallback, i.e. the monitor causing the fault it watches
  for. Release is scoped to its own `web_session_id`, so a run handed a SHARED lease cannot release
  a customer's number mid-visit. **It does NOT verify the number reached the screen** — that needs
  a headless browser on the `cron` service, deliberately deferred; the SPA re-render risk is real
  but is already defended by the MutationObserver in `app/track.js/route.ts`.
- DNI leasing draws only from pools flagged `pools.is_dni`, so a number provisioned for a mailer
  (default pool `reserved`) can't be handed to website visitors before it's marked static.
  `number_assignments_active_idx` is UNIQUE — one active lease per number — and `leaseNumber`
  retries on the conflict rather than double-leasing.
- `/api/dni/assign` requires an `Origin` header; `/api/track` does not. The asymmetry is
  deliberate: a rejected assign just leaves the page on its static number, while a rejected form
  post is a lost lead. Rate limiting keys on the LAST `x-forwarded-for` hop — the first is
  client-supplied and gives a free bucket per request.
