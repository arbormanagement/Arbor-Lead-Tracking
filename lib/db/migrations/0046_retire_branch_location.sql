-- Retire the `location` column from the four ATTRIBUTION tables.
--
-- `location` was a branch (Edwardsville / O'Fallon) stored per row, and it had three
-- writers: a static tracking number's configured branch, a `utm_campaign` match, and
-- — the reason this is a removal rather than a repair — a match on the PAGE URL, so
-- any visitor who merely read `/locations/edwardsville-tree-services` was recorded as
-- an Edwardsville contact whatever channel actually sent them. That produced Google
-- Ads estimates tagged with a branch they had nothing to do with.
--
-- The two Google Business Profiles are the only thing that genuinely names a branch,
-- and they already arrive as CAMPAIGNS: their website links carry
-- `utm_campaign=edwardsville` / `ofallon`, and since #137 each profile's own tracking
-- number carries the same campaign. So branch reporting derives from the campaign
-- (`branchExpr` in lib/queries/sources.ts) and the column is a second, dirtier copy.
--
-- The customer's actual city was never in here anyway — that is `hcp_estimates.address`,
-- the service address, which the estimates table already splits into street/city/state/zip.
-- Measured over the 12 GBP wins to 2026-08-30 the listing and the service city disagree
-- half the time, which is the whole argument: they are different questions.
--
-- `location` stays on `campaigns`, `tracking_numbers` and `pools`, where it is
-- CONFIGURATION — what an asset represents — rather than an inference about a person.

-- 1. Last use of the column: give any remaining GBP lead the campaign its branch
--    implies, so nothing loses its listing on the way out. This ran once from
--    `seedDefaults` (it is the step removed there in this change); repeating it is
--    a no-op because it only ever fills a NULL.
UPDATE "leads" l
SET "campaign_id" = c."id"
FROM "campaigns" c, "sources" s
WHERE c."source_id" = s."id"
  AND s."key" = 'gbp'
  AND c."platform" = 'other'
  AND c."external_campaign_id" = l."location"::text
  AND l."source_id" = s."id"
  AND l."campaign_id" IS NULL;
--> statement-breakpoint

-- 2. The unique key includes `location`, so it has to come off before the column can.
ALTER TABLE "roi_daily" DROP CONSTRAINT "roi_daily_key_uq";--> statement-breakpoint

ALTER TABLE "hcp_estimates" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "roi_daily" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "web_sessions" DROP COLUMN "location";--> statement-breakpoint

-- 3. Rows that differed ONLY by location are now duplicates of each other, and the
--    constraint below would refuse to be created. Collapse them by summing into the
--    oldest of each group — the same arithmetic the rebuild would do — rather than
--    keeping one and discarding the rest, which would quietly delete contacts,
--    estimates and spend from any day outside the rebuild window.
--
--    `runAttribution` rewrites the last 365 days on its next pass regardless (it is
--    delete-then-insert over the whole window), so this only has to be right for the
--    history behind that. The derived per-row rates are recomputed here from the
--    summed totals for the same reason: a rate carried over from one of the merged
--    rows would be arithmetically wrong for the row it now sits on.
WITH grp AS (
  SELECT "id",
         first_value("id") OVER w AS keep_id,
         sum("contacts_count")     OVER w AS c,
         sum("estimates_count")    OVER w AS e,
         sum("calls_count")        OVER w AS ca,
         sum("forms_count")        OVER w AS f,
         sum("won_count")          OVER w AS wo,
         sum("spend_cents")        OVER w AS sp,
         sum("revenue_cents")      OVER w AS rev,
         sum("quote_value_cents")  OVER w AS qv,
         count(*)                  OVER w AS n
  FROM "roi_daily"
  WINDOW w AS (
    PARTITION BY "date", "touch_type", "source_id", "campaign_id"
    ORDER BY "created_at", "id"
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
),
merged AS (
  UPDATE "roi_daily" r SET
    "contacts_count"    = g.c,
    "estimates_count"   = g.e,
    "calls_count"       = g.ca,
    "forms_count"       = g.f,
    "won_count"         = g.wo,
    "spend_cents"       = g.sp,
    "revenue_cents"     = g.rev,
    "quote_value_cents" = g.qv,
    "cost_per_estimate_cents"    = CASE WHEN g.e  > 0 THEN round(g.sp::numeric / g.e)  ELSE NULL END,
    "cost_per_acquisition_cents" = CASE WHEN g.wo > 0 THEN round(g.sp::numeric / g.wo) ELSE NULL END,
    "roi_ratio"                  = CASE WHEN g.sp > 0 THEN round(g.rev::numeric / g.sp, 4) ELSE NULL END
  FROM grp g
  WHERE r."id" = g."id" AND g.n > 1 AND g."id" = g.keep_id
  RETURNING r."id"
)
DELETE FROM "roi_daily" r
USING grp g
WHERE r."id" = g."id" AND g.n > 1 AND g."id" <> g.keep_id;
--> statement-breakpoint

-- 4. Same key, one column shorter. NULLS NOT DISTINCT is still load-bearing: source_id
--    and campaign_id are nullable and the unattributed row is the common case.
ALTER TABLE "roi_daily" ADD CONSTRAINT "roi_daily_key_uq" UNIQUE NULLS NOT DISTINCT("date","touch_type","source_id","campaign_id");
