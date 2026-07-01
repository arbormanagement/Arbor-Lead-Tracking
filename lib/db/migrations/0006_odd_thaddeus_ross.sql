ALTER TABLE "hcp_estimates" ADD COLUMN "customer_phone_e164" text;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "customer_email_lc" text;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "customer_name" text;--> statement-breakpoint
CREATE INDEX "hcp_estimates_phone_idx" ON "hcp_estimates" USING btree ("customer_phone_e164");--> statement-breakpoint
CREATE INDEX "hcp_estimates_email_idx" ON "hcp_estimates" USING btree ("customer_email_lc");