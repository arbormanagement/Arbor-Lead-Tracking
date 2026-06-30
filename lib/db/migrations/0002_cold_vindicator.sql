ALTER TABLE "tracking_numbers" ADD COLUMN "forward_destination" text;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD COLUMN "whisper_message" text;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD COLUMN "record_calls" boolean DEFAULT true NOT NULL;