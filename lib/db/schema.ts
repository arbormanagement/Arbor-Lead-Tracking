import {
  pgTable,
  pgEnum,
  text,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  numeric,
  uniqueIndex,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { ulid } from "ulid";

// ─────────────────────────────────────────────────────────────────────────────
// Conventions
//   • Primary keys: ULID strings (sortable, URL-safe) via $defaultFn.
//   • Money: integer CENTS everywhere (never floats).
//   • Phones: E.164 strings (+16188368004).
//   • Timestamps: timestamptz; created_at/updated_at on every table.
//   • `raw` jsonb columns retain the upstream API payload for debugging/backfill.
// ─────────────────────────────────────────────────────────────────────────────

const id = () => text("id").primaryKey().$defaultFn(() => ulid());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Enums ────────────────────────────────────────────────────────────────────
export const locationEnum = pgEnum("location", ["edwardsville", "ofallon", "unknown"]);
// Pools are user-managed rows in `pools` (not a fixed enum), so a number's `pool`
// is a plain text key referencing pools.key. Defaults seeded by the migrate/seed.
export const numberStatusEnum = pgEnum("number_status", ["active", "disabled"]);
export const platformEnum = pgEnum("platform", ["google", "google_lsa", "facebook", "other"]);
export const leadTypeEnum = pgEnum("lead_type", [
  "call",
  "web_form",
  "facebook_leadgen",
  "lsa",
  "manual",
  "sms",
  "email",
]);
// Inbox channels. `call` is stored in `calls` (recordings/duration have no message
// analogue); `sms`/`email` are rows in `messages`. All three thread into the same
// `conversations` spine, so the inbox is one list regardless of how someone reached us.
export const messageChannelEnum = pgEnum("message_channel", ["sms", "email"]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
export const contactIdentifierKindEnum = pgEnum("contact_identifier_kind", ["phone", "email"]);
// Threads are worked, not just read: `closed` is "dealt with", and the inbox
// defaults to open so it drains like a real inbox instead of growing forever.
export const conversationStateEnum = pgEnum("conversation_state", ["open", "closed"]);
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "working",
  "qualified",
  "quoted",
  "won",
  "lost",
  "cancelled",
  "spam",
  "duplicate",
]);
// Option-approval outcome of an HCP estimate: won = ≥1 option approved; lost = every
// decided option declined/expired; open = no decisions yet (or a mix).
export const estimateOutcomeEnum = pgEnum("estimate_outcome", ["won", "lost", "open"]);
export const touchTypeEnum = pgEnum("touch_type", ["first", "last", "linear"]);
export const syncStatusEnum = pgEnum("sync_status", ["running", "success", "error"]);

// ── Identity & web tracking ──────────────────────────────────────────────────
export const visitors = pgTable("visitors", {
  id: id(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  gaClientId: text("ga_client_id"),
  userAgent: text("user_agent"),
  ipHash: text("ip_hash"),
  // First-touch snapshot (never overwritten after first pageview)
  ftSource: text("ft_source"),
  ftMedium: text("ft_medium"),
  ftCampaign: text("ft_campaign"),
  ftContent: text("ft_content"),
  ftTerm: text("ft_term"),
  ftGclid: text("ft_gclid"),
  ftFbclid: text("ft_fbclid"),
  ftReferrer: text("ft_referrer"),
  ftLandingPage: text("ft_landing_page"),
  ftAt: timestamp("ft_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webSessions = pgTable(
  "web_sessions",
  {
    id: id(),
    visitorId: text("visitor_id").references(() => visitors.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Last-touch attribution for this visit
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    content: text("content"),
    term: text("term"),
    gclid: text("gclid"),
    fbclid: text("fbclid"),
    gbraid: text("gbraid"),
    wbraid: text("wbraid"),
    msclkid: text("msclkid"),
    referrer: text("referrer"),
    landingPage: text("landing_page"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    location: locationEnum("location").default("unknown"),
    derivedSourceId: text("derived_source_id").references(() => sources.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("web_sessions_visitor_idx").on(t.visitorId)],
);

// ── Sources / campaigns / spend ──────────────────────────────────────────────
export const sources = pgTable(
  "sources",
  {
    id: id(),
    key: text("key").notNull(), // e.g. "google/cpc", "facebook/paid", "organic/seo"
    displayName: text("display_name").notNull(),
    platform: platformEnum("platform").default("other"),
    defaultCostModel: text("default_cost_model"), // cpc | cpl | fixed | none
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sources_key_uq").on(t.key)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    sourceId: text("source_id").references(() => sources.id),
    platform: platformEnum("platform").notNull(),
    externalCampaignId: text("external_campaign_id").notNull(),
    name: text("name"),
    status: text("status"),
    location: locationEnum("location").default("unknown"),
    // Non-customer-acquisition campaigns (arborist recruiting, brand awareness):
    // their spend and their leads are kept for the record but never counted in ROI.
    // Recruiting dollars in the denominator with no revenue in the numerator drag
    // the whole channel's ROAS down, so the rollup and the ingest both skip these.
    excluded: boolean("excluded").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("campaigns_platform_extid_uq").on(t.platform, t.externalCampaignId)],
);

export const adSpend = pgTable(
  "ad_spend",
  {
    id: id(),
    date: date("date").notNull(),
    platform: platformEnum("platform").notNull(),
    campaignId: text("campaign_id").references(() => campaigns.id),
    // Part of the idempotency key below — must never be NULL (NULLS DISTINCT would
    // let a null-keyed row duplicate on every rolling re-pull). Providers skip
    // rows without a campaign id.
    externalCampaignId: text("external_campaign_id").notNull(),
    impressions: integer("impressions").default(0),
    clicks: integer("clicks").default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    conversions: numeric("conversions", { precision: 12, scale: 2 }).default("0"),
    source: text("source"), // provenance, e.g. "mcp:googleads"
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ad_spend_platform_extid_date_uq").on(t.platform, t.externalCampaignId, t.date),
    index("ad_spend_date_idx").on(t.date),
  ],
);

// Manually-entered monthly spend for channels without an API sync (LSA until its
// sync lands, GBP, print, yard signs, …) so every channel gets a CPL/ROAS row.
// One row per (source, month); the ROI rollup spreads the amount evenly across
// the month's days. `month` is stored as the first of the month.
export const manualSpend = pgTable(
  "manual_spend",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    month: date("month").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("manual_spend_source_month_uq").on(t.sourceId, t.month)],
);

// ── Tracking numbers / DNI ───────────────────────────────────────────────────
// User-managed number pools (channel buckets for DNI + organizing static numbers).
// `key` is the stable identifier stored on tracking_numbers.pool.
export const pools = pgTable(
  "pools",
  {
    id: id(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    // Whether website DNI draws rotating numbers from this pool (vs. a label for
    // organizing static numbers).
    isDni: boolean("is_dni").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pools_key_uq").on(t.key)],
);

export const trackingNumbers = pgTable(
  "tracking_numbers",
  {
    id: id(),
    twilioSid: text("twilio_sid").notNull(),
    phoneNumber: text("phone_number").notNull(), // E.164
    friendlyName: text("friendly_name"),
    pool: text("pool").notNull().default("reserved"), // references pools.key
    status: numberStatusEnum("status").notNull().default("active"),
    capabilities: jsonb("capabilities"),
    // Static (source-level) numbers — flyers, GBP, call extensions — never pooled/recycled.
    isStatic: boolean("is_static").notNull().default(false),
    staticSourceId: text("static_source_id").references(() => sources.id),
    location: locationEnum("location").default("unknown"),
    // Per-number call routing (override the global Twilio defaults). Null → fall
    // back to the account default forward / whisper / recording.
    forwardDestination: text("forward_destination"), // E.164 — where this number rings
    whisperMessage: text("whisper_message"), // spoken to the rep before bridge
    recordCalls: boolean("record_calls").notNull().default(true),
    // Pre-call message played to the caller before we dial (e.g. a recording notice).
    // Independent of recording; `greeting_enabled` false → no message at all.
    greetingMessage: text("greeting_message"),
    greetingEnabled: boolean("greeting_enabled").notNull().default(true),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tracking_numbers_twilio_sid_uq").on(t.twilioSid),
    uniqueIndex("tracking_numbers_phone_uq").on(t.phoneNumber),
    index("tracking_numbers_pool_idx").on(t.pool, t.status),
  ],
);

export const numberAssignments = pgTable(
  "number_assignments",
  {
    id: id(),
    trackingNumberId: text("tracking_number_id")
      .notNull()
      .references(() => trackingNumbers.id),
    webSessionId: text("web_session_id").references(() => webSessions.id),
    visitorId: text("visitor_id").references(() => visitors.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // Attribution snapshot frozen at lease time
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    keyword: text("keyword"),
    gclid: text("gclid"),
    gbraid: text("gbraid"),
    wbraid: text("wbraid"),
    fbclid: text("fbclid"),
    landingPage: text("landing_page"),
    createdAt: createdAt(),
  },
  (t) => [
    // Fast "who currently holds this number" AND the enforcement of one active
    // lease per number. This must be UNIQUE: the leasing query picks a free number
    // with `SELECT … FOR UPDATE SKIP LOCKED` and a `NOT EXISTS` check on active
    // assignments, but inserting an assignment never modifies the locked
    // tracking_numbers row, so no EPQ recheck happens. Under READ COMMITTED two
    // concurrent visitors can both pass `NOT EXISTS` against their own snapshots
    // and lease the SAME number — after which the voice route resolves the newest
    // lease and freezes the wrong visitor's source/gclid onto the call. Unique
    // turns that silent race into a retryable insert failure.
    uniqueIndex("number_assignments_active_idx")
      .on(t.trackingNumberId)
      .where(sql`released_at IS NULL`),
    index("number_assignments_session_idx").on(t.webSessionId),
    // The expired-lease reaper scans `released_at IS NULL AND expires_at <= now()`
    // on every assign request.
    index("number_assignments_expiry_idx")
      .on(t.expiresAt)
      .where(sql`released_at IS NULL`),
    // `resolveInboundAttribution` — the inbound call/text lookup — filters
    // `tracking_number_id = ? AND expires_at > ?`. Neither index above can serve it:
    // both are partial on `released_at IS NULL`, and that lookup deliberately
    // matches RELEASED leases too (a caller dialling within the grace window). Left
    // unindexed it is a sequential scan on a table that grows with every lease, on
    // the one path CLAUDE.md requires to answer in under three seconds.
    index("number_assignments_number_expiry_idx").on(t.trackingNumberId, t.expiresAt),
  ],
);

// ── Revenue (HousecallPro) ───────────────────────────────────────────────────
export const hcpCustomers = pgTable(
  "hcp_customers",
  {
    id: id(),
    hcpCustomerId: text("hcp_customer_id").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    emailLc: text("email_lc"), // normalized for matching
    phone: text("phone"),
    mobile: text("mobile"),
    phoneE164: text("phone_e164"), // normalized for matching — the PRIMARY only
    // EVERY normalized number this customer has, deduped. `phone_e164` is
    // `mobile ?? home ?? work`, which is one number for a person who may have
    // three — and people call from whichever handset they are holding. That single
    // value was the reason an estimate could sit unattributed while two real calls
    // from the same household were on file: the calls came in on the home number
    // and every match key in the app held the mobile.
    //
    // An array rather than more columns because the question is always "is this one
    // of theirs?", never "which slot is it in", and a GIN index answers that
    // directly. Kept alongside `phone_e164` rather than replacing it so existing
    // reads keep working; new matching should use this.
    phonesE164: text("phones_e164").array(),
    addresses: jsonb("addresses"),
    // HCP's own timestamps. `createdAt` above is when WE first saw the row, which is
    // a fact about the sync, not about the customer — windowing "customers acquired
    // this month" on it would date the whole back catalogue to the day of the
    // backfill.
    company: text("company"),
    notificationsEnabled: boolean("notifications_enabled"),
    /** HCP's `lead_source`. NOT attribution — same trap as hcpEstimates.leadSourceRaw. */
    leadSourceRaw: text("lead_source_raw"),
    notes: text("notes"),
    kind: text("kind"),
    tags: text("tags").array(),
    /**
     * ⚠️ THREE-STATE, and the third state is the dangerous one.
     *
     * true = flagged, false = explicitly not, **null = UNKNOWN** — the field only
     * arrives with `expand[]=do_not_service`, and without it the key is absent from
     * the payload and reads exactly like `false`. That is how 51 flagged customers
     * ended up on a newsletter send. NEVER treat null as "safe to contact"; any
     * mailing filter must require `do_not_service IS FALSE`, never `IS NOT TRUE`.
     */
    doNotService: boolean("do_not_service"),
    createdAtHcp: timestamp("created_at_hcp", { withTimezone: true }),
    updatedAtHcp: timestamp("updated_at_hcp", { withTimezone: true }),
    // When the cold-zone crawl last SAW this row.
    //
    // A crawl can only ever see what HousecallPro still returns, so a record HCP
    // has deleted or merged away is invisible to it by construction — no number of
    // passes will notice it is gone. Estimates hide this (HCP soft-deletes them, so
    // they keep coming back); customers do not, which is how 57 surplus customer
    // rows survived a full pass with drift reporting +57 and no mechanism able to
    // resolve it (2026-08-26).
    //
    // Stamped by a narrow UPDATE after each crawl page — deliberately NOT part of
    // the row upsert, whose skip-if-unchanged guard would leave untouched rows
    // unstamped, and whose jsonb rewrite is the cost that guard exists to avoid.
    // Rows still carrying a stamp older than the last completed pass are the ones
    // HCP no longer lists.
    crawlSeenAt: timestamp("crawl_seen_at", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_customers_hcp_id_uq").on(t.hcpCustomerId),
    index("hcp_customers_crawl_seen_idx").on(t.crawlSeenAt),
    index("hcp_customers_created_hcp_idx").on(t.createdAtHcp),
    index("hcp_customers_do_not_service_idx").on(t.doNotService),
    index("hcp_customers_phone_idx").on(t.phoneE164),
    index("hcp_customers_email_idx").on(t.emailLc),
    // GIN, because every query against this asks "does the array CONTAIN this
    // number" — a btree cannot answer that.
    index("hcp_customers_phones_idx").using("gin", t.phonesE164),
  ],
);

export const hcpJobs = pgTable(
  "hcp_jobs",
  {
    id: id(),
    hcpJobId: text("hcp_job_id").notNull(),
    hcpCustomerId: text("hcp_customer_id").references(() => hcpCustomers.id),
    workStatus: text("work_status"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    totalAmountCents: integer("total_amount_cents").default(0),
    subtotalCents: integer("subtotal_cents").default(0),
    outstandingBalanceCents: integer("outstanding_balance_cents").default(0),
    // ── Invoice rollup ────────────────────────────────────────────────────────
    // Derived from `hcp_invoices` after each sync, NOT read off the job payload.
    //
    // This column used to be mapped from `j.invoice_total ?? j.total_amount`, and
    // /jobs carries no `invoice_total` — so it silently held a copy of
    // `total_amount` on every row and "invoiced" and "quoted" were the same number
    // wearing two names. Now that invoices are synced in their own right it is a
    // real rollup: the sum of live (not voided/canceled) invoices on the job.
    invoiceTotalCents: integer("invoice_total_cents").default(0),
    invoicePaidCents: integer("invoice_paid_cents").default(0),
    invoiceDueCents: integer("invoice_due_cents").default(0),
    invoiceCount: integer("invoice_count").default(0),
    invoiceNumber: text("invoice_number"),
    description: text("description"),
    // HCP's `work_timestamps.completed_at` — when the crew finished. The honest
    // answer to "what did we actually DO in this window", as distinct from what was
    // sold (estimates) or billed (invoices).
    completedAtHcp: timestamp("completed_at_hcp", { withTimezone: true }),
    // With completedAt these are the only source of real job duration: dispatched →
    // on site → finished. Projected 2026-08-26; previously only `completed_at` was
    // promoted, which answers "did it happen" but nothing about how long it took.
    onMyWayAtHcp: timestamp("on_my_way_at_hcp", { withTimezone: true }),
    startedAtHcp: timestamp("started_at_hcp", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    /** Minutes of slack quoted around the start. 0 is a real value (a hard time),
     *  distinct from null (no window set). */
    arrivalWindowMinutes: integer("arrival_window_minutes"),
    /**
     * Every visit on the job. Requires `expand[]=appointments` — without it HCP
     * returns `schedule.appointments: []` rather than omitting it, so a multi-day
     * job silently reads as a single-day one.
     *
     * Each entry carries `dispatched_employees_ids`, which is who was actually SENT.
     * That is not the same as `assigned_employees`, which is empty on a great many
     * jobs — so this is the more reliable answer to "who did this work".
     */
    appointments: jsonb("appointments"),
    notes: text("notes"),
    jobTypeId: text("job_type_id"),
    businessUnit: text("business_unit"),
    lockedAtHcp: timestamp("locked_at_hcp", { withTimezone: true }),
    assignedRouteTemplateId: text("assigned_route_template_id"),
    // Recurring work (plant healthcare rounds). Absent columns are how a whole
    // category of work becomes invisible to reporting.
    recurrenceNumber: integer("recurrence_number"),
    recurrenceRule: jsonb("recurrence_rule"),
    recurrenceStatus: text("recurrence_status"),
    recurrenceId: text("recurrence_id"),
    canceledAtHcp: timestamp("canceled_at_hcp", { withTimezone: true }),
    deletedAtHcp: timestamp("deleted_at_hcp", { withTimezone: true }),
    updatedAtHcp: timestamp("updated_at_hcp", { withTimezone: true }),
    jobType: text("job_type"),
    tags: text("tags").array(),
    assignedEmployees: jsonb("assigned_employees"),
    // HCP's `original_estimate_uuids` — the estimate this job was created from.
    //
    // ⚠️ These are OPTION ids, not estimate ids, despite the field name: they are
    // `est_…` values, while an estimate's own id is `csr_…` (verified 2026-08-25 —
    // GET /estimates/est_… returns 404). So the join to `hcp_estimates` is against
    // `options[].id`, never against `hcp_estimate_id`. Stored as an array because a
    // job can be created from several options at once.
    estimateOptionIds: text("estimate_option_ids").array(),
    // HCP's `lead_source`, verbatim and **NOT usable as attribution** — see the long
    // note on `hcpEstimates.leadSourceRaw`. Same field, same trap.
    leadSourceRaw: text("lead_source_raw"),
    address: jsonb("address"),
    location: locationEnum("location").default("unknown"),
    createdAtHcp: timestamp("created_at_hcp", { withTimezone: true }),
    /** When the cold-zone crawl last saw this row — see hcpCustomers.crawlSeenAt. */
    crawlSeenAt: timestamp("crawl_seen_at", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_jobs_hcp_id_uq").on(t.hcpJobId),
    index("hcp_jobs_crawl_seen_idx").on(t.crawlSeenAt),
    index("hcp_jobs_customer_idx").on(t.hcpCustomerId),
    index("hcp_jobs_created_hcp_idx").on(t.createdAtHcp),
    index("hcp_jobs_completed_hcp_idx").on(t.completedAtHcp),
    index("hcp_jobs_started_hcp_idx").on(t.startedAtHcp),
    index("hcp_jobs_recurrence_idx").on(t.recurrenceId),
    index("hcp_jobs_work_status_idx").on(t.workStatus),
    // GIN: the job → estimate join asks "does this array contain that option id".
    index("hcp_jobs_estimate_options_idx").using("gin", t.estimateOptionIds),
  ],
);

// HCP estimates — the ROI revenue event is an estimate the customer WON (approved),
// not a completed job. `approved_amount_cents` is the value of the accepted option(s);
// `total_amount_cents` is the quote value: the highest-value option (options are
// usually alternative bids for the same work, so a sum would overstate the quote).
export const hcpEstimates = pgTable(
  "hcp_estimates",
  {
    id: id(),
    hcpEstimateId: text("hcp_estimate_id").notNull(),
    hcpCustomerId: text("hcp_customer_id").references(() => hcpCustomers.id),
    status: text("status"),
    won: boolean("won").notNull().default(false),
    outcome: estimateOutcomeEnum("outcome").notNull().default("open"),
    totalAmountCents: integer("total_amount_cents").default(0),
    approvedAmountCents: integer("approved_amount_cents").default(0),
    // Customer contact embedded on the estimate itself (normalized) — matching keys
    // off these so it doesn't depend on the customer being independently synced.
    customerPhoneE164: text("customer_phone_e164"),
    customerEmailLc: text("customer_email_lc"),
    customerName: text("customer_name"),
    address: jsonb("address"),
    location: locationEnum("location").default("unknown"),
    createdAtHcp: timestamp("created_at_hcp", { withTimezone: true }),
    // The estimate VISIT being booked — HCP's schedule.scheduled_start. Distinct
    // from createdAtHcp: an estimate is created the moment the office writes it,
    // but only becomes a real appointment once a date is set, and ~29% never get
    // one (cancelled or still "needs scheduling"). Conflating the two overstates
    // the funnel, which is why this is its own column rather than derived.
    scheduledStartHcp: timestamp("scheduled_start_hcp", { withTimezone: true }),
    scheduledEndHcp: timestamp("scheduled_end_hcp", { withTimezone: true }),
    arrivalWindowMinutes: integer("arrival_window_minutes"),
    // The ESTIMATOR's visit timeline. Three distinct clocks live on an estimate and
    // conflating them is easy: created_at (the office wrote it), these (the arborist
    // drove out and looked at the tree), approved_at (the customer said yes).
    onMyWayAtHcp: timestamp("on_my_way_at_hcp", { withTimezone: true }),
    startedAtHcp: timestamp("started_at_hcp", { withTimezone: true }),
    completedAtHcp: timestamp("completed_at_hcp", { withTimezone: true }),
    assignedRouteTemplateId: text("assigned_route_template_id"),
    approvedAtHcp: timestamp("approved_at_hcp", { withTimezone: true }),
    // The options array, modelled rather than left buried in `raw`. Every stage,
    // amount and approval this app reports on is derived from it, and the reporting
    // pivots we are absorbing group and filter on it directly — digging through
    // `raw->'options'` for that is both slower and easy to get subtly wrong.
    options: jsonb("options"),
    // HCP's `lead_source`, stored verbatim and **NOT usable as attribution**. Never
    // let this populate `source_id` or reach an ROI surface.
    //
    // It records how the record was TYPED INTO HCP, not where the customer came
    // from: the dominant values are "Online Booking" and "Website", so someone who
    // clicks a Google ad, lands on the site and books online is filed as "Online
    // Booking" — which says nothing about Google. Confirmed inaccurate by Justin
    // 2026-08-14, and the data agrees three ways: the vocabulary CHANGED over time
    // (2024 estimates use Online Booking / Google / Referral; 2026 use Website /
    // Facebook / Online Booking, so a time series shows Google vanishing purely from
    // relabelling), coverage swings from ~60% recently to ~22% in 2024, and
    // `customer.lead_source` is a second, mostly-null field carrying different values
    // again ("HMI").
    //
    // Kept because it costs nothing and its absence is a trap: without it the next
    // person finds `lead_source` in the HCP payload and wires it up. A wrong source is
    // worse than no source — it bills spend to a channel that did not earn it, while
    // looking like data. The honest answer for an unattributable estimate is the
    // `unattributed` bucket.
    leadSourceRaw: text("lead_source_raw"),
    // Flattened line items across every option. NULL until the P5 hydration job
    // exists — HCP's /estimates LIST payload carries options but NOT their line
    // items, so filling this costs one API call per option (~23k calls for the
    // account) and cannot ride along with the estimate sync. The `service_type`
    // classifier and the discount maths both depend on it, so the column lands now
    // to keep that a backfill rather than a second migration.
    lineItems: jsonb("line_items"),
    // HCP's own updated_at — lets attribution re-derive leads whose estimate
    // changed long after creation (late approval, cancellation, price edit).
    updatedAtHcp: timestamp("updated_at_hcp", { withTimezone: true }),
    /** When the cold-zone crawl last saw this row — see hcpCustomers.crawlSeenAt. */
    crawlSeenAt: timestamp("crawl_seen_at", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_estimates_hcp_id_uq").on(t.hcpEstimateId),
    index("hcp_estimates_crawl_seen_idx").on(t.crawlSeenAt),
    index("hcp_estimates_customer_idx").on(t.hcpCustomerId),
    index("hcp_estimates_won_idx").on(t.won),
    index("hcp_estimates_phone_idx").on(t.customerPhoneE164),
    index("hcp_estimates_email_idx").on(t.customerEmailLc),
    // The hourly attribution scan filters on these; without indexes it becomes a
    // full-table scan as estimates accumulate.
    index("hcp_estimates_created_hcp_idx").on(t.createdAtHcp),
    index("hcp_estimates_updated_hcp_idx").on(t.updatedAtHcp),
    // GIN: the job → estimate join asks "which estimate has an option with THIS id"
    // (`options @> [{"id": …}]`). A job's `original_estimate_uuids` are option ids,
    // so this is the only path from billed work back to the attributed opportunity.
    // Without the index it is a sequential scan of the whole estimate history per
    // job row.
    index("hcp_estimates_options_idx").using("gin", t.options),
  ],
);

// HCP invoices — what was actually BILLED, as distinct from what was sold.
//
// Deliberately NOT a revenue source for ROI. `roi_daily` is anchored on the won
// estimate (approved-option amount) and stays that way: an estimate is approved the
// moment the customer says yes, which is when the marketing that produced them did
// its job, while an invoice is written days or weeks later and paid later still.
// Re-anchoring ROI on invoices would move every historical figure and lag the
// channel that earned it. These rows exist so "booked vs billed vs collected" is
// answerable at all — a second lens, not a replacement. See docs/estimate-anchored-model.md.
//
// One job can carry SEVERAL invoices (progress billing, a second visit), which is
// why this is its own table rather than columns on `hcp_jobs`; the per-job rollup
// lives on `hcp_jobs.invoice_*` and is derived from here.
export const hcpInvoices = pgTable(
  "hcp_invoices",
  {
    id: id(),
    hcpInvoiceId: text("hcp_invoice_id").notNull(),
    /** Human-facing number, e.g. "10036008". NOT unique — HCP suffixes re-issues
     *  ("10035706-1"), and the arbor-general books notes record that trap. */
    invoiceNumber: text("invoice_number"),
    /** Our `hcp_jobs.id`. Null until the job itself has been synced. */
    hcpJobId: text("hcp_job_id").references(() => hcpJobs.id),
    /**
     * HCP's OWN job id (`job_…`), kept alongside the resolved FK.
     *
     * The invoice payload carries `job_id` and nothing else — no customer, no
     * address — so this is the only link the API hands us. Storing it raw means an
     * invoice whose job has not been crawled yet still lands, and is re-linked by
     * the self-heal pass on a later run, instead of being dropped or blocking the
     * insert.
     */
    hcpJobIdHcp: text("hcp_job_id_hcp"),
    /** Resolved through the job — invoices carry no customer of their own. */
    hcpCustomerId: text("hcp_customer_id").references(() => hcpCustomers.id),
    /** open | pending_payment | paid | voided | uncollectible | canceled. Text, not
     *  an enum: HCP owns this vocabulary and a new value must not fail the sync. */
    status: text("status"),
    amountCents: integer("amount_cents").default(0),
    subtotalCents: integer("subtotal_cents").default(0),
    dueAmountCents: integer("due_amount_cents").default(0),
    /** Sum of `payments[]` with status `succeeded` — what was actually collected. */
    paidAmountCents: integer("paid_amount_cents").default(0),
    refundedAmountCents: integer("refunded_amount_cents").default(0),
    taxAmountCents: integer("tax_amount_cents").default(0),
    discountAmountCents: integer("discount_amount_cents").default(0),
    /**
     * Distinct `payments[].payment_method` values.
     *
     * Worth a column of its own because payment method is how the QuickBooks side
     * finds trouble: HCP's payout sync silently skips payouts containing Klarna
     * (`bnpl`) or mobile-check-deposit lines, and `bnpl` is not even in HCP's
     * documented filter enum — so scanning this array is the way to find them.
     */
    paymentMethods: text("payment_methods").array(),
    /** HCP's `invoice_date` — the billing date, and what a money window should run
     *  on. Note the API exposes no `created_at`/`updated_at` on invoices at all. */
    /** HCP's payment-terms fields: `due_concept` is the code ("upon"),
     *  `display_due_concept` the rendered phrase ("upon receipt"). */
    dueConcept: text("due_concept"),
    displayDueConcept: text("display_due_concept"),
    invoiceDate: timestamp("invoice_date", { withTimezone: true }),
    serviceDate: timestamp("service_date", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    items: jsonb("items"),
    taxes: jsonb("taxes"),
    discounts: jsonb("discounts"),
    payments: jsonb("payments"),
    refunds: jsonb("refunds"),
    /** When the cold-zone crawl last saw this row — see hcpCustomers.crawlSeenAt. */
    crawlSeenAt: timestamp("crawl_seen_at", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_invoices_hcp_id_uq").on(t.hcpInvoiceId),
    index("hcp_invoices_crawl_seen_idx").on(t.crawlSeenAt),
    index("hcp_invoices_job_idx").on(t.hcpJobId),
    // The self-heal pass filters on this, and it is how an invoice finds its job.
    index("hcp_invoices_job_hcp_idx").on(t.hcpJobIdHcp),
    index("hcp_invoices_customer_idx").on(t.hcpCustomerId),
    index("hcp_invoices_status_idx").on(t.status),
    index("hcp_invoices_invoice_date_idx").on(t.invoiceDate),
    index("hcp_invoices_paid_at_idx").on(t.paidAt),
    index("hcp_invoices_number_idx").on(t.invoiceNumber),
  ],
);

// ── Leads (unified) ──────────────────────────────────────────────────────────
/**
 * A person. The inbox threads on this, not on a phone number, which is what lets
 * "Sarah filled in the form on Monday" and "Sarah called on Thursday" be the same
 * conversation instead of two strangers.
 *
 * A contact is never authoritative business data — HousecallPro owns the customer
 * record. This is only an identity spine for grouping inbound activity.
 */
export const contacts = pgTable("contacts", {
  id: id(),
  displayName: text("display_name"),
  /**
   * The HousecallPro customer this person turned out to be, matched on phone or
   * email. A LINK, not a copy: HCP owns the customer record, so their name,
   * address and history are read through this rather than duplicated here. Null
   * simply means "not a customer yet" — which is most of the inbox.
   */
  hcpCustomerId: text("hcp_customer_id").references(() => hcpCustomers.id),
  // Best-known primaries, for display and for picking a reply target.
  primaryPhone: text("primary_phone"),
  primaryEmail: text("primary_email"),
  /**
   * Set when the person replies STOP (or Twilio reports carrier opt-out, error
   * 21610). Blocks app-originated sends — the block is legally required and lives
   * on the person, not the thread, so it survives them starting a new one.
   */
  smsOptedOutAt: timestamp("sms_opted_out_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("contacts_hcp_customer_idx").on(t.hcpCustomerId)]);

/**
 * Every phone/email known to belong to a contact — the index identity resolution
 * runs on. One value maps to exactly one contact (unique on kind+value), so a form
 * carrying both a phone and an email is what stitches those two identities together.
 */
export const contactIdentifiers = pgTable(
  "contact_identifiers",
  {
    id: id(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    kind: contactIdentifierKindEnum("kind").notNull(),
    value: text("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contact_identifiers_kind_value_uq").on(t.kind, t.value),
    index("contact_identifiers_contact_idx").on(t.contactId),
  ],
);

/**
 * A conversation thread — the spine of the inbox. ONE per contact, holding every
 * way that person has ever reached us: calls, texts, form submissions, Facebook
 * lead forms, later email. Each of those tables carries a `conversation_id` and the
 * thread view unions them into a single timeline.
 *
 * One-per-contact is deliberate. A returning customer who calls in March and again
 * in September is one relationship with two leads, not two conversations — which is
 * exactly what "capture every way customers reach out, even if they aren't a new
 * lead" needs. Lead-level attribution stays on `leads`; the snapshot here is
 * first-touch, for showing where the relationship started.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id),
    state: conversationStateEnum("state").notNull().default("open"),
    // First-touch snapshot — where this relationship came from.
    sourceId: text("source_id").references(() => sources.id),
    trackingNumberId: text("tracking_number_id").references(() => trackingNumbers.id),
    numberAssignmentId: text("number_assignment_id").references(() => numberAssignments.id),
    /**
     * Arbor-side endpoint of the most recent inbound activity — the tracking number
     * to reply FROM, so the customer sees the number they already contacted rather
     * than a stranger's.
     */
    lastEndpointKey: text("last_endpoint_key"),
    subject: text("subject"), // email threads only
    /**
     * Every channel this thread has ever carried. Denormalized so the inbox's
     * channel tabs are one indexed predicate instead of an EXISTS across four
     * activity tables — and so "Texts" means "threads with texts in them", not
     * "threads whose newest message happens to be a text".
     */
    channels: text("channels").array().notNull().default([]),
    // Denormalized "last activity" so the inbox list needs no per-thread subquery.
    lastChannel: text("last_channel"), // 'call' | 'sms' | 'email' | 'form' | 'facebook'
    lastDirection: text("last_direction"), // 'inbound' | 'outbound'
    lastPreview: text("last_preview"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    // Inbound activity nobody has opened yet. Bumped on inbound, zeroed on read.
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_contact_uq").on(t.contactId),
    index("conversations_last_activity_idx").on(t.lastActivityAt),
    index("conversations_state_idx").on(t.state),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: id(),
    type: leadTypeEnum("type").notNull(),
    // The thread this lead came out of. Many leads over time can share one thread.
    conversationId: text("conversation_id").references(() => conversations.id),
    contactId: text("contact_id").references(() => contacts.id),
    status: leadStatusEnum("status").notNull().default("new"),
    // Contact
    name: text("name"),
    phoneE164: text("phone_e164"),
    emailLc: text("email_lc"),
    message: text("message"),
    // Last-touch attribution (denormalized for fast dashboard filtering)
    sourceId: text("source_id").references(() => sources.id),
    medium: text("medium"),
    campaignId: text("campaign_id").references(() => campaigns.id),
    keyword: text("keyword"),
    gclid: text("gclid"),
    // iOS/Safari Google clicks return gbraid/wbraid instead of a gclid — carried
    // through so offline conversion upload can match those clicks too.
    gbraid: text("gbraid"),
    wbraid: text("wbraid"),
    fbclid: text("fbclid"),
    landingPage: text("landing_page"),
    referrer: text("referrer"),
    location: locationEnum("location").default("unknown"),
    // Linkage
    visitorId: text("visitor_id").references(() => visitors.id),
    webSessionId: text("web_session_id").references(() => webSessions.id),
    hcpCustomerId: text("hcp_customer_id").references(() => hcpCustomers.id),
    hcpJobId: text("hcp_job_id").references(() => hcpJobs.id),
    hcpEstimateId: text("hcp_estimate_id").references(() => hcpEstimates.id),
    // Value: quote = estimate total; sales = the WON (approved) estimate amount.
    quoteValueCents: integer("quote_value_cents"),
    salesValueCents: integer("sales_value_cents"),
    // Flags
    isSpam: boolean("is_spam").notNull().default(false),
    // Is this an actual lead? Forms/FB are inherently true; for calls it's set from
    // the transcript (AI or keyword: did the caller request an estimate?). null =
    // not yet classified. The Leads inbox shows only leads (or non-call types).
    isLead: boolean("is_lead"),
    leadReason: text("lead_reason"), // short why (AI/keyword/manual) for the is_lead call
    // Caller's self-reported source ("how did you hear about us"), extracted from the
    // call transcript — shown alongside the DNI-attributed source as a cross-check.
    selfReportedSource: text("self_reported_source"),
    isLeadManual: boolean("is_lead_manual").notNull().default(false), // human override — auto-classify won't touch it
    isFirstTime: boolean("is_first_time"),
    // The upstream platform's own id for this lead (LSA lead id, …) — the real
    // idempotency key for synced lead types that have one.
    externalId: text("external_id"),
    isDuplicate: boolean("is_duplicate").notNull().default(false),
    duplicateOfLeadId: text("duplicate_of_lead_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("leads_occurred_idx").on(t.occurredAt),
    index("leads_phone_idx").on(t.phoneE164),
    index("leads_email_idx").on(t.emailLc),
    index("leads_source_idx").on(t.sourceId),
    index("leads_status_idx").on(t.status),
    index("leads_hcp_estimate_idx").on(t.hcpEstimateId),
    // Every ROI surface filters through `campaignNotExcluded(leads.campaignId, …)`.
    index("leads_campaign_idx").on(t.campaignId),
    uniqueIndex("leads_type_external_id_uq")
      .on(t.type, t.externalId)
      .where(sql`external_id IS NOT NULL`),
  ],
);

export const calls = pgTable(
  "calls",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    twilioCallSid: text("twilio_call_sid").notNull(),
    trackingNumberId: text("tracking_number_id").references(() => trackingNumbers.id),
    numberAssignmentId: text("number_assignment_id").references(() => numberAssignments.id),
    fromNumber: text("from_number"),
    toDestination: text("to_destination"),
    direction: text("direction").default("inbound"),
    answered: boolean("answered"),
    durationSec: integer("duration_sec"),
    status: text("status"),
    recordingUrl: text("recording_url"),
    recordingSid: text("recording_sid"),
    recordingDurationSec: integer("recording_duration_sec"),
    transcript: text("transcript"),
    // Poison-pill guard for the transcription backlog: failed attempts count up
    // and the sync skips calls past its retry cap instead of retrying forever.
    transcribeAttempts: integer("transcribe_attempts").notNull().default(0),
    transcribeError: text("transcribe_error"),
    transcriptProvider: text("transcript_provider"),
    transcriptConfidence: numeric("transcript_confidence", { precision: 4, scale: 3 }),
    intentLabel: text("intent_label"),
    // AI one-liner of what the call was about, and the caller's own answer to
    // "how did you hear about us" (verbatim-ish) — DNI-invisible channels like
    // referrals/yard signs/truck wraps only ever surface here.
    summary: text("summary"),
    selfReportedSource: text("self_reported_source"),
    spamScore: numeric("spam_score", { precision: 4, scale: 3 }),
    voicemail: boolean("voicemail").default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calls_twilio_sid_uq").on(t.twilioCallSid),
    index("calls_lead_idx").on(t.leadId),
    index("calls_from_idx").on(t.fromNumber),
    index("calls_tracking_number_idx").on(t.trackingNumberId),
    // /calls orders by created_at desc — without this it is a seq scan + sort.
    index("calls_created_at_idx").on(t.createdAt),
    index("calls_conversation_idx").on(t.conversationId),
  ],
);

/**
 * A single text or email in a thread. Deliberately channel-agnostic: `body` is the
 * text, `subject` is email-only, `media` holds Twilio MediaUrl* / email attachments.
 * Adding a channel means a new enum value and an ingest route — not a new table.
 *
 * `external_id` is the provider's own id (Twilio MessageSid, RFC-822 Message-ID) and
 * is the idempotency key: webhooks retry, and mail sync re-reads overlapping windows.
 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    leadId: text("lead_id").references(() => leads.id),
    channel: messageChannelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    body: text("body"),
    media: jsonb("media"),
    externalId: text("external_id"),
    status: text("status"), // provider delivery status (queued/sent/delivered/failed)
    errorCode: text("error_code"),
    numSegments: integer("num_segments"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("messages_channel_external_uq")
      .on(t.channel, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("messages_conversation_idx").on(t.conversationId, t.occurredAt),
    index("messages_lead_idx").on(t.leadId),
    index("messages_occurred_idx").on(t.occurredAt),
  ],
);

export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    webSessionId: text("web_session_id").references(() => webSessions.id),
    formId: text("form_id"),
    pageUrl: text("page_url"),
    fields: jsonb("fields"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("form_submissions_lead_idx").on(t.leadId),
    index("form_submissions_conversation_idx").on(t.conversationId),
  ],
);

export const facebookLeads = pgTable(
  "facebook_leads",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    conversationId: text("conversation_id").references(() => conversations.id),
    fbLeadgenId: text("fb_leadgen_id").notNull(),
    fbFormId: text("fb_form_id"),
    fbAdId: text("fb_ad_id"),
    fbCampaignId: text("fb_campaign_id"),
    fields: jsonb("fields"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("facebook_leads_leadgen_id_uq").on(t.fbLeadgenId),
    index("facebook_leads_conversation_idx").on(t.conversationId),
  ],
);

// ── Attribution & rollups ────────────────────────────────────────────────────
export const attributions = pgTable(
  "attributions",
  {
    id: id(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id),
    touchType: touchTypeEnum("touch_type").notNull(),
    sourceId: text("source_id").references(() => sources.id),
    campaignId: text("campaign_id").references(() => campaigns.id),
    gclid: text("gclid"),
    fbclid: text("fbclid"),
    keyword: text("keyword"),
    landingPage: text("landing_page"),
    weight: numeric("weight", { precision: 5, scale: 4 }).default("1"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // touch_type is indexed because every attribution rebuild issues a
  // `DELETE WHERE touch_type = 'last'` over the whole table.
  (t) => [index("attributions_lead_idx").on(t.leadId), index("attributions_touch_type_idx").on(t.touchType)],
);

export const roiDaily = pgTable(
  "roi_daily",
  {
    id: id(),
    date: date("date").notNull(),
    // Which attribution model this row is computed under. BOTH are written on every
    // rebuild — 'last' credits the contact immediately before the estimate, 'first'
    // credits the contact that originally acquired that customer — so switching
    // models is a filter, not a re-derivation, and the two can be compared directly.
    //
    // Every read MUST filter on this. Summing across models double-counts everything,
    // including spend, which is written identically to both (the money spent does not
    // change with the model; only who gets credit for what it produced does).
    touchType: touchTypeEnum("touch_type").notNull().default("last"),
    sourceId: text("source_id").references(() => sources.id),
    campaignId: text("campaign_id").references(() => campaigns.id),
    location: locationEnum("location").default("unknown"),
    // DEMAND — inbound contacts, bucketed on the day they contacted us. Non-spam
    // only: `is_lead` no longer gates anything here (an unclassified call from a
    // real person is still demand), which is what stops the three rival "what is a
    // lead" predicates from ever disagreeing again.
    contactsCount: integer("contacts_count").notNull().default(0),
    // OPPORTUNITY — countable HCP estimates (see lib/estimates/countable.ts).
    // Bucketed on the CONTACT's date when we can attribute one, so estimates line
    // up with the spend that produced them; on the estimate's own appointment date
    // when we cannot, where there is no spend to line up with anyway.
    estimatesCount: integer("estimates_count").notNull().default(0),
    callsCount: integer("calls_count").notNull().default(0),
    formsCount: integer("forms_count").notNull().default(0),
    wonCount: integer("won_count").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    quoteValueCents: integer("quote_value_cents").notNull().default(0),
    // Spend ÷ ESTIMATES, not ÷ contacts. Renamed rather than redefined in place:
    // the old `cost_per_lead_cents` divided by a looser, larger contact count, so
    // keeping the name would have left every historical reader silently comparing
    // two different metrics.
    costPerEstimateCents: integer("cost_per_estimate_cents"),
    costPerAcquisitionCents: integer("cost_per_acquisition_cents"),
    roiRatio: numeric("roi_ratio", { precision: 12, scale: 4 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT (PG15+) is load-bearing, not a detail: source_id and
    // campaign_id are nullable and unattributed rows (no source, no campaign) are
    // the common case. Under the default NULLS DISTINCT, Postgres treats every
    // such row as unique, so the constraint silently does NOT fire for exactly the
    // rows most likely to be duplicated — and every dashboard SUM() over
    // roi_daily double-counts that day.
    // Declared as a table constraint rather than uniqueIndex because only the
    // constraint builder exposes NULLS NOT DISTINCT (it creates a unique index
    // underneath either way). The rebuild is delete-then-insert, so nothing
    // targets this in an ON CONFLICT clause.
    unique("roi_daily_key_uq").on(t.date, t.touchType, t.sourceId, t.campaignId, t.location).nullsNotDistinct(),
    index("roi_daily_date_idx").on(t.date),
  ],
);

// ── Auth & ops ───────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("admin"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const authSessions = pgTable("auth_sessions", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const spamRules = pgTable("spam_rules", {
  id: id(),
  field: text("field").notNull(), // from_number | transcript | name | email
  pattern: text("pattern").notNull(),
  action: text("action").notNull().default("flag"), // flag | reject
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * What `/api/dni/assign` actually did, counted per business day.
 *
 * The endpoint has eight different ways to end and recorded none of them, so the
 * one question that matters about DNI — "what share of visitors actually got a
 * tracking number, and why not?" — could not be asked at all. It cannot be
 * reconstructed from `number_assignments` either: `findShareableLease` hands a
 * second visitor an EXISTING lease without writing a row, so a shared visitor and
 * a refused one look identical after the fact. Only the endpoint knows, and only
 * at the moment it decides.
 *
 * COUNTS, not rows-per-visit, and written through the buffer in
 * `lib/dni/outcomes.ts`. This endpoint is public and unauthenticated: a row per
 * request would let a stranger drive our write volume, and the refusal paths
 * (bot, bad origin) sit in front of the rate limiter, so they are the least
 * bounded of all. Buffering makes writes scale with elapsed time rather than with
 * traffic, and a day-grain counter is all a rate needs.
 *
 * `outcome` is deliberately free text rather than an enum: it is diagnostic, and a
 * new branch in the endpoint should be able to start counting itself without a
 * migration. See `AssignOutcome` for the live vocabulary.
 */
export const dniOutcomes = pgTable(
  "dni_outcomes",
  {
    id: id(),
    // businessDate() — America/Chicago, like every other daily bucket in this
    // schema. A UTC bucket here would split a Central evening across two rows.
    date: date("date").notNull(),
    outcome: text("outcome").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [unique("dni_outcomes_date_outcome_uq").on(t.date, t.outcome)],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    job: text("job").notNull(), // spend.sync.daily | hcp.sync.jobs | attribution.run | ...
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stats: jsonb("stats"),
    error: text("error"),
  },
  (t) => [
    index("sync_runs_job_idx").on(t.job, t.startedAt),
    // At most one in-flight run per job, enforced by the database rather than by
    // the scheduler. The cron worker's `protect` flag only serializes its own
    // fetch — on a timeout the web-side handler keeps running while the next tick
    // fires, so a job can genuinely overlap itself. That interleaves the
    // attribution rebuild's reset/re-derive passes (corrupting ROI until the next
    // clean run) and doubles Deepgram spend on transcribe. `withSyncRun` claims
    // this index and skips the run when the claim is already held.
    uniqueIndex("sync_runs_one_running_uq")
      .on(t.job)
      .where(sql`${t.status} = 'running'`),
  ],
);

// ── Conversion exports (closed-loop feedback to ad platforms) ─────────────────
// One row per (lead, platform, event) we send back to Google Ads (offline click
// conversion) / Meta (Conversions API). The unique key is the idempotency guard:
// a row only ever advances to 'sent' once, so a retry never double-counts a
// conversion in the ad account. `identifier` is the gclid/fbclid we matched on.
export const conversionExportStatusEnum = pgEnum("conversion_export_status", [
  "pending",
  "sent",
  "error",
  "skipped",
]);

export const conversionExports = pgTable(
  "conversion_exports",
  {
    id: id(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id),
    platform: text("platform").notNull(), // 'google' | 'facebook'
    event: text("event").notNull(), // 'qualified' | 'won'
    status: conversionExportStatusEnum("status").notNull().default("pending"),
    valueCents: integer("value_cents"),
    currency: text("currency").notNull().default("USD"),
    identifier: text("identifier"), // the click id / lead id used to match
    identifierType: text("identifier_type"), // 'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'leadgen_id'
    attempts: integer("attempts").notNull().default(0),
    response: jsonb("response"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversion_exports_lead_platform_event_uq").on(t.leadId, t.platform, t.event),
    index("conversion_exports_status_idx").on(t.status),
  ],
);

// ── Settings (singleton key/value) ───────────────────────────────────────────
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

// ── MCP OAuth grants (authorization codes + refresh tokens) ──────────────────
// Storage for the OAuth 2.1 flow in front of /api/mcp (see lib/mcp-oauth.ts).
// Only the stateful halves live here: single-use authorization CODES and
// rotating REFRESH tokens. Access tokens are stateless HMAC (nothing to store).
// Secrets are stored as sha256 hashes — a database read never yields a usable
// credential.
export const mcpOauthGrants = pgTable(
  "mcp_oauth_grants",
  {
    id: id(),
    kind: text("kind").notNull(), // 'code' | 'refresh'
    secretHash: text("secret_hash").notNull(),
    clientId: text("client_id").notNull(),
    // Codes only: the exact redirect_uri and PKCE challenge the code is bound to.
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set when a code is exchanged or a refresh token is rotated — presenting a
    // consumed grant again is invalid_grant, never a second issuance.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_oauth_grants_secret_hash_uq").on(t.secretHash)],
);

// ── Integration credentials (envelope-encrypted; tenant_id reserved for MT) ───
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().default("default"),
    platform: text("platform").notNull(), // housecallpro | google_ads | facebook | deepgram
    key: text("key").notNull(), // api_key | refresh_token | ...
    valueEncrypted: text("value_encrypted").notNull(), // base64(iv|tag|ciphertext)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integration_credentials_uq").on(t.tenantId, t.platform, t.key)],
);

// ── Relations ────────────────────────────────────────────────────────────────
export const visitorsRelations = relations(visitors, ({ many }) => ({
  sessions: many(webSessions),
  leads: many(leads),
}));

export const webSessionsRelations = relations(webSessions, ({ one, many }) => ({
  visitor: one(visitors, { fields: [webSessions.visitorId], references: [visitors.id] }),
  derivedSource: one(sources, {
    fields: [webSessions.derivedSourceId],
    references: [sources.id],
  }),
  assignments: many(numberAssignments),
  leads: many(leads),
}));

export const trackingNumbersRelations = relations(trackingNumbers, ({ one, many }) => ({
  staticSource: one(sources, {
    fields: [trackingNumbers.staticSourceId],
    references: [sources.id],
  }),
  assignments: many(numberAssignments),
}));

export const numberAssignmentsRelations = relations(numberAssignments, ({ one }) => ({
  trackingNumber: one(trackingNumbers, {
    fields: [numberAssignments.trackingNumberId],
    references: [trackingNumbers.id],
  }),
  webSession: one(webSessions, {
    fields: [numberAssignments.webSessionId],
    references: [webSessions.id],
  }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  conversation: one(conversations, { fields: [leads.conversationId], references: [conversations.id] }),
  contact: one(contacts, { fields: [leads.contactId], references: [contacts.id] }),
  source: one(sources, { fields: [leads.sourceId], references: [sources.id] }),
  campaign: one(campaigns, { fields: [leads.campaignId], references: [campaigns.id] }),
  visitor: one(visitors, { fields: [leads.visitorId], references: [visitors.id] }),
  hcpJob: one(hcpJobs, { fields: [leads.hcpJobId], references: [hcpJobs.id] }),
  call: one(calls, { fields: [leads.id], references: [calls.leadId] }),
  formSubmission: one(formSubmissions, {
    fields: [leads.id],
    references: [formSubmissions.leadId],
  }),
  attributions: many(attributions),
}));

export const callsRelations = relations(calls, ({ one }) => ({
  lead: one(leads, { fields: [calls.leadId], references: [leads.id] }),
  conversation: one(conversations, {
    fields: [calls.conversationId],
    references: [conversations.id],
  }),
  trackingNumber: one(trackingNumbers, {
    fields: [calls.trackingNumberId],
    references: [trackingNumbers.id],
  }),
}));

export const contactsRelations = relations(contacts, ({ many }) => ({
  identifiers: many(contactIdentifiers),
  conversations: many(conversations),
  leads: many(leads),
}));

export const contactIdentifiersRelations = relations(contactIdentifiers, ({ one }) => ({
  contact: one(contacts, { fields: [contactIdentifiers.contactId], references: [contacts.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  source: one(sources, { fields: [conversations.sourceId], references: [sources.id] }),
  trackingNumber: one(trackingNumbers, {
    fields: [conversations.trackingNumberId],
    references: [trackingNumbers.id],
  }),
  messages: many(messages),
  calls: many(calls),
  formSubmissions: many(formSubmissions),
  facebookLeads: many(facebookLeads),
  leads: many(leads),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  lead: one(leads, { fields: [messages.leadId], references: [leads.id] }),
}));

export const hcpJobsRelations = relations(hcpJobs, ({ one, many }) => ({
  customer: one(hcpCustomers, {
    fields: [hcpJobs.hcpCustomerId],
    references: [hcpCustomers.id],
  }),
  invoices: many(hcpInvoices),
}));

export const hcpInvoicesRelations = relations(hcpInvoices, ({ one }) => ({
  job: one(hcpJobs, {
    fields: [hcpInvoices.hcpJobId],
    references: [hcpJobs.id],
  }),
  customer: one(hcpCustomers, {
    fields: [hcpInvoices.hcpCustomerId],
    references: [hcpCustomers.id],
  }),
}));
