CREATE TABLE "dni_refusals" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"outcome" text NOT NULL,
	"detail" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dni_refusals_date_outcome_detail_uq" UNIQUE("date","outcome","detail")
);
