# Ad-level ROAS tracking — one-time ad-account setup

The app attributes leads to **individual ads** by reading the platform's ad id
off the click URL (`utm_content`). FB lead-gen submissions carry the ad id
natively; everything else needs the ad platforms to stamp it — a one-time
settings change in each ad account. Until it's done, per-ad Leads/Revenue/ROAS
on the Spend page stay empty for web-click traffic (spend/clicks per ad still
show; data accrues only from the day the template goes live — nothing is
retroactive).

## Google Ads (covers Search; LSA and PMax have no per-ad reporting)

Account level, so it applies to every campaign automatically:

1. Google Ads → **Admin → Account settings → Tracking** (label varies slightly
   by UI version; it's the account-level "Tracking template / Final URL suffix"
   screen).
2. Set **Final URL suffix** to:

   ```
   utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}
   ```

   `{creative}` expands to the ad's numeric id; `{keyword}` gives keyword-level
   reporting as a bonus. Use the **Test** button on that screen to confirm the
   landing page still loads.
3. Leave auto-tagging (gclid) ON — it's independent of this.

Prefer the *final URL suffix* over a tracking template: it appends parameters
without redirect risk.

## Meta / Facebook Ads (for website-click campaigns; lead forms need nothing)

URL parameters live on the **ad** level in Ads Manager. Set the default once and
it applies to new ads; existing active ads must be edited once:

1. Ads Manager → edit the ad → **Tracking → URL parameters**, set:

   ```
   utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}
   ```

2. Repeat for each currently-active website-traffic ad (or duplicate-replace).
   Lead-gen (on-Facebook form) ads can be skipped — their leads carry the ad id
   through the API already.

## What flows where (no further action)

- `track.js` already captures `utm_content` → web-form leads get
  `external_ad_id` (guarded: paid traffic + numeric id only).
- DNI phone leases freeze `utm_content` in the attribution snapshot → pooled
  calls get `external_ad_id` the same way.
- FB lead-gen ingest copies the ad id from Meta directly (historical rows
  backfilled by migration 0016).
- Spend page → "Individual ads" joins `leads.external_ad_id` to
  `ad_spend_ads.external_ad_id` for per-ad Leads / Revenue / ROAS.

## Reading per-ad ROAS honestly

At Arbor's lead volume a single won estimate swings an ad's ROAS hard. Use the
per-ad view to find ads that spend without ever producing leads, and trust
campaign-level ROAS for budget decisions.
