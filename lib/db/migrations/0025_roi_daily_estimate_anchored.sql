-- roi_daily becomes estimate-anchored.
--
-- Renames rather than drop/add, so the table keeps its rows through the deploy.
-- It is fully derived either way (rebuildRoiDaily deletes and re-inserts the whole
-- 365-day window on every attribution run), but a rename means the dashboard is
-- never briefly blank between the migration and the next run.
--
-- The names change because the MEANINGS change, and leaving the old names on the
-- new numbers is exactly the failure this whole change exists to fix:
--   leads_count         → contacts_count      (demand: people who got in touch)
--   qualified_count     → estimates_count     (opportunity: countable HCP estimates)
--   cost_per_lead_cents → cost_per_estimate_cents  (spend ÷ estimates, not ÷ contacts)
ALTER TABLE "roi_daily" RENAME COLUMN "leads_count" TO "contacts_count";--> statement-breakpoint
ALTER TABLE "roi_daily" RENAME COLUMN "qualified_count" TO "estimates_count";--> statement-breakpoint
ALTER TABLE "roi_daily" RENAME COLUMN "cost_per_lead_cents" TO "cost_per_estimate_cents";
