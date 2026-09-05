import { createMcpHandler } from "mcp-handler";
import { attributionBreakdown } from "@/lib/diagnostics/attribution";
import { diagnosticsReport } from "@/lib/diagnostics/report";
import { env } from "@/lib/env";
import {
  AttributionHealthInput,
  ClassifyLeadInput,
  SetLeadDispositionInput,
  SetLeadAttributionInput,
  DiagnosticsInput,
  EstimateDetailInput,
  EstimateDetailOutput,
  LineItemsInput,
  LineItemsOutput,
  FunnelOverviewInput,
  FunnelOverviewOutput,
  LandingPagesOutput,
  ListCampaignsOutput,
  ListEstimatesOutput,
  ListLeadsOutput,
  ListThreadsOutput,
  RoiSummaryOutput,
  SpendSummaryOutput,
  GetThreadInput,
  LandingPagesInput,
  ListCampaignsInput,
  ListCustomersInput,
  ListCustomersOutput,
  ListEstimatesInput,
  ListInvoicesInput,
  ListInvoicesOutput,
  ListJobsInput,
  ListJobsOutput,
  ListLeadsInput,
  CleanupLeadsInput,
  CleanupLeadsOutput,
  DeletePoolInput,
  GetSettingsInput,
  GetSettingsOutput,
  ImportNumberInput,
  ImportNumberOutput,
  ListFacebookFormsInput,
  ListFacebookFormsOutput,
  ListManualSpendInput,
  ListManualSpendOutput,
  ListNumbersInput,
  ListPoolsInput,
  ListPoolsOutput,
  ListNumbersOutput,
  ListThreadsInput,
  ReclassifySourcesInput,
  ReplyToThreadInput,
  RoiSummaryInput,
  SetAttributionModelInput,
  SetCampaignExcludedInput,
  SetThreadStateInput,
  SpendSummaryInput,
  TriggerSyncInput,
  ResetConversionExportsInput,
  ResetConversionExportsOutput,
  SetFacebookFormsInput,
  SetManualSpendInput,
  SetRoutingInput,
  SetTrackingOriginsInput,
  TestCredentialsInput,
  TestCredentialsOutput,
  TrackingOriginsOutput,
  UpdateNumberInput,
  UpsertPoolInput,
  UpsertPoolOutput,
  UpdateNumberOutput,
} from "@/lib/api-contracts/tools";
import { selectedTouchModel, setAttributionOptions } from "@/lib/attribution/model";
import { setCampaignExcluded } from "@/lib/campaigns";
import { setLeadClassification, setLeadDisposition } from "@/lib/leads/classify-override";
import { setLeadAttribution } from "@/lib/leads/attribution";
import { listCampaignsWithVolume } from "@/lib/queries/campaigns";
import { listTrackingNumbers } from "@/lib/queries/numbers";
import { createPool, deletePool, listPools, updatePool } from "@/lib/pools";
import { probeCredential } from "@/lib/credentials/probe";
import { runLeadCleanup } from "@/lib/leads/cleanup";
import { facebook } from "@/lib/integrations/facebook";
import { getIncludedFormIds, setIncludedFormIds } from "@/lib/sync/facebook-leads";
import { provisionNumber } from "@/lib/twilio/numbers";
import { deleteManualSpend, listManualSpend, setManualSpend } from "@/lib/spend/manual";
import { getDefaultForwardNumber, getSmsForwardNumber, setRoutingConfig } from "@/lib/routing";
import { setTrackingOrigins, trackingOrigins } from "@/lib/origin";
import { resetFailedExports } from "@/lib/sync/conversions";
import { applyNumberPatch, resolveSourceIdByKey } from "@/lib/twilio/numbers";
import { reclassifyUnmappedSources } from "@/lib/sources/reclassify";
import { SendError, sendThreadSms } from "@/lib/messaging/send";
import { setThreadState } from "@/lib/messaging/thread";
import { runSyncJob } from "@/lib/sync/run-job";
import { getEstimateDetail, listEstimates } from "@/lib/queries/estimates";
import { getLineItems } from "@/lib/queries/line-items";
import { listCustomers, listInvoices, listJobs } from "@/lib/queries/hcp";
import { getThreadDetail, listThreads } from "@/lib/queries/inbox";
import { searchLeads } from "@/lib/queries/leads";
import { overviewData } from "@/lib/queries/overview";
import { campaignPerformance, landingPagePerformance, sourceBreakdowns, sourcePerformance } from "@/lib/queries/sources";
import { verifyAccessToken } from "@/lib/mcp-oauth";
import { spendSummary } from "@/lib/queries/spend";
import { secretEquals } from "@/lib/secret-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The MCP endpoint — the generative-UI read surface (see GENERATIVE-UI.md).
 *
 * Semantic tools over the SAME query layer the dashboard pages render from
 * (lib/queries/*), so a generated dashboard and the old page show the same number
 * by construction. Deliberately NOT a SQL interface: every metric trap this app
 * documents (work_status is never the test for won, business-date bucketing,
 * recruiting-campaign exclusion, `none` as a real filter value) is encoded once,
 * behind these tools, where a generated view cannot re-derive it wrong.
 *
 * Auth: `Authorization: Bearer $MCP_API_TOKEN`. Unset token = endpoint off
 * (fail closed, same shape as ADMIN_API_TOKEN). The middleware already passes
 * Bearer-carrying /api/* requests through to this handler.
 *
 * Eleven read tools plus four Phase 3 write tools, each write mirroring an
 * existing gated route with the enforcement kept server-side (consent inside
 * sendThreadSms, one-run-at-a-time inside withSyncRun).
 *
 * ⚠️ arbor_reply_to_thread means MCP_API_TOKEN can TEXT CUSTOMERS. The reply route
 * itself is deliberately session-only and stays that way; exposing the same
 * action here was a deliberate Phase 3 decision (GENERATIVE-UI.md) so the
 * inbox is operable generatively. Treat the token accordingly: it is not a
 * read-only credential any more, and rotating it is one env change.
 */

/**
 * Tool result: the same payload twice — text JSON for clients that read content,
 * and `structuredContent` for clients that want typed data without re-parsing.
 *
 * The JSON round-trip is load-bearing, not decoration: the query layer returns
 * `Date` objects, and a Date would fail an `outputSchema` expecting an ISO
 * string. Serializing first guarantees what is validated is exactly what a
 * client receives.
 */
const json = (value: unknown) => {
  const payload = JSON.parse(JSON.stringify(value));
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
};

/**
 * A failed call, reported as an error rather than as data. Every message says
 * what to do next: a model that cannot tell "no such row" from "row with no
 * fields" will happily report the absence as a finding.
 */
const fail = (error: string, nextStep: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error, nextStep }) }],
  isError: true as const,
});

/** Long free text (transcripts, bodies) is clipped, with a marker, not dropped. */
const clip = (s: string | null, max = 4000): string | null =>
  s && s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "arbor_funnel_overview",
      {
        title: "Funnel overview",
        description:
          "The business at a glance: contacts → estimates → won funnel, daily spend/revenue series, and top sources by revenue. " +
          "Reads roi_daily (the aggregate of record) under the currently selected attribution model, with recruiting campaigns excluded. " +
          "All money is integer cents; daily dates are America/Chicago business dates.",
        inputSchema: FunnelOverviewInput.shape,
        outputSchema: FunnelOverviewOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days }) => json(await overviewData(days)),
    );

    server.registerTool(
      "arbor_roi_summary",
      {
        title: "ROI by channel, campaign, or location",
        description:
          "Marketing performance from roi_daily: contacts, estimates (countable: scheduled or won, not cancelled), won, spend and revenue in cents. " +
          "grain=channel adds a cancelled column (counted via isCancelledEstimate, the exact complement of countable) and per-source location splits. " +
          "grain=campaign is the floor of money reporting — below it the sample is noise. " +
          "Windows are business-date (America/Chicago); estimates here bucket on the CONTACT date, so counts will not reconcile row-for-row with arbor_list_estimates (which windows on estimate creation). Both are correct for their own question.",
        inputSchema: RoiSummaryInput.shape,
        outputSchema: RoiSummaryOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, grain }) => {
        const touch = await selectedTouchModel();
        if (grain === "campaign") {
          const { rows } = await campaignPerformance(days, touch);
          return json({ touch, grain, rows });
        }
        if (grain === "location") {
          const { byLocation } = await campaignPerformance(days, touch);
          return json({ touch, grain, rows: byLocation });
        }
        const [{ rows, locationRows }, breakdowns] = await Promise.all([
          sourcePerformance(days, touch),
          sourceBreakdowns(days),
        ]);
        return json({ touch, grain, rows, locationRows, breakdowns });
      },
    );

    server.registerTool(
      "arbor_list_estimates",
      {
        title: "List estimates",
        description:
          "The opportunity list — every live estimate (not cancelled, not deleted), windowed on when it was WRITTEN unless `dateField` says otherwise, with its full attribution chain " +
          "(source → campaign → landing page → keyword → what the caller said). Filters accept `none` to mean unattributed — asking for the untracked ones directly is the point. " +
          "The returned agg is computed over the whole filtered window, not just the returned rows. Close rate = won ÷ agg.countable (scheduled or won), NEVER ÷ agg.total — " +
          "dividing by the listed total is the 25%-vs-48% close-rate error this app exists to prevent. `outcome` is decided by customer option APPROVAL, never by HCP's work_status. " +
          "⚠️ `dateField: \"scheduled\"` windows on the booked estimate VISIT and therefore drops every estimate nobody has scheduled — about a third of the book, including the whole " +
          "unscheduled backlog. It answers 'whose visit falls in this period' and reaches forward for upcoming ones; it is the wrong window for volume, attribution or close rate. " +
          "The agg follows whichever window ran, so its totals always match the rows returned.",
        inputSchema: ListEstimatesInput.shape,
        outputSchema: ListEstimatesOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, start, end, dateField, limit, offset, ...filters }) =>
        json(await listEstimates({ days, start, end, dateField, filters, limit, offset })),
    );

    server.registerTool(
      "arbor_estimate_detail",
      {
        title: "Estimate detail",
        description:
          "One estimate with its customer (read through the HousecallPro link — this app stores no customer data), its attribution chain, " +
          "and the tracked contact behind it (leadId + conversationId to follow into arbor_get_thread). Null attribution fields mean no tracked contact matched: repeat business, a referral, or an estimate written in the field.",
        inputSchema: EstimateDetailInput.shape,
        outputSchema: EstimateDetailOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const detail = await getEstimateDetail(id);
        if (!detail) {
          return fail(
            `No estimate with id '${id}'.`,
            "Ids come from arbor_list_estimates (the `id` field), not from HousecallPro's own estimate number. If you have a customer name or phone instead, find the estimate with arbor_list_estimates and read its id.",
          );
        }
        return json(detail);
      },
    );

    server.registerTool(
      "arbor_line_items",
      {
        title: "Line items on one estimate or job",
        description:
          "The individual priced lines of ONE record — what is actually on it, which on a tree job is the list of trees and what each was priced at. " +
          "Every other line-item field is a rollup (a count, a sum, a joined list of names); this is the only place the lines themselves are readable. " +
          "⚠️ READ `amountCents`, NOT `unitPriceRaw`. A 'percent discount' line stores BASIS POINTS in unit_price — 1000 means 10%, not $10.00 — so reading the raw value " +
          "reports a 10% discount on an $11,725 job as ten dollars, wrong by 117x. `amountCents` is the line's real signed effect with both discount kinds already converted " +
          "onto one scale (negative on a discount), and `discountRate` carries the percentage itself so you can say both '10% off' and '-$1,172.50'. " +
          "`unitPriceRaw` is kept only for reconciling against HousecallPro's own screen. " +
          "A discount is a LINE and not a field, so the record's own total is ALREADY NET of it — `grossCents` is what it would have been. " +
          "On a WON estimate the lines cover the APPROVED options only, matching its approved value; elsewhere they cover every option, which on a multi-option estimate are usually " +
          "ALTERNATIVE bids for the same work, so do not read them as one job's contents. " +
          "`syncedAt: null` means the lines have not been read from HousecallPro yet — NOT that the record is unpriced, which is an empty `lines` with a non-null syncedAt. " +
          "`reconciles: false` means these lines disagree with the record's own total and the figures should not be quoted until that is understood.",
        inputSchema: LineItemsInput.shape,
        outputSchema: LineItemsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ kind, id }) => {
        const detail = await getLineItems(kind, id);
        if (!detail) {
          return fail(
            `No ${kind} with id '${id}'.`,
            `Ids come from arbor_list_${kind}s (the \`id\` field) — not from HousecallPro's estimate number, invoice number or job id.`,
          );
        }
        return json(detail);
      },
    );

    server.registerTool(
      "arbor_list_jobs",
      {
        title: "List jobs",
        description:
          "Work actually SOLD AND DONE, from HousecallPro — the counterpart to arbor_list_estimates, which is the opportunity list. " +
          "Each row carries its invoice rollup (invoiced / collected / due, voided and canceled invoices excluded) and `estimateId`, the link back " +
          "to the estimate and therefore to its attribution chain. " +
          "⚠️ Choose `dateField` deliberately: `created` is when the job was written, `completed` is when the crew finished — 'what did we DO in July' is `completed`. " +
          "Crew timeline is `onMyWayAt` → `startedAt` → `completedAt`, with `onSiteMinutes` derived from the last two; a null there means it was never clocked, not zero. " +
          "`dispatchedEmployeeIds` (from the appointments expand) is who actually went, and is more reliable than `assignedTo`, which is empty on many jobs. " +
          "None of this money is ROI revenue: roi_daily is anchored on the won estimate, because that is when the marketing did its job. Booked, billed and collected are three different numbers. " +
          "`leadSourceRaw` is HCP's own lead_source and is NOT attribution — it records how the record was typed in.",
        inputSchema: ListJobsInput.shape,
        outputSchema: ListJobsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, start, end, dateField, limit, offset, ...filters }) =>
        json(await listJobs({ days, start, end, dateField, filters, limit, offset })),
    );

    server.registerTool(
      "arbor_list_invoices",
      {
        title: "List invoices",
        description:
          "What was BILLED and what was COLLECTED. Every money total excludes voided and canceled invoices — a re-issued invoice would otherwise count twice — " +
          "so read `agg.live`, not `agg.total`, as the denominator for anything financial. " +
          "`paidCents` counts succeeded payments only; `dueCents` is the collections number. " +
          "One job can carry several invoices (progress billing, a second visit), and `invoiceNumber` is NOT unique — HCP suffixes re-issues (\"10035706-1\"). " +
          "Filter `paymentMethod: bnpl` to find Klarna lines, which are the known poison pill for HCP's QuickBooks payout sync. " +
          "This is not ROI revenue: roi_daily stays anchored on the won estimate.",
        inputSchema: ListInvoicesInput.shape,
        outputSchema: ListInvoicesOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, start, end, dateField, limit, offset, ...filters }) =>
        json(await listInvoices({ days, start, end, dateField, filters, limit, offset })),
    );

    server.registerTool(
      "arbor_list_customers",
      {
        title: "List customers",
        description:
          "The customer book from HousecallPro, with lifetime rollups: jobs, estimates, and billed / collected / still-owed. " +
          "`days` is OPTIONAL here and windows on HCP's own created_at ('customers acquired since') — omit it to search the whole book, which is the usual case. " +
          "`phones` holds EVERY number on the record, not just the primary: people call from whichever handset they are holding, and matching on the primary alone " +
          "is what used to leave estimates unattributed while two real calls from the same household sat on file. " +
          "`tracked: false` finds customers who never reached us on a tracked channel — referrals, walk-ins, and anyone predating tracking. " +
          "⚠️ `doNotService` is THREE-STATE: true / false / null, where null means the flag is UNKNOWN because that row has not been re-read since the " +
          "`expand[]=do_not_service` request was added. null is NOT 'safe to contact' — treating an absent flag as false is how 51 flagged customers were " +
          "put on a newsletter send. For anything that contacts people, filter `doNotService: false`, which matches only rows provably not flagged.",
        inputSchema: ListCustomersInput.shape,
        outputSchema: ListCustomersOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, limit, offset, ...filters }) => json(await listCustomers({ days, filters, limit, offset })),
    );

    server.registerTool(
      "arbor_landing_pages",
      {
        title: "Landing-page performance",
        description:
          "CRO view: sessions (crawlers excluded), contacts, conversion, estimates, won and revenue per landing path. Deliberately has NO spend — money attaches to campaigns, not pages. " +
          "Reads raw session/lead timestamps, so totals will not reconcile with arbor_roi_summary at a window edge. Rates on under ~30 sessions are noise wearing a percent sign — suppress them when presenting. " +
          "unknownUa sessions carry no user-agent (recorded only from 2026-08-13) and are counted as human. " +
          "`basis` chooses entry page (default) or the page they were on at contact.",
        inputSchema: LandingPagesInput.shape,
        outputSchema: LandingPagesOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, basis }) => json(await landingPagePerformance(days, basis)),
    );

    server.registerTool(
      "arbor_list_threads",
      {
        title: "List inbox threads",
        description:
          "The inbox: one thread per PERSON (contact-centric), newest activity first, every channel folded together. channel filters to threads CONTAINING that channel. " +
          "Recruiting enquiries appear here by design (someone contacting the business is inbox-worthy) but never become leads, so they stay out of ROI. " +
          "smsOptedOut=true means outbound texting is blocked in code — the consent gate lives server-side.",
        inputSchema: ListThreadsInput.shape,
        outputSchema: ListThreadsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, channel, state, limit, offset }) => {
        const { threads, counts, total, hasMore, nextOffset } = await listThreads({ days, channel, state, limit, offset });
        return json({
          counts,
          total,
          hasMore,
          nextOffset,
          threads: threads.map((t) => ({
            id: t.id,
            state: t.state,
            channels: t.channels,
            lastDirection: t.lastDirection,
            lastPreview: t.lastPreview,
            lastActivityAt: t.lastActivityAt,
            unreadCount: t.unreadCount,
            name: [t.hcpFirst, t.hcpLast].filter(Boolean).join(" ") || t.name,
            phone: t.phone,
            email: t.email,
            smsOptedOut: t.optedOut != null,
            hcpCustomer: t.hcpFirst != null || t.hcpLast != null,
          })),
        });
      },
    );

    server.registerTool(
      "arbor_get_thread",
      {
        title: "Get one thread",
        description:
          "One person's whole history: calls (with summaries and transcripts, clipped at 4000 chars), texts both directions, web forms, Facebook lead forms, " +
          "and the separate enquiries (leads) this person has raised over time. Reading here does NOT mark the thread read — that happens only when the owner opens it. " +
          "replyFrom is the tracking number a reply must send from (replying from any other number would start a second thread on the customer's phone and break attribution).",
        inputSchema: GetThreadInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const d = await getThreadDetail(id);
        if (!d) {
          return fail(
            `No thread with id '${id}'.`,
            "Thread ids come from arbor_list_threads (the `id` field). An estimate's linked thread is on arbor_estimate_detail as `conversationId`.",
          );
        }
        return json({
          thread: {
            id: d.thread.id,
            state: d.thread.state,
            channels: d.thread.channels,
            lastActivityAt: d.thread.lastActivityAt,
            replyFrom: d.thread.lastEndpointKey,
            firstSource: d.sourceName ?? d.sourceKey,
          },
          contact: {
            name: [d.hcpFirst, d.hcpLast].filter(Boolean).join(" ") || d.contact.displayName,
            phone: d.contact.primaryPhone,
            email: d.contact.primaryEmail,
            smsOptedOut: d.contact.smsOptedOutAt != null,
            hcpCustomerId: d.hcpExternalId,
          },
          calls: d.calls.map((c) => ({
            id: c.call.id,
            at: c.call.createdAt,
            dialed: c.dialedNumber,
            dialedLabel: c.dialedName,
            answered: c.call.answered,
            voicemail: c.call.voicemail,
            status: c.call.status,
            durationSec: c.call.durationSec,
            summary: c.call.summary,
            transcript: clip(c.call.transcript),
            selfReportedSource: c.call.selfReportedSource,
            hasRecording: c.call.recordingUrl != null,
          })),
          messages: d.messages.map((m) => ({
            id: m.id,
            at: m.occurredAt,
            direction: m.direction,
            channel: m.channel,
            subject: m.subject,
            body: clip(m.body),
            status: m.status,
          })),
          forms: d.forms.map((f) => ({ id: f.id, at: f.submittedAt, pageUrl: f.pageUrl, fields: f.fields })),
          facebookLeads: d.facebookLeads.map((f) => ({ id: f.id, at: f.createdTime ?? f.createdAt, fields: f.fields })),
          enquiries: d.leads.map((l) => ({
            id: l.id,
            at: l.occurredAt,
            type: l.type,
            status: l.status,
            disposition: l.disposition,
            dispositionManual: l.dispositionManual,
            dispositionReason: l.dispositionReason,
            isLead: l.isLead,
            leadReason: l.leadReason,
            quoteValueCents: l.quoteValueCents,
            salesValueCents: l.salesValueCents,
          })),
        });
      },
    );

    server.registerTool(
      "arbor_list_leads",
      {
        title: "Search leads",
        description:
          "Raw lead records with full attribution fields (source, campaign, click ids, landing page, self-reported source) — the support-question tool: " +
          '"did that call land with the right source?", "which callers to the static Google Ads number had no click id?". ' +
          "A lead is one tracked ENQUIRY, not a person (that is a thread) and not an opportunity (that is an estimate). selfReportedSource is the only field that can say what is inside the `direct` bucket.",
        inputSchema: ListLeadsInput.shape,
        outputSchema: ListLeadsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async (p) => {
        const { rows, total, hasMore, nextOffset } = await searchLeads(p);
        return json({ leads: rows, total, hasMore, nextOffset });
      },
    );

    server.registerTool(
      "arbor_spend_summary",
      {
        title: "Ad spend",
        description:
          "What the platforms billed, by platform and campaign: impressions, clicks, spend in cents. Reads ad_spend directly, so EXCLUDED (recruiting/brand) campaigns are " +
          "visible here flagged excluded:true — they are kept out of every ROI number but their spend stays on record. Use arbor_roi_summary for return on this spend.",
        inputSchema: SpendSummaryInput.shape,
        outputSchema: SpendSummaryOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, platform }) => json(await spendSummary({ days, platform })),
    );

    server.registerTool(
      "arbor_diagnostics",
      {
        title: "Operational arbor_diagnostics",
        description:
          "Is the machine healthy right now? Sync-job health, DNI pool state, swap coverage, conversion-export failures, estimate-sync drift vs HousecallPro, " +
          "credential presence (never values), and a warnings list where anything non-empty deserves a human. A fixed set of checks, deliberately not a query interface.",
        inputSchema: DiagnosticsInput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const { report } = await diagnosticsReport();
        return json(report);
      },
    );

    server.registerTool(
      "arbor_attribution_health",
      {
        title: "Attribution health",
        description:
          "Why are estimates unattributed? Splits the window's estimates into attributed / pre-tracking / reached-us-but-unlinked / never-reached-us. " +
          "Windows reaching past the 2026-08-08 CallRail cutover measure the cutover, not the tracking — prefer short windows for 'is matching working'.",
        inputSchema: AttributionHealthInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days }) => json(await attributionBreakdown(days)),
    );

    // ── Phase 3 write tools ──────────────────────────────────────────────────
    // Each mirrors an existing gated route; the enforcement lives in the shared
    // lib functions, never in tool descriptions.

    server.registerTool(
      "arbor_reply_to_thread",
      {
        title: "Reply to a thread by text",
        description:
          "Sends an SMS to the thread's contact FROM the tracking number they contacted (replying from any other number would start a second thread on their phone and break attribution). " +
          "This messages a real customer and cannot be unsent — confirm with the user before calling unless they just dictated the exact message. " +
          "Consent is enforced server-side: an opted-out contact (STOP) fails with code opted_out no matter what is asked. Max 1600 chars (Twilio's split point).",
        inputSchema: ReplyToThreadInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ id, body }) => {
        try {
          const message = await sendThreadSms({ conversationId: id, body });
          return json({ ok: true, id: message.id, status: message.status });
        } catch (err) {
          if (err instanceof SendError) {
            // Consent/config refusals are state, not transport — retrying cannot
            // help, so each says what would actually change the outcome.
            const nextStep = {
              opted_out:
                "This contact replied STOP. Texting them is blocked in code and cannot be overridden here — reach them another way.",
              no_destination: "This thread has no phone number to reply to. Check the contact in arbor_get_thread.",
              no_sender:
                "No tracking number is recorded for this thread, so there is nothing to send from. Replying from another number would break attribution.",
              provider: "Twilio rejected the send. Check arbor_diagnostics for credential and number health, then retry.",
              empty: "The message body was empty after trimming.",
            }[err.code];
            return fail(err.message, nextStep ?? "Check arbor_diagnostics for service health.");
          }
          throw err;
        }
      },
    );

    server.registerTool(
      "arbor_set_thread_state",
      {
        title: "Open or close a thread",
        description:
          "Mark a thread done (closed) or reopen it — the flag that lets the inbox drain. Nothing is deleted; a closed thread reopens automatically on new inbound activity.",
        inputSchema: SetThreadStateInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, state }) => {
        await setThreadState(id, state);
        return json({ ok: true, id, state });
      },
    );

    server.registerTool(
      "arbor_set_lead_disposition",
      {
        title: "Set why nothing came of an enquiry",
        description:
          "Set ONE enquiry's disposition by hand: requested_work (asked for tree work), spam, not_business (vendor, recruiter, wrong number), existing_customer (service/billing on work already sold), or missed (a real request nobody wrote an estimate for — the ones to chase). " +
          "The ESTIMATE is the ground truth for 'was this business' and every metric counts estimates; the disposition is the answer an estimate cannot give, which is NO and why. So it cannot move ROI numbers. " +
          "requested_work is the one positive value and exists because the inbox and the Lead Created export need a verdict before an estimate exists. " +
          "Sets a manual override the transcript/text classifiers never overwrite; null clears it (the transcript is re-classified, or the row returns to pending). spam also flags is_spam.",
        inputSchema: SetLeadDispositionInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, disposition, reason }) => {
        const row = await setLeadDisposition(id, disposition, reason);
        if (!row) {
          return fail(
            `No lead with id '${id}'.`,
            "Lead ids come from arbor_list_leads, or from arbor_get_thread's `enquiries` array. A lead id is not an estimate id.",
          );
        }
        return json({ ok: true, ...row });
      },
    );

    server.registerTool(
      "arbor_classify_lead",
      {
        title: "Mark a lead as lead / not a lead",
        description:
          "The two-valued slice of arbor_set_lead_disposition (true = requested_work, false = not_business), kept for the inbox toggle. Prefer arbor_set_lead_disposition, which can also say existing_customer, missed or spam. " +
          "For inbox triage only — NO metric reads this (estimates are counted from HousecallPro), so it cannot move ROI numbers. " +
          "A boolean sets a manual verdict the auto-classifier will not overwrite; null clears the override and re-runs the classifier on the call transcript.",
        inputSchema: ClassifyLeadInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, isLead }) => {
        const row = await setLeadClassification(id, isLead);
        if (!row) {
          return fail(
            `No lead with id '${id}'.`,
            "Lead ids come from arbor_list_leads, or from arbor_get_thread's `enquiries` array. A lead id is not an estimate id.",
          );
        }
        return json({ ok: true, ...row });
      },
    );

    server.registerTool(
      "arbor_set_lead_attribution",
      {
        title: "Correct a lead's source and/or campaign",
        description:
          "Set the source (sources.key) and/or campaign (campaigns.id) on ONE lead — the enquiry, not the person — when attribution was recorded wrong: a transposed tag, a monitor's lease shadowing a real one, a call to a mis-labelled number. " +
          "Validates against EXISTING sources and campaigns and never mints either; a campaign must belong to the lead's resulting source or the write is refused. " +
          "Stamps attribution_set_manually_at so the automatic repair passes (seed backfills, reclassify) leave the row alone from then on; manual:false releases that lock without changing values; campaignId:null clears the campaign. " +
          "Then run arbor_trigger_sync { job: 'attribution' } — roi_daily is rebuilt from leads and /sources does not move until it runs. " +
          "Source keys come from arbor_roi_summary rows; campaign ids from arbor_list_campaigns; lead ids from arbor_list_leads or arbor_get_thread.",
        inputSchema: SetLeadAttributionInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, ...patch }) => {
        const result = await setLeadAttribution(id, patch);
        if (!result.ok) return fail(result.error, result.nextStep);
        return json(result);
      },
    );

    server.registerTool(
      "arbor_trigger_sync",
      {
        title: "Run a sync job now",
        description:
          "Kick a sync on demand, same as POST /api/sync/[job]: spend, hcp, attribution, transcribe, conversions, fbleads, reaper, twilio-fallback, classify-messages, thread-backfill, or `all` (the full chain, ingest before attribution). " +
          "Safe to call — jobs are idempotent and withSyncRun refuses to interleave (a run already in progress returns skipped:true rather than doubling). " +
          "OMIT days unless deliberately backfilling history: each job owns its own window policy, and an explicit window short-circuits it. Long jobs (hcp, all) can take minutes.",
        inputSchema: TriggerSyncInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ job, days }) => json({ ok: true, job, result: await runSyncJob(job, days) }),
    );

    server.registerTool(
      "arbor_list_campaigns",
      {
        title: "List ad campaigns",
        description:
          "Every campaign the syncs have seen, with lifetime spend (cents), lead count, and the excluded flag. " +
          "This is where campaignId values for arbor_set_campaign_excluded come from. Campaigns are created by the spend sync and Facebook ingest — never invented from URL text.",
        inputSchema: ListCampaignsInput.shape,
        outputSchema: ListCampaignsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => json({ campaigns: await listCampaignsWithVolume() }),
    );

    server.registerTool(
      "arbor_list_facebook_forms",
      {
        title: "Facebook lead forms",
        description:
          "Every lead form on the page, with which are currently polled. ⚠️ An EMPTY `selected` means every ACTIVE form is polled, not none — the same inversion that decides whether arbor_cleanup_leads has anything to do.",
        inputSchema: ListFacebookFormsInput.shape,
        outputSchema: ListFacebookFormsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const [forms, selected] = await Promise.all([facebook.listLeadForms(), getIncludedFormIds()]);
        return json({
          forms: forms.map((f) => ({
            id: f.id,
            name: f.name ?? null,
            status: f.status ?? null,
            leadsCount: f.leadsCount ?? null,
          })),
          selected,
        });
      },
    );

    server.registerTool(
      "arbor_set_facebook_forms",
      {
        title: "Choose which Facebook forms are polled",
        description:
          "REPLACES the selection — read arbor_list_facebook_forms first and send the full set. An empty list restores 'poll every active form'. " +
          "Unchecking a form stops FUTURE leads from it; leads already ingested stay until arbor_cleanup_leads removes them.",
        inputSchema: SetFacebookFormsInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ formIds }) => {
        await setIncludedFormIds(formIds);
        return json({ ok: true, selected: await getIncludedFormIds() });
      },
    );

    server.registerTool(
      "arbor_cleanup_leads",
      {
        title: "Remove leads from an excluded campaign or form",
        description:
          "⚠️ The only operation here that HARD DELETES leads (and their attributions and conversion exports). Everything else in this app tombstones. " +
          "Defaults to a DRY RUN: call it once to see `wouldRemove`, then again with apply:true. Same shape as arbor_reclassify_sources. " +
          "Ad spend is never touched — flagging a campaign already keeps its dollars out of ROI, and deleting the spend row would destroy history rather than uncount it.",
        inputSchema: CleanupLeadsInput.shape,
        outputSchema: CleanupLeadsOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ scope, apply }) => json(await runLeadCleanup(scope, apply)),
    );

    server.registerTool(
      "arbor_import_number",
      {
        title: "Import an already-owned Twilio number",
        description:
          "Brings a number ALREADY owned in the Twilio account under tracking and points its webhooks at this app. " +
          "Cannot buy a number: purchasing costs money every month until somebody notices, so it stays behind an interactive login — the same line /api/numbers draws for token callers.",
        inputSchema: ImportNumberInput.shape,
        outputSchema: ImportNumberOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ phoneNumber, pool, friendlyName, isStatic, staticSourceKey, location, forwardDestination }) => {
        if (!(await listPools()).some((p) => p.key === pool)) {
          return fail(`No pool with key '${pool}'.`, "Keys come from arbor_list_pools.");
        }
        const staticSourceId = isStatic && staticSourceKey ? await resolveSourceIdByKey(staticSourceKey) : null;
        try {
          const row = await provisionNumber({
            pool,
            importPhoneNumber: phoneNumber,
            isStatic,
            staticSourceId,
            location,
            friendlyName,
            forwardDestination: forwardDestination || null,
          });
          const fresh = (await listTrackingNumbers()).find((n) => n.id === row.id) ?? null;
          return json({ number: fresh });
        } catch (err) {
          return fail(
            err instanceof Error ? err.message : String(err),
            "The number must already exist in the Twilio account — this tool cannot purchase one.",
          );
        }
      },
    );

    server.registerTool(
      "arbor_get_settings",
      {
        title: "Current configuration",
        description:
          "Routing (where calls forward and texts relay), the tracking-origin allowlist, and the attribution model — the settings the write tools below change. Read this before changing one: every setter takes a full value, not a delta.",
        inputSchema: GetSettingsInput.shape,
        outputSchema: GetSettingsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () =>
        json({
          defaultForward: await getDefaultForwardNumber(),
          smsForward: await getSmsForwardNumber(),
          allowedOrigins: await trackingOrigins(),
          attributionModel: await selectedTouchModel(),
        }),
    );

    server.registerTool(
      "arbor_set_routing",
      {
        title: "Set call forwarding and text relay",
        description:
          "Where calls ring when a tracking number has no per-number override, and where inbound texts are relayed. Send only the field being changed; an empty string clears it. " +
          "Changing the call default also re-points every number's Twilio-side voice FALLBACK, which is the destination used when the app itself is failing — leaving that stale is invisible until a call is already lost.",
        inputSchema: SetRoutingInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (patch) => {
        const result = await setRoutingConfig(patch);
        if (!result.ok) {
          return fail(`'${patch[result.field]}' is not a valid phone number.`, "Use E.164, e.g. +16188368004.");
        }
        // `result` already carries ok:true plus whichever fields changed.
        return json(result);
      },
    );

    server.registerTool(
      "arbor_set_tracking_origins",
      {
        title: "Set the tracking-origin allowlist",
        description:
          "The sites whose pages may POST to /api/track and /api/dni/assign. REPLACES the list — read arbor_get_settings first and send the full set. " +
          "An empty list restores the built-in arbor-mgmt.com defaults rather than blocking everything. Takes effect within a minute (the built set is cached briefly). " +
          "⚠️ Removing the live site's origin stops the DNI swap and form capture for every visitor.",
        inputSchema: SetTrackingOriginsInput.shape,
        outputSchema: TrackingOriginsOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async ({ allowedOrigins }) => {
        const result = await setTrackingOrigins(allowedOrigins);
        if (!result.ok) return fail(`'${result.invalid}' is not a valid origin.`, "Use https://example.com or a bare hostname.");
        return json({ allowedOrigins: result.allowedOrigins, defaults: result.defaults });
      },
    );

    server.registerTool(
      "arbor_list_pools",
      {
        title: "Number pools",
        description:
          "The buckets tracking numbers belong to. `isDni` is the load-bearing one: website DNI leasing draws ONLY from pools flagged with it, so a number in an un-flagged pool can never be handed to a visitor.",
        inputSchema: ListPoolsInput.shape,
        outputSchema: ListPoolsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => json({ pools: await listPools() }),
    );

    server.registerTool(
      "arbor_upsert_pool",
      {
        title: "Create or edit a number pool",
        description:
          "Creates the pool when the key is new (displayName required), otherwise edits display metadata and the DNI flag. The key is stored on every number in the pool and is immutable — a different key is a different pool. " +
          "⚠️ Toggling isDni changes which numbers the website can hand to visitors.",
        inputSchema: UpsertPoolInput.shape,
        outputSchema: UpsertPoolOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ key, displayName, description, isDni }) => {
        const existing = (await listPools()).find((p) => p.key === key);
        if (!existing) {
          if (!displayName) return fail(`Pool '${key}' does not exist.`, "Pass displayName to create it.");
          const row = await createPool({ key, displayName, description, isDni });
          if (!row) return fail(`Pool '${key}' already exists.`, "Retry without displayName to edit it.");
          return json({ pool: row, created: true });
        }
        const row = await updatePool(key, { displayName, description, isDni });
        return row ? json({ pool: row, created: false }) : fail(`Pool '${key}' disappeared mid-update.`, "Retry.");
      },
    );

    server.registerTool(
      "arbor_delete_pool",
      {
        title: "Delete a number pool",
        description:
          "Refused while any tracking number still points at the pool — reassign those first — and refused for 'reserved', which is where a newly provisioned number lands by default.",
        inputSchema: DeletePoolInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ key }) => {
        const result = await deletePool(key);
        if (result.ok) return json({ ok: true });
        if (result.reason === "reserved") return fail("The reserved pool cannot be deleted.", "It is the default for new numbers.");
        if (result.reason === "in_use") {
          return fail(
            `${result.numbers} number(s) still use '${key}'.`,
            "Move them to another pool with arbor_update_number first.",
          );
        }
        return fail(`No pool with key '${key}'.`, "Keys come from arbor_list_pools.");
      },
    );

    server.registerTool(
      "arbor_list_manual_spend",
      {
        title: "Hand-entered monthly spend",
        description:
          "Spend typed in for channels no API sync reaches — Local Services, Google Business Profile, print, yard signs. runAttribution spreads each month evenly across its days so these channels get CPL and ROAS beside the synced ones.",
        inputSchema: ListManualSpendInput.shape,
        outputSchema: ListManualSpendOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => json({ rows: await listManualSpend() }),
    );

    server.registerTool(
      "arbor_set_manual_spend",
      {
        title: "Set or clear a month's manual spend",
        description:
          "Upserts one (source, month) figure in integer CENTS; null amountCents deletes the row. Never writes ad_spend, so a hand-entered figure cannot collide with a platform pull. " +
          "Shows up in ROI on the next attribution rebuild (hourly, or arbor_trigger_sync('attribution')).",
        inputSchema: SetManualSpendInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ sourceId, month, amountCents, note }) => {
        const result =
          amountCents === null
            ? await deleteManualSpend(sourceId, month)
            : await setManualSpend({ sourceId, month, amountCents, note });
        if (result.ok) return json({ ok: true });
        return result.reason === "unknown_source"
          ? fail(`No source with id '${sourceId}'.`, "This wants sources.id, not the source key — ids come from arbor_roi_summary rows.")
          : fail(`'${month}' is not a month.`, "Use YYYY-MM.");
      },
    );

    server.registerTool(
      "arbor_reset_conversion_exports",
      {
        title: "Retry failed conversion uploads",
        description:
          "Reopens conversion exports sitting in 'error' so the next export run retries them. Deliberately narrow: a row already 'sent' is NEVER reopened, which is the guard that stops one conversion being uploaded twice. " +
          "Use after fixing the cause of a failure, not as a routine retry — the exporter already retries within the attempt cap on its own.",
        inputSchema: ResetConversionExportsInput.shape,
        outputSchema: ResetConversionExportsOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ onlyAbandoned, platform }) => json(await resetFailedExports({ onlyAbandoned, platform })),
    );

    server.registerTool(
      "arbor_test_credentials",
      {
        title: "Test a platform credential",
        description:
          "Makes the cheapest authenticated call to HousecallPro, Google Ads or Meta and reports whether it WORKED — which arbor_diagnostics cannot tell you, since it reports only that a value is present. Never returns the credential.",
        inputSchema: TestCredentialsInput.shape,
        outputSchema: TestCredentialsOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ platform }) => {
        const result = await probeCredential(platform);
        return json({ platform, ...result });
      },
    );

    server.registerTool(
      "arbor_list_numbers",
      {
        title: "Tracking numbers",
        description:
          "Every tracking number with its resolved source and campaign, so a number can be pointed somewhere without a second lookup. " +
          "A STATIC number names its own source and campaign; a pooled (website DNI) number inherits both from the visitor's lease, which is why those read null on one. " +
          "This is where `id` values for arbor_update_number come from.",
        inputSchema: ListNumbersInput.shape,
        outputSchema: ListNumbersOutput.shape,
        annotations: { readOnlyHint: true },
      },
      async () => json({ numbers: await listTrackingNumbers() }),
    );

    server.registerTool(
      "arbor_update_number",
      {
        title: "Edit a tracking number",
        description:
          "Change what a tracking number represents or how it routes: friendly name, source, campaign, location, forward destination, whisper, pre-call message, recording, or active/disabled. " +
          "Same implementation as the Settings → Numbers editor, so the Twilio-side voice fallback follows a changed forward destination here too. " +
          "`staticCampaignId` is the one to reach for when a source is too coarse — one of two Google Business Profile listings, or a Google Ads call asset — and it applies to calls from the moment it is set, NOT retroactively. " +
          "Omit a field to leave it alone. Cannot buy or release a number: both are deliberately absent from this surface.",
        inputSchema: UpdateNumberInput.shape,
        outputSchema: UpdateNumberOutput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, ...patch }) => {
        const row = await applyNumberPatch(id, patch);
        if (!row) {
          return fail(
            `No tracking number with id '${id}'.`,
            "Number ids come from arbor_list_numbers.",
          );
        }
        const [fresh] = (await listTrackingNumbers()).filter((n) => n.id === id);
        return json({ number: fresh ?? null });
      },
    );

    server.registerTool(
      "arbor_set_campaign_excluded",
      {
        title: "Flag a campaign as recruiting/brand",
        description:
          "Marks one campaign as non-customer-acquisition (or unmarks it). Excluded campaigns are kept out of EVERY ROI number — roi_daily, the funnel, sources, estimates — " +
          "while their spend stays on record; exclusion is applied when reading, never by deleting data. Flag a new recruiting campaign promptly, or its dollars land in a channel's ROAS denominator with no revenue behind them. " +
          "Takes effect for stored aggregates on the next attribution rebuild (hourly, or trigger_sync('attribution')).",
        inputSchema: SetCampaignExcludedInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ campaignId, excluded }) => {
        const row = await setCampaignExcluded(campaignId, excluded);
        if (!row) {
          return fail(
            `No campaign with id '${campaignId}'.`,
            "Campaign ids come from arbor_list_campaigns. Campaigns are created by the spend sync and Facebook ingest — a campaign absent there has not been pulled yet, so run arbor_trigger_sync with job 'spend' first.",
          );
        }
        return json({ ok: true, ...row });
      },
    );

    server.registerTool(
      "arbor_set_attribution_model",
      {
        title: "Switch the attribution model",
        description:
          "Sets which single-touch model every surface reports under: last_touch (which channel produced this estimate — repeat customers show unattributed, by design) or " +
          "first_touch (which channel acquired the customer). Both models are always stored side by side, so switching is an instant display filter — nothing is recomputed and switching back loses nothing. " +
          "customerWindowDays (optional) changes how long a repeat won estimate inherits the original source, applied on the next attribution rebuild.",
        inputSchema: SetAttributionModelInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ model, customerWindowDays }) => {
        await setAttributionOptions({ model, customerWindowDays });
        return json({ ok: true, model, ...(customerWindowDays !== undefined ? { customerWindowDays } : {}) });
      },
    );

    server.registerTool(
      "arbor_reclassify_sources",
      {
        title: "Re-run source classification on unmapped leads",
        description:
          "After classifySource learns a new channel mapping, this moves leads currently sitting in `other` onto sources the classifier now recognises. " +
          "It only ever moves a lead OFF `other` — never between mapped sources — so it cannot rewrite the source that earned a call. " +
          "apply=false (the default) is a dry run reporting what WOULD move; run that first and show the user before calling with apply=true.",
        inputSchema: ReclassifySourcesInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ apply }) => json(await reclassifyUnmappedSources({ apply })),
    );
  },
  {
    serverInfo: { name: "arbor-lead-tracking", version: "1.0.0" },
    instructions:
      "Tools over Arbor Management's lead-tracking and ROI data: fifteen reads plus seven writes (replying to customers, triage, settings, syncs). " +
      "Money is integer cents. Window shapes differ by tool: roi_summary/arbor_funnel_overview bucket on America/Chicago business dates by CONTACT date; " +
      "arbor_list_estimates windows on estimate CREATION by default and takes a `dateField` (created/scheduled) to window on the booked visit instead — `scheduled` excludes every " +
      "unscheduled estimate by construction; arbor_list_jobs and arbor_list_invoices take their own `dateField` (created/scheduled/completed, invoice/service/paid); " +
      "arbor_landing_pages uses raw timestamps. Totals across shapes will not reconcile at window edges — that is documented behavior, not a data bug. " +
      "FOUR different money numbers live here and must not be blended: estimate APPROVED value (the only ROI revenue), job QUOTED total, invoice BILLED, and invoice COLLECTED. " +
      "roi_summary and arbor_funnel_overview are the only revenue surfaces; jobs and invoices answer 'was the work done and did we get paid', never 'did the ads work'. " +
      "Close rates always divide by countable estimates (scheduled or won), never by everything listed. " +
      "List tools page: they return total/hasMore/nextOffset — never present a page as the whole set, and follow nextOffset when the question needs all of them.",
  },
  {
    // Route lives at /api/mcp; basePath derives the streamable-HTTP endpoint.
    basePath: "/api",
    // No Redis in this deployment, and the 2025-03-26 spec dropped SSE anyway —
    // streamable HTTP (plain POST) is the one transport served.
    disableSse: true,
    verboseLogs: false,
  },
);

/**
 * Fail-closed bearer gate, two credentials in one header:
 *  - the static MCP_API_TOKEN (machine callers: Claude Code --header, curl) —
 *    unset means that path is off entirely;
 *  - an OAuth access token minted by this app's own authorization flow
 *    (claude.ai custom connectors authenticate via OAuth; see lib/mcp-oauth.ts).
 *
 * The 401 carries the WWW-Authenticate handshake Claude's connector flow keys
 * on: 401 → resource metadata → authorization server → consent at /oauth/authorize.
 */
function authorized(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice(7);

  const configured = env.MCP_API_TOKEN;
  if (configured && secretEquals(header, `Bearer ${configured}`)) return true;

  return verifyAccessToken(presented) !== null;
}

function unauthorized(): Response {
  const base = env.APP_BASE_URL.replace(/\/$/, "");
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorized();
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
