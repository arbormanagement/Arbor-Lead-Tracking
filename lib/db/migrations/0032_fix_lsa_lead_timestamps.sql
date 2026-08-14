-- Repair Local Services lead timestamps stored 5-6 hours early.
--
-- `local_services_lead.creation_date_time` is a Google Ads DATE_TIME: the string
-- "yyyy-MM-dd HH:mm:ss" in the ACCOUNT's timezone, with no offset attached.
-- `new Date(...)` on an offset-less string reads it as the SERVER's local time,
-- which on Railway is UTC — so every LSA lead was stored as though a Chicago wall
-- clock were a UTC one, landing 5 hours early in summer and 6 in winter.
-- (Confirmed against the API: customer 8300392986 reports America/Chicago.)
--
-- How it surfaced: an LSA lead and the call it produced showed on /leads as two
-- contacts five hours apart. They are one contact a minute apart — (618) 631-3620
-- and (618) 514-4341 both match to the minute once the offset is undone.
--
-- Two things were wrong, not one. Display was the visible half; the load-bearing
-- half is that `occurred_at` is what roi_daily buckets on via businessDate(), so
-- any LSA lead between midnight and ~5am CT was being counted on the PREVIOUS
-- business day — beside the wrong day's spend.
--
-- The correction reads the stored UTC wall clock (which IS the intended Chicago
-- wall clock) and re-interprets it in Chicago. Postgres resolves the offset per
-- row, so rows either side of a DST boundary each get the right one — a fixed
-- INTERVAL '5 hours' would have been wrong for every winter lead.
--
-- Scoped to type='lsa' because that is the only path that read this field. Not
-- idempotent by construction — running it twice would shift twice — which is safe
-- here only because the migration journal applies it exactly once. Do not re-run
-- it by hand.
UPDATE "leads"
SET "occurred_at" = ("occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago'
WHERE "type" = 'lsa';--> statement-breakpoint

-- roi_daily is fully derived over a rolling window, so it needs no correction
-- here; the next attribution run re-buckets these leads onto the right days.
SELECT 1;
