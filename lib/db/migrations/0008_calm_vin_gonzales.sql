CREATE TYPE "public"."conversion_export_status" AS ENUM('pending', 'sent', 'error', 'skipped');--> statement-breakpoint
CREATE TABLE "conversion_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"platform" text NOT NULL,
	"event" text NOT NULL,
	"status" "conversion_export_status" DEFAULT 'pending' NOT NULL,
	"value_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"identifier" text,
	"identifier_type" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response" jsonb,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversion_exports" ADD CONSTRAINT "conversion_exports_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_exports_lead_platform_event_uq" ON "conversion_exports" USING btree ("lead_id","platform","event");--> statement-breakpoint
CREATE INDEX "conversion_exports_status_idx" ON "conversion_exports" USING btree ("status");