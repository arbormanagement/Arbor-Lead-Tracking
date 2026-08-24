CREATE TABLE "mcp_oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"secret_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text,
	"code_challenge" text,
	"scope" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_secret_hash_uq" ON "mcp_oauth_grants" USING btree ("secret_hash");