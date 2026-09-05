import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { TRACKING_STARTED_AT } from "@/lib/tracking-coverage";

/**
 * Why is an estimate unattributed?
 *
 * "~41% of estimates have no lead" is the most-quoted number in this app and the
 * least understood, because it bundles four completely different causes that need
 * four different responses — and only two of them are fixable in software:
 *
 *   1. no communication ever happened   — referral, repeat, canvassing, written in
 *                                          the field. Only HCP-side capture reaches it.
 *   2. the communication predates tracking (before the CallRail cutover). Decays on
 *                                          its own; the CallRail import shrinks it.
 *   3. they contacted us on a route we do not track (an employee's cell, an old
 *                                          number on old marketing).
 *   4. we DID hear from them and failed to link it to the estimate.
 *
 * **The decisive test is 3+4 versus 1+2**: does any non-spam contact exist, on any
 * channel, from any phone number or email belonging to that customer — ever? If yes,
 * the signal reached us and the app lost it, which is a bug. If no, nothing in this
 * codebase could have attributed it and the answer is a process change.
 *
 * That test is what `reachedUsButUnlinked` answers, and it is the number worth acting
 * on. Deliberately matched against the customer's FULL identifier set
 * (`hcp_customers.phones_e164`, plus the estimate's own copy), because matching on a
 * single `mobile ?? home ?? work` value is exactly the bug that hid three real calls
 * in eleven when this was last measured — people ring from whichever handset they are
 * holding.
 *
 * Returns counts and estimate IDs only. No names, phones or emails: this is a
 * bearer-token endpoint and a cause breakdown needs no PII to be actionable — look
 * the IDs up in HousecallPro.
 */
export async function attributionBreakdown(rawDays = 90) {
  const days = Math.min(730, Math.max(1, rawDays));
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db.execute(sql`
    WITH est AS (
      SELECT
        e.id,
        e.hcp_estimate_id,
        -- Aliased: the classified CTE selects est.* AND l.id AS lead_id below, and
        -- two columns named lead_id made every later reference ambiguous (found
        -- live 2026-09-05, first call after 0057 deployed).
        e.lead_id AS linked_lead_id,
        e.created_at_hcp,
        e.hcp_customer_id,
        -- Every identifier this customer is known by, deduped and null-stripped.
        (
          SELECT array_agg(DISTINCT p) FROM unnest(
            coalesce(c.phones_e164, ARRAY[]::text[])
            || ARRAY[e.customer_phone_e164, c.phone_e164]
          ) AS p WHERE p IS NOT NULL AND p <> ''
        ) AS phones,
        lower(coalesce(e.customer_email_lc, c.email_lc)) AS email
      FROM hcp_estimates e
      LEFT JOIN hcp_customers c ON c.id = e.hcp_customer_id
      WHERE e.created_at_hcp >= ${since}
        -- isLiveEstimate + isDeletedEstimate, inline: a cancelled or deleted
        -- estimate is not an opportunity anyone failed to attribute.
        AND (e.status IS NULL OR e.status NOT IN ('pro canceled', 'user canceled'))
        AND NOT (
          e.options IS NOT NULL
          AND jsonb_typeof(e.options) = 'array'
          AND jsonb_array_length(e.options) > 0
          AND jsonb_path_query_array(e.options, '$[*].status') <@ '["deleted"]'::jsonb
        )
    ),
    classified AS (
      SELECT
        est.*,
        l.id AS lead_id,
        l.source_id,
        -- Do we know this person at all? (their HCP customer is linked to a contact)
        EXISTS (SELECT 1 FROM contacts ct WHERE ct.hcp_customer_id = est.hcp_customer_id) AS known_contact,
        -- THE test: did any non-spam contact from this customer ever reach us?
        EXISTS (
          SELECT 1 FROM leads l2
          WHERE l2.is_spam = false
            AND (
              (est.phones IS NOT NULL AND l2.phone_e164 = ANY(est.phones))
              OR (est.email IS NOT NULL AND l2.email_lc = est.email)
            )
        ) AS reached_us
      FROM est
      LEFT JOIN leads l ON l.id = est.linked_lead_id AND l.is_spam = false
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE lead_id IS NOT NULL AND source_id IS NOT NULL)::int AS attributed,
      count(*) FILTER (WHERE lead_id IS NOT NULL AND source_id IS NULL)::int AS lead_but_no_source,
      count(*) FILTER (WHERE lead_id IS NULL)::int AS no_lead,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp < ${TRACKING_STARTED_AT})::int AS no_lead_pre_tracking,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT})::int AS no_lead_since_tracking,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT} AND reached_us)::int AS reached_us_but_unlinked,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT} AND NOT reached_us AND known_contact)::int AS known_contact_never_reached,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT} AND NOT reached_us AND NOT known_contact)::int AS stranger,
      count(*) FILTER (WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT} AND phones IS NULL AND email IS NULL)::int AS no_identifiers_at_all,
      -- IDs for the actionable bucket, so it can be checked case by case in HCP.
      (array_agg(hcp_estimate_id) FILTER (
        WHERE lead_id IS NULL AND created_at_hcp >= ${TRACKING_STARTED_AT} AND reached_us
      ))[1:25] AS unlinked_sample
    FROM classified
  `);

  // "Attributed" is not the same as "usefully attributed". A call to a static
  // published number resolves through `tracking_numbers.static_source_id`, so it
  // lands on a real source row — but if that row is `direct` or `other`, the
  // estimate counts as attributed while telling you nothing you can act on.
  // Splitting the attributed bucket by source is what stops a healthy-looking
  // percentage from hiding a pile of `direct`.
  const bySource = await db.execute(sql`
    SELECT coalesce(s.key, '(none)') AS source_key, count(*)::int AS n
    FROM hcp_estimates e
    JOIN leads l ON l.id = e.lead_id AND l.is_spam = false
    LEFT JOIN sources s ON s.id = l.source_id
    WHERE e.created_at_hcp >= ${since}
      AND (e.status IS NULL OR e.status NOT IN ('pro canceled', 'user canceled'))
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  const r = (rows.rows?.[0] ?? {}) as Record<string, number | string[] | null>;
  const n = (k: string) => Number(r[k] ?? 0);

  const total = n("total");
  const pct = (x: number) => (total ? Math.round((x / total) * 1000) / 10 : 0);

  return {
    ok: true as const,
    windowDays: days,
    trackingStartedAt: TRACKING_STARTED_AT.toISOString(),
    total,
    attributed: { n: n("attributed"), pct: pct(n("attributed")) },
    leadButNoSource: { n: n("lead_but_no_source"), pct: pct(n("lead_but_no_source")) },
    noLead: { n: n("no_lead"), pct: pct(n("no_lead")) },
    causes: {
      // (2) predates tracking — decays on its own, CallRail import shrinks it
      preTracking: n("no_lead_pre_tracking"),
      // (3)/(4) THE ACTIONABLE ONE — the signal reached us and we lost it
      reachedUsButUnlinked: n("reached_us_but_unlinked"),
      // (1) we know them, but this job produced no contact — repeat/referral
      knownContactNeverReached: n("known_contact_never_reached"),
      // (1) never heard of them at all
      stranger: n("stranger"),
      // Cannot be matched either way — no phone and no email on the estimate
      noIdentifiersAtAll: n("no_identifiers_at_all"),
    },
    unlinkedSample: r.unlinked_sample ?? [],
    // Which channels the attributed ones landed on. `direct` and `other` are real
    // source rows, so they inflate "attributed" without being actionable.
    attributedBySource: Object.fromEntries(
      (bySource.rows as Array<{ source_key: string; n: number }>).map((x) => [x.source_key, Number(x.n)]),
    ),
    note:
      "reachedUsButUnlinked is the fixable bucket: a non-spam contact exists from one of this customer's " +
      "phone numbers or emails, but no lead is linked to the estimate. preTracking decays on its own. " +
      "knownContactNeverReached and stranger are reachable only by capturing source inside HousecallPro.",
  };
}
