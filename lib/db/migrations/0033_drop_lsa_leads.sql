-- Remove the imported Local Services lead rows along with the sync that made them.
--
-- The LSA leads pull was pure duplication. Since the CallRail cutover on
-- 2026-08-08 every Local Services PHONE_CALL also arrives on the LSA tracking
-- number, and the call is the better record: it carries duration, a recording and
-- a transcript, so it can be classified, which an API row never could. Over the
-- first six days the line recorded MORE than Google billed (24 calls against 19
-- leads), because Google only charges for qualifying calls.
--
-- The other two lead types were the reason to keep it and neither survived a look
-- at the data: MESSAGE has produced nothing since 2024, BOOKING nothing since
-- 2026-04-05. Cost is unaffected either way — LSA spend comes from the campaign
-- report (advertising_channel_type = LOCAL_SERVICES), never from this pull.
--
-- The pre-cutover rows are deleted too, at Justin's direction: they cover the
-- period when CallRail was the system of record, and that history is better
-- re-imported from CallRail itself than kept as a partial copy carrying only a
-- name and a phone number.
--
-- google/lsa remains a source and +16183669977 remains its tracking number, so
-- calls keep attributing to Local Services exactly as before. `lsa` also stays in
-- lead_type: removing a value from a pg enum means rebuilding the type, and a
-- CallRail import may well want it back.

-- Nullable back-references first. LSA rows were bare inserts that never threaded,
-- so these should all be no-ops — done anyway rather than assumed, because an
-- FK violation here would abort the release for a row nobody predicted.
UPDATE "calls"             SET "lead_id" = NULL WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint
UPDATE "messages"          SET "lead_id" = NULL WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint
UPDATE "form_submissions"  SET "lead_id" = NULL WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint
UPDATE "facebook_leads"    SET "lead_id" = NULL WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint

-- These two reference leads NOT NULL, so they must go rather than be detached.
-- Both are derived: `attributions` is rebuilt from leads on every attribution run,
-- and a conversion export needs a click id, which an LSA row never had — so there
-- should be nothing here either.
DELETE FROM "conversion_exports" WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint
DELETE FROM "attributions"       WHERE "lead_id" IN (SELECT id FROM "leads" WHERE type = 'lsa');--> statement-breakpoint

DELETE FROM "leads" WHERE type = 'lsa';--> statement-breakpoint

-- Retire the job's run history so Settings → Sync stops showing a job that no
-- longer exists as permanently stale.
DELETE FROM "sync_runs" WHERE "job" = 'lsa.sync.leads';--> statement-breakpoint

-- roi_daily is fully derived over a rolling window; the next attribution run
-- rebuilds it without these contacts.
SELECT 1;
