import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
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
/**
 * Every option on the estimate is marked `deleted` — i.e. it was deleted in HCP.
 *
 * HCP soft-deletes: a deleted estimate is still returned by the API, forever. There
 * is no `deleted` work_status and no `deleted_at` on the header — the only trace is
 * `options[].status`. Measured 2026-08-15 over 2,048 estimates spanning 2017–2026:
 * 120 (5.9%) have every option deleted, and all of them are still listed.
 *
 * In practice HCP also sets the work_status to `user canceled` / `pro canceled` when
 * you delete, so `CANCELLED_STATUSES` was already catching these for the RATE — none
 * of the 120 passed `isCountableEstimate`. This is belt-and-braces for the LIST:
 * `isLiveEstimate` tests only the work_status, so a deleted estimate left at
 * `needs scheduling` would render as an "unscheduled" opportunity. Testing the
 * deletion marker directly means that cannot happen whatever HCP does with the header.
 *
 * Uses jsonb containment rather than a NOT EXISTS subquery so it stays a single
 * expression that composes into the shared predicates below. `<@ '["deleted"]'`
 * is true only when EVERY element of the projected status array is "deleted".
 */
export const isDeletedEstimate: SQL = sql`
  ${hcpEstimates.options} IS NOT NULL
  AND jsonb_typeof(${hcpEstimates.options}) = 'array'
  AND jsonb_array_length(${hcpEstimates.options}) > 0
  AND jsonb_path_query_array(${hcpEstimates.options}, '$[*].status') <@ '["deleted"]'::jsonb
`;

/** Its negation, for composing into the "still counts" predicates. */
const notDeleted: SQL = sql`NOT (${isDeletedEstimate})`;

export const isCountableEstimate: SQL = and(
  // Scheduled, **or won without ever being scheduled** (Justin, 2026-08-21).
  //
  // The `won` arm is a correction, not a loosening. The scheduled-only rule was
  // aimed at estimates that went nowhere — created, never priced, never booked —
  // and it is still right about those. It was never meant to reach a job the
  // business actually SOLD, and it was: some estimates are settled entirely over
  // the phone, so the crew never needs a calendar entry and `scheduled_start` stays
  // null forever. Those were dropped from the close-rate denominator AND from
  // `roi_daily`, so a won job earned real money that no ROI surface could see, and
  // /estimates badged it `unscheduled` rather than `won`.
  //
  // Measured across three 200-estimate slices of HCP history (2026-08-21): 1, 1 and
  // 2 won-but-never-scheduled per 200 — ~1.5–3% of all wins. Small, and entirely
  // silent, which is why it survived this long.
  //
  // The Feb-2026 argument for the predicate is untouched: those 45 cancelled rows
  // and the never-scheduled-never-priced ones are not won, so they still do not
  // count. This arm only ever ADDS an estimate that closed, which lands in the
  // numerator and denominator alike — so the close rate moves by a fraction of a
  // point, and in exchange it becomes impossible for a sale to be invisible.
  or(isNotNull(hcpEstimates.scheduledStartHcp), eq(hcpEstimates.won, true)),
  // `status IS NULL OR status NOT IN (...)` — spelled out because SQL NULL is not
  // false, so a bare NOT IN would silently drop every estimate with no work_status.
  or(isNull(hcpEstimates.status), notInArray(hcpEstimates.status, CANCELLED_STATUSES)),
  notDeleted,
)!;

/**
 * When a countable estimate happened, for anything that has to bucket it by day and
 * has no attributed contact to date it from.
 *
 * `scheduled_start` is the appointment and is the right answer whenever there is
 * one. A won-but-never-scheduled estimate has none, so it falls back to creation —
 * without this it would pass `isCountableEstimate` and then be silently dropped by
 * every `scheduled_start >= window` filter, which is precisely the bug the `won` arm
 * above exists to fix.
 */
export const countableEstimateDate: SQL = sql`coalesce(${hcpEstimates.scheduledStartHcp}, ${hcpEstimates.createdAtHcp})`;

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
 * Deliberately still requires a scheduled start. A never-scheduled estimate that
 * nobody won is excluded from the countable set too, and it is not a cancellation —
 * nobody called anything off.
 *
 * Note this is no longer a strict partition: since 2026-08-21 `isCountableEstimate`
 * also admits a won estimate that was never scheduled, which has no appointment to
 * cancel and cannot be cancelled anyway (a cancelled work_status excludes it). The
 * two predicates remain DISJOINT, which is what the /sources columns need — they
 * simply no longer cover exactly "everything with an appointment" between them.
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
export const isLiveEstimate: SQL = and(
  or(isNull(hcpEstimates.status), notInArray(hcpEstimates.status, CANCELLED_STATUSES)),
  // See `isDeletedEstimate`: this predicate tests the work_status, and a deleted
  // estimate whose header did not go to `canceled` would otherwise be LISTED as
  // an unscheduled opportunity even though it no longer exists to the business.
  notDeleted,
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
