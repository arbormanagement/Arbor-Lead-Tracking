ALTER TABLE "review_requests" ADD COLUMN "sms_undeliverable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_requests" ADD COLUMN "sms_undeliverable_code" text;