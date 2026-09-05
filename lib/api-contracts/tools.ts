import { z } from "zod";
import { LOCATIONS } from "@/lib/locations";

/**
 * Typed contracts for the MCP tool catalog served at /api/mcp.
 *
 * Inputs are what each tool accepts; outputs are the JSON shapes each tool
 * returns (as stringified JSON in the tool result). Both halves live HERE, apart
 * from the tool implementations, because they are the long-lived interface:
 * a future generative frontend (CopilotKit/AG-UI component catalog) imports these
 * output types as its component props, which is what turns a schema drift into a
 * build error instead of a blank screen.
 *
 * Conventions, enforced by the query layer these wrap:
 *  - Money is integer CENTS, named `*Cents` or documented on the field.
 *  - Phones are E.164; dates are ISO-8601 strings in tool output.
 *  - `none` is a real value on every estimate filter — it means "unattributed",
 *    and ~18% of post-cutover estimates genuinely have no lead.
 *
 * This module must stay CLIENT-SAFE: zod and types only, no db imports (the
 * same rule as lib/messaging/channels.ts).
 */

/** Mirrors leadTypeEnum / leadStatusEnum in lib/db/schema.ts exactly — a value
 *  that isn't in the pg enum fails the query rather than matching nothing.
 *  Defined HERE (db-free) so both the query layer and client code can import. */
export const LEAD_TYPES = ["call", "web_form", "facebook_leadgen", "sms", "email"] as const;
export const LEAD_STATUSES = [
  "new",
  "working",
  "qualified",
  "quoted",
  "won",
  "lost",
  "cancelled",
  "spam",
  "duplicate",
] as const;

const days = (def: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(def)
    .describe("Window in days back from now. Windows over roi_daily use America/Chicago business dates.");

/**
 * The window for tools that read the raw HousecallPro tables (estimates, jobs,
 * invoices), which are synced back to 2017 and mean the same thing at any depth.
 *
 * Two differences from `days` above, both deliberate:
 *
 * - It reaches TEN YEARS rather than one. The 365 cap belongs to the roi_daily
 *   tools, where a longer window puts complete ad spend beside attribution that
 *   only starts 2026-08-08 and calls the quotient ROAS. No such hazard here.
 * - It has NO default, so "the caller asked for `days`" is distinguishable from
 *   "the caller asked for nothing" — which is what lets `start`/`end` and `days`
 *   be rejected as a combination instead of one silently winning. The default is
 *   applied in the query layer; each tool states it below.
 */
const historyDays = (def: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe(
      `Rolling window in days back from now (default ${def}). ` +
        "Alternative to `start`/`end` — passing both is an error. " +
        "Reaches the full HousecallPro history; attribution fields are null before 2026-08-08, which `agg.createdBeforeTracking` counts where a tool reports it.",
    );

const ISO_OR_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A fixed period, for the questions `days` cannot ask: last August, the same week
 * a year ago, a specific storm. A bare date means the WHOLE day in America/Chicago
 * and both ends are INCLUSIVE — matching the HousecallPro tools, where reading a
 * bare upper bound as midnight silently dropped the final day.
 */
const windowBound = (edge: "start" | "end") =>
  z
    .string()
    .regex(ISO_OR_DATE, "Use YYYY-MM-DD or an ISO-8601 timestamp")
    .optional()
    .describe(
      edge === "start"
        ? "Fixed window START (inclusive). `YYYY-MM-DD` = from 00:00 that day in America/Chicago; a full ISO timestamp is used exactly. Use with `end` instead of `days`."
        : "Fixed window END (INCLUSIVE — `2025-08-31` includes all of the 31st). A full ISO timestamp is used exactly, so `[start, end)` is still available. Use with `start` instead of `days`.",
    );

/** Spread into every raw-table list tool so the three cannot drift apart. */
const windowFields = (def: number) => ({
  days: historyDays(def),
  start: windowBound("start"),
  end: windowBound("end"),
});

const isoDate = z.string().describe("ISO-8601 timestamp");

/**
 * Paging metadata every list tool returns alongside its rows. Without it a
 * limited fetch is indistinguishable from a complete one — which is how a
 * generated view silently reports partial data as if it were the whole set.
 */
export const PagingFields = {
  total: z.number().int().describe("Rows matching the filters, across all pages"),
  hasMore: z.boolean().describe("True when more rows exist beyond this page"),
  nextOffset: z.number().int().nullable().describe("Pass as `offset` to fetch the next page; null when this is the last page"),
};

// ── funnel_overview ──────────────────────────────────────────────────────────
export const FunnelOverviewInput = z.object({ days: days(30) });

export const FunnelOverviewOutput = z.object({
  touch: z.enum(["first", "last"]).describe("Attribution model these figures were read under"),
  funnel: z.object({
    contacts: z.number().int(),
    calls: z.number().int(),
    forms: z.number().int(),
    estimates: z.number().int().describe("Countable estimates: scheduled or won, not cancelled"),
    won: z.number().int(),
  }),
  daily: z.array(
    z.object({
      date: z.string().describe("Business date (America/Chicago), YYYY-MM-DD"),
      spend: z.number().int().describe("cents"),
      revenue: z.number().int().describe("cents"),
    }),
  ),
  topSources: z.array(
    z.object({
      key: z.string().nullable(),
      name: z.string().nullable(),
      spend: z.number().int().describe("cents"),
      revenue: z.number().int().describe("cents"),
    }),
  ),
});
export type FunnelOverview = z.infer<typeof FunnelOverviewOutput>;

// ── roi_summary ──────────────────────────────────────────────────────────────
export const RoiSummaryInput = z.object({
  days: days(30),
  grain: z
    .enum(["channel", "campaign", "location"])
    .default("channel")
    .describe(
      "channel = per source (google/cpc, gbp, direct, …); campaign = per ad campaign (the floor of money reporting); location = branch (Edwardsville vs O'Fallon), derived from the Google Business Profile listing campaign — the only thing that names a branch",
    ),
});

export const RoiChannelRow = z.object({
  key: z.string().nullable().describe("sources.key; null = unattributed"),
  name: z.string().nullable(),
  contacts: z.number().int(),
  estimates: z.number().int(),
  won: z.number().int(),
  cancelled: z.number().int(),
  spend: z.number().int().describe("cents"),
  revenue: z.number().int().describe("cents"),
});
export const RoiCampaignRow = z.object({
  campaignId: z.string().nullable().describe("null = not campaign-attributed"),
  name: z.string().nullable(),
  platform: z.string().nullable(),
  sourceName: z.string().nullable(),
  contacts: z.number().int(),
  estimates: z.number().int(),
  won: z.number().int(),
  spend: z.number().int().describe("cents"),
  revenue: z.number().int().describe("cents"),
});
export const RoiLocationRow = z.object({
  location: z.string().nullable(),
  contacts: z.number().int(),
  estimates: z.number().int(),
  won: z.number().int(),
  spend: z.number().int().describe("cents"),
  revenue: z.number().int().describe("cents"),
});
export type RoiChannel = z.infer<typeof RoiChannelRow>;
export type RoiCampaign = z.infer<typeof RoiCampaignRow>;
export type RoiLocation = z.infer<typeof RoiLocationRow>;

// ── list_estimates / estimate_detail ─────────────────────────────────────────
export const ESTIMATE_DATE_FIELDS = ["created", "scheduled"] as const;

export const ListEstimatesInput = z.object({
  ...windowFields(7),
  dateField: z
    .enum(ESTIMATE_DATE_FIELDS)
    .default("created")
    .describe(
      "Which date the window runs on: created (when the estimate was WRITTEN — the default, and the only one every estimate has) " +
        "or scheduled (the booked estimate visit). " +
        "⚠️ `scheduled` structurally EXCLUDES estimates with no appointment — roughly a third of the book, and the entire unscheduled backlog — " +
        "because they have no such date. Use it to answer 'whose visit falls in this period' (it also reaches FORWARD, so a future window lists upcoming visits); " +
        "use `created` for anything about volume, attribution or close rate, whose denominator must include the unscheduled.",
    ),
  source: z.string().max(200).optional().describe('sources.key, or "none" for unattributed'),
  campaign: z.string().max(200).optional().describe('campaigns.name, or "none"'),
  page: z.string().max(200).optional().describe('Normalised landing path (e.g. "/services/tree-removal"), or "none"'),
  type: z.string().max(50).optional().describe('Lead channel (call, web_form, sms, facebook_leadgen, …), or "none" for untracked'),
  arborist: z.string().max(200).optional().describe('Assigned employee, substring match (e.g. "Brooks"), or "none" for unassigned'),
  city: z.string().max(200).optional().describe('Service-address city, case-insensitive, or "none" where HCP holds no address'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

export const EstimateRow = z.object({
  id: z.string(),
  outcome: z.string().describe("open | won | lost — won is decided by option APPROVAL, never work_status"),
  scheduled: z.boolean().describe("False = no appointment in HCP (a won one was settled over the phone)"),
  createdAt: isoDate.describe("When the estimate was written — what the window runs on unless dateField says scheduled"),
  scheduledStart: isoDate.nullable(),
  name: z.string().nullable(),
  phone: z.string().nullable().describe("E.164"),
  email: z.string().nullable(),
  approved: z.number().int().nullable().describe("Approved-option amount, cents"),
  total: z.number().int().nullable().describe("cents; HCP creates estimates UNPRICED (0) — pricing lands on options later"),
  leadId: z.string().nullable().describe("null = no tracked contact matched (repeat business, referral, field estimate)"),
  leadType: z.string().nullable(),
  sourceKey: z.string().nullable(),
  sourceName: z.string().nullable(),
  campaignName: z.string().nullable(),
  keyword: z.string().nullable(),
  landingPage: z.string().nullable().describe("Normalised path"),
  selfReportedSource: z.string().nullable().describe('Caller\'s own answer to "how did you hear about us"'),

  // The HousecallPro side of the estimate. Everything above answers "where did this
  // come from"; these answer "what is it and who has it".
  status: z.string().nullable().describe("HCP work_status — NEVER the test for won, which is option approval"),
  hcpEstimateId: z.string().nullable().describe("HCP's own id (csr_…)"),
  estimateNumber: z.string().nullable().describe('Human-facing estimate number, e.g. "15441"'),
  assignedTo: z.string().nullable().describe("Assigned employee(s), comma-joined — the sales arborist. null = unassigned (~17%)"),
  jobType: z.string().nullable().describe("HCP job-type name. Almost always null — barely set on estimates; check coverage before reporting on it"),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  optionCount: z.number().int().describe("Options on the estimate — why `total` is the highest option, not their sum"),
  serviceNote: z.string().nullable().describe("First option note — in practice the description of the work"),

  // ── Line items ──────────────────────────────────────────────────────────────
  // Hydrated separately from the record itself (one HCP request per job / per
  // estimate option), so `lineItemsSyncedAt` is the only honest test of whether the
  // zeroes below mean "nothing" or "not read yet". Check it before reporting a
  // discount total as fact.
  lineItemsSyncedAt: isoDate
    .nullable()
    .describe("When line items were last read from HCP. null = NEVER READ — the figures below are absent, not zero"),
  lineItemCount: z.number().int().describe("0 is a real answer: a record is written before it is priced"),
  grossCents: z.coerce
    .number()
    .int()
    .describe("Line-item total BEFORE discounts. The money figures elsewhere are already net, so this is what makes a discount visible"),
  discountCents: z.coerce
    .number()
    .int()
    .describe(
      "Discount in CENTS, both kinds converted onto one scale. ⚠️ Do NOT recompute this from raw line items: a 'percent discount' line carries BASIS POINTS in unit_price/amount (1000 = 10%), so summing amounts reports a 10% discount on an $11,725 job as $10.00",
    ),
  discountNames: z
    .string()
    .nullable()
    .describe("Why it was given — 'Cash', 'Combo', 'Bundle', 'Sales Dept'. Comma-joined"),
  quotedHours: z.coerce
    .number()
    .nullable()
    .describe(
      "The estimator's quoted hours, off the hourly price book — the only per-record estimate of duration there is. Crew hours AS PRICED, not man-hours: compare against the door-to-door clock, not clock x headcount",
    ),
  services: z
    .string()
    .nullable()
    .describe("Price-book item names, comma-joined ('Tree Removal, Tree Deadwood') — the only per-record answer to what the work was. $0 lines like 'Arborist Notes' excluded"),
  // ⚠️ On a WON estimate these cover the APPROVED options only — the work actually
  // sold, matching `approved`. Otherwise they cover every option, which on an
  // estimate with `optionCount > 1` means several ALTERNATIVE bids for the same
  // work: do not read grossCents there as one quote.
});
export type Estimate = z.infer<typeof EstimateRow>;

export const EstimateAgg = z.object({
  total: z.number().int().describe("Everything listed (live estimates)"),
  countable: z.number().int().describe("Close-rate denominator: scheduled OR won"),
  scheduled: z.number().int(),
  won: z.number().int(),
  attributed: z.number().int(),
  createdBeforeTracking: z.number().int().describe("Written before 2026-08-08 — unattributable whatever the matching does"),
  wonCents: z.number().int(),
});
export type EstimateAggregate = z.infer<typeof EstimateAgg>;

export const EstimateDetailInput = z.object({ id: z.string().max(64) });

// ── landing_pages ────────────────────────────────────────────────────────────
export const LandingPagesInput = z.object({
  days: days(30),
  basis: z
    .enum(["entry", "conversion"])
    .default("entry")
    .describe(
      "Which page to count against. 'entry' (default) is where the visit started — what an ad click bought. " +
        "'conversion' is the page on screen when they got in touch; arbor-mgmt.com routes client-side, so that is " +
        "usually a different page from the one they arrived on. Recorded from 2026-08-28 onward only — earlier " +
        "sessions carry no value on this basis and are absent rather than zero.",
    ),
});

export const LandingPageRow = z.object({
  path: z.string(),
  sessions: z.number().int().describe("Visits starting on this page (basis=entry) or last seen on it (basis=conversion), crawlers excluded"),
  contacts: z.number().int(),
  estimates: z.number().int(),
  won: z.number().int(),
  revenue: z.number().int().describe("cents"),
});
export type LandingPage = z.infer<typeof LandingPageRow>;

// ── list_threads / get_thread ────────────────────────────────────────────────
export const ListThreadsInput = z.object({
  days: days(30),
  channel: z
    .enum(["call", "sms", "form", "facebook", "email"])
    .optional()
    .describe("Threads CONTAINING this channel — not threads whose newest activity is it"),
  state: z.enum(["open", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

export const ThreadRow = z.object({
  id: z.string(),
  state: z.string(),
  channels: z.array(z.string()),
  lastDirection: z.string().nullable(),
  lastPreview: z.string().nullable(),
  lastActivityAt: isoDate,
  unreadCount: z.number().int(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  smsOptedOut: z.boolean().describe("Replied STOP — outbound texting is blocked in code"),
  hcpCustomer: z.boolean().describe("Linked to a HousecallPro customer record"),
});
export type Thread = z.infer<typeof ThreadRow>;

export const GetThreadInput = z.object({ id: z.string().max(64) });

// ── list_leads ───────────────────────────────────────────────────────────────
export const ListLeadsInput = z.object({
  q: z.string().max(200).optional().describe("Free text over name/email/phone/message"),
  type: z.enum(LEAD_TYPES).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  isSpam: z.boolean().optional(),
  hasClickId: z.boolean().optional().describe("true = carries gclid/gbraid/wbraid/fbclid; false = carries none"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

// ── spend_summary ────────────────────────────────────────────────────────────
export const SpendSummaryInput = z.object({
  days: days(30),
  // Mirrors the `platform` pg enum exactly. A value outside it does not match
  // nothing — Postgres rejects the cast and the whole call errors, so the wrong
  // vocabulary here is a runtime failure rather than an empty result.
  platform: z.enum(["google", "google_lsa", "facebook", "other"]).optional(),
});

export const SpendRow = z.object({
  platform: z.string(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  excluded: z.boolean().describe("Recruiting/brand campaign — spend recorded but kept out of every ROI number"),
  impressions: z.number().int(),
  clicks: z.number().int(),
  spend: z.number().int().describe("cents"),
});
export type Spend = z.infer<typeof SpendRow>;

// ── diagnostics / attribution_health ─────────────────────────────────────────
export const DiagnosticsInput = z.object({});
export const AttributionHealthInput = z.object({ days: days(90) });

// ── Phase 3 write tools ──────────────────────────────────────────────────────

export const ReplyToThreadInput = z.object({
  id: z.string().max(64).describe("Conversation (thread) id, from list_threads / get_thread"),
  // Twilio splits at 1600 chars; refuse rather than silently truncate.
  body: z.string().min(1).max(1600).describe("The text message to send. Plain text."),
});

export const SetThreadStateInput = z.object({
  id: z.string().max(64),
  state: z.enum(["open", "closed"]),
});

export const SetLeadAttributionInput = z.object({
  id: z.string().max(64).describe("Lead id, from arbor_list_leads or arbor_get_thread's enquiries — one ENQUIRY, not a person"),
  sourceKey: z
    .string()
    .max(100)
    .optional()
    .describe("sources.key to set (google/cpc, gbp, google/lsa, facebook/paid, organic/seo, direct, email/newsletter, …). Must already exist — never mints"),
  campaignId: z
    .string()
    .max(64)
    .nullable()
    .optional()
    .describe("campaigns.id to set (the `id` from arbor_list_campaigns, not external_campaign_id). null clears the campaign. Must belong to the resulting source"),
  note: z.string().max(500).nullable().optional().describe("Why — stored on the lead so the next reader knows a human decided this"),
  manual: z
    .boolean()
    .optional()
    .describe("Default true: lock the row so seed backfills and reclassify never overwrite it. false: release the lock, values untouched"),
});

export const ClassifyLeadInput = z.object({
  id: z.string().max(64).describe("Lead id, from list_leads or get_thread's enquiries"),
  isLead: z
    .boolean()
    .nullable()
    .describe(
      "true/false sets a MANUAL verdict the auto-classifier will not overwrite; null clears the override and re-runs the classifier on the call transcript",
    ),
});

/** Job names accepted by trigger_sync / POST /api/sync/[job]. Defined here
 *  (db-free) so contracts stay client-safe; lib/sync/run-job.ts re-exports. */
export const SYNC_JOBS = [
  "spend",
  "hcp",
  "hcp-lineitems",
  "attribution",
  "reaper",
  "twilio-fallback",
  "transcribe",
  "classify-messages",
  "thread-backfill",
  "conversions",
  "fbleads",
  "all",
] as const;
export type SyncJob = (typeof SYNC_JOBS)[number];

export const ListCampaignsInput = z.object({});

export const SetCampaignExcludedInput = z.object({
  campaignId: z.string().max(64).describe("Campaign id, from list_campaigns"),
  excluded: z
    .boolean()
    .describe(
      "true = non-customer-acquisition (recruiting/brand): kept out of every ROI number while its spend stays on record; false = counts normally",
    ),
});

export const ListNumbersInput = z.object({});

export const NumberRow = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  friendlyName: z.string().nullable(),
  pool: z.string(),
  status: z.string(),
  isStatic: z.boolean(),
  sourceKey: z.string().nullable(),
  staticCampaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  location: z.string().nullable(),
  forwardDestination: z.string().nullable(),
  recordCalls: z.boolean(),
});
export const ListNumbersOutput = z.object({ numbers: z.array(NumberRow) });

export const UpdateNumberInput = z.object({
  id: z.string().max(64).describe("Tracking number row id, from list_numbers"),
  friendlyName: z.string().max(120).optional(),
  /**
   * A number is either a SOURCE number or part of the website DNI rotation, and the
   * two read their attribution from opposite places — which is why these fields are
   * only meaningful on a static one.
   */
  isStatic: z.boolean().optional().describe("true = a source number that names its own source/campaign; false = website DNI rotation"),
  staticSourceKey: z
    .string()
    .max(100)
    .optional()
    .describe('sources.key this number represents, e.g. "gbp". Empty string clears it. Static numbers only.'),
  staticCampaignId: z
    .string()
    .max(64)
    .nullable()
    .optional()
    .describe(
      "Campaign id this number represents, from list_campaigns — for when the source is too coarse, e.g. one of two Google Business Profile listings, or a Google Ads call asset. null clears it. Static numbers only: a pooled number takes its campaign from the visitor's lease.",
    ),
  location: z.enum(LOCATIONS).optional(),
  status: z.enum(["active", "disabled"]).optional().describe("disabled stops using the number without releasing it"),
  forwardDestination: z.string().max(20).nullable().optional().describe("E.164; null = the account default"),
  whisperMessage: z.string().max(300).nullable().optional(),
  recordCalls: z.boolean().optional(),
  greetingMessage: z.string().max(300).nullable().optional(),
  greetingEnabled: z.boolean().optional(),
});
export const UpdateNumberOutput = z.object({ number: NumberRow.nullable() });

// ── settings, pools, manual spend ────────────────────────────────────────────
export const GetSettingsInput = z.object({});
export const GetSettingsOutput = z.object({
  defaultForward: z.string().describe("E.164 the office rings when a number has no per-number override"),
  smsForward: z.string().nullable().describe("Where inbound texts are relayed; null = not relayed anywhere"),
  allowedOrigins: z.array(z.string()).describe("Sites whose pages may POST to /api/track and /api/dni/assign"),
  attributionModel: z.enum(["first", "last"]),
});

export const SetRoutingInput = z.object({
  defaultForward: z
    .string()
    .optional()
    .describe("Account-wide call-forward destination. Empty string clears it (falls back to the env default). Omit to leave unchanged."),
  smsForward: z
    .string()
    .optional()
    .describe("Where inbound texts are relayed — a mobile someone reads. Empty string stops relaying. Omit to leave unchanged."),
});

export const SetTrackingOriginsInput = z.object({
  allowedOrigins: z
    .array(z.string().max(200))
    .max(50)
    .describe(
      "Sites whose pages may POST to /api/track and /api/dni/assign. Bare hostnames are read as https. An EMPTY list restores the built-in arbor-mgmt.com defaults — it does not mean 'allow nothing'.",
    ),
});
export const TrackingOriginsOutput = z.object({
  allowedOrigins: z.array(z.string()),
  defaults: z.boolean().describe("true = the stored value was cleared and the built-in defaults apply"),
});

export const ListPoolsInput = z.object({});
export const PoolRowSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  isDni: z.boolean().describe("Website DNI leasing draws ONLY from pools flagged here"),
});
export const ListPoolsOutput = z.object({ pools: z.array(PoolRowSchema) });

export const UpsertPoolInput = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_/-]*$/, "lowercase letters, digits, and - _ / only")
    .describe("Stable identifier stored on tracking_numbers.pool. Immutable: creating with a new key makes a new pool."),
  displayName: z.string().min(1).max(80).optional().describe("Required when creating"),
  description: z.string().max(300).nullable().optional(),
  isDni: z.boolean().optional().describe("⚠️ Changing this changes which numbers the website can hand to visitors"),
});
export const UpsertPoolOutput = z.object({ pool: PoolRowSchema, created: z.boolean() });

export const DeletePoolInput = z.object({
  key: z.string().max(40).describe("Refused while any number still points at the pool, and for 'reserved'"),
});

export const ListManualSpendInput = z.object({});
export const ManualSpendRowSchema = z.object({
  sourceId: z.string(),
  sourceKey: z.string().nullable(),
  month: z.string().describe("First of the month, YYYY-MM-DD"),
  amountCents: z.number().int(),
  note: z.string().nullable(),
});
export const ListManualSpendOutput = z.object({ rows: z.array(ManualSpendRowSchema) });

export const SetManualSpendInput = z.object({
  sourceId: z.string().min(1).describe("sources.id — from roi_summary/list_campaigns, not the source KEY"),
  month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "YYYY-MM"),
  amountCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe("Integer cents for the whole month, spread evenly across its days by the next attribution run. null DELETES the row."),
  note: z.string().max(500).optional(),
});

export const ResetConversionExportsInput = z.object({
  onlyAbandoned: z.boolean().default(false).describe("Only rows past the attempt cap — the permanently abandoned ones"),
  platform: z.enum(["google", "facebook"]).optional().describe("Omit for both"),
});
export const ResetConversionExportsOutput = z.object({
  reset: z.number().int(),
  scope: z.object({ status: z.string(), onlyAbandoned: z.boolean(), platform: z.string() }),
});

export const TestCredentialsInput = z.object({
  platform: z.enum(["housecallpro", "google_ads", "facebook"]),
});
export const TestCredentialsOutput = z.object({
  platform: z.string(),
  ok: z.boolean().describe("The credential actually worked — not merely that it is present"),
});

export const ListFacebookFormsInput = z.object({});
export const ListFacebookFormsOutput = z.object({
  forms: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      status: z.string().nullable(),
      leadsCount: z.number().int().nullable(),
    }),
  ),
  selected: z.array(z.string()).describe("Form ids currently polled. EMPTY means every ACTIVE form is polled, not none."),
});

export const SetFacebookFormsInput = z.object({
  formIds: z
    .array(z.string().max(64))
    .max(200)
    .describe(
      "REPLACES the selection — read list_facebook_forms first and send the full set. An empty list restores 'poll every active form'; it does not mean 'poll nothing'.",
    ),
});

export const CleanupLeadsInput = z.object({
  scope: z
    .enum(["excluded_campaigns", "unselected_facebook_forms"])
    .describe(
      "excluded_campaigns: leads captured against a campaign since flagged recruiting/brand. unselected_facebook_forms: leads from a Facebook form since unchecked.",
    ),
  apply: z
    .boolean()
    .default(false)
    .describe("false (default) reports what WOULD be deleted and changes nothing. true performs the delete."),
});
export const CleanupLeadsOutput = z.object({
  scope: z.string(),
  applied: z.boolean(),
  wouldRemove: z.number().int(),
  removed: z.number().int(),
  note: z.string().optional(),
});

export const ImportNumberInput = z.object({
  phoneNumber: z.string().max(20).describe("E.164 of a number ALREADY owned in the Twilio account. Cannot buy one."),
  pool: z.string().max(40).default("reserved").describe("Pool key, from list_pools"),
  friendlyName: z.string().max(120).optional(),
  isStatic: z.boolean().default(true).describe("true = a source number; false puts it in the website DNI rotation"),
  staticSourceKey: z.string().max(100).optional().describe('sources.key it represents, e.g. "gbp"'),
  location: z.enum(LOCATIONS).optional(),
  forwardDestination: z.string().max(20).optional().describe("E.164; omit for the account default"),
});
export const ImportNumberOutput = z.object({ number: NumberRow.nullable() });

export const SetAttributionModelInput = z.object({
  model: z
    .enum(["last_touch", "first_touch"])
    .describe("last_touch: which channel produced THIS estimate. first_touch: which channel ACQUIRED the customer."),
  customerWindowDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe(
      "How many days a repeat won estimate inherits the customer's original source. OMIT to leave unchanged; applies on the next attribution rebuild.",
    ),
});

export const ReclassifySourcesInput = z.object({
  apply: z
    .boolean()
    .default(false)
    .describe("false (default) = dry run, reports what WOULD move; true = write the changes"),
});

export const TriggerSyncInput = z.object({
  job: z.enum(SYNC_JOBS),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "OMIT unless doing a deliberate historical backfill: each job owns its own window policy (rolling re-pulls, cold-start backfill), and an explicit window short-circuits it. Applies to spend, hcp, fbleads and the `all` chain only.",
    ),
});

// ── Output schemas ───────────────────────────────────────────────────────────
// Declared so tools return `structuredContent` (typed data a client can use
// directly) alongside the text JSON, instead of a string every caller re-parses.
// These are also the props contracts a future component catalog imports.
//
// Every date leaves the tools as an ISO-8601 STRING — the handlers pass results
// through a JSON round-trip before validating, so a Date can never reach a
// client (or fail validation) as an object.
//
// Deliberately NOT declared for the write tools, `diagnostics` and
// `attribution_health`: their payloads are pass-throughs whose shape is owned
// elsewhere (sync-job stats, the diagnostics report), and an outputSchema that
// drifts from reality fails the call outright — worse than none at all.

/**
 * One ROI row. Metrics are precise; the identity fields are optional because a
 * row identifies itself differently per grain (source key, campaign, location).
 * All of them appear here so nothing is stripped during validation.
 */
export const RoiRow = z.object({
  key: z.string().nullable().optional().describe("sources.key; null = unattributed"),
  name: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional().describe("null = not campaign-attributed"),
  platform: z.string().nullable().optional(),
  sourceName: z.string().nullable().optional(),
  location: z.string().nullable().optional().describe("Branch, derived from the GBP listing campaign"),
  contacts: z.number().int(),
  estimates: z.number().int().describe("Countable: scheduled or won, not cancelled"),
  won: z.number().int(),
  cancelled: z.number().int().optional().describe("channel grain only"),
  spend: z.number().int().describe("cents"),
  revenue: z.number().int().describe("cents"),
});

const BreakdownRow = z.object({
  value: z.string().nullable(),
  contacts: z.number().int(),
  estimates: z.number().int(),
  won: z.number().int(),
  revenue: z.number().int().describe("cents"),
});

export const RoiSummaryOutput = z.object({
  touch: z.enum(["first", "last"]),
  grain: z.enum(["channel", "campaign", "location"]),
  rows: z.array(RoiRow),
  locationRows: z.array(RoiRow).optional().describe("channel grain: the same rollup split by location"),
  breakdowns: z
    .object({
      landingPages: z.array(BreakdownRow),
      keywords: z.array(BreakdownRow),
      selfReported: z.array(BreakdownRow).describe('Callers\' own "how did you hear about us"'),
    })
    .optional(),
});

export const ListEstimatesOutput = z.object({
  rows: z.array(EstimateRow),
  agg: EstimateAgg.describe("Computed over the whole filtered window, not just this page"),
  dateField: z.enum(ESTIMATE_DATE_FIELDS).describe("Which date the window actually ran on"),
  ...PagingFields,
});

export const EstimateDetailOutput = EstimateRow.extend({
  hcpCustomerId: z.string().nullable(),
  conversationId: z.string().nullable().describe("Follow into get_thread"),
  leadOccurredAt: isoDate.nullable(),
});

export const LandingPagesOutput = z.object({
  rows: z.array(LandingPageRow),
  unknownUa: z.number().int().describe("Sessions with no user-agent recorded; counted as human, not bots"),
});

export const ListThreadsOutput = z.object({
  counts: z.object({
    call: z.number().int(),
    sms: z.number().int(),
    form: z.number().int(),
    facebook: z.number().int(),
    email: z.number().int(),
  }),
  threads: z.array(ThreadRow),
  ...PagingFields,
});

export const LeadRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  name: z.string().nullable(),
  phoneE164: z.string().nullable(),
  emailLc: z.string().nullable(),
  sourceKey: z.string().nullable(),
  campaignName: z.string().nullable(),
  medium: z.string().nullable(),
  keyword: z.string().nullable(),
  selfReportedSource: z.string().nullable(),
  gclid: z.string().nullable(),
  gbraid: z.string().nullable(),
  wbraid: z.string().nullable(),
  fbclid: z.string().nullable(),
  landingPage: z.string().nullable(),
  isSpam: z.boolean(),
  isFirstTime: z.boolean().nullable(),
  hcpEstimateId: z.string().nullable(),
  occurredAt: isoDate,
});

export const ListLeadsOutput = z.object({
  leads: z.array(LeadRowSchema),
  ...PagingFields,
});

export const SpendSummaryOutput = z.object({
  rows: z.array(SpendRow),
  totals: z.object({
    spend: z.number().int().describe("cents, including excluded campaigns"),
    excludedSpend: z.number().int().describe("cents attributable to recruiting/brand campaigns"),
  }),
});

export const CampaignRowSchema = z.object({
  id: z.string(),
  platform: z.string(),
  externalCampaignId: z.string(),
  name: z.string().nullable(),
  excluded: z.boolean().describe("Recruiting/brand — kept out of every ROI number"),
  spendCents: z.number().int(),
  leadsCount: z.number().int(),
});

export const ListCampaignsOutput = z.object({ campaigns: z.array(CampaignRowSchema) });

// ── list_jobs / list_invoices / list_customers ───────────────────────────────
//
// The HousecallPro side of the business: what was DONE, what was BILLED, and who
// the customer is. Deliberately kept apart from the estimate tools and from
// `roi_daily` — booked, billed and collected are three different numbers, and ROI
// stays anchored on the won estimate. Money here answers "did we get paid", never
// "did the ads work".

export const JOB_DATE_FIELDS = ["created", "scheduled", "completed"] as const;
export const INVOICE_DATE_FIELDS = ["invoice", "service", "paid"] as const;
export const INVOICE_STATUSES = [
  "open",
  "pending_payment",
  "paid",
  "voided",
  "uncollectible",
  "canceled",
] as const;
export const PAYMENT_METHODS = [
  "credit_card",
  "ach",
  "external",
  "mobile_check_deposit",
  "consumer_financing",
  "bnpl",
] as const;

export const ListJobsInput = z.object({
  ...windowFields(30),
  dateField: z
    .enum(JOB_DATE_FIELDS)
    .default("created")
    .describe(
      "Which date the window runs on: created (when the job was written), scheduled (the booked visit), or completed (when the crew finished). " +
        "Pick deliberately — 'what did we DO in July' is `completed`, not `created`.",
    ),
  q: z.string().max(200).optional().describe("Free text over customer name/phone/email, job description, and invoice number"),
  workStatus: z
    .string()
    .max(50)
    .optional()
    .describe(
      'HCP work_status, matched exactly. ⚠️ HCP has TWO vocabularies: jobs REPORT "complete rated" / "needs scheduling" / "user canceled", ' +
        "which is what this matches — not the filter words HCP's own API takes.",
    ),
  city: z.string().max(200).optional().describe("Service-address city, case-insensitive"),
  tag: z.string().max(200).optional().describe('Job tag, exact (e.g. "Treezilla", "Wet weather work")'),
  jobType: z.string().max(200).optional().describe("HCP job-type name, substring match"),
  invoiced: z.boolean().optional().describe("true = has at least one live invoice; false = never invoiced"),
  unpaid: z.boolean().optional().describe("true = money still owed on this job's invoices"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

export const JobRow = z.object({
  id: z.string(),
  hcpJobId: z.string().nullable().describe("HCP's own id (job_…)"),
  invoiceNumber: z.string().nullable(),
  description: z.string().nullable(),
  workStatus: z.string().nullable().describe("As HCP reports it, e.g. 'complete rated'"),
  jobType: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  createdAt: isoDate.nullable(),
  scheduledStart: isoDate.nullable(),
  scheduledEnd: isoDate.nullable(),
  arrivalWindowMinutes: z.number().int().nullable().describe("Slack quoted around the start. 0 is a hard time; null means no window set"),
  onMyWayAt: isoDate.nullable().describe("Crew dispatched"),
  startedAt: isoDate.nullable().describe("Crew on site"),
  completedAt: isoDate.nullable().describe("work_timestamps.completed_at — when the crew finished"),
  onSiteMinutes: z.number().int().nullable().describe("completed − started. Null = not clocked, NEVER zero"),
  canceledAt: isoDate.nullable(),
  appointmentCount: z.number().int().nullable().describe("Visits on the job. Null until the row is re-read with expand[]=appointments"),
  dispatchedEmployeeIds: z.array(z.string()).nullable().describe("Who was actually SENT, across all visits — more reliable than assignedTo, which is empty on many jobs"),
  notes: z.string().nullable(),
  recurrenceId: z.string().nullable().describe("Set on recurring work (plant healthcare rounds)"),
  recurrenceStatus: z.string().nullable(),
  totalCents: z.number().int().nullable().describe("The job's own quoted total"),
  outstandingCents: z.number().int().nullable().describe("HCP's own outstanding_balance on the job"),
  invoicedCents: z.number().int().nullable().describe("Rolled up from live invoices — voided/canceled excluded"),
  collectedCents: z.number().int().nullable().describe("Succeeded payments across those invoices"),
  dueCents: z.number().int().nullable(),
  invoiceCount: z.number().int().nullable(),
  assignedTo: z.string().nullable().describe("Assigned employee(s), comma-joined"),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  customerEmail: z.string().nullable(),
  estimateId: z
    .string()
    .nullable()
    .describe("The estimate this job came from — follow into arbor_estimate_detail for its attribution chain"),
  estimateOutcome: z.string().nullable(),
  estimateOptionIds: z
    .array(z.string())
    .nullable()
    .describe("HCP's original_estimate_uuids. These are OPTION ids (est_…), NOT estimate ids (csr_…)"),
  leadSourceRaw: z
    .string()
    .nullable()
    .describe("HCP's own lead_source. NOT attribution — it records how the record was typed into HCP. Never bill a channel from this"),

  // ── Line items ──────────────────────────────────────────────────────────────
  // Hydrated separately from the record itself (one HCP request per job / per
  // estimate option), so `lineItemsSyncedAt` is the only honest test of whether the
  // zeroes below mean "nothing" or "not read yet". Check it before reporting a
  // discount total as fact.
  lineItemsSyncedAt: isoDate
    .nullable()
    .describe("When line items were last read from HCP. null = NEVER READ — the figures below are absent, not zero"),
  lineItemCount: z.number().int().describe("0 is a real answer: a record is written before it is priced"),
  grossCents: z.coerce
    .number()
    .int()
    .describe("Line-item total BEFORE discounts. The money figures elsewhere are already net, so this is what makes a discount visible"),
  discountCents: z.coerce
    .number()
    .int()
    .describe(
      "Discount in CENTS, both kinds converted onto one scale. ⚠️ Do NOT recompute this from raw line items: a 'percent discount' line carries BASIS POINTS in unit_price/amount (1000 = 10%), so summing amounts reports a 10% discount on an $11,725 job as $10.00",
    ),
  discountNames: z
    .string()
    .nullable()
    .describe("Why it was given — 'Cash', 'Combo', 'Bundle', 'Sales Dept'. Comma-joined"),
  quotedHours: z.coerce
    .number()
    .nullable()
    .describe(
      "The estimator's quoted hours, off the hourly price book — the only per-record estimate of duration there is. Crew hours AS PRICED, not man-hours: compare against the door-to-door clock, not clock x headcount",
    ),
  services: z
    .string()
    .nullable()
    .describe("Price-book item names, comma-joined ('Tree Removal, Tree Deadwood') — the only per-record answer to what the work was. $0 lines like 'Arborist Notes' excluded"),
});

export const JobAgg = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  canceled: z.number().int(),
  quotedCents: z.coerce.number().int().describe("Sum of the jobs' own totals"),
  invoicedCents: z.coerce.number().int(),
  collectedCents: z.coerce.number().int(),
  dueCents: z.coerce.number().int(),
  uninvoiced: z.number().int().describe("Jobs with no live invoice at all"),
  discountCents: z.coerce.number().int().describe("Total discounted across the window — what was given away"),
  quotedHours: z.coerce.number().nullable().describe("Total quoted hours across the window"),
  lineItemsHydrated: z
    .number()
    .int()
    .describe("Jobs in the window whose line items have been read. Below `total` means the two figures above cover only part of it — say so rather than reporting them as the whole"),
});

export const ListJobsOutput = z.object({
  rows: z.array(JobRow),
  agg: JobAgg.describe("Computed over the whole filtered window, not just this page"),
  dateField: z.enum(JOB_DATE_FIELDS).describe("Which date the window actually ran on"),
  ...PagingFields,
});

export const ListInvoicesInput = z.object({
  ...windowFields(30),
  dateField: z
    .enum(INVOICE_DATE_FIELDS)
    .default("invoice")
    .describe("Which date the window runs on: invoice (billing date), service, or paid (when collected)"),
  q: z.string().max(200).optional().describe("Free text over customer name/phone/email and invoice number"),
  status: z.enum(INVOICE_STATUSES).optional(),
  paymentMethod: z
    .enum(PAYMENT_METHODS)
    .optional()
    .describe("Matches any succeeded payment on the invoice. 'bnpl' is Klarna — the line HCP's QuickBooks payout sync silently skips"),
  unpaid: z.boolean().optional().describe("true = still owed money"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

export const InvoiceRow = z.object({
  id: z.string(),
  hcpInvoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable().describe('Not unique — HCP suffixes re-issues ("10035706-1")'),
  status: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  subtotalCents: z.number().int().nullable(),
  dueCents: z.number().int().nullable(),
  paidCents: z.number().int().nullable().describe("Succeeded payments only"),
  refundedCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable().describe('Includes HCP-modelled fees such as "Credit Card Processing Fee"'),
  discountCents: z.number().int().nullable().describe("Positive magnitude; HCP reports discounts as negative"),
  paymentMethods: z.array(z.string()).nullable(),
  invoiceDate: isoDate.nullable(),
  serviceDate: isoDate.nullable(),
  dueAt: isoDate.nullable(),
  paidAt: isoDate.nullable(),
  sentAt: isoDate.nullable(),
  jobId: z.string().nullable().describe("Our hcp_jobs.id — null only while the job has not been synced yet"),
  hcpJobId: z.string().nullable().describe("HCP's own job id (job_…) — the only link the invoice payload carries"),
  jobWorkStatus: z.string().nullable(),
  jobCompletedAt: isoDate.nullable(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  customerEmail: z.string().nullable(),
  services: z.string().nullable().describe("Distinct line-item names, comma-joined"),
  itemCount: z.number().int(),
});

export const InvoiceAgg = z.object({
  total: z.number().int().describe("Everything listed, voided and canceled included"),
  live: z.number().int().describe("Not voided or canceled — the population every money total below uses"),
  paid: z.number().int(),
  billedCents: z.coerce.number().int(),
  collectedCents: z.coerce.number().int(),
  dueCents: z.coerce.number().int(),
  refundedCents: z.coerce.number().int(),
  unlinked: z.number().int().describe("Invoices whose job has not been synced yet; their customer is unknown until it is"),
});

export const ListInvoicesOutput = z.object({
  rows: z.array(InvoiceRow),
  agg: InvoiceAgg.describe("Computed over the whole filtered window, not just this page"),
  dateField: z.enum(INVOICE_DATE_FIELDS),
  ...PagingFields,
});

export const ListCustomersInput = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Optional: only customers CREATED in HousecallPro this recently. Omit to search the whole book, which is the usual case"),
  q: z.string().max(200).optional().describe("Free text over name, email, and every phone on the record"),
  city: z.string().max(200).optional(),
  hasJobs: z.boolean().optional(),
  doNotService: z
    .boolean()
    .optional()
    .describe(
      "true = flagged do-not-service. false = PROVABLY not flagged — the only set safe to mail. " +
        "Customers whose flag is still unknown are excluded from both, deliberately.",
    ),
  tracked: z
    .boolean()
    .optional()
    .describe("true = linked to a tracked inbox contact; false = never reached us on a tracked channel (referral, walk-in, or predates tracking)"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0).describe("Row offset for paging; use nextOffset from the previous response"),
});

export const CustomerRow = z.object({
  id: z.string(),
  hcpCustomerId: z.string().nullable().describe("HCP's own id (cus_…)"),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable().describe("E.164 primary"),
  phones: z.array(z.string()).nullable().describe("EVERY number on the record — people call from whichever handset they are holding"),
  createdAt: isoDate.nullable().describe("HCP's own created_at, not when we first synced them"),
  updatedAt: isoDate.nullable(),
  company: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  notes: z.string().nullable(),
  notificationsEnabled: z.boolean().nullable(),
  doNotService: z
    .boolean()
    .nullable()
    .describe(
      "⚠️ THREE-STATE. true = flagged, false = not flagged, null = UNKNOWN (not yet re-read with the expand). " +
        "null is NOT 'safe to contact' — treating absence as false is how 51 flagged customers were mailed.",
    ),
  leadSourceRaw: z.string().nullable().describe("HCP's own lead_source. NOT attribution"),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  contactId: z.string().nullable().describe("The tracked inbox contact, when they have one"),
  conversationId: z.string().nullable().describe("Follow into arbor_get_thread"),
  jobCount: z.number().int(),
  lastJobAt: isoDate.nullable(),
  estimateCount: z.number().int(),
  wonEstimateCount: z.number().int(),
  billedCents: z.number().int().describe("Lifetime, live invoices only"),
  collectedCents: z.number().int(),
  dueCents: z.number().int().describe("Still owed — the collections number"),
});

export const ListCustomersOutput = z.object({
  rows: z.array(CustomerRow),
  agg: z.object({
    total: z.number().int(),
    tracked: z.number().int().describe("How many are linked to a tracked contact"),
    doNotService: z.number().int().describe("Flagged do-not-service"),
    doNotServiceUnknown: z.number().int().describe("Flag not yet known — never pool these with the unflagged"),
  }),
  ...PagingFields,
});

/**
 * The individual priced lines of one estimate or job.
 *
 * `id` is this app's own id (as returned by arbor_list_estimates / arbor_list_jobs),
 * never HousecallPro's estimate number or job id.
 */
export const LineItemsInput = z.object({
  kind: z.enum(["estimate", "job"]),
  id: z.string().max(64),
});

export const LineItemsOutput = z.object({
  kind: z.enum(["estimate", "job"]),
  id: z.string(),
  syncedAt: z.string().nullable(),
  lines: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      quantity: z.number().nullable(),
      unitOfMeasure: z.string().nullable(),
      unitPriceRaw: z.number().nullable(),
      amountCents: z.number(),
      discountRate: z.number().nullable(),
      optionId: z.string().nullable(),
    }),
  ),
  grossCents: z.number(),
  discountCents: z.number(),
  netCents: z.number(),
  quotedHours: z.number().nullable(),
  recordTotalCents: z.number(),
  reconciles: z.boolean(),
});
