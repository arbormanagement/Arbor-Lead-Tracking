ALTER TABLE "hcp_customers" ADD COLUMN "crawl_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "crawl_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD COLUMN "crawl_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "crawl_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "hcp_customers_crawl_seen_idx" ON "hcp_customers" USING btree ("crawl_seen_at");--> statement-breakpoint
CREATE INDEX "hcp_estimates_crawl_seen_idx" ON "hcp_estimates" USING btree ("crawl_seen_at");--> statement-breakpoint
CREATE INDEX "hcp_invoices_crawl_seen_idx" ON "hcp_invoices" USING btree ("crawl_seen_at");--> statement-breakpoint
CREATE INDEX "hcp_jobs_crawl_seen_idx" ON "hcp_jobs" USING btree ("crawl_seen_at");