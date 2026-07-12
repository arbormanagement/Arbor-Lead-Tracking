CREATE TYPE "public"."estimate_outcome" AS ENUM('won', 'lost', 'open');--> statement-breakpoint
ALTER TABLE "hcp_estimates" ADD COLUMN "outcome" "estimate_outcome" DEFAULT 'open' NOT NULL;