ALTER TABLE "leads" ADD COLUMN "attribution_set_manually_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "attribution_manual_note" text;