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
import { conversionExports, leads, pools, sources, trackingNumbers } from "@/lib/db/schema";
import { seedDefaults } from "@/lib/db/seed-data";
import { createPool, deletePool, listPools, updatePool } from "@/lib/pools";
import { deleteManualSpend, listManualSpend, normalizeMonth, setManualSpend } from "@/lib/spend/manual";
import { DEFAULT_ALLOWED_ORIGINS, setTrackingOrigins, trackingOrigins } from "@/lib/origin";
import { setRoutingConfig } from "@/lib/routing";
import { resetFailedExports } from "@/lib/sync/conversions";

let failures = 0;
const ok = (c: boolean, m: string) => {
  if (!c) failures++;
  console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`);
};

const POOL = "verify-pool";
const PHONE = "+16185559001";

async function main() {
  // Fixtures first, so a re-run is not a different test from the first run.
  await db.delete(trackingNumbers).where(eq(trackingNumbers.phoneNumber, PHONE));
  await db.delete(pools).where(inArray(pools.key, [POOL]));
  await seedDefaults(db);

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
