/**
 * Exercises lib/leads/stage.ts against a real Postgres: an inquiry per estimate state,
 * then the MULTI-estimate cases the rollup exists for.
 *
 *   npm run verify:lead-stage
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production. Every row it creates is deleted before it exits.
 *
 * Same reason the other verify scripts exist: `leadStageSql`, `leadQuoteCentsSql`,
 * `leadSalesCentsSql` and `isOpenLead` are `sql` templates over a grouped subquery, so
 * `tsc` cannot see inside them, and their whole correctness is a CASE over the rollup —
 * including that a NULL `work_status` can never make a predicate NULL. The stage
 * vocabulary is the one `leads.status` used to store; this proves the derivation says
 * the same thing the sync used to write, for every state, without a column — and that
 * two won estimates on one inquiry are worth both of them.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, leads } from "@/lib/db/schema";
import { searchLeads } from "@/lib/queries/leads";
import { findOpenLead } from "@/lib/leads/open";
import { getThreadDetail } from "@/lib/queries/inbox";
import { runAttribution } from "@/lib/sync/attribution";
import { conversations, contacts } from "@/lib/db/schema";

type Est = Partial<typeof hcpEstimates.$inferInsert>;
const open = (total = 0, status: string | null = "needs scheduling"): Est => ({ outcome: "open", won: false, totalAmountCents: total, status });
const wonEst = (total: number, approved: number): Est => ({ outcome: "won", won: true, totalAmountCents: total, approvedAmountCents: approved, status: "created job from estimate" });
const lost = (total: number): Est => ({ outcome: "lost", won: false, totalAmountCents: total, status: "complete rated" });
const cancelled = (total: number): Est => ({ outcome: "open", won: false, totalAmountCents: total, status: "user canceled" });

async function main() {
  const cases: Array<{ tag: string; ests: Est[]; spam?: boolean; want: string; open: boolean; quote: number | null; sales: number | null }> = [
    // ── one estimate per state (the old single-link vocabulary) ──
    { tag: "new", ests: [], want: "new", open: true, quote: null, sales: null },
    { tag: "spam", ests: [], spam: true, want: "spam", open: false, quote: null, sales: null },
    { tag: "qualified", ests: [open(0)], want: "qualified", open: true, quote: null, sales: null },
    { tag: "quoted", ests: [open(120000, "scheduled")], want: "quoted", open: true, quote: 120000, sales: null },
    { tag: "won", ests: [wonEst(120000, 95000)], want: "won", open: false, quote: 95000, sales: 95000 },
    { tag: "lost", ests: [lost(120000)], want: "lost", open: false, quote: 120000, sales: null },
    { tag: "cancelled", ests: [cancelled(120000)], want: "cancelled", open: false, quote: 120000, sales: null },
    { tag: "nullstatus", ests: [open(0, null)], want: "qualified", open: true, quote: null, sales: null },
    // ── several estimates on one inquiry ──
    // A won job and its cancelled duplicate: the win is the answer, the duplicate is noise.
    { tag: "won+dup", ests: [cancelled(120000), wonEst(120000, 95000)], want: "won", open: false, quote: 95000, sales: 95000 },
    // Two jobs sold off one enquiry: worth BOTH of them.
    { tag: "won+won", ests: [wonEst(100000, 90000), wonEst(50000, 45000)], want: "won", open: false, quote: 135000, sales: 135000 },
    // One sold, one still being decided: won, and still open for a follow-up to join.
    { tag: "won+open", ests: [wonEst(100000, 90000), open(30000, "scheduled")], want: "won", open: true, quote: 90000, sales: 90000 },
    // A live priced estimate beside a cancelled one: the survivor is the truth.
    { tag: "quoted+dup", ests: [cancelled(50000), open(120000, "scheduled")], want: "quoted", open: true, quote: 120000, sales: null },
    // Everything cancelled.
    { tag: "all-cancelled", ests: [cancelled(50000), cancelled(60000)], want: "cancelled", open: false, quote: 110000, sales: null },
    // Lost beside a cancelled duplicate reads as lost, not cancelled.
    { tag: "lost+dup", ests: [cancelled(50000), lost(70000)], want: "lost", open: false, quote: 70000, sales: null },
  ];
  let failures = 0;
  const ok = (c: boolean, m: string) => { if (!c) failures++; console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`); };
  let n = 0;
  for (const c of cases) {
    n++;
    const [contact] = await db.insert(contacts).values({}).returning();
    const [conv] = await db.insert(conversations).values({ contactId: contact.id }).returning();
    const [l] = await db.insert(leads).values({ type: "call", phoneE164: `+16185550${String(n).padStart(3, "0")}`, conversationId: conv.id, contactId: contact.id, isSpam: !!c.spam }).returning();
    const estIds: string[] = [];
    for (const [i, e] of c.ests.entries()) {
      const [row] = await db.insert(hcpEstimates).values({ hcpEstimateId: `verify-${c.tag}-${i}`, leadId: l.id, createdAtHcp: new Date(Date.now() - (c.ests.length - i) * 60_000), ...e } as typeof hcpEstimates.$inferInsert).returning();
      estIds.push(row.id);
    }
    const row = (await searchLeads({ q: l.phoneE164!, limit: 5 })).rows.find((r) => r.id === l.id);
    ok(row?.status === c.want, `${c.tag}: stage = ${row?.status} (want ${c.want})`);
    ok((row?.estimateIds ?? []).length === c.ests.length, `${c.tag}: estimateIds carries ${row?.estimateIds?.length} of ${c.ests.length}`);
    const thread = await getThreadDetail(conv.id);
    const tl = thread?.leads.find((x) => x.id === l.id);
    ok((tl?.quoteValueCents ?? null) === c.quote, `${c.tag}: quote = ${tl?.quoteValueCents} (want ${c.quote})`);
    ok((tl?.salesValueCents ?? null) === c.sales, `${c.tag}: sales = ${tl?.salesValueCents} (want ${c.sales})`);
    const openId = await findOpenLead(conv.id);
    ok((openId === l.id) === c.open, `${c.tag}: open = ${openId === l.id} (want ${c.open})`);
    if (estIds.length) await db.delete(hcpEstimates).where(inArray(hcpEstimates.id, estIds));
    await db.delete(leads).where(eq(leads.id, l.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    await db.delete(contacts).where(eq(contacts.id, contact.id));
  }
  // ── The matcher links EVERY estimate an inquiry produced, not just the first ──
  console.log("\nmatcher:");
  const phone = "+16185559999";
  const [contact] = await db.insert(contacts).values({ primaryPhone: phone }).returning();
  const [conv] = await db.insert(conversations).values({ contactId: contact.id }).returning();
  const [inq] = await db.insert(leads).values({ type: "web_form", phoneE164: phone, conversationId: conv.id, contactId: contact.id, occurredAt: new Date(Date.now() - 3 * 86_400_000) }).returning();
  const mk = (tag: string, daysAgo: number) =>
    db.insert(hcpEstimates).values({ hcpEstimateId: `verify-match-${tag}`, customerPhoneE164: phone, createdAtHcp: new Date(Date.now() - daysAgo * 86_400_000), updatedAtHcp: new Date(), outcome: "open", won: false } as typeof hcpEstimates.$inferInsert).returning();
  const [[front], [back], [stale]] = await Promise.all([mk("front", 2.9), mk("back", 2.5), mk("stale", 400)]);
  // …and one written BEFORE the inquiry, which it cannot have caused.
  const [[earlier]] = await Promise.all([mk("earlier", 4)]);
  await runAttribution({ windowDays: 90 });
  const linked = await db.select({ id: hcpEstimates.id, leadId: hcpEstimates.leadId }).from(hcpEstimates).where(inArray(hcpEstimates.id, [front.id, back.id, stale.id, earlier.id]));
  const by = new Map(linked.map((r) => [r.id, r.leadId]));
  ok(by.get(front.id) === inq.id, "first estimate after the inquiry links to it");
  ok(by.get(back.id) === inq.id, "SECOND estimate after the same inquiry links to it too");
  ok(by.get(earlier.id) == null, "an estimate written before the inquiry does not link");
  ok(by.get(stale.id) == null, "an estimate outside the scan window is untouched");
  const found = (await searchLeads({ q: phone, limit: 5 })).rows.find((r) => r.id === inq.id);
  ok((found?.estimateIds ?? []).length === 2, `the inquiry lists both (${found?.estimateIds?.length})`);
  await db.delete(hcpEstimates).where(inArray(hcpEstimates.id, [front.id, back.id, stale.id, earlier.id]));
  await db.execute(sql`delete from attributions where lead_id = ${inq.id}`);
  await db.delete(leads).where(eq(leads.id, inq.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(contacts).where(eq(contacts.id, contact.id));

  console.log(failures ? `\n${failures} FAILED` : "\nAll stage checks passed.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
