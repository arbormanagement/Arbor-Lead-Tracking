import { and, eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { leads, leadTypeEnum } from "@/lib/db/schema";

type LeadType = (typeof leadTypeEnum.enumValues)[number];

/**
 * Channels where reaching us is NOT by itself a request for an estimate. A phone
 * call or a text can be an existing customer, a vendor, a wrong number or a
 * robocall, so those only count once something says the person asked for work:
 * `is_lead = true`, set by the transcript/body classifier or by hand.
 *
 * Everything else (web form, Facebook lead form, LSA, manual entry) is an
 * estimate request by construction — you don't fill in the quote form by accident.
 */
export const QUALIFICATION_REQUIRED: LeadType[] = ["call", "sms"];

/**
 * "Is this genuinely someone who requested an estimate?" — the single predicate
 * behind the Leads list, its counters, and the leads API, so the list and the
 * numbers above it can never disagree.
 *
 * Three things must hold:
 *  1. not spam;
 *  2. for calls/texts, the classifier or a human said yes (`is_lead = true`) —
 *     `null` (unclassified, e.g. no transcript yet) is NOT good enough;
 *  3. nothing explicitly marked "not a lead" survives, whatever its type. This
 *     is what makes the manual override work on a web form: before, marking a
 *     junk form submission as not-a-lead left it sitting in the list anyway,
 *     because forms were trusted purely on their type.
 *
 * Unqualified traffic isn't lost — it lives in the Inbox, which shows everything
 * that came in. Leads is the filtered, trustworthy view.
 */
export const isQualifiedLead: SQL = and(
  eq(leads.isSpam, false),
  or(notInArray(leads.type, QUALIFICATION_REQUIRED), eq(leads.isLead, true)),
  // is_lead IS NOT FALSE — spelled out because SQL NULL isn't false.
  or(isNull(leads.isLead), eq(leads.isLead, true)),
)!;
