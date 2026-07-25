CREATE TABLE "ad_spend_ads" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"platform" "platform" NOT NULL,
	"campaign_id" text,
	"external_campaign_id" text,
	"external_group_id" text,
	"group_name" text,
	"external_ad_id" text NOT NULL,
	"ad_name" text,
	"ad_status" text,
	"creative_thumb_url" text,
	"creative_title" text,
	"creative_body" text,
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
ALTER TABLE "ad_spend_ads" ADD CONSTRAINT "ad_spend_ads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_spend_ads_platform_adid_date_uq" ON "ad_spend_ads" USING btree ("platform","external_ad_id","date");--> statement-breakpoint
CREATE INDEX "ad_spend_ads_date_idx" ON "ad_spend_ads" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ad_spend_ads_campaign_idx" ON "ad_spend_ads" USING btree ("platform","external_campaign_id");