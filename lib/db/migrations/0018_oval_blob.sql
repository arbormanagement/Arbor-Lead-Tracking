CREATE TYPE "public"."message_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
ALTER TYPE "public"."lead_type" ADD VALUE 'sms';--> statement-breakpoint
ALTER TYPE "public"."lead_type" ADD VALUE 'email';--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"contact_key" text NOT NULL,
	"contact_name" text,
	"endpoint_key" text NOT NULL,
	"tracking_number_id" text,
	"number_assignment_id" text,
	"source_id" text,
	"subject" text,
	"last_channel" text,
	"last_direction" text,
	"last_preview" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
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
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tracking_number_id_tracking_numbers_id_fk" FOREIGN KEY ("tracking_number_id") REFERENCES "public"."tracking_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_number_assignment_id_number_assignments_id_fk" FOREIGN KEY ("number_assignment_id") REFERENCES "public"."number_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_contact_endpoint_uq" ON "conversations" USING btree ("contact_key","endpoint_key");--> statement-breakpoint
CREATE INDEX "conversations_last_activity_idx" ON "conversations" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "conversations_lead_idx" ON "conversations" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_uq" ON "messages" USING btree ("channel","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_lead_idx" ON "messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "messages_occurred_idx" ON "messages" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_conversation_idx" ON "calls" USING btree ("conversation_id");