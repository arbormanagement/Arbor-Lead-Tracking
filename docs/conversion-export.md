# Closed-loop conversion export (Google Ads OCI + Meta CAPI)

Sends qualified/won leads (with dollar value) back to the ad platforms so bidding
can optimize toward **won revenue**, not just raw lead volume.

## Status (2026-07-27)

- **Meta — live.** Pixel/dataset id configured; the hourly job has sent 103 `Lead`
  and 15 `Purchase` events with zero errors. Every one matched by `leadgen_id`
  (all paid leads today are Meta lead forms).
- **Google — configured but idle.** "Estimate Created"/"Estimate Won" show 0
  conversions because **no lead carries a `gclid`** — Google traffic isn't landing
  through `track.js` yet. The blocker is web-tracking rollout, not this job.

## How it works

- **Trigger:** the hourly attribution run flips a lead `new → qualified → won`.
- **Job:** `conversions.export` (`lib/sync/conversions.ts`) — cron `/api/cron/conversions`
  hourly at `:37` (after attribution at `:22`); manual `POST /api/sync/conversions`.
- **Matching:** only leads that came from a paid click (or a Meta lead form) are
  eligible — `gclid`/`gbraid`/`wbraid` → Google Ads, `fbclid` or `leadgen_id` → Meta.
  `gbraid`/`wbraid` are the iOS/Safari click ids Google substitutes for `gclid`;
  exactly one identifier goes on each upload, and Google rejects them alongside
  `user_identifiers`, which we never send. Pooled-DNI call leads inherit the click
  id from their number lease (`number_assignments`). Organic/GBP/direct leads have
  no identifier and are correctly never uploaded.
- **Events:** `qualified` (value = quote) and `won` (value = approved amount).
  Google → two conversion actions; Meta → `Lead` / `Purchase`.
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
     lead status qualified/quoted, value = quote amount).
   - **"Estimate Won"** — category `CONVERTED_LEAD`, id `7695519049` (fires on won,
     value = approved amount).
   Verified after creation: `primaryForGoal=false` on both, and the primary
   campaign's (23633267649) new `QUALIFIED_LEAD`/`CONVERTED_LEAD` goals are
   **not** biddable — existing bidding untouched.
2. **Still planned:** a dedicated **Submit-Form** conversion action to send web-form
   leads to Google Ads (separate from the phone-call ones CallRail currently feeds).
3. **TODO:** in **Settings → Integrations → Google Ads**, hit **Choose from
   account** under the conversion-action fields and pick **Estimate Created**
   (`7695123530`) for *Qualified Lead* and **Estimate Won** (`7695519049`) for
   *Won Estimate* — the picker lists the account's import (upload) actions via
   `/api/settings/google-ads/conversion-actions`. Manual ID paste still works.
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

- Google Enhanced Conversions for Leads (hashed email/phone fallback when no click
  id) is not implemented; only click-id matching. This is intentional — no click id
  means the lead didn't come from the ad, so it shouldn't be uploaded anyway.
