-- roi_daily carries BOTH attribution models side by side.
--
-- Existing rows were computed last-touch, so they are labelled that way and the
-- first-touch half is written by the next attribution run (which rebuilds the whole
-- 365-day window from source anyway — nothing here needs backfilling by hand).
--
-- touch_type joins the uniqueness key. Without it the two models collide on the
-- same (date, source, campaign, location) and the rebuild aborts on the constraint.
-- NULLS NOT DISTINCT is retained for the same reason it was there before: source_id
-- and campaign_id are nullable and unattributed rows are the common case.
ALTER TABLE "roi_daily" ADD COLUMN "touch_type" "touch_type" DEFAULT 'last' NOT NULL;--> statement-breakpoint
ALTER TABLE "roi_daily" DROP CONSTRAINT IF EXISTS "roi_daily_key_uq";--> statement-breakpoint
ALTER TABLE "roi_daily" ADD CONSTRAINT "roi_daily_key_uq" UNIQUE NULLS NOT DISTINCT("date","touch_type","source_id","campaign_id","location");
