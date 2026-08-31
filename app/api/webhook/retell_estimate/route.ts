import { after } from "next/server";
import { createIntake, processIntake } from "@/lib/intake/process";
import { webhookAuthorized } from "@/lib/intake/webhook-auth";
import { formatPhoneNumber } from "@/lib/integrations/housecallpro-write";

export const runtime = "nodejs";

/**
 * Retell custom-function webhook: Chloe's `create_estimate` tool posts the
 * caller's details here mid-call. Ported from Arbor-Automations at the same
 * path (the merge's slice 2); dormant until the Retell tool URL points at this
 * host.
 *
 * Contract quirks that must not change:
 *  - ALWAYS 200 with a `result` string — that string is what Chloe speaks-from
 *    next (`speak_after_execution: true` since v112, the dead-air fix). A 4xx
 *    or a hung response leaves the caller in silence.
 *  - `call.from_number` (Twilio caller ID) beats any phone the model captured:
 *    voice transcription mangles read-out numbers; caller ID doesn't.
 *  - The HCP work runs AFTER the response flushes (`after()`) — creating a
 *    customer + estimate takes seconds Chloe shouldn't spend silent.
 */
export async function POST(req: Request) {
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const args = body.args || body;
    const call = body.call || {};
    // Caller ID first, the model-captured phone second. The old app also fell
    // back to call.to_number — which is the ARBOR line the caller dialed, so a
    // blocked-caller-ID call got the company's own number recorded as the
    // customer's and the phone Chloe actually captured was thrown away.
    const callerPhone = call.from_number || "";

    const rawPhone = callerPhone || args.mobile_number || args.phone || "";
    const normalizedPhone = formatPhoneNumber(String(rawPhone));

    const data = {
      firstName: String(args.first_name || ""),
      lastName: String(args.last_name || ""),
      email: String(args.email || ""),
      phone: normalizedPhone,
      street: String(args.street || ""),
      city: String(args.city || ""),
      state: String(args.state || ""),
      zip: String(args.zip || ""),
      serviceNeeded: String(args.services_needed || args.service_needed || ""),
    };

    if (!data.firstName || !data.lastName) {
      return Response.json({ result: "Missing required fields. Need: first_name, last_name" });
    }

    if (normalizedPhone.length !== 10) {
      console.log(`[retell_estimate] invalid phone: raw="${rawPhone}" normalized="${normalizedPhone}"`);
      return Response.json({
        result: `Invalid phone number received (${normalizedPhone.length} digits). Need a 10-digit US number.`,
      });
    }

    const intake = await createIntake("retell", data);
    if (intake) {
      after(async () => {
        await processIntake(intake.id, data, "retell").catch((err) => {
          console.log(`[retell_estimate] background processing error for ${intake.id}: ${err instanceof Error ? err.message : err}`);
        });
      });
    }

    return Response.json({
      result: `Estimate request created successfully for ${data.firstName} ${data.lastName}`,
    });
  } catch (error) {
    console.log(`[retell_estimate] webhook error: ${error instanceof Error ? error.message : error}`);
    return Response.json({ result: "An error occurred processing the estimate request" });
  }
}
