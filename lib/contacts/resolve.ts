import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contactIdentifiers, contacts } from "@/lib/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";

export interface ContactInput {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  /** When this contact was seen, for first/last-seen bookkeeping. Defaults to now. */
  at?: Date;
}

type Identifier = { kind: "phone" | "email"; value: string };

/** Normalize whatever a channel handed us into canonical identifiers. */
function identifiersOf(input: ContactInput): Identifier[] {
  const out: Identifier[] = [];
  const phone = normalizePhone(input.phone ?? undefined);
  const email = normalizeEmail(input.email ?? undefined);
  if (phone) out.push({ kind: "phone", value: phone });
  if (email) out.push({ kind: "email", value: email });
  return out;
}

/**
 * Find or create the person behind an inbound contact, and remember every
 * identifier they arrive with.
 *
 * This is what makes the inbox contact-centric rather than phone-centric: a web
 * form carrying both a phone and an email is the event that stitches "the number
 * that called us last week" to "the address that emailed us today".
 *
 * Merging is deliberately conservative. When a phone and an email each already
 * point at DIFFERENT contacts we do NOT fuse those records — a shared household
 * phone or a mistyped address would silently collapse two real customers into
 * one, and un-merging is far harder than living with a duplicate. Instead the
 * oldest match wins the thread and the conflict is logged.
 *
 * Returns null only when there is nothing identifiable to key on (an anonymous
 * form with no contact details), in which case the caller should skip threading
 * rather than invent an identity.
 */
export async function resolveContact(input: ContactInput): Promise<typeof contacts.$inferSelect | null> {
  const ids = identifiersOf(input);
  if (ids.length === 0) return null;

  const at = input.at ?? new Date();
  const name = input.name?.trim() || null;

  const existing = await db
    .select()
    .from(contactIdentifiers)
    .where(
      inArray(
        sql`(${contactIdentifiers.kind}, ${contactIdentifiers.value})`,
        ids.map((i) => sql`(${i.kind}, ${i.value})`),
      ),
    );

  const matchedIds = [...new Set(existing.map((r) => r.contactId))];
  let contact: typeof contacts.$inferSelect;

  if (matchedIds.length === 0) {
    const [created] = await db
      .insert(contacts)
      .values({
        displayName: name,
        primaryPhone: ids.find((i) => i.kind === "phone")?.value ?? null,
        primaryEmail: ids.find((i) => i.kind === "email")?.value ?? null,
        firstSeenAt: at,
        lastSeenAt: at,
      })
      .returning();
    contact = created;
  } else {
    if (matchedIds.length > 1) {
      console.warn(
        "[contacts] identifiers point at different contacts — keeping them separate:",
        matchedIds.join(", "),
      );
    }
    // Oldest wins, so the choice is stable no matter which identifier arrives first.
    const rows = await db.select().from(contacts).where(inArray(contacts.id, matchedIds));
    contact = rows.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())[0];

    const [updated] = await db
      .update(contacts)
      .set({
        // Fill gaps only — never overwrite what we already know with a later,
        // possibly worse value (a form that only captured "Sarah" shouldn't
        // replace "Sarah Whitfield").
        displayName: sql`coalesce(${contacts.displayName}, ${name})`,
        primaryPhone: sql`coalesce(${contacts.primaryPhone}, ${ids.find((i) => i.kind === "phone")?.value ?? null})`,
        primaryEmail: sql`coalesce(${contacts.primaryEmail}, ${ids.find((i) => i.kind === "email")?.value ?? null})`,
        firstSeenAt: sql`least(${contacts.firstSeenAt}, ${at})`,
        lastSeenAt: sql`greatest(${contacts.lastSeenAt}, ${at})`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, contact.id))
      .returning();
    contact = updated;
  }

  // Attach any identifier this contact doesn't already carry. onConflictDoNothing
  // means an identifier already claimed by ANOTHER contact stays with its owner —
  // the conservative-merge rule above, enforced by the unique index.
  await db
    .insert(contactIdentifiers)
    .values(ids.map((i) => ({ contactId: contact.id, kind: i.kind, value: i.value })))
    .onConflictDoNothing();

  return contact;
}

/** Mark a person opted out of app-originated texts (STOP, or carrier error 21610). */
export async function markSmsOptedOut(contactId: string, at: Date = new Date()) {
  await db
    .update(contacts)
    .set({ smsOptedOutAt: at, updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), sql`${contacts.smsOptedOutAt} is null`));
}

/** Clear the opt-out when someone texts START/UNSTOP (Twilio re-enables delivery). */
export async function clearSmsOptOut(contactId: string) {
  await db
    .update(contacts)
    .set({ smsOptedOutAt: null, updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}
