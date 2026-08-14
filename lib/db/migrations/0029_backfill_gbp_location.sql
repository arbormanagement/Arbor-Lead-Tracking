-- Backfill the location that was always in the data but never read.
--
-- Each Google Business Profile tags its own website link (utm_campaign=edwardsville
-- / ofallon) and that value has been stored on web_sessions.campaign all along.
-- inferLocation only ever looked at the page URL, and both profiles point at the
-- homepage — so every GBP web click was filed `unknown` while the answer sat one
-- column away. The code fix handles new traffic; this recovers the history.
--
-- Only rows still `unknown` are touched, so a location already determined some other
-- way (a tracking number, a location-specific landing page) is never overwritten.
UPDATE "web_sessions" SET "location" = 'edwardsville'
WHERE ("location" IS NULL OR "location" = 'unknown')
  AND lower("campaign") LIKE '%edwardsville%';--> statement-breakpoint

UPDATE "web_sessions" SET "location" = 'ofallon'
WHERE ("location" IS NULL OR "location" = 'unknown')
  AND (lower("campaign") LIKE '%ofallon%' OR lower("campaign") LIKE '%o-fallon%');--> statement-breakpoint

-- Leads carry their own copy (it is what roi_daily groups on), so they need the same
-- correction. Joined through web_session_id rather than re-parsing the campaign, so
-- the lead can only ever agree with its session.
UPDATE "leads" l SET "location" = s."location"
FROM "web_sessions" s
WHERE l."web_session_id" = s."id"
  AND (l."location" IS NULL OR l."location" = 'unknown')
  AND s."location" IS NOT NULL
  AND s."location" <> 'unknown';--> statement-breakpoint

-- roi_daily is fully derived and rebuilt over a rolling 365-day window on every
-- attribution run, so it needs no correction here — the next run regenerates it from
-- the leads above, on the right location rows.
SELECT 1;
