-- Flag the OTHER half of a duplicate pair: the one with no estimate, whichever
-- order it arrived in.
--
-- 0035 assumed the later lead of a close pair is the stray. That is usually true and
-- it is wrong for the case that prompted the work. Tom Schalk, 2026-08-13:
--
--   14:19:19  new,    no estimate     <- the stray
--   14:19:37  quoted, estimate linked <- the real one
--
-- The real submission arrived SECOND. 0035 only ever considered flagging the later
-- row and correctly refuses to touch a row with an estimate, so it flagged nothing
-- here — leaving the exact lead that motivated the fix uncorrected while the
-- migration reported success.
--
-- Order is the weaker signal. A linked estimate is the strong one: it means the
-- office turned that submission into real work. So within a close pair the row
-- WITHOUT an estimate is the duplicate, regardless of which came first; order only
-- decides when neither has one.
--
-- Same narrowness as 0035 — same conversation, within 30 minutes, never a row that
-- is already won/lost/cancelled, never a row carrying an estimate, nothing deleted.
UPDATE "leads" dup
SET "is_duplicate" = true,
    "status" = 'duplicate',
    "updated_at" = now()
FROM "leads" other
WHERE dup."conversation_id" IS NOT NULL
  AND dup."conversation_id" = other."conversation_id"
  AND dup."id" <> other."id"
  AND abs(extract(epoch FROM (dup."occurred_at" - other."occurred_at"))) < 1800
  AND dup."hcp_estimate_id" IS NULL
  AND dup."is_duplicate" = false
  AND dup."status" NOT IN ('won', 'lost', 'cancelled', 'duplicate')
  AND dup."type" IN ('web_form', 'facebook_leadgen')
  AND (
    -- the sibling became real work, so this one is the stray whichever came first
    other."hcp_estimate_id" IS NOT NULL
    -- neither did: fall back to order, keeping the first
    OR other."occurred_at" < dup."occurred_at"
  );--> statement-breakpoint

-- roi_daily is derived; the next attribution run drops these from contacts_count.
SELECT 1;
