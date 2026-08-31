ALTER TABLE "hcp_estimates" ADD COLUMN "line_items_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "line_items" jsonb;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "line_items_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "hcp_estimates_line_items_synced_idx" ON "hcp_estimates" USING btree ("line_items_synced_at");--> statement-breakpoint
CREATE INDEX "hcp_jobs_line_items_synced_idx" ON "hcp_jobs" USING btree ("line_items_synced_at");