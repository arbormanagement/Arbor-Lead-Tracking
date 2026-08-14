-- Merge the duplicate Google Business Profile source.
--
-- Both profiles link to the site as `utm_source=google+my+business`, which arrives
-- as "google my business" (a `+` decodes to a space). classifySource matched none of
-- the spellings it tested for at the time, so it minted a parallel source and Google
-- Business Profile ended up split in two: calls to the two GBP tracking numbers
-- landed on `gbp`, every click through to the website on the other key, and neither
-- half said what the profiles were worth.
--
-- The CLASSIFIER was fixed on 2026-08-12 (it now matches a squashed form, so nothing
-- new lands there) but nothing repointed the rows already attributed to the old key.
-- This is that cleanup, and it is why the earlier fix appeared not to have worked.
--
-- EVERY table referencing sources.id must be repointed before the delete. A first
-- version of this migration handled leads, web_sessions and roi_daily and was
-- rejected by the FK from `attributions` — which is the pre-deploy migration step
-- doing its job: the release aborted and the previous version kept serving. The full
-- set, from `grep 'references(() => sources.id)'`:
--   web_sessions.derived_source_id · campaigns.source_id · manual_spend.source_id
--   tracking_numbers.static_source_id · conversations.source_id · leads.source_id
--   attributions.source_id · roi_daily.source_id
--
-- Matching is on a squashed key so every spelling folds in, not just the one known
-- row — the whole point is that the spelling varied.
CREATE TEMP TABLE _dupe_gbp ON COMMIT DROP AS
  SELECT id FROM "sources"
  WHERE key <> 'gbp'
    AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') LIKE '%googlemybusiness%';--> statement-breakpoint

UPDATE "leads"         SET "source_id"        = (SELECT id FROM "sources" WHERE key='gbp') WHERE "source_id"        IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "attributions"  SET "source_id"        = (SELECT id FROM "sources" WHERE key='gbp') WHERE "source_id"        IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "conversations" SET "source_id"        = (SELECT id FROM "sources" WHERE key='gbp') WHERE "source_id"        IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "campaigns"     SET "source_id"        = (SELECT id FROM "sources" WHERE key='gbp') WHERE "source_id"        IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "manual_spend"  SET "source_id"        = (SELECT id FROM "sources" WHERE key='gbp') WHERE "source_id"        IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "web_sessions"  SET "derived_source_id"= (SELECT id FROM "sources" WHERE key='gbp') WHERE "derived_source_id" IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint
UPDATE "tracking_numbers" SET "static_source_id" = (SELECT id FROM "sources" WHERE key='gbp') WHERE "static_source_id" IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint

-- roi_daily is fully derived and rebuilt over a rolling 365-day window on every
-- attribution run, so its rows are deleted rather than repointed — merging them
-- would collide with the `gbp` rows on the uniqueness key. The next run regenerates
-- them correctly from the leads repointed above.
DELETE FROM "roi_daily" WHERE "source_id" IN (SELECT id FROM _dupe_gbp);--> statement-breakpoint

DELETE FROM "sources" WHERE id IN (SELECT id FROM _dupe_gbp);
