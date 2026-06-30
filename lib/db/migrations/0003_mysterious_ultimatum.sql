CREATE TABLE "pools" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"is_dni" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pools_key_uq" ON "pools" USING btree ("key");--> statement-breakpoint
-- Convert tracking_numbers.pool from the number_pool enum to managed text.
-- Drop the enum default first, cast existing values with USING, then restore it.
ALTER TABLE "tracking_numbers" ALTER COLUMN "pool" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ALTER COLUMN "pool" SET DATA TYPE text USING "pool"::text;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ALTER COLUMN "pool" SET DEFAULT 'reserved';--> statement-breakpoint
DROP TYPE "public"."number_pool";
