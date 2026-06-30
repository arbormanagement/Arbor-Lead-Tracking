import { and, desc, eq, gte, lte, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  adSpend,
  attributions,
  campaigns,
  hcpCustomers,
  hcpEstimates,
  leads,
  roiDaily,
  sources,
} from "@/lib/db/schema";
import { withSyncRun } from "./run";

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
 *
 * Reuses the normalized phone_e164 / email_lc columns written by the HCP sync.
 */
export async function runAttribution({ windowDays = 90 }: { windowDays?: number } = {}) {
  return withSyncRun("attribution.run", async () => {
    const matched = await matchLeadsToWonEstimates(windowDays);
    const touches = await rebuildAttributions();
    const roiRows = await rebuildRoiDaily(windowDays);
    return { matchedEstimates: matched, attributionTouches: touches, roiRows };
  });
}

// ── 1. Lead → WON HCP estimate revenue matching ──────────────────────────────
async function matchLeadsToWonEstimates(windowDays: number): Promise<number> {
  // Reset prior matches so this is a clean rebuild (preserve manual non-won statuses).
  await db
    .update(leads)
    .set({ hcpEstimateId: null, salesValueCents: null, quoteValueCents: null })
    .where(eq(leads.isSpam, false));
  await db.update(leads).set({ status: "new" }).where(eq(leads.status, "won"));

  // Candidate estimates: WON, with a customer + an approved amount, created recently.
  const lookback = new Date(Date.now() - (windowDays + 30) * 86_400_000);
  const estRows = await db
    .select({
      estId: hcpEstimates.id,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      createdAtHcp: hcpEstimates.createdAtHcp,
      approvedAtHcp: hcpEstimates.approvedAtHcp,
      custId: hcpCustomers.id,
      custPhone: hcpCustomers.phoneE164,
      custEmail: hcpCustomers.emailLc,
    })
    .from(hcpEstimates)
    .innerJoin(hcpCustomers, eq(hcpEstimates.hcpCustomerId, hcpCustomers.id))
    .where(and(eq(hcpEstimates.won, true), gte(hcpEstimates.createdAtHcp, lookback)));

  const claimedLeads = new Set<string>();
  let matched = 0;

  for (const est of estRows) {
    const revenue = est.approved || 0;
    if (revenue <= 0) continue;
    // Anchor to when it was won (falling back to created), so the lead must precede it.
    const estDate = est.approvedAtHcp ?? est.createdAtHcp;
    if (!estDate) continue;
    if (!est.custPhone && !est.custEmail) continue;

    const windowStart = new Date(estDate.getTime() - windowDays * 86_400_000);

    // Nearest non-spam lead from this customer that occurred before the estimate was won.
    const contactMatch =
      est.custPhone && est.custEmail
        ? or(eq(leads.phoneE164, est.custPhone), eq(leads.emailLc, est.custEmail))
        : est.custPhone
          ? eq(leads.phoneE164, est.custPhone)
          : eq(leads.emailLc, est.custEmail!);

    const candidates = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          contactMatch,
          eq(leads.isSpam, false),
          gte(leads.occurredAt, windowStart),
          lte(leads.occurredAt, estDate),
        ),
      )
      .orderBy(desc(leads.occurredAt))
      .limit(5);

    const pick = candidates.find((c) => !claimedLeads.has(c.id));
    if (!pick) continue;

    claimedLeads.add(pick.id);
    await db
      .update(leads)
      .set({
        hcpCustomerId: est.custId,
        hcpEstimateId: est.estId,
        quoteValueCents: est.total ?? revenue,
        salesValueCents: revenue,
        status: "won",
      })
      .where(eq(leads.id, pick.id));
    matched++;
  }

  return matched;
}

// ── 2. Attribution trail (last-touch for now) ────────────────────────────────
async function rebuildAttributions(): Promise<number> {
  const rows = await db
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
  await db.delete(attributions).where(eq(attributions.touchType, "last"));
  if (rows.length === 0) return 0;

  await db.insert(attributions).values(
    rows.map((r) => ({
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
  return rows.length;
}

// ── 3. roi_daily rollup ──────────────────────────────────────────────────────
const PLATFORM_SOURCE_KEY: Record<string, string> = {
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
  callsCount: number;
  formsCount: number;
  wonCount: number;
  spendCents: number;
  revenueCents: number;
  quoteValueCents: number;
}

async function rebuildRoiDaily(windowDays: number): Promise<number> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const sinceDate = since.toISOString().slice(0, 10);

  // Source-key → id, so ad spend (which carries platform, not source) can roll up.
  const sourceRows = await db.select({ id: sources.id, key: sources.key }).from(sources);
  const sourceIdByKey = new Map(sourceRows.map((s) => [s.key, s.id]));

  const acc = new Map<string, RoiAcc>();
  const keyOf = (a: { date: string; sourceId: string | null; campaignId: string | null; location: string }) =>
    `${a.date}|${a.sourceId ?? ""}|${a.campaignId ?? ""}|${a.location}`;
  const bump = (seed: Omit<RoiAcc, "leadsCount" | "callsCount" | "formsCount" | "wonCount" | "spendCents" | "revenueCents" | "quoteValueCents">) => {
    const k = keyOf(seed);
    let row = acc.get(k);
    if (!row) {
      row = { ...seed, leadsCount: 0, callsCount: 0, formsCount: 0, wonCount: 0, spendCents: 0, revenueCents: 0, quoteValueCents: 0 };
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
    .where(and(eq(leads.isSpam, false), gte(leads.occurredAt, since)));

  for (const l of leadRows) {
    const row = bump({
      date: l.occurredAt.toISOString().slice(0, 10),
      sourceId: l.sourceId ?? null,
      campaignId: l.campaignId ?? null,
      location: (l.location ?? "unknown") as RoiAcc["location"],
    });
    row.leadsCount++;
    if (l.type === "call") row.callsCount++;
    if (l.type === "web_form") row.formsCount++;
    // "Won" = the lead's estimate was approved; revenue is that approved amount.
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
    .where(gte(adSpend.date, sinceDate));

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

  // Full rebuild of the window.
  await db.delete(roiDaily).where(gte(roiDaily.date, sinceDate));
  const rows = [...acc.values()];
  if (rows.length === 0) return 0;

  await db.insert(roiDaily).values(
    rows.map((r) => ({
      date: r.date,
      sourceId: r.sourceId,
      campaignId: r.campaignId,
      location: r.location,
      leadsCount: r.leadsCount,
      callsCount: r.callsCount,
      formsCount: r.formsCount,
      wonCount: r.wonCount,
      spendCents: r.spendCents,
      revenueCents: r.revenueCents,
      quoteValueCents: r.quoteValueCents,
      costPerLeadCents: r.leadsCount ? Math.round(r.spendCents / r.leadsCount) : null,
      costPerAcquisitionCents: r.wonCount ? Math.round(r.spendCents / r.wonCount) : null,
      roiRatio: r.spendCents ? (r.revenueCents / r.spendCents).toFixed(4) : null,
    })),
  );
  return rows.length;
}
