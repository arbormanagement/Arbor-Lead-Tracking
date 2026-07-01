ALTER TABLE "tracking_numbers" ADD COLUMN "greeting_message" text;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD COLUMN "greeting_enabled" boolean DEFAULT true NOT NULL;