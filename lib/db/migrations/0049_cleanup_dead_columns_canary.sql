-- Retire what an audit on 2026-09-05 found nothing reading or writing, collapse the
-- DNI pools to the one that exists, and clear the canary's fingerprints off real leads.
--
-- Every column and table below was checked for writers and readers across lib/, app/
-- and scripts/ before it went. The pattern is the one 0046/0047 named: a column
-- nothing writes is not a spare field, it is where the next person puts a value that
-- then silently does nothing.
--
--   integration_credentials  empty and unread since the store was removed 2026-08-12.
--   leads.hcp_job_id         never written; two readers (the delete guard, the
--                            detail page) permanently saw NULL.
--   leads.is_duplicate,      never written; one filter in runAttribution could never
--   leads.duplicate_of_lead_id  exclude anything, one badge could never render.
--   visitors.ft_*            ten first-touch columns written on every pageview and
--                            read by nothing. The first touch that reports derives
--                            from `leads` (earliest per contact) into `roi_daily`.
--   lead_type 'lsa','manual' no code path inserts either; zero rows carry them (the
--                            LSA pull was removed 2026-08-14). Postgres cannot drop
--                            an enum value, hence the recreate; `email` stays — it is
--                            the planned channel and `messages` already stores it.
ALTER TABLE "integration_credentials" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "integration_credentials" CASCADE;--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT "leads_hcp_job_id_hcp_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "hcp_job_id";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "is_duplicate";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "duplicate_of_lead_id";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_source";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_medium";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_campaign";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_content";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_term";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_gclid";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_fbclid";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_referrer";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_landing_page";--> statement-breakpoint
ALTER TABLE "visitors" DROP COLUMN "ft_at";--> statement-breakpoint
ALTER TABLE "public"."leads" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."lead_type";--> statement-breakpoint
CREATE TYPE "public"."lead_type" AS ENUM('call', 'web_form', 'facebook_leadgen', 'sms', 'email');--> statement-breakpoint
ALTER TABLE "public"."leads" ALTER COLUMN "type" SET DATA TYPE "public"."lead_type" USING "type"::"public"."lead_type";

-- ── Data ─────────────────────────────────────────────────────────────────────

-- The DNI canary leases a real pool number every hour. Release stamps `released_at`,
-- which the /voice lease lookup deliberately ignores, and leaves `expires_at` fifteen
-- minutes out — so for two hours after each run the monitor's lease was a live, and
-- usually the NEWEST, candidate on that number. Three real calls inherited its
-- snapshot; the lookup now excludes the canary's session (lib/twilio/inbound.ts).
-- The keyword is the one field that is unambiguously the monitor's: `source` on
-- those rows is `direct`, which is also what "no lease matched" would have produced,
-- so it is left for a deliberate correction rather than guessed at here.
UPDATE "leads" SET "keyword" = NULL, "updated_at" = now() WHERE "keyword" = 'arbor-dni-canary';
--> statement-breakpoint

-- One DNI pool. Four were seeded — google / facebook / organic / direct — as if a
-- Google visitor were handed a Google number. `leaseNumber` is one flat rotation over
-- every `is_dni` pool and the source is frozen onto the LEASE, so the names described
-- routing that never existed; three sat empty while all six pool numbers lived in
-- `direct`. Rename the one in use so the key says what it is, move its numbers, and
-- drop the empties — guarded, so a pool that somehow holds a number is never deleted.
-- On a fresh database `pools` is empty here and the seed creates `website` directly.
UPDATE "pools"
   SET "key" = 'website',
       "display_name" = 'Website (DNI)',
       "description" = 'The rotation track.js leases from — one pool for every source; attribution rides on the lease',
       "updated_at" = now()
 WHERE "key" = 'direct'
   AND NOT EXISTS (SELECT 1 FROM "pools" w WHERE w."key" = 'website');
--> statement-breakpoint
UPDATE "tracking_numbers" SET "pool" = 'website' WHERE "pool" = 'direct';
--> statement-breakpoint
DELETE FROM "pools" p
 WHERE p."key" IN ('google', 'facebook', 'organic')
   AND NOT EXISTS (SELECT 1 FROM "tracking_numbers" tn WHERE tn."pool" = p."key");
