UPDATE "ad_spend" SET "external_campaign_id" = 'unknown-' || "id" WHERE "external_campaign_id" IS NULL;--> statement-breakpoint
ALTER TABLE "ad_spend" ALTER COLUMN "external_campaign_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcribe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcribe_error" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE INDEX "calls_tracking_number_idx" ON "calls" USING btree ("tracking_number_id");--> statement-breakpoint
CREATE INDEX "hcp_estimates_created_hcp_idx" ON "hcp_estimates" USING btree ("created_at_hcp");--> statement-breakpoint
CREATE INDEX "hcp_estimates_updated_hcp_idx" ON "hcp_estimates" USING btree ("updated_at_hcp");--> statement-breakpoint
CREATE INDEX "leads_hcp_estimate_idx" ON "leads" USING btree ("hcp_estimate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_type_external_id_uq" ON "leads" USING btree ("type","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "number_assignments_expiry_idx" ON "number_assignments" USING btree ("expires_at") WHERE released_at IS NULL;