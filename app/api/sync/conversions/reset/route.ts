import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { resetFailedExports } from "@/lib/sync/conversions";

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
  const platform = url.searchParams.get("platform");
  const result = await resetFailedExports({
    onlyAbandoned: url.searchParams.get("abandoned") === "1",
    platform: platform === "google" || platform === "facebook" ? platform : undefined,
  });

  return Response.json({
    ok: true,
    ...result,
    note: "Rows already 'sent' were not touched. Run the conversions.export job to retry these.",
  });
}
