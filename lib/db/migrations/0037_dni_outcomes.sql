CREATE TABLE "dni_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"outcome" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dni_outcomes_date_outcome_uq" UNIQUE("date","outcome")
);
