DROP INDEX "leads_status_idx";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "quote_value_cents";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "sales_value_cents";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "is_lead";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "lead_reason";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "is_lead_manual";--> statement-breakpoint
DROP TYPE "public"."lead_status";