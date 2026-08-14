-- Flag the duplicate leads that one person's repeated form submission created.
--
-- `leads.is_duplicate` has existed since the first schema, is rendered on lead
-- detail as a badge, and **nothing has ever written it**. A flag no code sets is a
-- flag that silently reads false for every row, which is worse than not having one:
-- the badge implied duplicates were being detected.
--
-- The leads themselves come from web forms minting one lead per submission. The
-- `(session, form, sorted fields)` dedupe key catches a literal re-post but cannot
-- catch a resubmission with a changed field — Tom Schalk, 2026-08-13, two leads
-- eighteen seconds apart. The code fix is `findOpenLead`: a submission joins the
-- enquiry already in flight, the way texts always have. This is the history.
--
-- Deliberately narrow. It flags a lead only when ALL of these hold:
--   · it shares a conversation with an EARLIER lead — same person, same thread;
--   · both arrived within 30 minutes, so a genuine repeat enquiry weeks later is
--     untouched (repeat business is real revenue and must keep its own lead);
--   · it has NO estimate linked — an estimate is proof the office treated it as
--     real work, and that outweighs any heuristic here;
--   · it is not already won/lost/cancelled.
--
-- Nothing is deleted. The row stays, the form_submissions row stays, the thread
-- still shows both events. Only the counting changes.
UPDATE "leads" dup
SET "is_duplicate" = true,
    "status" = 'duplicate',
    "updated_at" = now()
FROM "leads" orig
WHERE dup."conversation_id" IS NOT NULL
  AND dup."conversation_id" = orig."conversation_id"
  AND dup."id" <> orig."id"
  AND orig."occurred_at" < dup."occurred_at"
  AND dup."occurred_at" - orig."occurred_at" < interval '30 minutes'
  AND dup."hcp_estimate_id" IS NULL
  AND dup."is_duplicate" = false
  AND dup."status" NOT IN ('won', 'lost', 'cancelled', 'duplicate')
  AND dup."type" IN ('web_form', 'facebook_leadgen');--> statement-breakpoint

-- roi_daily is derived over a rolling window; the next attribution run drops these
-- from contacts_count, which is the only figure they were ever inflating.
SELECT 1;
