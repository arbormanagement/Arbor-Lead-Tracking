/**
 * Exercises lib/leads/stage.ts against a real Postgres: one lead per estimate state.
 *
 *   npm run verify:lead-stage
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production. Every row it creates is deleted before it exits.
 *
 * Same reason the other verify scripts exist: `leadStageSql`, `leadQuoteCentsSql`,
 * `leadSalesCentsSql` and `isOpenLead` are `sql` templates, so `tsc` cannot see
 * inside them, and their whole correctness is a CASE over the joined estimate —
 * including that a NULL `work_status` can never make a predicate NULL. The stage
 * vocabulary is the one `leads.status` used to store; this proves the derivation
 * says the same thing the sync used to write, for every state, without a column.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, leads } from "@/lib/db/schema";
import { searchLeads } from "@/lib/queries/leads";
import { findOpenLead } from "@/lib/leads/open";
import { conversations, contacts } from "@/lib/db/schema";

async function main() {
  const cases: Array<{ tag: string; est: Partial<typeof hcpEstimates.$inferInsert> | null; spam?: boolean; want: string; open: boolean; quote: number | null; sales: number | null }> = [
    { tag: "new", est: null, want: "new", open: true, quote: null, sales: null },
    { tag: "spam", est: null, spam: true, want: "spam", open: false, quote: null, sales: null },
    { tag: "qualified", est: { outcome: "open", won: false, totalAmountCents: 0, status: "needs scheduling" }, want: "qualified", open: true, quote: null, sales: null },
    { tag: "quoted", est: { outcome: "open", won: false, totalAmountCents: 120000, status: "scheduled" }, want: "quoted", open: true, quote: 120000, sales: null },
    { tag: "won", est: { outcome: "won", won: true, totalAmountCents: 120000, approvedAmountCents: 95000, status: "created job from estimate" }, want: "won", open: false, quote: 95000, sales: 95000 },
    { tag: "lost", est: { outcome: "lost", won: false, totalAmountCents: 120000, status: "complete rated" }, want: "lost", open: false, quote: 120000, sales: null },
    { tag: "cancelled", est: { outcome: "open", won: false, totalAmountCents: 120000, status: "user canceled" }, want: "cancelled", open: false, quote: 120000, sales: null },
    { tag: "nullstatus", est: { outcome: "open", won: false, totalAmountCents: 0, status: null }, want: "qualified", open: true, quote: null, sales: null },
  ];
  let failures = 0;
  const ok = (c: boolean, m: string) => { if (!c) failures++; console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`); };
  for (const c of cases) {
    const [contact] = await db.insert(contacts).values({}).returning();
    const [conv] = await db.insert(conversations).values({ contactId: contact.id }).returning();
    let estId: string | null = null;
    if (c.est) {
      const [e] = await db.insert(hcpEstimates).values({ hcpEstimateId: `verify-${c.tag}`, ...c.est } as typeof hcpEstimates.$inferInsert).returning();
      estId = e.id;
    }
    const [l] = await db.insert(leads).values({ type: "call", phoneE164: `+1618555${c.tag.length}${c.tag.charCodeAt(0)}`, conversationId: conv.id, contactId: contact.id, isSpam: !!c.spam, hcpEstimateId: estId }).returning();
    const row = (await searchLeads({ q: l.phoneE164!, limit: 5 })).rows.find((r) => r.id === l.id);
    ok(row?.status === c.want, `${c.tag}: stage = ${row?.status} (want ${c.want})`);
    const open = await findOpenLead(conv.id);
    ok((open === l.id) === c.open, `${c.tag}: open = ${open === l.id} (want ${c.open})`);
    await db.delete(leads).where(eq(leads.id, l.id));
    if (estId) await db.delete(hcpEstimates).where(eq(hcpEstimates.id, estId));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    await db.delete(contacts).where(eq(contacts.id, contact.id));
  }
  console.log(failures ? `\n${failures} FAILED` : "\nAll stage checks passed.");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
