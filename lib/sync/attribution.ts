import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import {
  adSpend,
  attributions,
  campaigns,
  hcpEstimates,
  leads,
  manualSpend,
  roiDaily,
  sources,
} from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { businessDate } from "@/lib/tz";
import { withSyncRun } from "./run";

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
    const touches = await rebuildAttributions();
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
//  · attribution_model — "last_touch" (default) credits the latest qualifying lead
//    before the estimate; "first_touch" credits the earliest (WhatConverts-style
//    single-touch models, applied retroactively on each rebuild).
//  · customer_window_days — repeat business: a won estimate whose contact has NO
//    unclaimed lead of its own inherits the contact's already-matched lead when it
//    falls within this many days of it (ServiceTitan "Smart Attribution" style),
//    so paid channels get credit for the follow-up work they generated. 0 disables.
async function matchLeadsToEstimates(windowDays: number): Promise<{ qualified: number; won: number }> {
  const model = await getSetting<string>("attribution_model", "last_touch");
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

  // Every estimate (created), won first so a won estimate claims its lead before a
  // merely-created one does.
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
    .orderBy(desc(hcpEstimates.won), desc(hcpEstimates.createdAtHcp));

  const claimedLeads = new Set<string>();
  // Contact key → the first claimed lead for that contact, for the repeat-business
  // inheritance pass (customer_window_days).
  const claimedByContact = new Map<string, { leadId: string; leadAt: Date }>();
  let qualified = 0;
  let won = 0;

  for (const est of estRows) {
    if (!est.custPhone && !est.custEmail) continue;
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
    const contactMatch =
      est.custPhone && est.custEmail
        ? or(eq(leads.phoneE164, est.custPhone), eq(leads.emailLc, est.custEmail))
        : est.custPhone
          ? eq(leads.phoneE164, est.custPhone)
          : eq(leads.emailLc, est.custEmail!);

    const candidates = await db
      .select({ id: leads.id, occurredAt: leads.occurredAt })
      .from(leads)
      .where(
        and(
          contactMatch,
          eq(leads.isSpam, false),
          gte(leads.occurredAt, windowStart),
          lte(leads.occurredAt, estDate),
        ),
      )
      // Last-touch credits the latest lead before the estimate; first-touch the earliest.
      .orderBy(model === "first_touch" ? asc(leads.occurredAt) : desc(leads.occurredAt))
      .limit(5);

    const pick = candidates.find((c) => !claimedLeads.has(c.id));
    if (!pick) {
      // Repeat business: a WON estimate with no lead of its own inherits the
      // contact's already-matched lead when it falls inside the customer window —
      // the revenue accrues to the source that originally acquired the customer.
      if (est.won && customerWindowDays > 0) {
        const prior = contactKeys.map((k) => claimedByContact.get(k)).find(Boolean);
        const age = prior ? estDate.getTime() - prior.leadAt.getTime() : -1;
        if (prior && age >= 0 && age <= customerWindowDays * 86_400_000) {
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
async function rebuildAttributions(): Promise<number> {
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
      .where(eq(leads.isSpam, false));

    // Full rebuild — clear then insert one 'last' touch per lead.
    await tx.delete(attributions).where(eq(attributions.touchType, "last"));
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

interface RoiAcc {
  date: string;
  sourceId: string | null;
  campaignId: string | null;
  location: "edwardsville" | "ofallon" | "unknown";
  leadsCount: number;
  qualifiedCount: number;
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

  // Non-customer-acquisition campaigns (recruiting) contribute neither spend nor
  // leads to ROI. Resolved once and applied to both sides of the rollup so a
  // campaign flagged in Settings drops out on the next run, with no cleanup needed.
  const excluded = await excludedCampaignIds();

  // Source-key → id, so ad spend (which carries platform, not source) can roll up.
  const sourceRows = await db.select({ id: sources.id, key: sources.key }).from(sources);
  const sourceIdByKey = new Map(sourceRows.map((s) => [s.key, s.id]));

  const acc = new Map<string, RoiAcc>();
  const keyOf = (a: { date: string; sourceId: string | null; campaignId: string | null; location: string }) =>
    `${a.date}|${a.sourceId ?? ""}|${a.campaignId ?? ""}|${a.location}`;
  const bump = (seed: Omit<RoiAcc, "leadsCount" | "qualifiedCount" | "callsCount" | "formsCount" | "wonCount" | "spendCents" | "revenueCents" | "quoteValueCents">) => {
    const k = keyOf(seed);
    let row = acc.get(k);
    if (!row) {
      row = { ...seed, leadsCount: 0, qualifiedCount: 0, callsCount: 0, formsCount: 0, wonCount: 0, spendCents: 0, revenueCents: 0, quoteValueCents: 0 };
      acc.set(k, row);
    }
    return row;
  };

  // Leads side
  const leadRows = await db
    .select({
      occurredAt: leads.occurredAt,
      sourceId: leads.sourceId,
      campaignId: leads.campaignId,
      location: leads.location,
      type: leads.type,
      status: leads.status,
      sales: leads.salesValueCents,
      quote: leads.quoteValueCents,
    })
    .from(leads)
    .where(
      and(
        eq(leads.isSpam, false),
        gte(leads.occurredAt, leadScanFrom),
        or(ne(leads.type, "call"), eq(leads.isLead, true)),
        campaignNotExcluded(leads.campaignId, excluded),
      ),
    );

  for (const l of leadRows) {
    // Business-timezone day, matching the ad platforms' account-timezone spend
    // dates — a late-evening CT lead must not land on tomorrow's (UTC) row.
    const date = businessDate(l.occurredAt);
    // Trim the over-wide scan back to the window the delete actually clears, so we
    // never insert a row outside it.
    if (date < sinceDate) continue;
    const row = bump({
      date,
      sourceId: l.sourceId ?? null,
      campaignId: l.campaignId ?? null,
      location: (l.location ?? "unknown") as RoiAcc["location"],
    });
    row.leadsCount++; // every captured (non-spam) contact
    if (l.type === "call") row.callsCount++;
    if (l.type === "web_form") row.formsCount++;
    // Qualified opportunity = an estimate exists (qualified/quoted/won). Won = approved.
    if (l.status === "qualified" || l.status === "quoted" || l.status === "won") row.qualifiedCount++;
    if (l.status === "won") {
      row.wonCount++;
      row.revenueCents += l.sales ?? 0;
    }
    row.quoteValueCents += l.quote ?? 0;
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
    const row = bump({
      date: s.date,
      sourceId: sourceKey ? sourceIdByKey.get(sourceKey) ?? null : null,
      campaignId: s.campaignId ?? null,
      location: (s.location ?? "unknown") as RoiAcc["location"],
    });
    row.spendCents += s.spendCents ?? 0;
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
      const row = bump({ date: dateStr, sourceId: m.sourceId, campaignId: null, location: "unknown" });
      row.spendCents += dayCents;
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
          sourceId: r.sourceId,
          campaignId: r.campaignId,
          location: r.location,
          leadsCount: r.leadsCount,
          qualifiedCount: r.qualifiedCount,
          callsCount: r.callsCount,
          formsCount: r.formsCount,
          wonCount: r.wonCount,
          spendCents: r.spendCents,
          revenueCents: r.revenueCents,
          quoteValueCents: r.quoteValueCents,
          // Cost per *qualified* lead (a real opportunity), not per raw contact.
          costPerLeadCents: r.qualifiedCount ? Math.round(r.spendCents / r.qualifiedCount) : null,
          costPerAcquisitionCents: r.wonCount ? Math.round(r.spendCents / r.wonCount) : null,
          roiRatio: r.spendCents ? (r.revenueCents / r.spendCents).toFixed(4) : null,
        })),
      );
    }
    return rows.length;
  });
}
