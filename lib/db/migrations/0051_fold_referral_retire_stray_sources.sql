-- Fold the runtime-minted "<host>/referral" sources into the seeded `referral`.
-- Data only; no schema change. The source rows themselves are deleted by a guarded
-- pass in seedDefaults, which runs on every deploy until nothing references them.
--
-- classifySource minted a source per referring domain, so /sources grew a row for every
-- site that ever linked here (yelp-com/referral: one lead, one row) while the seeded
-- `referral` was written by nothing. The classifier now returns `referral` for any
-- unrecognised referrer (lib/attribution/classify.ts); this moves the rows already
-- written. The host is not lost — the full referrer is on web_sessions.referrer.
--
-- A lead a human LOCKED (attribution_set_manually_at) is deliberately not folded: a
-- correction outranks a bulk move, and the seed's guarded delete then keeps its source.

-- 1. Fold. Each statement is a no-op where nothing matches (fresh database included).
UPDATE "leads" l SET "source_id" = r."id", "updated_at" = now()
  FROM "sources" r
 WHERE r."key" = 'referral'
   AND l."source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral')
   AND l."attribution_set_manually_at" IS NULL;
--> statement-breakpoint
UPDATE "conversations" c SET "source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND c."source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
UPDATE "attributions" a SET "source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND a."source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
UPDATE "tracking_numbers" t SET "static_source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND t."static_source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
UPDATE "campaigns" c SET "source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND c."source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
UPDATE "manual_spend" m SET "source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND m."source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
UPDATE "web_sessions" w SET "derived_source_id" = r."id"
  FROM "sources" r WHERE r."key" = 'referral'
   AND w."derived_source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
-- Text copies of the key (not FKs) on the session and the lease snapshot.
UPDATE "web_sessions" SET "source" = 'referral' WHERE "source" LIKE '%/referral' AND "source" <> 'referral';
--> statement-breakpoint
UPDATE "number_assignments" SET "source" = 'referral' WHERE "source" LIKE '%/referral' AND "source" <> 'referral';
--> statement-breakpoint
-- roi_daily is a derived rollup; runAttribution rebuilds 365 days on its next tick and
-- these rows are all post-cutover, so dropping them is what a rebuild would do anyway.
DELETE FROM "roi_daily" WHERE "source_id" IN (SELECT "id" FROM "sources" WHERE "key" LIKE '%/referral' AND "key" <> 'referral');
--> statement-breakpoint
