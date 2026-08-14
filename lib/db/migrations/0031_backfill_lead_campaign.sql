-- Backfill the campaign that was in the data all along but never read.
--
-- `leads.campaign_id` was set on exactly one path (the voice webhook). Web-form and
-- SMS leads never got one, even though the answer was sitting one join away — on
-- `web_sessions.campaign` for a form, and on the DNI lease for a text. So every
-- campaign-level figure under-counted by however much of that campaign's volume
-- converted as a form or a text rather than a call, while looking complete.
--
-- The code fix covers new leads; this recovers the history. Both passes match the
-- SAME way the runtime does — `utm_campaign` text against `campaigns.name` — so a
-- backfilled row and a freshly-captured one can never disagree about what a match
-- means. Nothing is invented: a name matching no campaign stays NULL, exactly as it
-- would at write time.
--
-- Only rows where campaign_id IS NULL are touched, so a campaign already resolved
-- some other way is never overwritten.

-- Pass 1 — leads carrying a web session (web forms, and calls whose lease recorded
-- one). The session froze utm_campaign when the visit began, which is last-touch.
UPDATE "leads" l
SET "campaign_id" = c."id"
FROM "web_sessions" s
JOIN "campaigns" c ON c."name" = s."campaign"
WHERE l."web_session_id" = s."id"
  AND l."campaign_id" IS NULL
  AND s."campaign" IS NOT NULL;--> statement-breakpoint

-- Pass 2 — texts, which have no web session of their own. Their conversation
-- records the DNI lease the contact arrived on, and the lease froze utm_campaign at
-- assign time.
UPDATE "leads" l
SET "campaign_id" = c."id"
FROM "conversations" conv
JOIN "number_assignments" na ON na."id" = conv."number_assignment_id"
JOIN "campaigns" c ON c."name" = na."campaign"
WHERE l."conversation_id" = conv."id"
  AND l."campaign_id" IS NULL
  AND na."campaign" IS NOT NULL;--> statement-breakpoint

-- DELIBERATELY NOT BACKFILLED HERE: the click ids (gclid/gbraid/wbraid/fbclid) that
-- the same lease also froze and the SMS path also discarded. Filling those would
-- make a batch of historical texts newly eligible for the Google Ads conversion
-- export, and `Lead Created` is now the biddable signal on Search | Tree Services —
-- so the backfill would land as a spike into a live bidding signal, reading as a
-- performance change that has nothing to do with the ads. That is the same
-- sequencing trap the conversion rollout avoided by backfilling while
-- observation-only. It is a separate decision, taken deliberately, not a leftover.

-- roi_daily is fully derived over a rolling window, so it needs no correction here;
-- the next attribution run regenerates it against the campaigns filled in above.
SELECT 1;
