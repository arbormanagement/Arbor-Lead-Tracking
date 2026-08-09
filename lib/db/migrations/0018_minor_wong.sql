CREATE TYPE "public"."contact_identifier_kind" AS ENUM('phone', 'email');--> statement-breakpoint
CREATE TYPE "public"."conversation_state" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
ALTER TYPE "public"."lead_type" ADD VALUE 'sms';--> statement-breakpoint
ALTER TYPE "public"."lead_type" ADD VALUE 'email';--> statement-breakpoint
CREATE TABLE "contact_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"kind" "contact_identifier_kind" NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"primary_phone" text,
	"primary_email" text,
	"sms_opted_out_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"state" "conversation_state" DEFAULT 'open' NOT NULL,
	"source_id" text,
	"tracking_number_id" text,
	"number_assignment_id" text,
	"last_endpoint_key" text,
	"subject" text,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"last_channel" text,
	"last_direction" text,
	"last_preview" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"lead_id" text,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body" text,
	"media" jsonb,
	"external_id" text,
	"status" text,
	"error_code" text,
	"num_segments" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "facebook_leads" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contact_id" text;--> statement-breakpoint
ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tracking_number_id_tracking_numbers_id_fk" FOREIGN KEY ("tracking_number_id") REFERENCES "public"."tracking_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_number_assignment_id_number_assignments_id_fk" FOREIGN KEY ("number_assignment_id") REFERENCES "public"."number_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identifiers_kind_value_uq" ON "contact_identifiers" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "contact_identifiers_contact_idx" ON "contact_identifiers" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_contact_uq" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_last_activity_idx" ON "conversations" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "conversations_state_idx" ON "conversations" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_uq" ON "messages" USING btree ("channel","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_lead_idx" ON "messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "messages_occurred_idx" ON "messages" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facebook_leads" ADD CONSTRAINT "facebook_leads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_conversation_idx" ON "calls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "facebook_leads_conversation_idx" ON "facebook_leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "form_submissions_conversation_idx" ON "form_submissions" USING btree ("conversation_id");