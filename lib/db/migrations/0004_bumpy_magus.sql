CREATE TABLE "hcp_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"hcp_estimate_id" text NOT NULL,
	"hcp_customer_id" text,
	"status" text,
	"won" boolean DEFAULT false NOT NULL,
	"total_amount_cents" integer DEFAULT 0,
	"approved_amount_cents" integer DEFAULT 0,
	"address" jsonb,
	"location" "location" DEFAULT 'unknown',
	"created_at_hcp" timestamp with time zone,
	"approved_at_hcp" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "hcp_estimate_id" text;--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD CONSTRAINT "hcp_estimates_hcp_customer_id_hcp_customers_id_fk" FOREIGN KEY ("hcp_customer_id") REFERENCES "public"."hcp_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_estimates_hcp_id_uq" ON "hcp_estimates" USING btree ("hcp_estimate_id");--> statement-breakpoint
CREATE INDEX "hcp_estimates_customer_idx" ON "hcp_estimates" USING btree ("hcp_customer_id");--> statement-breakpoint
CREATE INDEX "hcp_estimates_won_idx" ON "hcp_estimates" USING btree ("won");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_hcp_estimate_id_hcp_estimates_id_fk" FOREIGN KEY ("hcp_estimate_id") REFERENCES "public"."hcp_estimates"("id") ON DELETE no action ON UPDATE no action;