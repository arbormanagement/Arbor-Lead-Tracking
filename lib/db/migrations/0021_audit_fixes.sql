--> Audit fixes: turn three silent-corruption races into database invariants.
--> Each new constraint is preceded by the cleanup that makes it satisfiable —
--> existing rows already violate all three, and migrations run as the web
--> service's pre-deploy step, so an unguarded CREATE UNIQUE INDEX here would
--> abort the release rather than ship.

--> 1. sync_runs: at most one in-flight run per job.
--> Reconcile any pre-existing concurrent/zombie `running` rows, keeping the most
--> recent per job. Without this the unique index cannot be built.
UPDATE "sync_runs" SET
  "status" = 'error',
  "finished_at" = COALESCE("finished_at", now()),
  "error" = COALESCE("error", 'superseded — concurrent run reconciled by migration 0021')
WHERE "status" = 'running'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("job") "id" FROM "sync_runs"
    WHERE "status" = 'running' ORDER BY "job", "started_at" DESC
  );--> statement-breakpoint

--> 2. number_assignments: at most one active lease per tracking number.
--> Release the losers of any double-lease race that already happened, keeping the
--> newest lease per number (which is the one the voice route would have resolved).
UPDATE "number_assignments" SET "released_at" = now()
WHERE "released_at" IS NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("tracking_number_id") "id" FROM "number_assignments"
    WHERE "released_at" IS NULL ORDER BY "tracking_number_id", "assigned_at" DESC
  );--> statement-breakpoint

--> 3. roi_daily: one row per (date, source, campaign, location).
--> Collapse duplicates left behind by the UTC/CT rebuild-boundary bug. IS NOT
--> DISTINCT FROM matches the NULLS NOT DISTINCT semantics of the new constraint,
--> so this removes exactly the rows it would reject. Values are not merged: the
--> next attribution run rebuilds the whole 365-day window from source data.
DELETE FROM "roi_daily" a USING "roi_daily" b
WHERE a."id" > b."id"
  AND a."date" = b."date"
  AND a."source_id" IS NOT DISTINCT FROM b."source_id"
  AND a."campaign_id" IS NOT DISTINCT FROM b."campaign_id"
  AND a."location" IS NOT DISTINCT FROM b."location";--> statement-breakpoint

DROP INDEX "roi_daily_key_uq";--> statement-breakpoint
DROP INDEX "number_assignments_active_idx";--> statement-breakpoint
CREATE INDEX "attributions_touch_type_idx" ON "attributions" USING btree ("touch_type");--> statement-breakpoint
CREATE INDEX "calls_created_at_idx" ON "calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "leads_campaign_idx" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_one_running_uq" ON "sync_runs" USING btree ("job") WHERE "sync_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "number_assignments_active_idx" ON "number_assignments" USING btree ("tracking_number_id") WHERE released_at IS NULL;--> statement-breakpoint
ALTER TABLE "roi_daily" ADD CONSTRAINT "roi_daily_key_uq" UNIQUE NULLS NOT DISTINCT("date","source_id","campaign_id","location");
