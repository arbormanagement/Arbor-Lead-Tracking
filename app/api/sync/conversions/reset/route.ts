import { and, eq, gte, sql } from "drizzle-orm";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import { conversionExports } from "@/lib/db/schema";
import { MAX_EXPORT_ATTEMPTS } from "@/lib/sync/conversions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clear the attempt counter on failed conversion exports so they are retried.
 *
 * This exists for one specific situation, which has now happened: the exports did
 * not fail because of the data, they failed because the TRANSPORT was wrong. Every
 * upload went to the Google Ads ConversionUploadService, which is closed to new
 * integrations and rejected all of them on policy. Those rows burned through
 * MAX_EXPORT_ATTEMPTS and were abandoned permanently — correct behaviour for a
 * poison pill, wrong for a batch that was never actually given a working path.
 *
 * Deliberately narrow, because "retry everything" is how a conversion gets counted
 * twice:
 *   · only rows in 'error' are touched. A 'sent' row is never reopened — that is
 *     the guard which stops a conversion being uploaded a second time, and it is
 *     not this route's business to override it.
 *   · `?abandoned=1` narrows further, to only rows past the attempt cap.
 *
 * Google now also dedups on `transactionId`, so even a genuine double-send is
 * discarded server-side — but that is a backstop, not a licence to skip the guard.
 */
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const url = new URL(req.url);
  const onlyAbandoned = url.searchParams.get("abandoned") === "1";
  const platform = url.searchParams.get("platform"); // "google" | "facebook" | null = both

  const conditions = [eq(conversionExports.status, "error")];
  if (onlyAbandoned) conditions.push(gte(conversionExports.attempts, MAX_EXPORT_ATTEMPTS));
  if (platform === "google" || platform === "facebook") {
    conditions.push(eq(conversionExports.platform, platform));
  }

  const reset = await db
    .update(conversionExports)
    .set({ status: "pending", attempts: 0, error: null, updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: conversionExports.id });

  return Response.json({
    ok: true,
    reset: reset.length,
    scope: { status: "error", onlyAbandoned, platform: platform ?? "all" },
    note: "Rows already 'sent' were not touched. Run the conversions.export job to retry these.",
  });
}
