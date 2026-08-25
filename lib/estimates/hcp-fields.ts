import { sql, type SQL } from "drizzle-orm";
import { hcpEstimates } from "@/lib/db/schema";

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
