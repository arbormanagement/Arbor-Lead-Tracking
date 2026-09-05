-- `disposition` replaces `is_lead`: why nothing came of an enquiry, NULL = pending.
--
-- The estimate is the ground truth for "was this business" and every metric already
-- counts estimates. What an estimate cannot say is NO — a real request nobody wrote
-- up versus a vendor, a wrong number, an existing customer with an invoice question.
-- `is_lead` was a boolean guess at the positive case; this keeps that one verdict
-- (`requested_work`, which the inbox and the Lead Created export need before an
-- estimate exists) and adds the reasons a NO can have. See leadDispositionEnum.
--
-- `is_lead`, `is_lead_manual` and `lead_reason` are dual-written for one deploy
-- cycle and dropped in the next migration.
CREATE TYPE "public"."lead_disposition" AS ENUM('requested_work', 'spam', 'not_business', 'existing_customer', 'missed');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "disposition" "lead_disposition";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "disposition_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "disposition_reason" text;
--> statement-breakpoint
-- Backfill from what the old columns already knew. Only rows nobody has dispositioned.
UPDATE "leads"
   SET "disposition" = CASE
         WHEN "is_spam" OR "status" = 'spam' THEN 'spam'::"lead_disposition"
         WHEN "is_lead" = false THEN 'not_business'::"lead_disposition"
         WHEN "is_lead" = true THEN 'requested_work'::"lead_disposition"
         WHEN "type" IN ('web_form', 'facebook_leadgen') THEN 'requested_work'::"lead_disposition"
         ELSE NULL
       END,
       "disposition_manual" = "is_lead_manual",
       "disposition_reason" = "lead_reason"
 WHERE "disposition" IS NULL;
