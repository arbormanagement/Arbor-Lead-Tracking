import { and, inArray, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { hcpEstimates } from "@/lib/db/schema";

/**
 * Estimate work_status values that mean the appointment never happened. HCP's
 * vocabulary, verified against the live account: a cancelled estimate is
 * administrative debris, not a customer who said no.
 *
 * Note this is NOT the same vocabulary as invoices, which cancel as
 * `canceled` / `voided`. Each HCP entity has its own; do not generalise from
 * this one.
 */
export const CANCELLED_STATUSES = ["pro canceled", "user canceled"];

/**
 * "Does this estimate count as a sales opportunity?" — the one predicate behind
 * every estimate metric, so no two surfaces can disagree about the denominator.
 *
 * Two conditions, both load-bearing:
 *  1. it was actually scheduled (`scheduled_start_hcp IS NOT NULL`) — an estimate
 *     nobody booked a visit for was never sold;
 *  2. it was not cancelled — a cancelled appointment did not happen.
 *
 * **This is copied from the business's existing reporting, not invented**
 * (`arbor-reporting/server/storage.ts`, `getEstimatePivotMulti`). It is the rule the
 * team's numbers already run on, and getting it wrong is not a rounding error:
 *
 *   Feb 2026, every HCP record ....... 114 estimates, 29 won → 25%
 *   Feb 2026, this predicate .......... 60 estimates, 29 won → 48%
 *
 * Same wins both ways. The denominator is the entire difference, and 25% is not a
 * close rate — roughly 45 of those 114 rows are cancelled, including thirteen
 * created inside forty minutes on Feb 11, which is one person doing a cleanup
 * rather than thirteen customers declining.
 *
 * The trap this exists to prevent: this app now holds the COMPLETE 15,234-row HCP
 * history, so anything counting `hcp_estimates` without this predicate silently
 * reports the wrong number while looking perfectly correct.
 *
 * Cancelled estimates are not deleted — they stay queryable, and they are the right
 * population for asking "how many appointments are we losing before we get there?",
 * which is a real operational question. They just are not opportunities.
 */
export const isCountableEstimate: SQL = and(
  isNotNull(hcpEstimates.scheduledStartHcp),
  // `status IS NULL OR status NOT IN (...)` — spelled out because SQL NULL is not
  // false, so a bare NOT IN would silently drop every estimate with no work_status.
  or(isNull(hcpEstimates.status), notInArray(hcpEstimates.status, CANCELLED_STATUSES)),
)!;

/**
 * The exact complement of `isCountableEstimate` within scheduled estimates: an
 * appointment that was booked and then called off.
 *
 * It exists so "Cancelled" can never drift from "Estimates". Those two columns sit
 * next to each other on /sources, and until now Cancelled counted *leads* with
 * status `cancelled` under the old lead predicate while Estimates counted countable
 * HCP estimates — two different populations presented as parts of one row, so the
 * pair could not be added up or compared.
 *
 * Deliberately still requires a scheduled start. A never-scheduled estimate is
 * excluded from the countable set too, and it is not a cancellation — nobody
 * called anything off. Cancelled + countable therefore partitions exactly the
 * estimates that had an appointment on the calendar.
 */
export const isCancelledEstimate: SQL = and(
  isNotNull(hcpEstimates.scheduledStartHcp),
  inArray(hcpEstimates.status, CANCELLED_STATUSES),
)!;

/**
 * Every estimate that still exists as work — created, not cancelled, whether or not
 * it has an appointment yet.
 *
 * This is what `/estimates` LISTS. It is deliberately NOT what any rate is computed
 * from: conversion is won ÷ countable (scheduled), per Justin 2026-08-14, because an
 * estimate nobody booked a visit for was never a sales opportunity and letting those
 * into the denominator is most of what turns a 48% close rate into 25%.
 *
 * Showing them and counting them are different questions, and conflating the two is
 * what made the list feel wrong: 34 estimates were created in the last 30 days and
 * never scheduled — none of them priced — and the page rendered none of them, so work
 * that exists in HousecallPro was missing from the app entirely.
 */
export const isLiveEstimate: SQL = or(
  isNull(hcpEstimates.status),
  notInArray(hcpEstimates.status, CANCELLED_STATUSES),
)!;

/**
 * The date an estimate belongs to for reporting: **the appointment, not the
 * creation**. Close rate windows and cohorts group on this.
 *
 * Deliberately different from `roi_daily`, which buckets on the CONTACT date so
 * spend and outcomes land on the same day as the click that produced them. Both are
 * correct for their own question and they are easy to conflate:
 *
 *   roi_daily  → "what did the ads we ran that day produce?"     (contact date)
 *   close rate → "of the visits we ran that month, what closed?"  (appointment date)
 *
 * A cohort built on `created_at` is a different population from one built on
 * `scheduled_start` and the two will never reconcile.
 */
export const REPORTING_DATE = hcpEstimates.scheduledStartHcp;
