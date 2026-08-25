CREATE TABLE "hcp_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"hcp_invoice_id" text NOT NULL,
	"invoice_number" text,
	"hcp_job_id" text,
	"hcp_job_id_hcp" text,
	"hcp_customer_id" text,
	"status" text,
	"amount_cents" integer DEFAULT 0,
	"subtotal_cents" integer DEFAULT 0,
	"due_amount_cents" integer DEFAULT 0,
	"paid_amount_cents" integer DEFAULT 0,
	"refunded_amount_cents" integer DEFAULT 0,
	"tax_amount_cents" integer DEFAULT 0,
	"discount_amount_cents" integer DEFAULT 0,
	"payment_methods" text[],
	"invoice_date" timestamp with time zone,
	"service_date" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"items" jsonb,
	"taxes" jsonb,
	"discounts" jsonb,
	"payments" jsonb,
	"refunds" jsonb,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "created_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_customers" ADD COLUMN "updated_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "subtotal_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "invoice_paid_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "invoice_due_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "invoice_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "completed_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "canceled_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "deleted_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "updated_at_hcp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "job_type" text;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "assigned_employees" jsonb;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "estimate_option_ids" text[];--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD COLUMN "lead_source_raw" text;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD CONSTRAINT "hcp_invoices_hcp_job_id_hcp_jobs_id_fk" FOREIGN KEY ("hcp_job_id") REFERENCES "public"."hcp_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hcp_invoices" ADD CONSTRAINT "hcp_invoices_hcp_customer_id_hcp_customers_id_fk" FOREIGN KEY ("hcp_customer_id") REFERENCES "public"."hcp_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_invoices_hcp_id_uq" ON "hcp_invoices" USING btree ("hcp_invoice_id");--> statement-breakpoint
CREATE INDEX "hcp_invoices_job_idx" ON "hcp_invoices" USING btree ("hcp_job_id");--> statement-breakpoint
CREATE INDEX "hcp_invoices_job_hcp_idx" ON "hcp_invoices" USING btree ("hcp_job_id_hcp");--> statement-breakpoint
CREATE INDEX "hcp_invoices_customer_idx" ON "hcp_invoices" USING btree ("hcp_customer_id");--> statement-breakpoint
CREATE INDEX "hcp_invoices_status_idx" ON "hcp_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hcp_invoices_invoice_date_idx" ON "hcp_invoices" USING btree ("invoice_date");--> statement-breakpoint
CREATE INDEX "hcp_invoices_paid_at_idx" ON "hcp_invoices" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "hcp_invoices_number_idx" ON "hcp_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "hcp_customers_created_hcp_idx" ON "hcp_customers" USING btree ("created_at_hcp");--> statement-breakpoint
CREATE INDEX "hcp_estimates_options_idx" ON "hcp_estimates" USING gin ("options");--> statement-breakpoint
CREATE INDEX "hcp_jobs_created_hcp_idx" ON "hcp_jobs" USING btree ("created_at_hcp");--> statement-breakpoint
CREATE INDEX "hcp_jobs_completed_hcp_idx" ON "hcp_jobs" USING btree ("completed_at_hcp");--> statement-breakpoint
CREATE INDEX "hcp_jobs_work_status_idx" ON "hcp_jobs" USING btree ("work_status");--> statement-breakpoint
CREATE INDEX "hcp_jobs_estimate_options_idx" ON "hcp_jobs" USING gin ("estimate_option_ids");--> statement-breakpoint
-- `invoice_total_cents` changes meaning here. It was mapped from
-- `j.invoice_total ?? j.total_amount`, and HCP's /jobs payload has no
-- `invoice_total` — so every existing row holds a copy of the QUOTE, not a billed
-- amount. Reset it so the rollup from `hcp_invoices` fills it honestly; a job with
-- no invoice now correctly reads 0 rather than reporting its quote as if billed.
UPDATE "hcp_jobs" SET "invoice_total_cents" = 0 WHERE "invoice_total_cents" <> 0;
