ALTER TABLE "hcp_estimates" ADD COLUMN "lead_id" text;--> statement-breakpoint
-- Carry every existing link across before the old column goes: one inquiry per
-- estimate was always true under the old model, so this is lossless. The next
-- attribution run re-derives the last ~120 days anyway (and links the second and
-- third estimates the old column could not hold); older rows keep this.
UPDATE "hcp_estimates" e SET "lead_id" = l."id" FROM "leads" l WHERE l."hcp_estimate_id" = e."id";--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT "leads_hcp_estimate_id_hcp_estimates_id_fk";
--> statement-breakpoint
DROP INDEX "leads_hcp_estimate_idx";--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD CONSTRAINT "hcp_estimates_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hcp_estimates_lead_idx" ON "hcp_estimates" USING btree ("lead_id");--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "hcp_estimate_id";--> statement-breakpoint
-- The setting's meaning changed with the link: it used to bound how long a WON
-- estimate with no lead of its own inherited the contact's prior lead; it now bounds
-- the link itself, for every estimate. Justin's chosen window is 30 days (2026-09-05),
-- so the stored 90 from the old meaning is replaced rather than carried over.
INSERT INTO "settings" ("key", "value") VALUES ('customer_window_days', '30'::jsonb)
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();
