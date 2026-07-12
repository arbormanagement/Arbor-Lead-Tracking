CREATE TABLE "manual_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"month" date NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "self_reported_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "self_reported_source" text;--> statement-breakpoint
ALTER TABLE "manual_spend" ADD CONSTRAINT "manual_spend_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "manual_spend_source_month_uq" ON "manual_spend" USING btree ("source_id","month");