# Closed-loop conversion export (Google Ads OCI + Meta CAPI)

Sends qualified/won leads (with dollar value) back to the ad platforms so bidding
can optimize toward **won revenue**, not just raw lead volume.

## How it works

- **Trigger:** the hourly attribution run flips a lead `new → qualified → won`.
- **Job:** `conversions.export` (`lib/sync/conversions.ts`) — cron `/api/cron/conversions`
  hourly at `:37` (after attribution at `:22`); manual `POST /api/sync/conversions`.
- **Matching:** only leads that came from a paid click are eligible —
  `gclid` → Google Ads, `fbclid` → Meta. Organic/GBP/direct leads have no click id
  and are correctly never uploaded.
- **Events:** `qualified` (value = quote) and `won` (value = approved amount).
  Google → two conversion actions; Meta → `Lead` / `Purchase`.
- **Idempotency:** `conversion_exports` table, unique `(lead, platform, event)`.
  A row only reaches `sent` once. Google uploads one conversion per request
  (no dedup key server-side, so our `sent` guard is the guard). Meta batches and
  dedups on `event_id = <leadId>:<event>`, so retries are safe there too.
- **Gated:** each destination runs only when configured (below). Until then the job
  no-ops with `skipped: "No conversion export destinations configured"`.

## Setup — Google Ads (DEFERRED, per Justin 2026-07)

Not yet done. When ready:

1. **Create two conversion actions** (type *Import* / `UPLOAD_CLICKS`), created as
   **Secondary / observe-only** first so they don't disturb current bidding:
   - **"Arbor Qualified Lead"** — category `QUALIFIED_LEAD`, value = transaction-specific.
   - **"Arbor Won Estimate"** — category `CONVERTED_LEAD`, value = transaction-specific.
   After creating, re-check `googleads_list_campaign_conversion_goals` on the primary
   campaign (23633267649) to confirm no goal flipped to biddable.
2. **Also planned:** a dedicated **Submit-Form** conversion action to send web-form
   leads to Google Ads (separate from the phone-call ones CallRail currently feeds).
3. Enter the two action IDs (or full resource names) in **Settings → Integrations →
   Google Ads**: *Conv. action — Qualified Lead* and *Conv. action — Won Estimate*.
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

## Known limitations (v1)

- Uses the lead's `gclid`/`fbclid` (not `gbraid`/`wbraid` iOS click ids, which aren't
  denormalized onto `leads` yet) — add those to the lead + this job to cover iOS.
- Google Enhanced Conversions for Leads (hashed email/phone fallback when no gclid)
  is not implemented; only click-id matching. This is intentional — no click id means
  the lead didn't come from the ad, so it shouldn't be uploaded anyway.
- Conversion time uses the lead's `occurred_at`; won conversions report at that time
  rather than the approval time (both are within Google's lookback window).
