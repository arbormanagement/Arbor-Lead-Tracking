-- Merge the `fb/paid` alias into `facebook/paid`.
--
-- Found while verifying the GBP merge (0027): sampling every lead slice returned
-- `fb/paid` alongside `facebook/paid`, three leads on the wrong side of a split
-- that nothing in the code produces any more. It is the same leftover as GBP —
-- minted when an unmatched UTM pair became its own channel — and the same reason
-- fixing the classifier alone was not enough: the rows already written stay where
-- they were put.
--
-- Structured exactly like 0027, including the EXISTS guard and the full set of
-- eight tables referencing sources.id, because the failure mode there was missing
-- one of them and having the release aborted by the FK.
CREATE TEMP TABLE _alias_fb ON COMMIT DROP AS
  SELECT id FROM "sources"
  WHERE key <> 'facebook/paid'
    AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') IN ('fbpaid', 'fbcpc', 'fbppc')
    AND EXISTS (SELECT 1 FROM "sources" WHERE key = 'facebook/paid');--> statement-breakpoint

UPDATE "leads"            SET "source_id"         = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "source_id"         IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "attributions"     SET "source_id"         = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "source_id"         IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "conversations"    SET "source_id"         = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "source_id"         IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "campaigns"        SET "source_id"         = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "source_id"         IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "manual_spend"     SET "source_id"         = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "source_id"         IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "web_sessions"     SET "derived_source_id" = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "derived_source_id" IN (SELECT id FROM _alias_fb);--> statement-breakpoint
UPDATE "tracking_numbers" SET "static_source_id"  = (SELECT id FROM "sources" WHERE key='facebook/paid') WHERE "static_source_id"  IN (SELECT id FROM _alias_fb);--> statement-breakpoint

-- Deleted rather than repointed: merging would collide with the facebook/paid rows
-- on the uniqueness key, and roi_daily is fully derived — the next attribution run
-- regenerates it from the leads above.
DELETE FROM "roi_daily" WHERE "source_id" IN (SELECT id FROM _alias_fb);--> statement-breakpoint

DELETE FROM "sources" WHERE id IN (SELECT id FROM _alias_fb);
