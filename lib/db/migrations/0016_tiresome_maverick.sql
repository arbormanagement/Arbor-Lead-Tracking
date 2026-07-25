ALTER TABLE "leads" ADD COLUMN "external_ad_id" text;--> statement-breakpoint
ALTER TABLE "number_assignments" ADD COLUMN "content" text;--> statement-breakpoint
CREATE INDEX "leads_external_ad_idx" ON "leads" USING btree ("external_ad_id");--> statement-breakpoint
UPDATE "leads" SET "external_ad_id" = fl."fb_ad_id" FROM "facebook_leads" fl WHERE fl."lead_id" = "leads"."id" AND fl."fb_ad_id" IS NOT NULL AND "leads"."external_ad_id" IS NULL;
