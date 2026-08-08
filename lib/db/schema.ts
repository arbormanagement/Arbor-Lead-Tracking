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
]);
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
    // Fast "who currently holds this number" — only one active lease per number.
    index("number_assignments_active_idx")
      .on(t.trackingNumberId)
      .where(sql`released_at IS NULL`),
    index("number_assignments_session_idx").on(t.webSessionId),
    // The expired-lease reaper scans `released_at IS NULL AND expires_at <= now()`
    // on every assign request.
    index("number_assignments_expiry_idx")
      .on(t.expiresAt)
      .where(sql`released_at IS NULL`),
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
    phoneE164: text("phone_e164"), // normalized for matching
    addresses: jsonb("addresses"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_customers_hcp_id_uq").on(t.hcpCustomerId),
    index("hcp_customers_phone_idx").on(t.phoneE164),
    index("hcp_customers_email_idx").on(t.emailLc),
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
    outstandingBalanceCents: integer("outstanding_balance_cents").default(0),
    invoiceTotalCents: integer("invoice_total_cents").default(0),
    address: jsonb("address"),
    location: locationEnum("location").default("unknown"),
    createdAtHcp: timestamp("created_at_hcp", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_jobs_hcp_id_uq").on(t.hcpJobId),
    index("hcp_jobs_customer_idx").on(t.hcpCustomerId),
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
    approvedAtHcp: timestamp("approved_at_hcp", { withTimezone: true }),
    // HCP's own updated_at — lets attribution re-derive leads whose estimate
    // changed long after creation (late approval, cancellation, price edit).
    updatedAtHcp: timestamp("updated_at_hcp", { withTimezone: true }),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("hcp_estimates_hcp_id_uq").on(t.hcpEstimateId),
    index("hcp_estimates_customer_idx").on(t.hcpCustomerId),
    index("hcp_estimates_won_idx").on(t.won),
    index("hcp_estimates_phone_idx").on(t.customerPhoneE164),
    index("hcp_estimates_email_idx").on(t.customerEmailLc),
    // The hourly attribution scan filters on these; without indexes it becomes a
    // full-table scan as estimates accumulate.
    index("hcp_estimates_created_hcp_idx").on(t.createdAtHcp),
    index("hcp_estimates_updated_hcp_idx").on(t.updatedAtHcp),
  ],
);

// ── Leads (unified) ──────────────────────────────────────────────────────────
export const leads = pgTable(
  "leads",
  {
    id: id(),
    type: leadTypeEnum("type").notNull(),
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
  ],
);

export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    webSessionId: text("web_session_id").references(() => webSessions.id),
    formId: text("form_id"),
    pageUrl: text("page_url"),
    fields: jsonb("fields"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("form_submissions_lead_idx").on(t.leadId)],
);

export const facebookLeads = pgTable(
  "facebook_leads",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    fbLeadgenId: text("fb_leadgen_id").notNull(),
    fbFormId: text("fb_form_id"),
    fbAdId: text("fb_ad_id"),
    fbCampaignId: text("fb_campaign_id"),
    fields: jsonb("fields"),
    createdTime: timestamp("created_time", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("facebook_leads_leadgen_id_uq").on(t.fbLeadgenId)],
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
  (t) => [index("attributions_lead_idx").on(t.leadId)],
);

export const roiDaily = pgTable(
  "roi_daily",
  {
    id: id(),
    date: date("date").notNull(),
    sourceId: text("source_id").references(() => sources.id),
    campaignId: text("campaign_id").references(() => campaigns.id),
    location: locationEnum("location").default("unknown"),
    leadsCount: integer("leads_count").notNull().default(0),
    qualifiedCount: integer("qualified_count").notNull().default(0),
    callsCount: integer("calls_count").notNull().default(0),
    formsCount: integer("forms_count").notNull().default(0),
    wonCount: integer("won_count").notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    quoteValueCents: integer("quote_value_cents").notNull().default(0),
    costPerLeadCents: integer("cost_per_lead_cents"),
    costPerAcquisitionCents: integer("cost_per_acquisition_cents"),
    roiRatio: numeric("roi_ratio", { precision: 12, scale: 4 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("roi_daily_key_uq").on(t.date, t.sourceId, t.campaignId, t.location),
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
  (t) => [index("sync_runs_job_idx").on(t.job, t.startedAt)],
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
  trackingNumber: one(trackingNumbers, {
    fields: [calls.trackingNumberId],
    references: [trackingNumbers.id],
  }),
}));

export const hcpJobsRelations = relations(hcpJobs, ({ one }) => ({
  customer: one(hcpCustomers, {
    fields: [hcpJobs.hcpCustomerId],
    references: [hcpCustomers.id],
  }),
}));
