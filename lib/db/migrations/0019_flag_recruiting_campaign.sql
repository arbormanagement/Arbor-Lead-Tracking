-- Flag the arborist-recruiting campaign as non-customer-acquisition, so the fix
-- lands with the deploy instead of waiting on someone to tick a box.
--
-- Single-tenant app, so the campaign is named by its Meta id: 120242829454540403
-- ("Arborist Recruiting 2026"). Its spend stays on record — only the ROI counting
-- changes. Settings -> Campaigns can flip this back at any time.
--
-- No-op until the spend sync has pulled that campaign at least once, and safe to
-- re-run: it only sets a boolean that is already false.
UPDATE "campaigns"
SET "excluded" = true
WHERE "platform" = 'facebook'
  AND "external_campaign_id" = '120242829454540403';
