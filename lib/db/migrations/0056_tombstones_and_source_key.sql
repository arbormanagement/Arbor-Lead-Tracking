ALTER TABLE "web_sessions" RENAME COLUMN "source" TO "source_key";--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "missing_from_hcp_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "missing_from_hcp_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD COLUMN "missing_from_hcp_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "missing_from_hcp_at" timestamp with time zone;