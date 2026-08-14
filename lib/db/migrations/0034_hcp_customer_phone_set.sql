-- Give every HousecallPro customer ALL of their normalized phone numbers.
--
-- `hcp_customers.phone_e164` is `mobile ?? home ?? work` — one number for a person
-- who may have three. Every identity path in the app keyed off it, so someone who
-- always rings from the landline was invisible: their contact never linked to their
-- HCP record, and their estimates therefore never linked to their calls.
--
-- Measured against production before writing this: of eleven estimates whose
-- customer carried a second number, THREE had real calls only on the number the app
-- was ignoring — two calls in one case. Those estimates read as unattributed with
-- the evidence sitting in the same database.
--
-- The backfill reads `raw`, which holds HCP's full customer payload, rather than
-- the `phone` / `mobile` columns — those already collapsed home and work into one
-- slot, so re-deriving from them would preserve the very loss this fixes.
--
-- Normalization mirrors lib/phone.ts exactly (US/NANP): strip to digits, 10 digits
-- take +1, 11 digits beginning 1 take +, anything else is dropped rather than
-- guessed. Getting this out of step with the TypeScript would be worse than not
-- backfilling at all, because the two would produce keys that never match.
ALTER TABLE "hcp_customers" ADD COLUMN "phones_e164" text[];--> statement-breakpoint
CREATE INDEX "hcp_customers_phones_idx" ON "hcp_customers" USING gin ("phones_e164");--> statement-breakpoint

UPDATE "hcp_customers" SET "phones_e164" = sub.phones
FROM (
  SELECT c.id,
         array_agg(DISTINCT p.e164) FILTER (WHERE p.e164 IS NOT NULL) AS phones
  FROM "hcp_customers" c
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN length(regexp_replace(coalesce(n.raw_number,''), '[^0-9]', '', 'g')) = 10
               THEN '+1' || regexp_replace(n.raw_number, '[^0-9]', '', 'g')
             WHEN length(regexp_replace(coalesce(n.raw_number,''), '[^0-9]', '', 'g')) = 11
              AND left(regexp_replace(coalesce(n.raw_number,''), '[^0-9]', '', 'g'), 1) = '1'
               THEN '+' || regexp_replace(n.raw_number, '[^0-9]', '', 'g')
             ELSE NULL
           END AS e164
    FROM (
      VALUES
        (c."raw" ->> 'mobile_number'),
        (c."raw" ->> 'home_number'),
        (c."raw" ->> 'work_number'),
        -- The already-normalized primary, so a customer whose `raw` is missing
        -- (older rows, or a payload shape change) still ends up with one entry
        -- rather than an empty array that matches nothing.
        (c."phone_e164")
    ) AS n(raw_number)
  ) AS p
  GROUP BY c.id
) AS sub
WHERE "hcp_customers".id = sub.id;--> statement-breakpoint

-- roi_daily and the lead-to-estimate links are fully derived; the next attribution
-- run re-matches against the widened identity and picks up the recovered estimates.
SELECT 1;
