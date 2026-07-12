ALTER TABLE "hcp_estimates" ADD COLUMN "updated_at_hcp" timestamp with time zone;
--> statement-breakpoint
UPDATE "hcp_estimates" SET "updated_at_hcp" = NULLIF("raw"->>'updated_at', '')::timestamptz WHERE "updated_at_hcp" IS NULL AND "raw" ? 'updated_at';
