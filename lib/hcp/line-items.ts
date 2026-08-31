import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Derived figures over a stored `line_items` array.
 *
 * Everything here reads the jsonb the hydration job stored verbatim, in SQL, at
 * query time. Nothing is precomputed into a column on purpose: the account's
 * history is ~30k records that cost ~30k HCP requests to read, so a formula baked
 * into a column and later found wrong means re-crawling all of it. A formula in a
 * view expression is one deploy.
 *
 * ══ THE DISCOUNT MATHS, AND THE TRAP IN IT ══════════════════════════════════
 *
 * A discount in HousecallPro is a LINE, not a field. Two kinds, and they do NOT
 * encode their value the same way:
 *
 *   kind 'fixed discount'    unit_price = CENTS off      1000  =>    $10.00 off
 *   kind 'percent discount'  unit_price = BASIS POINTS   1000  =>    10.00% off
 *
 * `amount` mirrors `unit_price * quantity` on both, so it is the discount in cents
 * on a fixed line and IS NOT on a percent line. The naive query —
 * `sum(amount) where kind like '%discount%'` — reports a 10% discount on an
 * $11,725 job as **$10.00**. Wrong by 117x, and entirely plausible-looking in a
 * table, which is what makes it worth this much comment.
 *
 * Verified against three live jobs 2026-08-31, each reconciling to the cent:
 *
 *   inv 10036158   12 labor lines = $11,725   'Bundle' up=1000   -10%     = $10,552.50
 *   inv 10036152    4 labor lines =  $4,375   'Bundle' up=1000   -10%     =  $3,937.50
 *   inv 10036162   10 labor lines =  $7,000   'Cash'  up=100000  -$1,000  =  $6,000.00
 *
 * and in each case the result equals the parent's own `total_amount`. That identity
 * — gross - discount = the total HCP reports — is the whole safety net here, and it
 * is CHECKED rather than assumed: `lineItemReconcileSql` counts the rows where it
 * fails, and /api/diagnostics reports the count. A shape this formula gets wrong
 * (compounding percent discounts, a percent applied after a fixed one, gratuity
 * handled differently) shows up there as a non-zero number instead of as a quietly
 * wrong column.
 *
 * ⚠️ Two orderings are indistinguishable in the data seen so far, because no sampled
 * record carried BOTH a fixed and a percent discount: whether a percent applies to
 * the gross or to the gross net of fixed discounts. This computes it on the GROSS.
 * If a job with both ever exists and disagrees, the reconcile count is what says so.
 */

/** Guard for a jsonb column that might be null or, after some upstream change, not
 *  an array. `jsonb_array_elements` throws on a non-array, which would take down a
 *  whole list query rather than blanking one cell. */
const arr = (col: SQLWrapper): SQL => sql`
  case when jsonb_typeof(${col}) = 'array' then ${col} else '[]'::jsonb end`;

/**
 * A line's kind, defaulted.
 *
 * HCP's create API documents `labor` as the default when `kind` is omitted, and
 * omitted is what old rows have. Defaulting to labor rather than to null matters:
 * a null kind failing the `not like '%discount%'` test would drop the line out of
 * the gross entirely and understate every total that contains one.
 */
const kind = (item: string) => sql.raw(`coalesce(${item}->>'kind', 'labor')`);

/** Extended cents on a line. Numeric, not integer: `quantity` is fractional
 *  (2.25 hours is normal here), so `amount` can be too. */
const amount = (item: string) => sql.raw(`coalesce((${item}->>'amount')::numeric, 0)`);

/**
 * Everything that ADDS to the price: labor, materials, gratuity — anything that is
 * not a discount. This is the base a percent discount is taken from and the figure
 * a discount is meaningful against.
 */
export const grossCentsSql = (col: SQLWrapper): SQL<number> => sql<number>`(
  select coalesce(sum(${amount("i")}), 0)::bigint
  from jsonb_array_elements(${arr(col)}) i
  where ${kind("i")} not like '%discount%'
)`;

/**
 * Total discount in CENTS — the two kinds converted onto one scale.
 *
 * Rounded per line rather than once at the end, matching how a line-item system
 * has to present each line to a customer. Half-up via `round()`, Postgres's default
 * for numeric.
 */
export const discountCentsSql = (col: SQLWrapper): SQL<number> => sql<number>`(
  select coalesce(sum(
    case
      when ${kind("i")} = 'percent discount'
        -- Basis points against the gross. The subquery is correlated to the same
        -- column, so a row with no line items yields 0 rather than null.
        then round(${grossCentsSql(col)}::numeric * coalesce((i->>'unit_price')::numeric, 0) / 10000)
      when ${kind("i")} like '%discount%' then ${amount("i")}
      else 0
    end
  ), 0)::bigint
  from jsonb_array_elements(${arr(col)}) i
)`;

/** What the customer is asked to pay: gross less discounts. Should equal the
 *  parent's own total — see `lineItemReconcileSql`, which is what proves it. */
export const netCentsSql = (col: SQLWrapper): SQL<number> =>
  sql<number>`(${grossCentsSql(col)} - ${discountCentsSql(col)})`;

/**
 * QUOTED hours — the estimator's own read of how long the work takes.
 *
 * The tree-work price book is priced by the hour: `unit_of_measure` 'Hour(s)',
 * `unit_price` $700, `quantity` the hours. So this is a real, per-record estimate of
 * duration, and it is the only one there is — nothing else in HCP says how long a
 * job was expected to take.
 *
 * Matched on the unit rather than on the price, because the rate has changed over
 * the history and will again; the unit has not. Lines priced any other way (a flat
 * stump-grinding fee, a materials line) contribute nothing, which is right: they
 * carry no hours to contribute.
 *
 * ⚠️ These are the hours as PRICED, which for a crew-rate price book is crew-hours,
 * not man-hours. Compare it against the job's door-to-door clock, not against
 * clock x headcount, unless the rate is known to be per person.
 */
export const quotedHoursSql = (col: SQLWrapper): SQL<number | null> => sql<number | null>`(
  select nullif(coalesce(sum(coalesce((i->>'quantity')::numeric, 0)), 0), 0)
  from jsonb_array_elements(${arr(col)}) i
  where i->>'unit_of_measure' ilike 'hour%' and ${kind("i")} not like '%discount%'
)`;

/**
 * The distinct services on the record, comma-joined — the price-book item names
 * ("Tree Removal", "Tree Deadwood", "Removal - Stump Grinding").
 *
 * The only per-record answer to what the work actually WAS. `job_type` is set on
 * about 1 record in 200 and `description` is free text, so before line items landed
 * there was no way to ask "how much tree removal did we sell" at all.
 *
 * $0 lines are excluded, which is not cosmetic: "Arborist Notes" is a real
 * price-book item used to carry advice to the customer at zero price, and it appears
 * on a large share of jobs. Counting it as a service would make it look like one of
 * the most-sold things Arbor does.
 */
export const serviceNamesSql = (col: SQLWrapper): SQL<string | null> => sql<string | null>`(
  select nullif(string_agg(distinct nullif(trim(i->>'name'), ''), ', '), '')
  from jsonb_array_elements(${arr(col)}) i
  where ${kind("i")} not like '%discount%' and ${amount("i")} <> 0
)`;

/** Named discounts, comma-joined — 'Cash', 'Combo', 'Bundle', 'Sales Dept'. WHY a
 *  discount was given, which the cents alone never say. */
export const discountNamesSql = (col: SQLWrapper): SQL<string | null> => sql<string | null>`(
  select nullif(string_agg(distinct nullif(trim(i->>'name'), ''), ', '), '')
  from jsonb_array_elements(${arr(col)}) i
  where ${kind("i")} like '%discount%'
)`;

/** How many line items the record carries. Distinguishes "no line items" from
 *  "not hydrated yet" only in combination with `line_items_synced_at` — a record
 *  that has genuinely never been priced legitimately reports 0. */
export const lineItemCountSql = (col: SQLWrapper): SQL<number> => sql<number>`(
  select count(*)::int from jsonb_array_elements(${arr(col)}) i
)`;

/**
 * The self-check: does `gross - discount` equal the total HCP itself reports?
 *
 * This is the reason the discount maths above can be trusted beyond the three
 * records it was derived from. Every hydrated record carries an independent answer
 * — the parent's own `total_amount_cents` — and any shape the formula handles wrong
 * disagrees with it. Surfaced as a COUNT on /api/diagnostics rather than reasoned
 * about, so the failure mode is a number going non-zero rather than a column that
 * has been subtly wrong for months.
 *
 * Restricted to records with line items and a non-zero total: an unpriced estimate
 * has neither, and counting those as mismatches would bury a real one.
 *
 * A one-cent tolerance, because per-line rounding on a percent discount cannot be
 * guaranteed to land on the same cent as whatever HCP does internally.
 */
export const lineItemReconcileSql = (col: SQLWrapper, total: SQLWrapper): SQL<boolean> =>
  sql<boolean>`(
    ${lineItemCountSql(col)} > 0
    and coalesce(${total}, 0) <> 0
    and abs(${netCentsSql(col)} - coalesce(${total}, 0)) > 1
  )`;

/**
 * ══ ESTIMATES: WHICH OPTIONS THE FIGURES COVER ══════════════════════════════
 *
 * An estimate's line items are stored FLAT across every option, each tagged with
 * its `optionId`. That array must not be summed blind, because options are usually
 * ALTERNATIVE bids for the same work — the same reason `total_amount_cents` is the
 * highest option and never the sum. Summing three alternatives would report a
 * $30,000 quote on a $10,000 job.
 *
 * So on a WON estimate the items are narrowed to the APPROVED options: the work
 * actually sold, and the same population `approved_amount_cents` measures. That is
 * the case the discount question is really about — what did we come down to in
 * order to win this.
 *
 * Everywhere else the full array is used, and `optionCount` (already on every row)
 * is what says whether that is one bid or several. It is left deliberately un-picked
 * rather than resolved to "the biggest option": an open multi-option estimate has no
 * decided answer yet, and inventing one would put a number in the column that no
 * one at Arbor has agreed to.
 *
 * `approval_status` is matched case-insensitively on a `%approved%` substring
 * because HCP spells it more than one way ('pro approved', 'customer approved') and
 * has added spellings before — the sync's own `APPROVED_STATUSES` set had to be
 * widened once already.
 */
export const estimateLineItemsSql = (
  items: SQLWrapper,
  options: SQLWrapper,
  won: SQLWrapper,
): SQL => sql`(
  case
    when ${won} and exists (
      select 1 from jsonb_array_elements(${arr(options)}) o
      where lower(coalesce(o->>'approval_status', '')) like '%approved%'
    )
    then coalesce((
      select jsonb_agg(i)
      from jsonb_array_elements(${arr(items)}) i
      where i->>'optionId' in (
        select o->>'id' from jsonb_array_elements(${arr(options)}) o
        where lower(coalesce(o->>'approval_status', '')) like '%approved%'
      )
    ), '[]'::jsonb)
    else ${arr(items)}
  end
)`;
