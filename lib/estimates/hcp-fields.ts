import { sql, type SQL } from "drizzle-orm";
import { hcpEstimates } from "@/lib/db/schema";
import {
  discountCentsSql,
  discountNamesSql,
  estimateLineItemsSql,
  grossCentsSql,
  lineItemCountSql,
  quotedHoursSql,
  serviceNamesSql,
} from "@/lib/hcp/line-items";

/**
 * The HousecallPro estimate fields that live inside jsonb rather than in their own
 * column — `raw` (the verbatim HCP payload), `address`, and `options`.
 *
 * The sync has always stored these; nothing above the query layer could see them,
 * because `listEstimates` projected 19 scalar columns and stopped. Extracting them
 * here rather than inline in each query keeps the list and the detail tool reading
 * the SAME expression, which is the reason `filterSql` lives in lib/ too: two
 * spellings of "who wrote this estimate" is how the two surfaces start disagreeing.
 *
 * Every fragment is defensive about jsonb shape. `jsonb_array_length` throws on a
 * non-array, and `raw` is whatever HCP sent — a null, a renamed key or an object
 * where an array is expected would take down the whole list rather than blanking one
 * cell, so each one guards with `jsonb_typeof` before indexing.
 *
 * NOT here, deliberately: `lead_source_raw`. It records how a record was TYPED INTO
 * HCP, not where the customer came from — see its comment in schema.ts. Surfacing it
 * beside real attribution is precisely how it ends up in a report.
 */

/** HCP's human-facing estimate number (e.g. "15441"), for looking a record up in HCP. */
export const estimateNumberSql: SQL<string | null> = sql<string | null>`${hcpEstimates.raw}->>'estimate_number'`;

/**
 * Who the estimate is assigned to — the sales arborist, in practice. Comma-joined
 * because an estimate CAN carry more than one (1 of the 200 most recent does), and
 * dropping the second name would quietly under-credit a joint visit.
 *
 * 34 of those 200 have nobody assigned, so null here is normal and means unassigned,
 * not missing data.
 */
export const assignedToSql: SQL<string | null> = sql<string | null>`(
  select nullif(string_agg(nullif(trim(concat_ws(' ', e->>'first_name', e->>'last_name')), ''), ', '), '')
  from jsonb_array_elements(
    case when jsonb_typeof(${hcpEstimates.raw}->'assigned_employees') = 'array'
      then ${hcpEstimates.raw}->'assigned_employees' else '[]'::jsonb end
  ) e
)`;

/**
 * HCP's job type NAME (`estimate_fields.job_type` is an object, not a string).
 *
 * Almost always null: 1 of the 200 most recent estimates has one set. Carried anyway
 * because it costs one expression and the field is real — but do not build a report
 * on it without checking coverage first, and expect a group-by to be one bucket.
 */
export const jobTypeSql: SQL<string | null> = sql<string | null>`${hcpEstimates.raw}->'estimate_fields'->'job_type'->>'name'`;

/** Service address, off the modelled `address` column. */
export const addressPartSql = (part: "street" | "city" | "state" | "zip"): SQL<string | null> =>
  sql<string | null>`${hcpEstimates.address}->>${sql.raw(`'${part}'`)}`;

/** How many options the estimate carries — the count behind `total` being a max, not a sum. */
export const optionCountSql: SQL<number> = sql<number>`(
  case when jsonb_typeof(${hcpEstimates.options}) = 'array'
    then jsonb_array_length(${hcpEstimates.options}) else 0 end
)::int`;

/**
 * The first non-empty option note — in practice the description of the work ("Tree
 * removal for a tree that has already fallen in the yard").
 *
 * This is the closest thing the data has to "what is this job", and it is the field
 * people reach for when scanning a list. Later notes are left in `options`; the point
 * here is a one-line summary, not the note history.
 */
export const serviceNoteSql: SQL<string | null> = sql<string | null>`(
  select nullif(trim(n->>'content'), '')
  from jsonb_array_elements(
    case when jsonb_typeof(${hcpEstimates.options}) = 'array' then ${hcpEstimates.options} else '[]'::jsonb end
  ) o,
  jsonb_array_elements(
    case when jsonb_typeof(o->'notes') = 'array' then o->'notes' else '[]'::jsonb end
  ) n
  where nullif(trim(n->>'content'), '') is not null
  limit 1
)`;

/**
 * ── Line items ──────────────────────────────────────────────────────────────
 *
 * Derived at read time from the hydrated `line_items` jsonb. The maths — in
 * particular why a percent discount cannot be read straight off `amount` — lives in
 * `lib/hcp/line-items.ts`, as does the rule for which OPTIONS these cover on a
 * multi-option estimate.
 *
 * The short version of that rule: on a WON estimate the figures cover the approved
 * options only (the work actually sold, the same population `approved_amount_cents`
 * measures); everywhere else they cover every option, and `optionCount` above is
 * what says whether that is one bid or several alternatives.
 */
const estimateItems = estimateLineItemsSql(hcpEstimates.lineItems, hcpEstimates.options, hcpEstimates.won);

/** Line items across the covered options. 0 is a real answer — an estimate is
 *  written before it is priced — so read it beside `lineItemsSyncedAt`, which is
 *  what distinguishes it from "not fetched yet". */
export const lineItemCountEstimateSql: SQL<number> = lineItemCountSql(estimateItems);
/** Before discounts; `total`/`approved` are already net, so the pair is what makes
 *  a discount visible at all. */
export const grossCentsEstimateSql: SQL<number> = grossCentsSql(estimateItems);
export const discountCentsEstimateSql: SQL<number> = discountCentsSql(estimateItems);
/** WHY the discount was given — 'Cash', 'Combo', 'Bundle', 'Sales Dept'. */
export const discountNamesEstimateSql: SQL<string | null> = discountNamesSql(estimateItems);
/** The estimator's own read of duration, off the hourly price book. Crew hours as
 *  PRICED, not man-hours — see the note on `quotedHoursSql`. */
export const quotedHoursEstimateSql: SQL<number | null> = quotedHoursSql(estimateItems);
/** Which services the estimate covers, from the price-book item names — the only
 *  per-record answer to that question. */
export const servicesEstimateSql: SQL<string | null> = serviceNamesSql(estimateItems);
