ALTER TABLE "hcp_estimates" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "lead_source_raw" text;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "line_items" jsonb;