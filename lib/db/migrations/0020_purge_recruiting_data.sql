-- Remove what the arborist-recruiting campaign already put in the database:
-- the job applicants sitting in the lead inbox, and its ad_spend rows.
--
-- Flagging the campaign (0018) stops it counting; this clears the rows it already
-- wrote. Both are re-pullable from Meta if ever wanted back — leads via the form's
-- leads_retrieval, spend via the sync's rolling re-pull once the campaign is
-- un-excluded in Settings -> Campaigns.
--
-- Every statement is scoped to that one campaign (Meta 120242829454540403) and the
-- hiring form (853017504484918). Nothing here touches the tree-services campaign,
-- and future Facebook campaigns are unaffected: new campaigns default to counted.

-- Applicants whose ad-to-campaign lookup failed at ingest carry a null campaign_id,
-- so attach them to the recruiting campaign first. Everything below can then key off
-- campaign_id alone, which keeps the delete order simple and FK-safe.
UPDATE "leads"
SET "campaign_id" = (
  SELECT "id" FROM "campaigns"
  WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
)
WHERE "campaign_id" IS NULL
  AND "id" IN (
    SELECT "lead_id" FROM "facebook_leads"
    WHERE "fb_form_id" = '853017504484918' AND "lead_id" IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM "campaigns"
    WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
  );
--> statement-breakpoint

-- Dependents before the leads themselves.
DELETE FROM "conversion_exports"
WHERE "lead_id" IN (
  SELECT "id" FROM "leads"
  WHERE "campaign_id" IN (
    SELECT "id" FROM "campaigns"
    WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
  )
);
--> statement-breakpoint

DELETE FROM "attributions"
WHERE "lead_id" IN (
  SELECT "id" FROM "leads"
  WHERE "campaign_id" IN (
    SELECT "id" FROM "campaigns"
    WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
  )
);
--> statement-breakpoint

-- Also drops any hiring-form detail rows that never produced a lead. The ingest now
-- rejects excluded campaigns before writing anything, so these don't come back.
DELETE FROM "facebook_leads"
WHERE "fb_form_id" = '853017504484918'
   OR "lead_id" IN (
     SELECT "id" FROM "leads"
     WHERE "campaign_id" IN (
       SELECT "id" FROM "campaigns"
       WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
     )
   );
--> statement-breakpoint

DELETE FROM "leads"
WHERE "campaign_id" IN (
  SELECT "id" FROM "campaigns"
  WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403'
);
--> statement-breakpoint

-- The spend rows themselves. The sync now skips excluded campaigns, so the rolling
-- re-pull won't put them back. The campaigns row is deliberately kept: it is what
-- Settings -> Campaigns lists, and deleting it would remove the toggle.
DELETE FROM "ad_spend"
WHERE "platform" = 'facebook' AND "external_campaign_id" = '120242829454540403';
