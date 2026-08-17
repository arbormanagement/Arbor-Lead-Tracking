# Closed-loop conversion export (Google Ads OCI + Meta CAPI)

Sends qualified/won leads (with dollar value) back to the ad platforms so bidding
can optimize toward **won revenue**, not just raw lead volume.

## Status (2026-08-11)

- **Meta — live.** Pixel/dataset id configured; the hourly job has sent 103 `Lead`
  and 15 `Purchase` events with zero errors, matched by `leadgen_id`.
- **Google — live since 2026-08-08.** `track.js` took over the same day CallRail's
  numbers transferred, and Google Ads shows the app's own actions firing from
  08-08: `Lead Created`, `Estimate Created`, `Estimate Scheduled` and one
  `Estimate Won`. The July note below ("configured but idle, no lead carries a
  `gclid`") described the pre-`track.js` state and no longer holds. Two live
  caveats:
  - **Values are sparse.** Only ~4 of 19 uploaded conversions carried a non-zero
    value in the first days, and `Estimate Won` ($325) came in below
    `Estimate Created` ($350) and `Estimate Scheduled` ($1,575). Uploading `$0`
    is worse than uploading nothing once anything bids on value — verify the
    per-stage value mapping before switching to Maximize Conversion Value.
  - **Double-counting is a Google-side setting, and is currently on.** `Lead
    Created` and `Estimate Created` are both `primary_for_goal`, and one customer
    legitimately fires both, so the same lead counts twice in bidding. This job is
    right to report each stage once; the account has to pick which one bids.

## How it works

- **Trigger:** the hourly attribution run flips a lead `new → qualified → won`.
- **Job:** `conversions.export` (`lib/sync/conversions.ts`) — cron `/api/cron/conversions`
  hourly at `:37` (after attribution at `:22`); manual `POST /api/sync/conversions`.
- **Matching:** `gclid`/`gbraid`/`wbraid` → Google Ads, `fbclid` or `leadgen_id` → Meta.
  `gbraid`/`wbraid` are the iOS/Safari click ids Google substitutes for `gclid`.
  Pooled-DNI call leads inherit the click id from their number lease
  (`number_assignments`). Organic/GBP/direct leads have no identifier and are
  correctly never uploaded. **Since the Data Manager migration a click id and
  hashed user identifiers ride the SAME event** (the old endpoint rejected that
  pairing), so hashed email/phone now go on every Google upload to widen the match.
- **No-click-id fallback for paid Google sources** — `USER_DATA_FALLBACK_SOURCES`
  in `lib/sync/conversions.ts`. A lead whose source is `google/cpc` but which
  carries no click id still exports, matched on hashed email/phone alone.
  This exists because **"no click id ⇒ not from the ad" is false for a static
  tracking number wired straight to a Google ad.** `+16184145907` is the call-only /
  call-extension asset on campaign `23633267649` (plus account-level asset
  `172222076754`), so a call to it can *only* have come from a Google ad — yet
  static numbers hold no DNI lease (`resolveInboundAttribution` returns
  `lease: null`), so there is no gclid to inherit and every one of those ~24
  calls/month was silently skipped. Google still counted them natively via its own
  `Calls from ads` action, but that action is value-1-per-call, so the won-estimate
  dollars never arrived — exactly the signal this job exists to deliver. The
  fallback also rescues paid web leads whose gclid was lost to an ad blocker or a
  stripped referrer.
  The allowlist is deliberately narrow — **not** "any lead with a phone". Organic,
  GBP, direct and referral leads lack a click id because they genuinely were not
  sent by an ad; uploading them invites Google to take credit for traffic it never
  sent. **`google/lsa` is deliberately excluded**: LSA numbers are static and have
  the identical problem, but LSA bidding does not run through these conversion
  actions, and a hashed phone can match a Search click by the same person —
  crediting Search for an LSA lead. Add it as a deliberate decision, not a default.
- **Events:** four stages — `lead` (the call or form itself), `qualified` (an estimate
  was written), `scheduled` (that estimate got a date), `won` (an option was approved).
  Google → one conversion action each; Meta → `Lead` / — / `Schedule` / `Purchase`
  (`qualified` has no Meta analogue).
- **Only `won` carries a dollar value** (2026-08-17); the other three send 0. A quote is
  not revenue, and the earlier stages could not report one honestly anyway: HCP creates
  estimates UNPRICED and an export row only ever reaches `sent` once, so the value would
  be frozen at whatever existed when the cron happened to run. Measured before the fix:
  $1,400 across 15 real estimates. Inert while bidding on conversion COUNT, and a trap
  under Maximize Conversion Value / tROAS.
- **Conversion time** is the HCP estimate's created/approved timestamp, not the lead
  time — an estimate approved weeks later reports at approval.
- **Idempotency:** `conversion_exports` table, unique `(lead, platform, event)`.
  A row only reaches `sent` once. Google uploads one conversion per request
  (no dedup key server-side, so our `sent` guard is the guard). Meta batches and
  dedups on `event_id = <leadId>:<event>`, so retries are safe there too.
- **Gated:** each destination runs only when configured (below). Until then the job
  no-ops with `skipped: "No conversion export destinations configured"`.

## Setup — Google Ads

1. ✅ **Conversion actions created 2026-07-23** (type `UPLOAD_CLICKS`, secondary /
   observe-only, one-per-click, 90-day click lookback, transaction-specific values):
   - **"Estimate Created"** — category `QUALIFIED_LEAD`, id `7695123530` (fires on
     lead status qualified/quoted).
   - **"Estimate Won"** — category `CONVERTED_LEAD`, id `7695519049` (fires on won,
     value = approved amount).
   Verified after creation: `primaryForGoal=false` on both, and the primary
   campaign's (23633267649) new `QUALIFIED_LEAD`/`CONVERTED_LEAD` goals are
   **not** biddable — existing bidding untouched.
   **Superseded 2026-08-17** on both counts: `QUALIFIED_LEAD ~ WEBSITE` is now the
   campaign's ONLY biddable goal, and Estimate Created no longer sends a value —
   only `won` does. See CLAUDE.md for the reasoning and the measurements behind it.
2. ~~**Still planned:** a dedicated **Submit-Form** conversion action.~~ Obsolete —
   the `lead` stage covers web-form leads, so a separate action would double-count.
3. ~~**TODO:** pick the conversion actions in Settings → Integrations.~~ Done; all
   four ids resolve from env (`GOOGLE_ADS_CONV_{LEAD,QUALIFIED,SCHEDULED,WON}`).
   Leaving one blank disables just that event.
4. **No new token needed** — the Ads OAuth scope (`adwords`) is already read+write;
   the existing refresh token can upload. Developer token must have Standard access.

**Do NOT reuse CallRail's existing actions** ("First Time / Repeat Phone Call",
"Form Capture", "Chat Received") — they're count-based (value = 1, no revenue) and
CallRail double-uploads into them during the parallel run. Retire those at cutover.

## Setup — Meta (Conversions API)

1. Get a **Pixel/Dataset ID** and a token that can write to it (system-user token
   with `ads_management`, or a dataset-specific CAPI token — the current `ads_read`
   token likely can't write events).
2. Enter in **Settings → Integrations → Facebook / Instagram**: *Conversions API —
   Pixel/Dataset ID* and (optionally) *Conversions API — Access Token* (falls back to
   the ads access token if blank). Blank pixel id disables CAPI export.

## Rollout

Run in parallel with CallRail, compare counts, then promote **Won Estimate** to
primary + switch the primary campaign to **Maximize Conversion Value / tROAS** and
pause CallRail's actions. Same shadow → validate → cutover path as `track.js`.

## Lag between lead and outcome

Estimates are often approved well after the lead arrives, so the job looks back
**90 days** (`sinceDays`, matching the conversion actions' click lookback). A lead
that ages past that never exports. Three ceilings sit above ours:

- **Meta rejects any `event_time` older than 7 days** — and errors the *entire*
  batch, not the one event. So late conversions are clamped to `now - 6d` rather
  than dropped. Attribution is unharmed: Meta ties the event to the original lead
  through `lead_id`/`fbc`, not through `event_time`.
- **Meta Conversion Leads optimization expects the lead stage within 28 days** of
  lead creation. Past that the `won` signal still uploads but stops feeding
  optimization — the practical reason to keep estimate turnaround under 4 weeks.
  (Observed 2026-07: mean 3.9 days, max 23.8 — inside the window, with little room.)
- **Google** attributes within the conversion action's 90-day click lookback.

## Known limitations (v1)

- ~~Google Enhanced Conversions for Leads (hashed email/phone fallback when no click
  id) is not implemented; only click-id matching. This is intentional — no click id
  means the lead didn't come from the ad, so it shouldn't be uploaded anyway.~~
  **Resolved 2026-08-11.** Two things made the old rationale wrong. The Data Manager
  migration removed the technical blocker (identifiers no longer have to travel
  alone, and a `userData`-only event is valid — see the `"userData only"` probe
  case). And the premise itself was false for static paid numbers: after the
  CallRail transfer, `+16184145907` carries Google call-extension traffic with no
  click id by construction. Scoped fallback added above; the "don't upload
  non-ad traffic" instinct survives as the allowlist.
