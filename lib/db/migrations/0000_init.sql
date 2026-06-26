CREATE TYPE "public"."lead_status" AS ENUM('new', 'working', 'qualified', 'quoted', 'won', 'lost', 'spam', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."lead_type" AS ENUM('call', 'web_form', 'facebook_leadgen', 'lsa', 'manual');--> statement-breakpoint
CREATE TYPE "public"."location" AS ENUM('edwardsville', 'ofallon', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."number_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('google', 'google_lsa', 'facebook', 'other');--> statement-breakpoint
CREATE TYPE "public"."number_pool" AS ENUM('google', 'facebook', 'organic', 'lsa', 'direct', 'print', 'reserved');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'success', 'error');--> statement-breakpoint
CREATE TYPE "public"."touch_type" AS ENUM('first', 'last', 'linear');--> statement-breakpoint
CREATE TABLE "ad_spend" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"platform" "platform" NOT NULL,
	"campaign_id" text,
	"external_campaign_id" text,
	"impressions" integer DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"conversions" numeric(12, 2) DEFAULT '0',
	"source" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"touch_type" "touch_type" NOT NULL,
	"source_id" text,
	"campaign_id" text,
	"gclid" text,
	"fbclid" text,
	"keyword" text,
	"landing_page" text,
	"weight" numeric(5, 4) DEFAULT '1',
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"twilio_call_sid" text NOT NULL,
	"tracking_number_id" text,
	"number_assignment_id" text,
	"from_number" text,
	"to_destination" text,
	"direction" text DEFAULT 'inbound',
	"answered" boolean,
	"duration_sec" integer,
	"status" text,
	"recording_url" text,
	"recording_sid" text,
	"recording_duration_sec" integer,
	"transcript" text,
	"transcript_provider" text,
	"transcript_confidence" numeric(4, 3),
	"intent_label" text,
	"spam_score" numeric(4, 3),
	"voicemail" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text,
	"platform" "platform" NOT NULL,
	"external_campaign_id" text NOT NULL,
	"name" text,
	"status" text,
	"location" "location" DEFAULT 'unknown',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facebook_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"fb_leadgen_id" text NOT NULL,
	"fb_form_id" text,
	"fb_ad_id" text,
	"fb_campaign_id" text,
	"fields" jsonb,
	"created_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"web_session_id" text,
	"form_id" text,
	"page_url" text,
	"fields" jsonb,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hcp_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"hcp_customer_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"email_lc" text,
	"phone" text,
	"mobile" text,
	"phone_e164" text,
	"addresses" jsonb,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hcp_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"hcp_job_id" text NOT NULL,
	"hcp_customer_id" text,
	"work_status" text,
	"scheduled_start" timestamp with time zone,
	"total_amount_cents" integer DEFAULT 0,
	"outstanding_balance_cents" integer DEFAULT 0,
	"invoice_total_cents" integer DEFAULT 0,
	"address" jsonb,
	"location" "location" DEFAULT 'unknown',
	"created_at_hcp" timestamp with time zone,
	"raw" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "lead_type" NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"name" text,
	"phone_e164" text,
	"email_lc" text,
	"message" text,
	"source_id" text,
	"medium" text,
	"campaign_id" text,
	"keyword" text,
	"gclid" text,
	"fbclid" text,
	"landing_page" text,
	"referrer" text,
	"location" "location" DEFAULT 'unknown',
	"visitor_id" text,
	"web_session_id" text,
	"hcp_customer_id" text,
	"hcp_job_id" text,
	"quote_value_cents" integer,
	"sales_value_cents" integer,
	"is_spam" boolean DEFAULT false NOT NULL,
	"is_first_time" boolean,
	"is_duplicate" boolean DEFAULT false NOT NULL,
	"duplicate_of_lead_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"tracking_number_id" text NOT NULL,
	"web_session_id" text,
	"visitor_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"source" text,
	"medium" text,
	"campaign" text,
	"keyword" text,
	"gclid" text,
	"fbclid" text,
	"landing_page" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roi_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"source_id" text,
	"campaign_id" text,
	"location" "location" DEFAULT 'unknown',
	"leads_count" integer DEFAULT 0 NOT NULL,
	"calls_count" integer DEFAULT 0 NOT NULL,
	"forms_count" integer DEFAULT 0 NOT NULL,
	"won_count" integer DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"quote_value_cents" integer DEFAULT 0 NOT NULL,
	"cost_per_lead_cents" integer,
	"cost_per_acquisition_cents" integer,
	"roi_ratio" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"platform" "platform" DEFAULT 'other',
	"default_cost_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spam_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"field" text NOT NULL,
	"pattern" text NOT NULL,
	"action" text DEFAULT 'flag' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tracking_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"twilio_sid" text NOT NULL,
	"phone_number" text NOT NULL,
	"friendly_name" text,
	"pool" "number_pool" DEFAULT 'reserved' NOT NULL,
	"status" "number_status" DEFAULT 'active' NOT NULL,
	"capabilities" jsonb,
	"is_static" boolean DEFAULT false NOT NULL,
	"static_source_id" text,
	"location" "location" DEFAULT 'unknown',
	"provisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ga_client_id" text,
	"user_agent" text,
	"ip_hash" text,
	"ft_source" text,
	"ft_medium" text,
	"ft_campaign" text,
	"ft_content" text,
	"ft_term" text,
	"ft_gclid" text,
	"ft_fbclid" text,
	"ft_referrer" text,
	"ft_landing_page" text,
	"ft_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"visitor_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"source" text,
	"medium" text,
	"campaign" text,
	"content" text,
	"term" text,
	"gclid" text,
	"fbclid" text,
	"gbraid" text,
	"wbraid" text,
	"msclkid" text,
	"referrer" text,
	"landing_page" text,
	"ip_hash" text,
	"user_agent" text,
	"location" "location" DEFAULT 'unknown',
	"derived_source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tracking_number_id_tracking_numbers_id_fk" FOREIGN KEY ("tracking_number_id") REFERENCES "public"."tracking_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_number_assignment_id_number_assignments_id_fk" FOREIGN KEY ("number_assignment_id") REFERENCES "public"."number_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_leads" ADD CONSTRAINT "facebook_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_web_session_id_web_sessions_id_fk" FOREIGN KEY ("web_session_id") REFERENCES "public"."web_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hcp_jobs" ADD CONSTRAINT "hcp_jobs_hcp_customer_id_hcp_customers_id_fk" FOREIGN KEY ("hcp_customer_id") REFERENCES "public"."hcp_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_web_session_id_web_sessions_id_fk" FOREIGN KEY ("web_session_id") REFERENCES "public"."web_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_hcp_customer_id_hcp_customers_id_fk" FOREIGN KEY ("hcp_customer_id") REFERENCES "public"."hcp_customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_hcp_job_id_hcp_jobs_id_fk" FOREIGN KEY ("hcp_job_id") REFERENCES "public"."hcp_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_assignments" ADD CONSTRAINT "number_assignments_tracking_number_id_tracking_numbers_id_fk" FOREIGN KEY ("tracking_number_id") REFERENCES "public"."tracking_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_assignments" ADD CONSTRAINT "number_assignments_web_session_id_web_sessions_id_fk" FOREIGN KEY ("web_session_id") REFERENCES "public"."web_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_assignments" ADD CONSTRAINT "number_assignments_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roi_daily" ADD CONSTRAINT "roi_daily_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roi_daily" ADD CONSTRAINT "roi_daily_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD CONSTRAINT "tracking_numbers_static_source_id_sources_id_fk" FOREIGN KEY ("static_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_visitor_id_visitors_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."visitors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_derived_source_id_sources_id_fk" FOREIGN KEY ("derived_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_platform_extid_date_uq" ON "ad_spend" USING btree ("platform","external_campaign_id","date");--> statement-breakpoint
CREATE INDEX "ad_spend_date_idx" ON "ad_spend" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attributions_lead_idx" ON "attributions" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_twilio_sid_uq" ON "calls" USING btree ("twilio_call_sid");--> statement-breakpoint
CREATE INDEX "calls_lead_idx" ON "calls" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "calls_from_idx" ON "calls" USING btree ("from_number");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_platform_extid_uq" ON "campaigns" USING btree ("platform","external_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facebook_leads_leadgen_id_uq" ON "facebook_leads" USING btree ("fb_leadgen_id");--> statement-breakpoint
CREATE INDEX "form_submissions_lead_idx" ON "form_submissions" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_customers_hcp_id_uq" ON "hcp_customers" USING btree ("hcp_customer_id");--> statement-breakpoint
CREATE INDEX "hcp_customers_phone_idx" ON "hcp_customers" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "hcp_customers_email_idx" ON "hcp_customers" USING btree ("email_lc");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_jobs_hcp_id_uq" ON "hcp_jobs" USING btree ("hcp_job_id");--> statement-breakpoint
CREATE INDEX "hcp_jobs_customer_idx" ON "hcp_jobs" USING btree ("hcp_customer_id");--> statement-breakpoint
CREATE INDEX "leads_occurred_idx" ON "leads" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "leads_phone_idx" ON "leads" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email_lc");--> statement-breakpoint
CREATE INDEX "leads_source_idx" ON "leads" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "number_assignments_active_idx" ON "number_assignments" USING btree ("tracking_number_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "number_assignments_session_idx" ON "number_assignments" USING btree ("web_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roi_daily_key_uq" ON "roi_daily" USING btree ("date","source_id","campaign_id","location");--> statement-breakpoint
CREATE INDEX "roi_daily_date_idx" ON "roi_daily" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_key_uq" ON "sources" USING btree ("key");--> statement-breakpoint
CREATE INDEX "sync_runs_job_idx" ON "sync_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_numbers_twilio_sid_uq" ON "tracking_numbers" USING btree ("twilio_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_numbers_phone_uq" ON "tracking_numbers" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "tracking_numbers_pool_idx" ON "tracking_numbers" USING btree ("pool","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "web_sessions_visitor_idx" ON "web_sessions" USING btree ("visitor_id");