import { and, arrayOverlaps, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contactIdentifiers, contacts, hcpCustomers } from "@/lib/db/schema";

/**
 * Tie inbox contacts to the real customer record in HousecallPro.
 *
 * This app deliberately holds no customer data of its own — HCP owns that. What
 * it holds is identifiers that arrive on their own with every call, text and
 * form, and `hcp_customers` is already synced with `phone_e164` / `email_lc`
 * normalized and indexed for exactly this join. It's the same key the ROI
 * pipeline uses to match a lead to its revenue, so a thread and its money agree
 * on who the customer is by construction.
 *
 * The link is one-directional and non-destructive: we store the customer's id,
 * never a copy of their details. Whatever Justin fixes in HCP is what the inbox
 * shows.
 */

/** Match one contact against HCP by any of its identifiers. Best-effort. */
export async function linkContactToHcpCustomer(contactId: string): Promise<string | null> {
  const ids = await db
    .select({ kind: contactIdentifiers.kind, value: contactIdentifiers.value })
    .from(contactIdentifiers)
    .where(eq(contactIdentifiers.contactId, contactId));
  if (ids.length === 0) return null;

  const phones = ids.filter((i) => i.kind === "phone").map((i) => i.value);
  const emails = ids.filter((i) => i.kind === "email").map((i) => i.value);
  const predicates = [
    // Against the customer's WHOLE phone set, not just the primary. `phone_e164`
    // is mobile-first, so a household that always rings from the landline matched
    // nothing here and stayed unlinked — which then made their estimates
    // unattributable, because the estimate reaches the contact through this link.
    // arrayOverlaps, not a raw `&& ${phones}` — drizzle's sql template expands a
    // JS array into a parameter list, so `&& $1` got a bare string and threw
    // 22P02 "malformed array literal" on EVERY inline link from 8/14 to 8/31;
    // only the sweep's `@> array[…]` form ever worked.
    phones.length ? arrayOverlaps(hcpCustomers.phonesE164, phones) : null,
    emails.length ? inArray(hcpCustomers.emailLc, emails) : null,
  ].filter(Boolean) as ReturnType<typeof sql>[];
  if (predicates.length === 0) return null;

  const [customer] = await db
    .select({ id: hcpCustomers.id, phones: hcpCustomers.phonesE164, email: hcpCustomers.emailLc })
    .from(hcpCustomers)
    .where(predicates.length === 1 ? predicates[0] : or(...predicates))
    // Oldest wins, so a duplicate in HCP resolves to the original record.
    .orderBy(hcpCustomers.createdAt)
    .limit(1);
  if (!customer) return null;

  await db
    .update(contacts)
    .set({ hcpCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));

  await adoptHcpIdentifiers([{ contactId, phones: customer.phones, email: customer.email }]);
  return customer.id;
}

/**
 * Teach our identity index what HousecallPro already knows about this person.
 *
 * Without this the link is one-way and half-blind: someone who texts gives us
 * their phone, so we'd recognize the phone forever but not the email address
 * sitting on their HCP record — and their first email would open a second thread
 * for a customer we can already name.
 *
 * `onConflictDoNothing` keeps the conservative-merge rule intact: an identifier
 * already claimed by a different contact stays with its owner rather than being
 * quietly reassigned.
 */
async function adoptHcpIdentifiers(
  rows: Array<{ contactId: string; phones: string[] | null; email: string | null }>,
) {
  const values = rows.flatMap((r) => [
    // Every number, so the next call from any handset in the household lands on
    // the thread we already have rather than opening a second one.
    ...(r.phones ?? []).map((p) => ({ contactId: r.contactId, kind: "phone" as const, value: p })),
    ...(r.email ? [{ contactId: r.contactId, kind: "email" as const, value: r.email }] : []),
  ]);
  if (values.length === 0) return;
  await db.insert(contactIdentifiers).values(values).onConflictDoNothing();
}

/**
 * Sweep every unlinked contact against HCP. Runs after each HCP sync, which is
 * the direction the one-shot link can't cover: someone texts as a stranger on
 * Monday, Justin creates them in HousecallPro on Tuesday, and the thread should
 * start showing their name without anyone re-texting.
 *
 * Set-based on purpose — one statement, not a query per contact.
 */
export async function linkContactsToHcpCustomers(): Promise<{ linked: number }> {
  const matched = db
    .select({
      contactId: contactIdentifiers.contactId,
      // Deterministic pick when a contact's phone and email hit different HCP
      // records: oldest customer row wins, same rule as the single-contact path.
      customerId: sql<string>`min(${hcpCustomers.id})`.as("customer_id"),
    })
    .from(contactIdentifiers)
    .innerJoin(
      hcpCustomers,
      or(
        and(eq(contactIdentifiers.kind, "phone"), sql`${hcpCustomers.phonesE164} @> array[${contactIdentifiers.value}]`),
        and(eq(contactIdentifiers.kind, "email"), eq(hcpCustomers.emailLc, contactIdentifiers.value)),
      ),
    )
    .groupBy(contactIdentifiers.contactId)
    .as("matched");

  const updated = await db
    .update(contacts)
    .set({ hcpCustomerId: sql`${matched.customerId}`, updatedAt: new Date() })
    .from(matched)
    .where(and(eq(contacts.id, matched.contactId), isNull(contacts.hcpCustomerId)))
    .returning({ id: contacts.id });

  if (updated.length > 0) {
    const enriched = await db
      .select({
        contactId: contacts.id,
        phones: hcpCustomers.phonesE164,
        email: hcpCustomers.emailLc,
      })
      .from(contacts)
      .innerJoin(hcpCustomers, eq(contacts.hcpCustomerId, hcpCustomers.id))
      .where(inArray(contacts.id, updated.map((u) => u.id)));
    await adoptHcpIdentifiers(enriched);
  }

  return { linked: updated.length };
}
