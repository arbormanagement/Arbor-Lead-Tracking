import { after } from "next/server";
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { automationIntakes } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { sendFailureAlert } from "@/lib/email/sendgrid";
import { createIntake, processIntake, updateIntakeFailed } from "@/lib/intake/process";
import { formatPhoneNumber } from "@/lib/integrations/housecallpro-write";
import { normalizePhone as toE164 } from "@/lib/phone";
import { secretEquals } from "@/lib/secret-compare";

export const runtime = "nodejs";

/**
 * Website contact form → HCP customer + estimate. Ported from Arbor-Automations
 * at the same path (the merge's slice 5); dormant until the website's form
 * handler is repointed here. Authenticated by the shared X-Webhook-Secret.
 *
 * The same submission also arrives through `track.js` as a `form_submit`
 * seconds earlier — which is exactly why this handler routes through
 * `processIntake`: its linking step finds the open lead that form just minted
 * and stamps the estimate onto it, closing the same-second-timestamp gap that
 * used to leave web-form estimates unattributed.
 */
export async function POST(req: Request) {
  try {
    const secret = env.WEBSITE_LEAD_SECRET;
    const provided = req.headers.get("x-webhook-secret") ?? "";
    if (!secret || !secretEquals(provided, secret)) {
      console.log("[website_lead] rejected: bad or missing secret");
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

    const rawPhone = str(b.phone || b.mobile_number);
    const phone = formatPhoneNumber(rawPhone);

    let firstName = str(b.firstName || b.first_name).trim();
    let lastName = str(b.lastName || b.last_name).trim();
    if (!firstName && !lastName && b.name) {
      const parts = str(b.name).trim().split(/\s+/);
      firstName = parts[0] || "";
      lastName = parts.slice(1).join(" ") || "";
    }

    const data = {
      firstName: firstName || "Unknown",
      lastName: lastName || "Lead",
      email: str(b.email).trim(),
      phone,
      street: str(b.street || b.address).trim(),
      city: str(b.city).trim(),
      state: str(b.state || "IL").trim(),
      zip: str(b.zip || b.zipCode).trim(),
      serviceNeeded:
        str(b.serviceNeeded || b.service_needed || b.message || b.details).trim() ||
        "Website lead — no service detail provided",
    };

    // Someone resubmitting the form within minutes is one enquiry, and HCP-side
    // there is no idempotency key to lean on — so the window check stands in.
    const e164 = toE164(phone);
    if (phone.length === 10 && e164) {
      const [recentDupe] = await db
        .select({ id: automationIntakes.id })
        .from(automationIntakes)
        .where(
          and(
            eq(automationIntakes.phoneE164, e164),
            eq(automationIntakes.source, "website"),
            gte(automationIntakes.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
          ),
        )
        .limit(1);
      if (recentDupe) {
        console.log(`[website_lead] duplicate within 10 min for ${e164}, skipping (existing ${recentDupe.id})`);
        return Response.json({ received: true, requestId: recentDupe.id, duplicate: true });
      }
    }

    const intake = await createIntake("website", data);
    if (!intake) return Response.json({ received: true, duplicate: true });

    if (phone.length !== 10) {
      await updateIntakeFailed(intake.id, `Invalid phone number (${phone.length} digits). Need 10-digit US number.`);
      await sendFailureAlert("Website Lead", "Lead had an invalid phone number", {
        name: `${data.firstName} ${data.lastName}`.trim(),
        email: data.email,
        rawPhone: rawPhone || "(none)",
        serviceNeeded: data.serviceNeeded,
      });
      return Response.json({ received: true, requestId: intake.id, warning: "invalid phone" });
    }

    after(async () => {
      await processIntake(intake.id, data, "website").catch((err) => {
        console.log(`[website_lead] background processing error: ${err instanceof Error ? err.message : err}`);
      });
    });

    return Response.json({ received: true, requestId: intake.id });
  } catch (error) {
    console.log(`[website_lead] webhook error: ${error instanceof Error ? error.message : error}`);
    return Response.json({ message: "Internal server error" }, { status: 500 });
  }
}
