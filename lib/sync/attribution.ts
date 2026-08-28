import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import {
  adSpend,
  attributions,
  campaigns,
  contacts,
  hcpEstimates,
  leads,
  manualSpend,
  roiDaily,
  sources,
} from "@/lib/db/schema";
import { countableEstimateDate, isCountableEstimate, isLiveEstimate } from "@/lib/estimates/countable";
import { PRE_TRACKING_SOURCE_KEY } from "@/lib/sources/naming";
import { TRACKING_STARTED_AT } from "@/lib/tracking-coverage";
import { getSetting } from "@/lib/settings";
import { businessDate } from "@/lib/tz";
import { withSyncRun } from "./run";

/**
 * HousecallPro reports `created_at` to WHOLE SECONDS — there is no sub-second
 * component in the payload — so an estimate stamped 15:57:58 was really created
 * somewhere in [15:57:58.000, 15:57:59.000).
 *
 * That matters because the lead must precede the estimate, and `leads.occurred_at`
 * DOES carry milliseconds. Comparing the two directly makes an enquiry look later
 * than the estimate it produced whenever the office (or the web-form automation)
 * writes the estimate inside the same second.
 *
 * Measured 2026-08-19: web form from Jim Wiemers (+16183776379) at 15:57:58.050 →
 * estimate csr_ab13fcb79a104e8386b333959024e223 stamped 15:57:58. Same phone, same
 * email, 50 ms apart — and permanently unattributable, with the lead frozen at
 * `new`. Nine other leads from the same batch matched only because their estimate
 * happened to land in the NEXT second. The failure is silent and looks exactly like
 * a customer who never contacted us.
 */
const HCP_CREATED_AT_GRANULARITY_MS = 1000;

/** Bulk-insert batch size — a single-statement insert exceeds Postgres's 65,535
 *  bind-param limit at ~5-6k rows (attributions/roi_daily are ~10 params/row). */
const INSERT_CHUNK = 500;

/**
 * attribution.run — the credential-independent core of ROI. Three passes, each a
 * full idempotent rebuild over a rolling window:
 *
 *   1. matchLeadsToWonEstimates  leads → hcp_customers (phone/email) → nearest WON
 *                         (customer-approved) hcp_estimate within `windowDays` → sets
 *                         hcp_estimate_id, quote + sales value, status 'won'. Revenue
 *                         is the approved-option amount. Estimate-centric so each won
 *                         estimate's value is counted once.
 *   2. rebuildAttributions one 'last' touch per non-spam lead (first-touch arrives
 *                          with web tracking in Phase 3; the table already supports it).
 *   3. rebuildRoiDaily     aggregate leads + ad_spend into roi_daily per
 *                          (date, source, campaign, location) with CPL/CPA/ROI.
 *                          Campaigns flagged `excluded` (recruiting) contribute
 *                          neither spend nor leads — see `lib/campaigns.ts`.
 *
 * Reuses the normalized phone_e164 / email_lc columns written by the HCP sync.
 */
export async function runAttribution({
  windowDays = 90,
  // roi_daily is cheap to rebuild (a few rows per day), so it covers the longest
  // dashboard timeframe — otherwise a lead re-derived late (e.g. an old estimate
  // approved months after the lead) would never reach its roi_daily date row.
  roiWindowDays = 365,
}: { windowDays?: number; roiWindowDays?: number } = {}) {
  return withSyncRun("attribution.run", async () => {
    const matched = await matchLeadsToEstimates(windowDays);
    const touches = await rebuildAttributions(roiWindowDays);
    const roiRows = await rebuildRoiDaily(roiWindowDays);
    return { qualifiedLeads: matched.qualified, wonLeads: matched.won, attributionTouches: touches, roiRows };
  });
}

// ── 1. Lead → HCP estimate matching (qualification + revenue) ─────────────────
// A lead is a QUALIFIED lead once an estimate is created for its contact, and WON
// once that estimate is approved — both derived from the same match, off the
// contact embedded on the estimate (no dependency on a separate customer sync).
//
// Two settings shape the match:
//  · customer_window_days — repeat business: a won estimate whose contact has NO
//    unclaimed lead of its own inherits the contact's already-matched lead when it
//    falls within this many days of it (ServiceTitan "Smart Attribution" style),
//    so paid channels get credit for the follow-up work they generated. 0 disables.
async function matchLeadsToEstimates(windowDays: number): Promise<{ qualified: number; won: number }> {
  const customerWindowDays = await getSetting<number>("customer_window_days", 90);
  const lookback = new Date(Date.now() - (windowDays + 30) * 86_400_000);

  // Estimates worth (re)deriving from: recently created, OR changed in HCP
  // recently no matter how old (late approval, cancellation, price edit —
  // updated_at_hcp is HCP's own change stamp, refreshed by the HCP sync).
  const scannedEstimates = or(
    gte(hcpEstimates.createdAtHcp, lookback),
    gte(hcpEstimates.updatedAtHcp, lookback),
  );

  // Clean rebuild — but only what the estimate scan below can re-derive:
  // recent leads, plus older leads whose linked estimate just changed. Anything
  // else keeps its last matched stage/value as frozen history rather than being
  // wiped and never re-matched.
  const resettable = and(
    eq(leads.isSpam, false),
    or(
      gte(leads.occurredAt, lookback),
      inArray(
        leads.hcpEstimateId,
        db.select({ id: hcpEstimates.id }).from(hcpEstimates).where(scannedEstimates),
      ),
    ),
  );
  // Status reset must run first — clearing hcp_estimate_id would break the
  // linked-estimate arm of `resettable` for the second statement. One transaction
  // so a crash between the two can't leave leads half-reset.
  await db.transaction(async (tx) => {
    await tx
      .update(leads)
      .set({ status: "new" })
      .where(and(resettable, inArray(leads.status, ["won", "qualified", "quoted", "lost", "cancelled"])));
    await tx
      .update(leads)
      .set({ hcpEstimateId: null, salesValueCents: null, quoteValueCents: null })
      .where(resettable);
  });

  // Every estimate (created), ordered so the RIGHT estimate claims the lead. A lead
  // can be claimed only once (`claimedLeads` below), so when one customer has
  // several estimates this ordering alone decides which of them carries the
  // attribution — and which are left reading as untracked business.
  //
  // The office's practice is the thing to encode: a customer who submits several
  // estimate requests gets ONE kept — the first — and the rest cancelled as
  // duplicates. So:
  //
  //  1. won first     — a won estimate claims its lead ahead of a merely-created
  //                     one; that is where the revenue is.
  //  2. live first    — a cancelled or deleted duplicate must never claim a lead
  //                     ahead of the estimate that survived it.
  //  3. oldest first  — of two live estimates competing for one lead, the earlier
  //                     is the real request; the later is the duplicate.
  //
  // Measured 2026-08-28, both caused by the previous `desc(created_at)` ordering:
  //  · Patrick Shansey — his CANCELLED duplicate (15466) claimed the 8/19 web-form
  //    lead, so the surviving estimate 15350 read as unattributed AND the live lead
  //    was stamped `cancelled`, since the stage set below is derived from whichever
  //    estimate claims it. 177 leads sat at `cancelled` against 94 at `quoted`.
  //  · Pamela Norton — her Google LSA call was credited to a $4,550 second estimate
  //    while the $7,000 one written four minutes after that call read as
  //    unattributed.
  const estRows = await db
    .select({
      estId: hcpEstimates.id,
      won: hcpEstimates.won,
      outcome: hcpEstimates.outcome,
      estStatus: hcpEstimates.status,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      createdAtHcp: hcpEstimates.createdAtHcp,
      custId: hcpEstimates.hcpCustomerId,
      custPhone: hcpEstimates.customerPhoneE164,
      custEmail: hcpEstimates.customerEmailLc,
    })
    .from(hcpEstimates)
    .where(scannedEstimates)
    .orderBy(desc(hcpEstimates.won), desc(isLiveEstimate), asc(hcpEstimates.createdAtHcp));

  // The identity spine, indexed by HCP customer. `contacts` + `contact_identifiers`
  // already unify every number and address a person has ever used, and
  // `contacts.hcp_customer_id` ties that person to their HCP record — so this is
  // the app's own answer to "who is this", and the estimate match had not been
  // using it.
  //
  // Matching purely on `hcp_estimates.customer_phone_e164` meant matching on ONE
  // number (mobile ?? home ?? work) by exact equality. Measured against production:
  // of eleven estimates whose customer had a second number, three had real calls
  // only on the number the app was ignoring, so those estimates read as
  // unattributed with the evidence sitting in the same database.
  const contactByHcpCustomerForMatch = new Map<string, string>();
  for (const c of await db
    .select({ id: contacts.id, hcpCustomerId: contacts.hcpCustomerId })
    .from(contacts)
    .where(isNotNull(contacts.hcpCustomerId))) {
    if (c.hcpCustomerId) contactByHcpCustomerForMatch.set(c.hcpCustomerId, c.id);
  }

  const claimedLeads = new Set<string>();
  // Contact key → the first claimed lead for that contact, for the repeat-business
  // inheritance pass (customer_window_days).
  const claimedByContact = new Map<string, { leadId: string; leadAt: Date }>();
  let qualified = 0;
  let won = 0;

  for (const est of estRows) {
    // A contact-linked estimate is matchable even with no phone or email of its
    // own, so this can no longer skip on those two alone.
    if (!est.custPhone && !est.custEmail && !est.custId) continue;
    // The lead must precede the estimate being WRITTEN, so the window is anchored
    // to created_at_hcp even for won estimates — approved_at_hcp can derive from
    // HCP's updated_at, which drifts on ANY edit, and anchoring there would let a
    // later unrelated inquiry steal credit for an old job.
    const estDate = est.createdAtHcp;
    if (!estDate) continue;

    const contactKeys = [est.custPhone && `p:${est.custPhone}`, est.custEmail && `e:${est.custEmail}`].filter(
      Boolean,
    ) as string[];

    const windowStart = new Date(estDate.getTime() - windowDays * 86_400_000);
    const estUpperBound = new Date(estDate.getTime() + HCP_CREATED_AT_GRANULARITY_MS);
    // Identity, widest first: the contact this estimate's customer resolves to,
    // then the estimate's own phone/email as the fallback for a customer the
    // contact spine has not linked yet. The spine arm is what recovers a caller
    // who used a different one of their own numbers.
    const contactId = est.custId ? contactByHcpCustomerForMatch.get(est.custId) : undefined;
    const identityArms = [
      contactId ? eq(leads.contactId, contactId) : null,
      est.custPhone ? eq(leads.phoneE164, est.custPhone) : null,
      est.custEmail ? eq(leads.emailLc, est.custEmail) : null,
    ].filter(Boolean) as SQL[];
    const contactMatch = identityArms.length === 1 ? identityArms[0] : or(...identityArms)!;

    const candidates = await db
      .select({ id: leads.id, occurredAt: leads.occurredAt })
      .from(leads)
      .where(
        and(
          contactMatch,
          eq(leads.isSpam, false),
          gte(leads.occurredAt, windowStart),
          // "Before the estimate was written" — to the end of the second HCP
          // stamped it in, not to the truncated stamp itself. See
          // HCP_CREATED_AT_GRANULARITY_MS. The widening is under one second, so it
          // cannot let an unrelated later enquiry steal an old job; what it buys is
          // that a lead which genuinely caused the estimate stops reading as later
          // than it.
          lt(leads.occurredAt, estUpperBound),
          // Never steal a lead that is already linked to an estimate this run did
          // not scan. Those leads are outside the reset above, so their stage and
          // value are frozen history — letting a newer estimate claim one would
          // OVERWRITE salesValueCents and hcp_estimate_id, and the older won
          // estimate's revenue would silently vanish from ROI with nothing to
          // restore it. Leads linked to an estimate we DID scan are fair game:
          // they were just reset and are being re-derived.
          or(
            isNull(leads.hcpEstimateId),
            inArray(
              leads.hcpEstimateId,
              db.select({ id: hcpEstimates.id }).from(hcpEstimates).where(scannedEstimates),
            ),
          ),
        ),
      )
      // Last-touch credits the latest lead before the estimate; first-touch the earliest.
      // ALWAYS the latest qualifying lead. This link IS the last-touch answer, and
      // first-touch is now computed properly in the rollup from the contact's own
      // history — so the old `attribution_model` setting no longer changes what is
      // derived here. It selects which model the dashboard DISPLAYS
      // (lib/attribution/model.ts), and both are always available.
      .orderBy(desc(leads.occurredAt))
      .limit(5);

    const pick = candidates.find((c) => !claimedLeads.has(c.id));
    if (!pick) {
      // Repeat business: a WON estimate with no lead of its own inherits the
      // contact's already-matched lead when it falls inside the customer window —
      // the revenue accrues to the source that originally acquired the customer.
      if (est.won && customerWindowDays > 0) {
        const prior = contactKeys.map((k) => claimedByContact.get(k)).find(Boolean);
        const age = prior ? estDate.getTime() - prior.leadAt.getTime() : -1;
        // Same second-truncation allowance as the candidate window above, so a
        // repeat customer whose enquiry landed inside the estimate's own second is
        // not read as having contacted us afterwards.
        if (prior && age > -HCP_CREATED_AT_GRANULARITY_MS && age <= customerWindowDays * 86_400_000) {
          await db
            .update(leads)
            .set({
              salesValueCents: sql`coalesce(${leads.salesValueCents}, 0) + ${est.approved ?? 0}`,
              status: "won",
            })
            .where(eq(leads.id, prior.leadId));
          won++;
        }
      }
      continue;
    }

    claimedLeads.add(pick.id);
    for (const k of contactKeys) if (!claimedByContact.has(k)) claimedByContact.set(k, { leadId: pick.id, leadAt: pick.occurredAt });
    // Stage from the estimate state: won (≥1 option approved) → won; cancelled →
    // cancelled (estimate-level work_status — cancellation never reaches the option
    // approval fields); lost (every decided option declined/expired) → lost; has a
    // quote amount → quoted; estimate exists but no price yet → qualified.
    const s = (est.estStatus ?? "").toLowerCase();
    const status = est.won
      ? "won"
      : /cancel/.test(s)
        ? "cancelled"
        : est.outcome === "lost"
          ? "lost"
          : (est.total ?? 0) > 0
            ? "quoted"
            : "qualified";
    await db
      .update(leads)
      .set({
        hcpCustomerId: est.custId,
        hcpEstimateId: est.estId,
        // Won → what was actually approved (multi-approval = add-ons, so the sum);
        // otherwise the highest-value option (alternative bids, not a sum).
        quoteValueCents: (est.won ? est.approved : null) || est.total || null,
        salesValueCents: est.won ? est.approved || 0 : null,
        status,
      })
      .where(eq(leads.id, pick.id));
    if (est.won) won++;
    else if (status !== "lost" && status !== "cancelled") qualified++;
  }

  // "qualified" total includes won leads (a won lead is also a qualified lead).
  return { qualified: qualified + won, won };
}

// ── 2. Attribution trail (last-touch for now) ────────────────────────────────
/**
 * `windowDays` bounds the rebuild to recent leads instead of every lead ever.
 * Unbounded, this re-selected and delete-reinserted the ENTIRE table every hour,
 * so the work per tick grew forever with no ceiling. A lead's attribution inputs
 * (source, campaign, click ids, keyword, landing page) are set when it is created
 * and don't change afterwards, so rebuilding older rows only ever reproduced them
 * — and the window used here is the same 365 days the ROI rollup covers, which is
 * wider than any dashboard timeframe.
 */
async function rebuildAttributions(windowDays: number): Promise<number> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  // Delete-then-insert in one transaction, serialized on an advisory lock so
  // concurrent rebuilds (hourly cron vs dashboard "Run sync now") queue instead
  // of interleaving — two interleaved rebuilds would drop or double touches.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('attribution-rebuild'))`);

    const rows = await tx
      .select({
        id: leads.id,
        sourceId: leads.sourceId,
        campaignId: leads.campaignId,
        gclid: leads.gclid,
        fbclid: leads.fbclid,
        keyword: leads.keyword,
        landingPage: leads.landingPage,
        occurredAt: leads.occurredAt,
      })
      .from(leads)
      .where(and(eq(leads.isSpam, false), gte(leads.occurredAt, since)));

    // Clear then insert one 'last' touch per lead — scoped to the same window, so
    // touches for older leads are left as frozen history rather than deleted with
    // nothing to re-insert them.
    await tx
      .delete(attributions)
      .where(
        and(
          eq(attributions.touchType, "last"),
          inArray(
            attributions.leadId,
            tx.select({ id: leads.id }).from(leads).where(gte(leads.occurredAt, since)),
          ),
        ),
      );
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(attributions).values(
        rows.slice(i, i + INSERT_CHUNK).map((r) => ({
          leadId: r.id,
          touchType: "last" as const,
          sourceId: r.sourceId,
          campaignId: r.campaignId,
          gclid: r.gclid,
          fbclid: r.fbclid,
          keyword: r.keyword,
          landingPage: r.landingPage,
          occurredAt: r.occurredAt,
          weight: "1",
        })),
      );
    }
    return rows.length;
  });
}

// ── 3. roi_daily rollup ──────────────────────────────────────────────────────
/** ad_spend platform → source key, so spend (which carries platform) can roll up.
 *  Also used by the spend sync to anchor cold-start backfills to lead history. */
export const PLATFORM_SOURCE_KEY: Record<string, string> = {
  google: "google/cpc",
  google_lsa: "google/lsa",
  facebook: "facebook/paid",
};

type TouchModel = "first" | "last";

interface RoiAcc {
  date: string;
  touchType: TouchModel;
  sourceId: string | null;
  campaignId: string | null;
  location: "edwardsville" | "ofallon" | "unknown";
  contactsCount: number;
  estimatesCount: number;
  callsCount: number;
  formsCount: number;
  wonCount: number;
  spendCents: number;
  revenueCents: number;
  quoteValueCents: number;
}

async function rebuildRoiDaily(windowDays: number): Promise<number> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  // The rebuild deletes and re-inserts whole BUSINESS days, so the boundary must be
  // a business date too. Deriving it from toISOString() (UTC) desynchronizes the
  // delete window from the `businessDate()` bucketing below: for runs between 00:00
  // and 06:00 UTC (6pm–midnight CT — several hourly ticks every evening) a lead
  // buckets to `sinceDate - 1`, lands OUTSIDE the deleted window, and either
  // collides with the previous run's surviving row (unique violation, aborting the
  // whole rebuild) or silently duplicates that day when source/campaign are NULL.
  const sinceDate = businessDate(since);
  // Re-count the boundary day in FULL. The delete clears entire business days, so
  // selecting leads on the raw `since` timestamp would permanently drop the ones
  // that occurred earlier on that same CT day, leaving a partial oldest row that
  // skews its CPL/ROAS high. Scan wider than any UTC offset and filter by business
  // date in the loop.
  const leadScanFrom = new Date(since.getTime() - 2 * 86_400_000);
  // Estimates are scanned on their APPOINTMENT date, but an attributed one buckets
  // to its contact's day — which can precede the appointment by weeks. Reach back
  // further so an estimate whose contact falls inside the window is not skipped
  // just because its visit was booked before the scan started.
  const estimateScanFrom = new Date(since.getTime() - 120 * 86_400_000);

  // Non-customer-acquisition campaigns (recruiting) contribute neither spend nor
  // leads to ROI. Resolved once and applied to both sides of the rollup so a
  // campaign flagged in Settings drops out on the next run, with no cleanup needed.
  const excluded = await excludedCampaignIds();

  // ── First-touch lookup ────────────────────────────────────────────────────
  // A contact's FIRST-EVER inbound event — the channel that originally acquired
  // that person, however long ago. This is what makes first-touch real rather than
  // "the earliest of the recent leads", which is all the old attribution_model
  // setting could reach.
  const firstTouchRows = await db
    .selectDistinctOn([leads.contactId], {
      contactId: leads.contactId,
      sourceId: leads.sourceId,
      campaignId: leads.campaignId,
      location: leads.location,
    })
    .from(leads)
    .where(and(isNotNull(leads.contactId), eq(leads.isSpam, false)))
    .orderBy(leads.contactId, asc(leads.occurredAt));
  const firstTouchByContact = new Map(firstTouchRows.map((r) => [r.contactId!, r]));

  // HCP customer → our contact, so a repeat estimate with NO new inbound contact can
  // still be traced back to the person and thus to whoever acquired them. This is the
  // path that makes first-touch work where last-touch correctly has nothing to say.
  const contactRowsByHcp = await db
    .select({ id: contacts.id, hcpCustomerId: contacts.hcpCustomerId })
    .from(contacts)
    .where(isNotNull(contacts.hcpCustomerId));
  const contactByHcpCustomer = new Map(contactRowsByHcp.map((c) => [c.hcpCustomerId!, c.id]));

  // Source-key → id, so ad spend (which carries platform, not source) can roll up.
  const sourceRows = await db.select({ id: sources.id, key: sources.key }).from(sources);
  const sourceIdByKey = new Map(sourceRows.map((s) => [s.key, s.id]));
  const preTrackingSourceId = sourceIdByKey.get(PRE_TRACKING_SOURCE_KEY) ?? null;

  const acc = new Map<string, RoiAcc>();
  const keyOf = (a: {
    date: string;
    touchType: TouchModel;
    sourceId: string | null;
    campaignId: string | null;
    location: string;
  }) => `${a.date}|${a.touchType}|${a.sourceId ?? ""}|${a.campaignId ?? ""}|${a.location}`;
  const bump = (seed: Omit<RoiAcc, "contactsCount" | "estimatesCount" | "callsCount" | "formsCount" | "wonCount" | "spendCents" | "revenueCents" | "quoteValueCents">) => {
    const k = keyOf(seed);
    let row = acc.get(k);
    if (!row) {
      row = { ...seed, contactsCount: 0, estimatesCount: 0, callsCount: 0, formsCount: 0, wonCount: 0, spendCents: 0, revenueCents: 0, quoteValueCents: 0 };
      acc.set(k, row);
    }
    return row;
  };

  // ── DEMAND: inbound contacts ──────────────────────────────────────────────
  // Every non-spam contact, whatever channel. `is_lead` is deliberately NOT
  // consulted: this counts people who got in touch, and an unclassified call from
  // a real person is still someone getting in touch. Opportunity is a separate
  // number now (below), measured off estimates, so this no longer has to double as
  // both — which is what made three rival definitions of "a lead" possible.
  const contactRows = await db
    .select({
      occurredAt: leads.occurredAt,
      sourceId: leads.sourceId,
      campaignId: leads.campaignId,
      location: leads.location,
      type: leads.type,
      contactId: leads.contactId,
    })
    .from(leads)
    .where(
      and(
        eq(leads.isSpam, false),
        // A duplicate is not a second person getting in touch. Web forms minted one
        // lead per submission until `findOpenLead` landed, so one visitor
        // resubmitting counted twice here — the only figure it ever inflated, since
        // opportunity is measured off estimates. Flagged by 0035 and by nothing else
        // before it: this column existed and was never written.
        eq(leads.isDuplicate, false),
        gte(leads.occurredAt, leadScanFrom),
        campaignNotExcluded(leads.campaignId, excluded),
      ),
    );

  for (const l of contactRows) {
    // Business-timezone day, matching the ad platforms' account-timezone spend
    // dates — a late-evening CT contact must not land on tomorrow's (UTC) row.
    const date = businessDate(l.occurredAt);
    // Trim the over-wide scan back to the window the delete actually clears, so we
    // never insert a row outside it.
    if (date < sinceDate) continue;
    // Last touch for a contact event is the event's own channel. First touch is
    // whoever acquired that person — for their very first contact the two coincide,
    // which is exactly right.
    const ft = l.contactId ? firstTouchByContact.get(l.contactId) : undefined;
    for (const touchType of ["last", "first"] as const) {
      const src = touchType === "last" ? l : (ft ?? l);
      const row = bump({
        date,
        touchType,
        sourceId: src.sourceId ?? null,
        campaignId: src.campaignId ?? null,
        location: (src.location ?? "unknown") as RoiAcc["location"],
      });
      row.contactsCount++;
      if (l.type === "call") row.callsCount++;
      if (l.type === "web_form") row.formsCount++;
    }
  }

  // ── OPPORTUNITY: estimates ────────────────────────────────────────────────
  // The unit changed here. This used to count leads that happened to have matched
  // an estimate, which could only ever see the ~42% of estimates traceable to a
  // tracked contact — the other ~58% (repeat business, referrals, canvassing,
  // estimates written in the field) were invisible rather than merely unattributed.
  //
  // `isCountableEstimate` is the denominator, and it is not negotiable: without it
  // this counts cancelled and never-scheduled records and reports a ~25% close rate
  // against a real one near 48%. See lib/estimates/countable.ts.
  const estimateRows = await db
    .select({
      outcome: hcpEstimates.outcome,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      scheduledStart: hcpEstimates.scheduledStartHcp,
      // The fallback date for a won estimate that was never scheduled — see
      // `countableEstimateDate`. Without it such a row reaches the loop below and
      // dates itself off a NULL appointment.
      createdAtHcp: hcpEstimates.createdAtHcp,
      estLocation: hcpEstimates.location,
      leadOccurredAt: leads.occurredAt,
      leadSourceId: leads.sourceId,
      leadCampaignId: leads.campaignId,
      leadLocation: leads.location,
      leadContactId: leads.contactId,
      hcpCustomerId: hcpEstimates.hcpCustomerId,
    })
    .from(hcpEstimates)
    // At most one lead per estimate — `matchLeadsToEstimates` claims each lead once,
    // so this cannot fan out and double-count revenue.
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    // Windowed on `countableEstimateDate`, NOT on `scheduled_start` directly. A won
    // estimate that was never scheduled has no appointment, so a bare
    // `scheduled_start >= from` would re-drop exactly the rows `isCountableEstimate`
    // was widened to admit — and silently, since the predicate would still say they
    // count.
    .where(and(isCountableEstimate, sql`${countableEstimateDate} >= ${estimateScanFrom}`));

  for (const e of estimateRows) {
    // Attributed → the CONTACT's day and channel, so an estimate lands on the same
    // row as the spend that produced it even when it was written weeks later.
    // Unattributed → its own appointment day, with no source. There is no spend to
    // align with, and dating it anywhere else would be inventing a touch. A won
    // estimate settled over the phone has no appointment, so it falls back to
    // creation — the same expression the window above filters on.
    const attributed = e.leadOccurredAt != null;
    // `created_at_hcp` is nullable, so an unattributed estimate with neither an
    // appointment nor a creation stamp cannot be placed on any day. Skipping is the
    // only honest option — bucketing it on today would move an old row forward every
    // time the rebuild runs.
    const estimateDate = e.scheduledStart ?? e.createdAtHcp;
    if (!attributed && !estimateDate) continue;
    const date = businessDate(attributed ? e.leadOccurredAt! : estimateDate!);
    if (date < sinceDate) continue;
    // A recruiting campaign's estimates are as excluded as its spend and contacts.
    if (attributed && e.leadCampaignId && excluded.includes(e.leadCampaignId)) continue;

    // FIRST touch: whoever acquired this customer. Reached through the attributed
    // lead's contact when there is one, and otherwise through the HCP customer —
    // which is the case that matters. A returning customer's estimate has no new
    // inbound contact, so last-touch has nothing to credit and says `unattributed`,
    // correctly. First-touch still knows the channel that won them years ago, which
    // is what the `customer_window_days` inheritance rule was crudely approximating:
    // capped at 90 days, won estimates only, and it credited revenue without ever
    // linking the estimate.
    // Whatever the model resolves to, an estimate left with NO source that predates
    // tracking is reported as `n/a` rather than as a nameless blank row. Applied
    // once here rather than inside the model branches so last- and first-touch
    // cannot disagree about it, and only ever as a fallback — an estimate that HAS
    // a source keeps it whatever its date.
    const unsourcedSourceId =
      e.createdAtHcp && e.createdAtHcp < TRACKING_STARTED_AT ? preTrackingSourceId : null;
    const contactId = e.leadContactId ?? (e.hcpCustomerId ? contactByHcpCustomer.get(e.hcpCustomerId) : undefined);
    const ft = contactId ? firstTouchByContact.get(contactId) : undefined;
    // Recruiting is excluded under either model.
    if (ft?.campaignId && excluded.includes(ft.campaignId)) continue;

    // Both models bucket on the SAME date, so the two are directly comparable
    // period-over-period and only the credited channel differs. The alternative —
    // dating a first-touch row to the original touch — is a cohort view ("what did
    // 2024's spend eventually earn?"), which is a genuinely useful but different
    // report, and one the 365-day rebuild window cannot hold.
    for (const touchType of ["last", "first"] as const) {
      const src =
        touchType === "last"
          ? attributed
            ? { sourceId: e.leadSourceId, campaignId: e.leadCampaignId, location: e.leadLocation }
            : { sourceId: null, campaignId: null, location: e.estLocation }
          : ft
            ? { sourceId: ft.sourceId, campaignId: ft.campaignId, location: ft.location }
            : { sourceId: null, campaignId: null, location: e.estLocation };

      const row = bump({
        date,
        touchType,
        sourceId: src.sourceId ?? unsourcedSourceId,
        campaignId: src.campaignId ?? null,
        location: (src.location ?? "unknown") as RoiAcc["location"],
      });
      row.estimatesCount++;
      row.quoteValueCents += e.total ?? 0;
      if (e.outcome === "won") {
        row.wonCount++;
        row.revenueCents += e.approved ?? 0;
      }
    }
  }

  // Spend side (platform → source; campaign carries location)
  const spendRows = await db
    .select({
      date: adSpend.date,
      platform: adSpend.platform,
      campaignId: adSpend.campaignId,
      spendCents: adSpend.spendCents,
      location: campaigns.location,
    })
    .from(adSpend)
    .leftJoin(campaigns, eq(adSpend.campaignId, campaigns.id))
    .where(and(gte(adSpend.date, sinceDate), campaignNotExcluded(adSpend.campaignId, excluded)));

  for (const s of spendRows) {
    const sourceKey = PLATFORM_SOURCE_KEY[s.platform];
    // Spend is written to BOTH models: the money spent does not change with the
    // attribution model, only who gets credit for what it produced. Every read
    // filters on touch_type, so this cannot double-count.
    for (const touchType of ["last", "first"] as const) {
      const row = bump({
        date: s.date,
        touchType,
        sourceId: sourceKey ? sourceIdByKey.get(sourceKey) ?? null : null,
        campaignId: s.campaignId ?? null,
        location: (s.location ?? "unknown") as RoiAcc["location"],
      });
      row.spendCents += s.spendCents ?? 0;
    }
  }

  // Manually-entered monthly spend (LSA/GBP/print/…): spread each month's amount
  // evenly over its days so non-API channels get CPL/ROAS rows alongside synced
  // spend. Only days inside [since, today] land in this rebuild's window.
  const windowMonthStart = `${sinceDate.slice(0, 7)}-01`;
  const manualRows = await db
    .select({ sourceId: manualSpend.sourceId, month: manualSpend.month, amountCents: manualSpend.amountCents })
    .from(manualSpend)
    .where(gte(manualSpend.month, windowMonthStart));

  const todayDate = businessDate(new Date());
  for (const m of manualRows) {
    const [y, mo] = m.month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const base = Math.floor((m.amountCents ?? 0) / daysInMonth);
    let remainder = (m.amountCents ?? 0) - base * daysInMonth;
    for (let d = 1; d <= daysInMonth; d++) {
      const dayCents = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      const dateStr = `${m.month.slice(0, 7)}-${String(d).padStart(2, "0")}`;
      if (dateStr < sinceDate || dateStr > todayDate || dayCents === 0) continue;
      for (const touchType of ["last", "first"] as const) {
        const row = bump({ date: dateStr, touchType, sourceId: m.sourceId, campaignId: null, location: "unknown" });
        row.spendCents += dayCents;
      }
    }
  }

  // Full rebuild of the window — transactional and serialized on the same
  // advisory lock as rebuildAttributions, so a concurrent run can't interleave
  // its delete/insert with ours (dashboards would see a half-empty window).
  const rows = [...acc.values()];
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('attribution-rebuild'))`);
    await tx.delete(roiDaily).where(gte(roiDaily.date, sinceDate));
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(roiDaily).values(
        rows.slice(i, i + INSERT_CHUNK).map((r) => ({
          date: r.date,
          touchType: r.touchType,
          sourceId: r.sourceId,
          campaignId: r.campaignId,
          location: r.location,
          contactsCount: r.contactsCount,
          estimatesCount: r.estimatesCount,
          callsCount: r.callsCount,
          formsCount: r.formsCount,
          wonCount: r.wonCount,
          spendCents: r.spendCents,
          revenueCents: r.revenueCents,
          quoteValueCents: r.quoteValueCents,
          // Spend ÷ ESTIMATES. The denominator is deliberately smaller than the old
          // cost-per-lead: only estimates we can attribute to a channel can have that
          // channel's spend divided into them, so this reads higher than the figure it
          // replaces — and honestly, since the old one divided by a looser contact
          // count that included traffic no spend produced.
          costPerEstimateCents: r.estimatesCount ? Math.round(r.spendCents / r.estimatesCount) : null,
          costPerAcquisitionCents: r.wonCount ? Math.round(r.spendCents / r.wonCount) : null,
          roiRatio: r.spendCents ? (r.revenueCents / r.spendCents).toFixed(4) : null,
        })),
      );
    }
    return rows.length;
  });
}
