CREATE TABLE "automation_intakes" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"fb_leadgen_id" text,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone_e164" text,
	"street" text,
	"city" text,
	"state" text,
	"zip" text,
	"service_needed" text,
	"hcp_customer_id" text,
	"customer_found" boolean,
	"hcp_estimate_id" text,
	"lead_id" text,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catchup_texts" (
	"id" text PRIMARY KEY NOT NULL,
	"review_request_id" text,
	"customer_name" text NOT NULL,
	"customer_phone_e164" text NOT NULL,
	"tracking_id" text NOT NULL,
	"tracking_url" text NOT NULL,
	"work_month" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retell_call_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text,
	"caller_phone" text,
	"summary" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"error_message" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tracking_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone_e164" text NOT NULL,
	"customer_email" text,
	"invoice_id" text NOT NULL,
	"county" text DEFAULT 'madison' NOT NULL,
	"review_url" text NOT NULL,
	"tracking_url" text NOT NULL,
	"hcp_customer_id" text,
	"contact_id" text,
	"clicked" boolean DEFAULT false NOT NULL,
	"clicked_at" timestamp with time zone,
	"sms_sent" boolean DEFAULT false NOT NULL,
	"email_sent" text DEFAULT 'pending' NOT NULL,
	"final_sms_sent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts_sms1" integer DEFAULT 0 NOT NULL,
	"attempts_email" integer DEFAULT 0 NOT NULL,
	"attempts_sms2" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_intakes" ADD CONSTRAINT "automation_intakes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_intakes_fb_leadgen_uq" ON "automation_intakes" USING btree ("fb_leadgen_id");--> statement-breakpoint
CREATE INDEX "automation_intakes_phone_created_idx" ON "automation_intakes" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "automation_intakes_status_idx" ON "automation_intakes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catchup_texts_tracking_idx" ON "catchup_texts" USING btree ("tracking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retell_call_summaries_call_uq" ON "retell_call_summaries" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_tracking_uq" ON "review_requests" USING btree ("tracking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_invoice_phone_uq" ON "review_requests" USING btree ("invoice_id","customer_phone_e164");--> statement-breakpoint
CREATE INDEX "review_requests_phone_created_idx" ON "review_requests" USING btree ("customer_phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "review_requests_status_idx" ON "review_requests" USING btree ("status");