/**
 * Exercises the line-item hydration queue against a real Postgres.
 *
 *   npm run verify:line-items
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production. It seeds estimates and jobs and leaves them behind.
 *
 * Same reason `verify:campaigns` exists: there is no test runner here, and none of
 * what this covers is visible to `tsc`. The whole correctness of the hydration job
 * is in a WHERE clause and a stamp, and every way of getting them wrong still
 * compiles — while failing in the most expensive way available:
 *
 *  · Queue on `line_items IS NULL` instead of the stamp and the ~40% of records that
 *    genuinely have no line items are re-fetched every ten minutes, forever, while
 *    the rest of the history never gets read at all. The job looks busy and makes no
 *    progress.
 *  · Stamp a record whose fetch FAILED and it is marked done with no data, silently
 *    and permanently — nothing ever asks for it again.
 *  · Miss the re-queue on `updated_at_hcp` and a discount applied after the fact
 *    never lands, so the numbers are stale in exactly the case anyone would check.
 *
 * The provider is stubbed: this is about the queue, not about HTTP. What the live
 * endpoints return is asserted where it actually matters — in `jobLineItems` /
 * `estimateLineItems`, which throw rather than store `[]` if the envelope changes.
 *
 * Set up a throwaway instance:
 *   initdb -D /var/tmp/pgt/data -U postgres --auth=trust
 *   pg_ctl -D /var/tmp/pgt/data -o "-p 55432" start
 *   createdb -h 127.0.0.1 -p 55432 -U postgres arbor_scratch
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/arbor_scratch npx drizzle-kit push --force
 *   DATABASE_URL=... APP_BASE_URL=http://localhost:3000 ADMIN_EMAIL=a@b.com \
 *     COOKIE_SIGNING_SECRET=0123456789abcdef0123 npm run verify:line-items
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, hcpJobs } from "@/lib/db/schema";
import type { HcpLineItem } from "@/lib/integrations/types";
import { syncHcpLineItems } from "@/lib/sync/hcp-line-items";

let failures = 0;
const ok = (c: boolean, m: string) => {
  if (!c) failures++;
  console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`);
};

const EST_IDS = ["lix_est_priced", "lix_est_two_opts", "lix_est_bare", "lix_est_fails"];
const JOB_IDS = ["lix_job_ok", "lix_job_fails"];

/** Records the stub was asked about, so "cost zero requests" is assertable rather
 *  than inferred from the absence of data. */
const asked = { estimates: [] as string[], jobs: [] as string[] };

const provider = {
  async estimateLineItems(estimateId: string, optionIds: string[]): Promise<HcpLineItem[]> {
    asked.estimates.push(estimateId);
    if (estimateId === "hcp_est_fails") throw new Error("HCP 404 (simulated)");
    return optionIds.map((optionId, i) => ({
      id: `rli_${optionId}_${i}`,
      name: "Tree Removal",
      kind: "labor",
      unit_price: 70_000,
      unit_of_measure: "Hour(s)",
      quantity: 2.5,
      amount: 175_000,
      optionId,
    }));
  },
  async jobLineItems(jobId: string): Promise<HcpLineItem[]> {
    asked.jobs.push(jobId);
    if (jobId === "hcp_job_fails") throw new Error("HCP 500 (simulated)");
    return [
      { id: "rli_a", name: "Tree Removal", kind: "labor", amount: 444_500 },
      { id: "rli_b", name: "Combo", kind: "fixed discount", amount: 50_000 },
    ];
  },
};

async function reset() {
  await db.delete(hcpEstimates).where(inArray(hcpEstimates.id, EST_IDS));
  await db.delete(hcpJobs).where(inArray(hcpJobs.id, JOB_IDS));
}

async function main() {
  await reset();
  const now = new Date();

  await db.insert(hcpEstimates).values([
    // One option → one request.
    {
      id: EST_IDS[0]!, hcpEstimateId: "hcp_est_priced", updatedAtHcp: now,
      options: [{ id: "est_1" }],
    },
    // Two options → two requests, both tagged.
    {
      id: EST_IDS[1]!, hcpEstimateId: "hcp_est_two", updatedAtHcp: now,
      options: [{ id: "est_a" }, { id: "est_b" }],
    },
    // No options at all — an estimate written but never priced, which is a large
    // share of the book. Must be stamped WITHOUT a request.
    { id: EST_IDS[2]!, hcpEstimateId: "hcp_est_bare", updatedAtHcp: now, options: [] },
    // The provider throws for this one.
    {
      id: EST_IDS[3]!, hcpEstimateId: "hcp_est_fails", updatedAtHcp: now,
      options: [{ id: "est_x" }],
    },
  ]);

  await db.insert(hcpJobs).values([
    { id: JOB_IDS[0]!, hcpJobId: "hcp_job_ok", updatedAtHcp: now },
    { id: JOB_IDS[1]!, hcpJobId: "hcp_job_fails", updatedAtHcp: now },
  ]);

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  await syncHcpLineItems({ provider });

  const est = Object.fromEntries(
    (await db.select().from(hcpEstimates).where(inArray(hcpEstimates.id, EST_IDS))).map((r) => [r.id, r]),
  );
  const job = Object.fromEntries(
    (await db.select().from(hcpJobs).where(inArray(hcpJobs.id, JOB_IDS))).map((r) => [r.id, r]),
  );

  const priced = est[EST_IDS[0]!]!.lineItems as HcpLineItem[];
  ok(priced?.length === 1, `one-option estimate hydrated (${priced?.length} item(s))`);
  ok(priced?.[0]?.optionId === "est_1", "…tagged with the option it came from");
  ok(est[EST_IDS[0]!]!.lineItemsSyncedAt != null, "…and stamped");

  const two = est[EST_IDS[1]!]!.lineItems as HcpLineItem[];
  ok(two?.length === 2, `two-option estimate flattens both options (${two?.length} item(s))`);
  ok(
    two?.map((i) => i.optionId).join(",") === "est_a,est_b",
    "…each tagged, so the per-option view survives the flattening",
  );

  const bare = est[EST_IDS[2]!]!;
  ok(Array.isArray(bare.lineItems) && (bare.lineItems as unknown[]).length === 0, "unpriced estimate stored as []");
  ok(bare.lineItemsSyncedAt != null, "…and STAMPED, so it never comes back");
  ok(!asked.estimates.includes("hcp_est_bare"), "…having cost zero HCP requests");

  ok(est[EST_IDS[3]!]!.lineItemsSyncedAt === null, "a failed fetch is left UNSTAMPED, not marked done");
  ok(est[EST_IDS[3]!]!.lineItems === null, "…and writes nothing");

  const jobItems = job[JOB_IDS[0]!]!.lineItems as HcpLineItem[];
  ok(jobItems?.length === 2, `job hydrated (${jobItems?.length} item(s))`);
  ok(
    jobItems?.some((i) => i.kind === "fixed discount"),
    "…including the discount line, which exists nowhere else in the payload",
  );
  ok(job[JOB_IDS[1]!]!.lineItemsSyncedAt === null, "a failed job fetch is left unstamped too");

  // ── Pass 2: the stamp is what stops the re-read ───────────────────────────
  asked.estimates = [];
  asked.jobs = [];
  await syncHcpLineItems({ provider });

  ok(!asked.estimates.includes("hcp_est_priced"), "a hydrated estimate is NOT re-fetched");
  ok(!asked.estimates.includes("hcp_est_bare"), "…nor an empty one — the case a null-column queue loops on");
  ok(!asked.jobs.includes("hcp_job_ok"), "a hydrated job is NOT re-fetched");
  ok(asked.estimates.includes("hcp_est_fails"), "…while the failed estimate IS retried");
  ok(asked.jobs.includes("hcp_job_fails"), "…and so is the failed job");

  // ── Pass 3: an HCP-side edit re-queues ────────────────────────────────────
  // A discount applied after the fact, a price edit, an added tree — all bump the
  // parent's own updated_at, and this is the only thing that brings the record back.
  await db
    .update(hcpJobs)
    .set({ updatedAtHcp: new Date(Date.now() + 60_000) })
    .where(eq(hcpJobs.id, JOB_IDS[0]!));
  asked.jobs = [];
  await syncHcpLineItems({ provider });
  ok(asked.jobs.includes("hcp_job_ok"), "a job touched in HCP since its stamp is re-fetched");

  // ── The queue counter, which is how the cold start is watched ─────────────
  const stats = (await syncHcpLineItems({ provider })) as { remainingEstimates: number; remainingJobs: number };
  ok(
    stats.remainingEstimates >= 1 && stats.remainingJobs >= 1,
    `remaining counts still name the failures (${stats.remainingEstimates} est / ${stats.remainingJobs} jobs)`,
  );
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
