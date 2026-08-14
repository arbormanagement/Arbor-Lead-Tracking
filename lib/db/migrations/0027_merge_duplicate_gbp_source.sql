-- Merge the duplicate Google Business Profile source.
--
-- Both profiles link to the site as `utm_source=google+my+business`, which arrives
-- as "google my business" (a `+` decodes to a space). classifySource matched none
-- of the spellings it tested for at the time, so it minted a parallel source and
-- Google Business Profile ended up split in two: calls to the two GBP tracking
-- numbers landed on `gbp`, every click through to the website on
-- `google my business/organic`, and neither half said what the profiles were worth.
--
-- The CLASSIFIER was fixed on 2026-08-12 (it now matches a squashed form, so no new
-- rows can land here) but nothing repointed the leads already attributed to the old
-- key. This is that cleanup, and it is why the fix did not appear to work.
--
-- Anything whose key is a spelling of Google Business Profile is folded in, not just
-- the one known row — the whole point is that the spelling varied.
UPDATE "leads" SET "source_id" = (SELECT id FROM "sources" WHERE key = 'gbp')
WHERE "source_id" IN (
  SELECT id FROM "sources"
  WHERE key <> 'gbp'
    AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') LIKE '%googlemybusiness%'
);--> statement-breakpoint

UPDATE "web_sessions" SET "derived_source_id" = (SELECT id FROM "sources" WHERE key = 'gbp')
WHERE "derived_source_id" IN (
  SELECT id FROM "sources"
  WHERE key <> 'gbp'
    AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') LIKE '%googlemybusiness%'
);--> statement-breakpoint

-- roi_daily is fully derived and rebuilt over a 365-day window on every attribution
-- run, so its rows need no repointing — they are regenerated from the leads above.
DELETE FROM "roi_daily" WHERE "source_id" IN (
  SELECT id FROM "sources"
  WHERE key <> 'gbp'
    AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') LIKE '%googlemybusiness%'
);--> statement-breakpoint

DELETE FROM "sources"
WHERE key <> 'gbp'
  AND regexp_replace(lower(key), '[^a-z0-9]', '', 'g') LIKE '%googlemybusiness%';
