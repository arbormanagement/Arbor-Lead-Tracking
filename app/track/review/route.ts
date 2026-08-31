import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { reviewRequests } from "@/lib/db/schema";
import { MADISON_REVIEW_URL } from "@/lib/reviews/county";

export const runtime = "nodejs";

/**
 * Review click-tracking redirect, ported from Arbor-Automations at the same
 * URL shape (`/track/review?id=<uuid>`). ⚠️ These links live in customers' SMS
 * history forever — the path and query contract must never change, and unknown
 * ids still land somewhere useful (the Madison review page) rather than a 404.
 *
 * A click completes not just this request but every other pending request for
 * the same phone: someone who left the review has done the thing, and texting
 * them again about a different invoice reads as not noticing.
 */
export async function GET(req: Request) {
  const fallback = () => Response.redirect(MADISON_REVIEW_URL, 302);
  try {
    const trackingId = new URL(req.url).searchParams.get("id");
    if (!trackingId) return new Response("Missing tracking ID", { status: 400 });

    const [request] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.trackingId, trackingId))
      .limit(1);
    if (!request) return fallback();

    if (!request.clicked) {
      const now = new Date();
      await db
        .update(reviewRequests)
        .set({ clicked: true, clickedAt: now, status: "completed", updatedAt: now })
        .where(eq(reviewRequests.id, request.id));
      console.log(`[track/review] click tracked for ${request.customerName} (${trackingId})`);

      await db
        .update(reviewRequests)
        .set({ clicked: true, clickedAt: now, status: "completed", updatedAt: now })
        .where(
          and(
            eq(reviewRequests.customerPhoneE164, request.customerPhoneE164),
            eq(reviewRequests.status, "pending"),
            ne(reviewRequests.id, request.id),
          ),
        );
    }

    return Response.redirect(request.reviewUrl, 302);
  } catch (error) {
    console.log(`[track/review] error: ${error instanceof Error ? error.message : error}`);
    return fallback();
  }
}
