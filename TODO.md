# Open items

Deliberately-deferred work, with enough context to pick up cold. Decisions and
mechanisms that are already settled live in `CLAUDE.md` — this file is only what
is *not* done. Delete an entry when it ships; don't let it rot into history.

Last reviewed 2026-08-13.

---

## Google Ads attribution

### 1. Ad calls landing on the GBP number are credited to `gbp`
**Deferred 2026-08-13 — understood, not started.**

Campaign `Search | Tree Services` (23633267649) has an ENABLED `LOCATION_SYNC` asset
set ("Google My Business locations", place `ChIJhy0NLQn5dYgR6uQQL2IYgBE`). That is
deliberate and Justin considers it critical. Its side effect: an ad can surface the
Business Profile's phone number, so the call button dials `+16183682902` (GBP
Edwardsville) instead of the call asset `+16184145907`. The app then books a **paid
ad call as a `gbp` lead** — ad spend gets no revenue attached, GBP gets revenue it
did not earn, and the lead never exports (only `google/cpc` is in
`USER_DATA_FALLBACK_SOURCES`).

Measured on all three post-cutover ad calls, matched to Twilio by timestamp,
duration and area code:

| Google `call_view` | dur | landed on | source |
|---|---|---|---|
| Aug 9 09:17:05 | 144s | `+16184145907` | `google/cpc` ✅ |
| Aug 10 08:55:13 | 223s | `+16184145907` | `google/cpc` ✅ |
| Aug 12 08:56:31 | 190s | `+16183682902` | `gbp` ❌ |

So the call asset wins ~2 of 3; the leak is the location asset's own call
affordance. **1 of 3 is three data points — the real rate is unknown**, and the job
below would measure it as a side effect.

**Fix:** a sync job that pulls `call_view` via the existing GAQL path in
`lib/integrations/google-ads.ts`, matches each ad call to a `calls` row on start
time (±few seconds) + duration (±2s) + caller area code, and re-points the lead's
`sourceId` to `google/cpc` with `campaignId` from the call_view row.
`lib/sync/attribution.ts` rebuilds `attributions` and `roi_daily` hourly off those
columns, so ROI self-corrects.

Constraints, all load-bearing:
- `call_view` exposes only the caller's **area code**, never the full number.
  Matching is on timing, not identity — an ambiguous match must be SKIPPED, not
  guessed. Safe at ~1 ad call/day; revisit the matcher at 10x that.
- Its timestamps are in the **account timezone** — use `businessDate()` /
  America/Chicago, never `toISOString()`. Same trap documented for `roi_daily`.
- It **rewrites attribution after the fact**, against this codebase's
  snapshot-at-creation rule. Justified only because it corrects a known-wrong value
  from the authoritative source. Move one direction only (`gbp`/`direct` →
  `google/cpc`, never the reverse), log every match, stay idempotent.
- **Ship it together with item 2** — once these calls are correctly sourced they
  export as Lead Created, which re-creates the double count against Calls from ads.

Ruled out, so nobody re-litigates: Google Ads has **no webhook/push** for
`call_view` (pull-only API); a Google Ads script could POST out but is hourly too,
lives outside the repo, and fails silently; nothing rides along with the call
itself (PSTN forward, real caller ID, no metadata channel — verified); and there is
no number-level split available because one line genuinely serves both paid and
organic. Google forwarding numbers are already enabled account-wide and **do**
preserve caller ID — that earlier concern was wrong — but they don't distinguish
paid from organic at the destination either.

### 2. Retire `Calls from ads` as a biddable signal
Blocked on item 1. Today every call-asset call is counted twice — natively by
Google and by our Lead Created export. It stays biddable **only** because the
GBP-routed calls (item 1) are counted by nothing else; drop it now and those go
dark. Once item 1 lands, set campaign conversion goal
`PHONE_CALL_LEAD/CALL_FROM_ADS` to `biddable: false` on 23633267649. Keep the
action itself for reporting, exactly as Estimate Created was handled.

### 3. `SUBMIT_LEAD_FORM/WEBSITE` is biddable and orphaned
Form Capture fed it and was removed 2026-08-13, so it counts nothing — but any
future conversion action created with that category **inherits biddability
automatically**. That is precisely how Estimate Created ended up bidding without a
decision. One toggle to close; harmless until someone creates an action.

### 4. Promote `Estimate Scheduled`? — revisit ~2026-09-03
Not before 2-3 weeks of data. Click-id capture only began at the 08-08 cutover, so
every figure behind the current ranking rests on four days. **Prerequisite:** its
`eventTimestamp` comes from the estimate's *appointment* time and is clamped to
`now` in `lib/sync/conversions.ts`, so it currently lands at export time rather
than booking time. Tolerable for observation, not for a bidding signal.

### 5. Exporter drops `lost`/`cancelled` leads entirely
`lib/sync/conversions.ts` candidate filter admits only
`new/working/qualified/quoted/won`, so a lead already lost when the exporter first
sees it never emits **Lead Created** at all — biasing the highest-volume signal
toward leads that closed well. Real, but it *raises* volume into a live bidding
signal, so sequence it with item 4 rather than shipping it alone.

---

## Inbox / classification

### 6. Event-driven SMS classification
Texts are cron-only (`classify-messages`, every 5 min); calls are event-driven off
the recording callback. Worth ~4 minutes of Inbox freshness, **not** correctness —
since the SMS gate landed, an unclassified text simply waits for the next hourly
export. Needs a debounce: the 5-minute delay is accidentally doing that work, and
classifying on the first webhook would judge "Hi" alone and lock in the wrong
answer via the `isNull(is_lead)` guard.

### 6b. The classifier can silently degrade, and nothing reports it
`classifyCallLead` falls back to the keyword classifier in `lib/transcription/analyze.ts`
— an 11-phrase list — whenever the Anthropic key is missing or the API throws, and
returns `method: "ai" | "keyword"` saying which ran. **That field is computed and
then discarded; nothing persists it.** So a lapsed key or a bad hour at Anthropic
would keep writing `is_lead` verdicts at quietly worse quality, with no signal
anywhere — and `is_lead` is the gate that makes **Lead Created** trustworthy as the
biddable signal.

Measured 08-08→08-13: Lead Created 9.39 → Estimate Created 9.22 (**98%** of exported
leads got an HCP estimate) → Estimate Scheduled 8.00 (85%). That is good, but it is
*precision*, and it would read identically if half those verdicts had come from
keyword matching.

Fix: persist `method` on `leads` (or `calls`), and surface a keyword-fallback count
in `/api/diagnostics` alongside `failingExports`. Small, and it turns "are we sure
Lead Created is accurate?" from an inference into a reading.

### 7. Add `+16183103486` to `spam_rules`
Justin's personal number, used to test. `isHardSpamNumber` is checked on both the
voice and SMS webhooks, so a rule there keeps test calls and texts out of leads,
ROI and the exporter permanently. Data row, not a deploy.

### 8. Three pre-pool test calls on `+16184278164` — probably nothing to do
Jul 1, Jul 2 (both `+16187413530`, Justin testing with a real person) and Aug 5
(`+16183103486`, 9s). All predate the number joining the DNI pool. Recordings exist
at Twilio but `recoverMissingRecordings` only reaches back 7 days, so the July pair
was never transcribed → `is_lead` NULL → already invisible to Leads, ROI and the
exporter. Worth one glance in the Inbox to confirm, no more.

---

## DNI pool

### 9. `LEASE_MINUTES` is likely more conservative than needed
At 6 numbers × 15 min the ceiling is ~24 visitors/hour against a measured peak of 9
(GA4, 14 days) — the pool grew *and* the hold time was cut, each without the other
in view. A longer hold buys back session stickiness for a visitor who leaves and
returns. **Confirm `exhausted` is absent in `/api/diagnostics` across a busy period
first** — bursty arrivals exhaust a pool that average capacity says is fine. A
reversible experiment: raise to 25–30, watch for a few days, revert if it returns.

---

## Housekeeping

### 10. Legacy call assets point at untracked numbers
Old/paused campaigns carry call assets for `(618) 202-5224` — **not in the Twilio
account at all** — and `(618) 205-3094` (the Direct tracking number). Harmless while
those campaigns are inactive; audit before reactivating any of them.

### 11. Four Smart-campaign conversion actions cannot be removed
`Calls from Smart Campaign Ads` (557755099), `Smart campaign ad clicks to call`
(623648372), `map clicks to call` (561575986), `map directions` (578033931) all
return `MUTATE_NOT_ALLOWED` / `IMMUTABLE_FIELD` — Google system-generated. Zero
volume in 6 months and no Smart campaign exists to feed them. Recorded so nobody
retries the removal.
