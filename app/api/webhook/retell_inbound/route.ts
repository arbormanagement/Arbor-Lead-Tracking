import { computeOfficeStatus, FAIL_SAFE_STATUS, TIME_ZONE } from "@/lib/retell/office-hours";
import { UNKNOWN_CALLER, callerContextVariables } from "@/lib/retell/caller-context";
import { lookupCaller } from "@/lib/retell/caller-lookup";
import { webhookAuthorized } from "@/lib/intake/webhook-auth";

export const runtime = "nodejs";

/**
 * Retell inbound-call webhook — the merge's slice 1, serving what
 * Arbor-Automations' `/api/webhook/retell_inbound` serves today, at the same
 * path so the dashboard-configured webhook URL (per phone number, not settable
 * via API) keeps working when the domain moves.
 *
 * Fires ONCE per call, before Chloe speaks, and returns dynamic variables
 * interpolated into her prompt for the whole call.
 *
 * Contract (Retell): POST { event: "call_inbound", call_inbound: { from_number, to_number, agent_id } }
 *          response:  { call_inbound: { dynamic_variables: { ... } } }
 *
 * Retell allows 10 seconds and retries 3 times. EVERY dynamic-variable value
 * must be a string — booleans and numbers are rejected outright and the call
 * proceeds with no variables at all. On any unexpected error this answers with
 * FAIL_SAFE_STATUS (team UNAVAILABLE — a wrong "available" wakes on-call staff;
 * a wrong "closed" still captures the lead) rather than returning nothing.
 *
 * The caller lookup runs AFTER the office answer is in hand and never throws;
 * every failure path yields UNKNOWN_CALLER. An unknown caller OMITS
 * `caller_context` rather than sending its empty string — see the note on the
 * response below for why that distinction is load-bearing.
 */
export async function POST(req: Request) {
  // The response describes real customers (name, address, email), so once the
  // shared secret is configured a request without it gets nothing.
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  const startedAt = Date.now();

  let inbound: { from_number?: string; to_number?: string } = {};
  try {
    const body = await req.json();
    inbound = body?.call_inbound ?? {};
  } catch {
    // Malformed body: fall through with no caller — the fail-safe philosophy
    // is "always answer with variables", never 4xx a live phone call.
  }
  const fromNumber = inbound.from_number ?? "";
  const toNumber = inbound.to_number ?? "";

  let status = FAIL_SAFE_STATUS;
  let failed = false;
  try {
    status = computeOfficeStatus();
  } catch (error) {
    failed = true;
    console.error(`[retell_inbound] office-hours computation failed, using fail-safe: ${error instanceof Error ? error.message : error}`);
  }

  const caller = fromNumber ? await lookupCaller(fromNumber) : UNKNOWN_CALLER;

  // Logged on every call: a lookup that silently returns the wrong thing is
  // invisible otherwise, which is exactly how the missed transfers went
  // unnoticed for weeks.
  console.log(
    `[retell_inbound] from=${fromNumber} to=${toNumber} open=${status.open}` +
      `${status.holiday ? ` holiday="${status.holiday}"` : ""}` +
      `${failed ? " FAILSAFE" : ""}` +
      ` caller=${caller.known ? caller.customerId : `none(matches=${caller.matchCount})`}` +
      `${caller.note ? ` note="${caller.note}"` : ""}` +
      `${caller.doNotService ? " DO_NOT_SERVICE" : ""}` +
      ` ${Date.now() - startedAt}ms`,
  );

  // ⚠️ An unknown caller must OMIT `caller_context`, never send "". Retell
  // applies `default_dynamic_variables` only when a key is ABSENT; an explicit
  // empty string renders as nothing and SKIPS the default. So v118's graded
  // fail-safe — "We have no information on file for this caller … do not offer
  // one" — only ever fired when this webhook itself failed, and never on an
  // ordinary miss, which is the common case.
  //
  // Handing the model NOTHING is not neutral: it infers rather than asks. On
  // 2026-09-04 a repeat caller whose number sits on two duplicate HCP records
  // resolved to UNKNOWN, Chloe asked "the same address we've helped you with
  // before?" with no record loaded, and on "yes" filled create_estimate with
  // Arbor's OWN office address and info@arbor-mgmt.com
  // (call_ce7664b8ca844a169f803fd99e8). That is the same failure the
  // "state an absence POSITIVELY" rule in caller-context.ts already fixed one
  // level down for a missing email — this is that rule applied to the whole
  // caller. Omitting the key is what lets the already-graded default speak.
  return Response.json({
    call_inbound: {
      dynamic_variables: {
        office_status: status.statusSentence,
        office_next_open: status.nextOpenSentence,
        ...callerContextVariables(caller.contextSentence),
      },
    },
  });
}

/**
 * Manual check: returns what Chloe would be handed if a call landed now.
 * Pass ?from=<number> to exercise the mirror lookup too. `served_by`
 * distinguishes this implementation from the old app during cutover — the old
 * host's SPA catch-all serves HTML with a 200 for unknown routes, so only a
 * JSON body carrying this field proves which app answered.
 */
export async function GET(req: Request) {
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  const status = computeOfficeStatus();
  const from = new URL(req.url).searchParams.get("from") ?? "";
  const caller = from ? await lookupCaller(from) : UNKNOWN_CALLER;
  return Response.json({
    served_by: "lead-tracking",
    now_central: new Date().toLocaleString("en-US", { timeZone: TIME_ZONE }),
    open: status.open,
    holiday: status.holiday || null,
    caller_known: caller.known,
    caller_matches: caller.matchCount,
    // Mirrors the POST exactly, omission included — a probe that always shows
    // the key would hide the very thing this endpoint exists to verify.
    dynamic_variables: {
      office_status: status.statusSentence,
      office_next_open: status.nextOpenSentence,
      ...callerContextVariables(caller.contextSentence),
    },
  });
}
