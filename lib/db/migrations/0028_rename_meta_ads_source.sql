-- "Facebook / Instagram Ads" → "Meta Ads".
--
-- Needed as a migration rather than a seed change: seedDefaults inserts with
-- onConflictDoNothing so it never overwrites an existing row, and the repair pass
-- beside it only touches sources whose name is still their raw key. Neither would
-- move a row that already has a real (just outdated) name.
--
-- Guarded on the old value so a name edited in the app afterwards is not reverted
-- if this ever re-runs.
UPDATE "sources" SET "display_name" = 'Meta Ads'
WHERE key = 'facebook/paid' AND "display_name" = 'Facebook / Instagram Ads';--> statement-breakpoint

UPDATE "sources" SET "display_name" = 'Meta (Organic)'
WHERE key = 'facebook/organic' AND "display_name" IN ('facebook/organic', 'Facebook (Organic)');
