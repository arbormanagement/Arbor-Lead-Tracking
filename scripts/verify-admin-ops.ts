/**
 * Exercises the operator actions behind the MCP config tools against a real Postgres.
 *
 *   npm run verify:admin-ops
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production.
 *
 * Same reason as verify:hcp and verify:campaigns: there is no test runner here, and
 * none of what these do is visible to `tsc`. Every one is a guard whose correctness
 * lives in a WHERE clause or an early return — a pool refusing to delete while
 * numbers still point at it, an unknown sourceId answering 404 instead of a raw
 * foreign-key 500, an empty origin list meaning "restore the defaults" rather than
 * "allow nothing" — and every way of getting those wrong still compiles.
 *
 * Set up a throwaway instance:
 *   initdb -D /var/tmp/pgt/data -U postgres --auth=trust
 *   pg_ctl -D /var/tmp/pgt/data -o "-p 55432" start
 *   createdb -h 127.0.0.1 -p 55432 -U postgres arbor_scratch
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/arbor_scratch npx drizzle-kit push --force
 *   DATABASE_URL=... APP_BASE_URL=http://localhost:3000 ADMIN_EMAIL=a@b.com \
 *     COOKIE_SIGNING_SECRET=0123456789abcdef0123 npm run verify:admin-ops
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contacts, conversations, conversionExports, facebookLeads, leads, pools, sources, trackingNumbers } from "@/lib/db/schema";
import { seedDefaults } from "@/lib/db/seed-data";
import { createPool, deletePool, listPools, updatePool } from "@/lib/pools";
import { deleteManualSpend, listManualSpend, normalizeMonth, setManualSpend } from "@/lib/spend/manual";
import { DEFAULT_ALLOWED_ORIGINS, setTrackingOrigins, trackingOrigins } from "@/lib/origin";
import { setRoutingConfig } from "@/lib/routing";
import { resetFailedExports } from "@/lib/sync/conversions";
import { runLeadCleanup } from "@/lib/leads/cleanup";
import { setIncludedFormIds } from "@/lib/sync/facebook-leads";
import { setLeadAttribution } from "@/lib/leads/attribution";
import { setLeadClassification, setLeadDisposition } from "@/lib/leads/classify-override";
import { searchLeads } from "@/lib/queries/leads";
import { campaigns } from "@/lib/db/schema";

let failures = 0;
const ok = (c: boolean, m: string) => {
  if (!c) failures++;
  console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`);
};

const POOL = "verify-pool";
const PHONE = "+16185559001";
const ATTR_PHONE = "+16185559002";

async function main() {
  // Fixtures first, so a re-run is not a different test from the first run.
  await db.delete(trackingNumbers).where(eq(trackingNumbers.phoneNumber, PHONE));
  await db.delete(pools).where(inArray(pools.key, [POOL]));
  const staleFb = db.select({ id: facebookLeads.leadId }).from(facebookLeads)
    .where(inArray(facebookLeads.fbLeadgenId, ["verify-keep", "verify-drop"]));
  await db.delete(facebookLeads).where(inArray(facebookLeads.fbLeadgenId, ["verify-keep", "verify-drop"]));
  await db.delete(leads).where(inArray(leads.id, staleFb));
  await db.delete(leads).where(eq(leads.phoneE164, ATTR_PHONE));
  await seedDefaults(db);

  // ── the seed retires stray source rows only once nothing points at them ──────
  await db.delete(sources).where(eq(sources.key, "test"));
  const [testSrc] = await db.insert(sources).values({ key: "test", displayName: "Test", platform: "other" }).returning();
  const [testLead] = await db.insert(leads).values({ type: "call", occurredAt: new Date(), phoneE164: ATTR_PHONE, sourceId: testSrc.id }).returning();
  await seedDefaults(db);
  ok((await db.select().from(sources).where(eq(sources.key, "test"))).length === 1,
    "seed KEEPS the `test` source while a lead still points at it");
  await db.delete(leads).where(eq(leads.id, testLead.id));
  await seedDefaults(db);
  ok((await db.select().from(sources).where(eq(sources.key, "test"))).length === 0,
    "…and retires it on the next run once the last reference is gone");
  ok((await db.select().from(sources).where(eq(sources.key, "referral"))).length === 1,
    "…while the seeded `referral` itself is never touched by the `%/referral` rule");

  // ── setLeadDisposition — the human verdict, and the boolean slice of it ──────
  const [dLead] = await db.insert(leads).values({ type: "call", occurredAt: new Date(), phoneE164: ATTR_PHONE }).returning();
  ok(dLead.disposition === null && dLead.dispositionManual === false, "a new call is PENDING: no disposition, no override");
  const missed = await setLeadDisposition(dLead.id, "missed", "verify: nobody called back");
  ok(missed?.disposition === "missed" && missed.dispositionManual && missed.dispositionReason === "verify: nobody called back",
    "setLeadDisposition sets the value, the override and the reason");
  const asSpam = await setLeadDisposition(dLead.id, "spam");
  const [spamRow] = await db.select().from(leads).where(eq(leads.id, dLead.id));
  ok(asSpam?.disposition === "spam" && spamRow.isSpam === true, "…spam also flags is_spam");
  // The stage is DERIVED: no estimate → new; spam wins over everything; no column to drift.
  const spamSearch = await searchLeads({ q: ATTR_PHONE, limit: 5 });
  ok(spamSearch.rows.find((r) => r.id === dLead.id)?.status === "spam", "searchLeads reports a derived stage: spam");
  await db.update(leads).set({ isSpam: false }).where(eq(leads.id, dLead.id));
  const newSearch = await searchLeads({ q: ATTR_PHONE, limit: 5 });
  ok(newSearch.rows.find((r) => r.id === dLead.id)?.status === "new", "…and `new` with no estimate linked");
  ok((await searchLeads({ q: ATTR_PHONE, status: "won", limit: 5 })).rows.every((r) => r.id !== dLead.id), "…and the stage filter reads the same derivation");
  const asTest = await setLeadDisposition(dLead.id, "test");
  const [testRow] = await db.select().from(leads).where(eq(leads.id, dLead.id));
  ok(asTest?.disposition === "test" && testRow.isSpam === true, "…test flags is_spam too, so synthetic rows leave every count");
  const back = await setLeadClassification(dLead.id, true);
  const [backRow] = await db.select().from(leads).where(eq(leads.id, dLead.id));
  ok(back?.isLead === true && backRow.disposition === "requested_work", "setLeadClassification(true) is requested_work");
  const no = await setLeadClassification(dLead.id, false);
  const [noRow] = await db.select().from(leads).where(eq(leads.id, dLead.id));
  ok(no?.isLead === false && noRow.disposition === "not_business", "…and (false) is not_business");
  const dCleared = await setLeadDisposition(dLead.id, null);
  ok(dCleared?.disposition === null && dCleared.dispositionManual === false, "null clears the override; with no transcript the row returns to pending");
  ok((await setLeadDisposition("no-such-lead", "missed")) === null, "…and an unknown id returns null, not a throw");
  await db.delete(leads).where(eq(leads.id, dLead.id));

  // ── setLeadAttribution — the manual correction, and what it refuses ─────────
  const [gbpSrc] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, "gbp")).limit(1);
  const [ofa] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.externalCampaignId, "ofallon")).limit(1);
  if (!gbpSrc || !ofa) throw new Error("seed did not create gbp / O'Fallon");
  const [attrLead] = await db.insert(leads).values({ type: "call", occurredAt: new Date(), phoneE164: ATTR_PHONE }).returning();

  const nf = await setLeadAttribution("no-such-lead", { sourceKey: "gbp" });
  ok(!nf.ok && nf.reason === "not_found", "setLeadAttribution: unknown lead id → not_found, not a throw");
  const nothing = await setLeadAttribution(attrLead.id, {});
  ok(!nothing.ok && nothing.reason === "nothing_to_set", "…an empty patch is refused rather than stamping the lock for nothing");
  const badSrc = await setLeadAttribution(attrLead.id, { sourceKey: "made/up" });
  ok(!badSrc.ok && badSrc.reason === "unknown_source", "…an unknown source key is refused — it never mints a source");
  const badCamp = await setLeadAttribution(attrLead.id, { campaignId: "no-such-campaign" });
  ok(!badCamp.ok && badCamp.reason === "unknown_campaign", "…an unknown campaign id is refused — it never mints a campaign");
  const mismatch = await setLeadAttribution(attrLead.id, { sourceKey: "direct", campaignId: ofa.id });
  ok(!mismatch.ok && mismatch.reason === "campaign_source_mismatch", "…an O'Fallon listing on a `direct` lead is refused: a campaign belongs to a source");
  const [untouched] = await db.select().from(leads).where(eq(leads.id, attrLead.id));
  ok(untouched.sourceId === null && untouched.campaignId === null && untouched.attributionSetManuallyAt === null,
    "…and a refused write changes NOTHING, lock included");

  const attrSet = await setLeadAttribution(attrLead.id, { sourceKey: "gbp", campaignId: ofa.id, note: "verify: transposed tag" });
  ok(attrSet.ok && attrSet.lead.sourceKey === "gbp" && attrSet.lead.campaignName === "O'Fallon" && !!attrSet.lead.attributionSetManuallyAt,
    "a valid source + campaign lands, with the lock stamped and the campaign name resolved");
  ok(attrSet.ok && attrSet.lead.attributionManualNote === "verify: transposed tag" && /attribution/.test(attrSet.nextStep),
    "…the note is stored and the result says roi_daily still needs the attribution sync");
  const attrCleared = await setLeadAttribution(attrLead.id, { campaignId: null });
  ok(attrCleared.ok && attrCleared.lead.campaignId === null && attrCleared.lead.sourceKey === "gbp" && !!attrCleared.lead.attributionSetManuallyAt,
    "campaignId:null clears the campaign, keeps the source, keeps the lock");
  // The thread's first-touch snapshot follows a corrected source — only where it came from this lead.
  const [otherSrc2] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, "other")).limit(1);
  const [directSrc] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, "direct")).limit(1);
  const [tContact] = await db.insert(contacts).values({}).returning();
  const [tConv] = await db.insert(conversations).values({ contactId: tContact.id, sourceId: otherSrc2!.id }).returning();
  const [tLead] = await db.insert(leads).values({ type: "call", occurredAt: new Date(), phoneE164: ATTR_PHONE, sourceId: otherSrc2!.id, conversationId: tConv.id, contactId: tContact.id }).returning();
  await setLeadAttribution(tLead.id, { sourceKey: "gbp", note: "verify: thread follows" });
  const [tConvAfter] = await db.select().from(conversations).where(eq(conversations.id, tConv.id));
  ok(tConvAfter.sourceId === gbpSrc.id, "correcting a lead's source also moves the thread's first-touch snapshot when it came from that lead");
  await db.update(conversations).set({ sourceId: directSrc!.id }).where(eq(conversations.id, tConv.id));
  await setLeadAttribution(tLead.id, { sourceKey: "google/cpc" });
  const [tConvHeld] = await db.select().from(conversations).where(eq(conversations.id, tConv.id));
  ok(tConvHeld.sourceId === directSrc!.id, "…but leaves a snapshot that was taken from a different enquiry alone");
  // …and the seed repairs a thread left saying `other` by a correction that predates this rule.
  await db.update(conversations).set({ sourceId: otherSrc2!.id }).where(eq(conversations.id, tConv.id));
  await seedDefaults(db);
  const [tConvRepaired] = await db.select().from(conversations).where(eq(conversations.id, tConv.id));
  ok(tConvRepaired.sourceId !== otherSrc2!.id, "the seed re-points a thread snapshot still on `other` to its first lead's source");
  await db.delete(leads).where(eq(leads.id, tLead.id));
  await db.delete(conversations).where(eq(conversations.id, tConv.id));
  await db.delete(contacts).where(eq(contacts.id, tContact.id));

  const attrReleased = await setLeadAttribution(attrLead.id, { manual: false });
  ok(attrReleased.ok && attrReleased.lead.attributionSetManuallyAt === null && attrReleased.lead.sourceKey === "gbp",
    "manual:false releases the lock and touches no value");
  await db.delete(leads).where(eq(leads.id, attrLead.id));

  // ── pools ──────────────────────────────────────────────────────────────────
  const created = await createPool({ key: POOL, displayName: "Verify", isDni: false });
  ok(created?.key === POOL, "createPool creates");
  ok((await createPool({ key: POOL, displayName: "Again" })) === null, "…and returns null on a duplicate key rather than throwing");

  const renamed = await updatePool(POOL, { displayName: "Verify 2", isDni: true });
  ok(renamed?.displayName === "Verify 2" && renamed?.isDni === true, "updatePool changes metadata and the DNI flag");
  ok((await updatePool("nope", { displayName: "x" })) === null, "…and returns null for an unknown key");
  ok((await listPools()).some((p) => p.key === POOL), "listPools includes it");

  // The two guards that stop a delete stranding numbers.
  ok((await deletePool("reserved")).ok === false, "deletePool refuses 'reserved' — where new numbers land by default");
  await db.insert(trackingNumbers).values({
    phoneNumber: PHONE, twilioSid: "PNverifyOps", pool: POOL, isStatic: false,
  });
  const inUse = await deletePool(POOL);
  ok(inUse.ok === false && inUse.reason === "in_use", "…and refuses while a number still points at the pool");
  ok(inUse.ok === false && inUse.reason === "in_use" && inUse.numbers === 1, "…reporting how many, so the caller can act");
  await db.delete(trackingNumbers).where(eq(trackingNumbers.phoneNumber, PHONE));
  ok((await deletePool(POOL)).ok === true, "…and deletes once nothing references it");
  const gone = await deletePool(POOL);
  ok(gone.ok === false && gone.reason === "not_found", "…then reports not_found rather than pretending to succeed");

  // ── manual spend ───────────────────────────────────────────────────────────
  const [gbp] = await db.select().from(sources).where(eq(sources.key, "gbp")).limit(1);
  ok(normalizeMonth("2026-08") === "2026-08-01", "a bare YYYY-MM normalizes to the first of the month");
  ok(normalizeMonth("nonsense") === null, "…and junk normalizes to null");

  ok((await setManualSpend({ sourceId: gbp.id, month: "2026-08", amountCents: 25000 })).ok, "setManualSpend upserts");
  const rows = await listManualSpend();
  const row = rows.find((r) => r.sourceId === gbp.id && r.month === "2026-08-01");
  ok(row?.amountCents === 25000, "listManualSpend reads it back");
  ok(row?.sourceKey === "gbp", "…with the source KEY resolved, so a caller need not join");

  ok((await setManualSpend({ sourceId: gbp.id, month: "2026-08", amountCents: 30000 })).ok, "…and a second write updates rather than duplicating");
  ok((await listManualSpend()).filter((r) => r.sourceId === gbp.id && r.month === "2026-08-01").length === 1, "…exactly one row for the month");

  const unknown = await setManualSpend({ sourceId: "no-such-source", month: "2026-08", amountCents: 1 });
  ok(unknown.ok === false && unknown.reason === "unknown_source", "an unknown sourceId is caught, not left to a raw FK error");
  const badMonth = await setManualSpend({ sourceId: gbp.id, month: "2026-8", amountCents: 1 });
  ok(badMonth.ok === false && badMonth.reason === "bad_month", "a malformed month is rejected");

  ok((await deleteManualSpend(gbp.id, "2026-08")).ok, "deleteManualSpend removes it");
  ok(!(await listManualSpend()).some((r) => r.sourceId === gbp.id && r.month === "2026-08-01"), "…and it is gone");

  // ── tracking origins ───────────────────────────────────────────────────────
  const set = await setTrackingOrigins(["https://example.com", "example.com", "arbor-mgmt.com"]);
  ok(set.ok === true && set.allowedOrigins.length === 2, "setTrackingOrigins dedupes a bare hostname against its https form");
  ok(set.ok === true && set.allowedOrigins.includes("https://arbor-mgmt.com"), "…and reads a bare hostname as https");
  const bad = await setTrackingOrigins(["not a url at all"]);
  ok(bad.ok === false, "…rejects an unparseable entry instead of storing it");

  // `settings.value` is jsonb NOT NULL, so clearing a setting has to delete the row
  // rather than write a null into it. Every "clear this" path used to 500 on that.
  const emptied = await setTrackingOrigins([]);
  ok(emptied.ok === true && emptied.defaults === true, "an EMPTY list restores the built-in defaults — it does not mean 'allow nothing'");
  ok(
    emptied.ok === true && DEFAULT_ALLOWED_ORIGINS.every((o) => emptied.allowedOrigins.includes(o)),
    "…and reports the defaults back, so the caller can see what is live",
  );
  const live = await trackingOrigins();
  ok(DEFAULT_ALLOWED_ORIGINS.every((o) => live.includes(o)), "…which is what the origin gate then actually allows");

  // ── routing validation (the Twilio half is best-effort and not exercised) ───
  const badPhone = await setRoutingConfig({ smsForward: "banana" });
  ok(badPhone.ok === false, "setRoutingConfig rejects an unparseable phone");
  const relay = await setRoutingConfig({ smsForward: "618-836-8004" });
  ok(relay.ok === true && relay.smsForward === "+16188368004", "…and normalizes a valid one to E.164");
  const cleared = await setRoutingConfig({ smsForward: "" });
  ok(cleared.ok === true && cleared.smsForward === null, "…and an empty string clears it");

  // ── conversion export reset ────────────────────────────────────────────────
  const [lead] = await db.insert(leads).values({ type: "call", occurredAt: new Date(), phoneE164: PHONE }).returning();
  await db.delete(conversionExports).where(eq(conversionExports.leadId, lead.id));
  await db.insert(conversionExports).values([
    { leadId: lead.id, platform: "google", event: "lead", status: "error", attempts: 9 },
    { leadId: lead.id, platform: "google", event: "qualified", status: "sent", attempts: 1 },
    { leadId: lead.id, platform: "facebook", event: "lead", status: "error", attempts: 1 },
  ]);

  const onlyGoogle = await resetFailedExports({ platform: "google" });
  ok(onlyGoogle.reset === 1, "resetFailedExports honours the platform filter");
  const after = await db.select().from(conversionExports).where(eq(conversionExports.leadId, lead.id));
  ok(after.find((r) => r.event === "qualified")?.status === "sent",
    "…and NEVER reopens a 'sent' row — the guard against uploading one conversion twice");
  ok(after.find((r) => r.event === "lead" && r.platform === "google")?.attempts === 0, "…while a reset row goes back to 0 attempts");
  ok((await resetFailedExports({ onlyAbandoned: true })).reset === 0,
    "onlyAbandoned skips a row under the attempt cap");

  await db.delete(conversionExports).where(eq(conversionExports.leadId, lead.id));
  await db.delete(leads).where(eq(leads.id, lead.id));

  // ── lead cleanup: the only hard delete in the app ──────────────────────────
  // Two things must hold before this is safe to expose: a dry run must change
  // nothing, and an EMPTY Facebook allowlist must mean "all forms allowed, nothing
  // excluded" — reading it the other way round would delete every Facebook lead
  // on file.
  await setIncludedFormIds([]);
  const noneExcluded = await runLeadCleanup("unselected_facebook_forms", true);
  ok(noneExcluded.wouldRemove === 0, "an EMPTY form allowlist excludes NOTHING — the inversion that would delete everything");
  ok(!!noneExcluded.note, "…and says why, rather than reporting a silent zero");

  const [keepForm] = await db.insert(leads).values({ type: "facebook_leadgen", occurredAt: new Date() }).returning();
  const [dropForm] = await db.insert(leads).values({ type: "facebook_leadgen", occurredAt: new Date() }).returning();
  await db.insert(facebookLeads).values([
    { fbLeadgenId: "verify-keep", fbFormId: "form-keep", leadId: keepForm.id },
    { fbLeadgenId: "verify-drop", fbFormId: "form-drop", leadId: dropForm.id },
  ]);
  await setIncludedFormIds(["form-keep"]);

  const dry = await runLeadCleanup("unselected_facebook_forms", false);
  ok(dry.wouldRemove === 1 && dry.removed === 0, "a dry run reports what would go and deletes nothing");
  ok((await db.select().from(leads).where(eq(leads.id, dropForm.id))).length === 1, "…the lead is still there afterwards");

  const applied = await runLeadCleanup("unselected_facebook_forms", true);
  ok(applied.removed === 1, "apply:true deletes it");
  ok((await db.select().from(leads).where(eq(leads.id, dropForm.id))).length === 0, "…the excluded lead is gone");
  ok((await db.select().from(leads).where(eq(leads.id, keepForm.id))).length === 1, "…and the selected form's lead is untouched");
  ok((await db.select().from(facebookLeads).where(eq(facebookLeads.fbLeadgenId, "verify-drop"))).length === 0,
    "…with its facebook_leads row cascaded, not orphaned");

  await db.delete(facebookLeads).where(inArray(facebookLeads.fbLeadgenId, ["verify-keep", "verify-drop"]));
  await db.delete(leads).where(inArray(leads.id, [keepForm.id, dropForm.id]));
  await setIncludedFormIds([]);
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
