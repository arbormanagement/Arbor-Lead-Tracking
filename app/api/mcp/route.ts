import { createMcpHandler } from "mcp-handler";
import { attributionBreakdown } from "@/lib/diagnostics/attribution";
import { diagnosticsReport } from "@/lib/diagnostics/report";
import { env } from "@/lib/env";
import {
  AttributionHealthInput,
  ClassifyLeadInput,
  DiagnosticsInput,
  EstimateDetailInput,
  FunnelOverviewInput,
  GetThreadInput,
  LandingPagesInput,
  ListEstimatesInput,
  ListLeadsInput,
  ListThreadsInput,
  ReplyToThreadInput,
  RoiSummaryInput,
  SetThreadStateInput,
  SpendSummaryInput,
  TriggerSyncInput,
} from "@/lib/api-contracts/tools";
import { selectedTouchModel } from "@/lib/attribution/model";
import { setLeadClassification } from "@/lib/leads/classify-override";
import { SendError, sendThreadSms } from "@/lib/messaging/send";
import { setThreadState } from "@/lib/messaging/thread";
import { runSyncJob } from "@/lib/sync/run-job";
import { getEstimateDetail, listEstimates } from "@/lib/queries/estimates";
import { getThreadDetail, listThreads } from "@/lib/queries/inbox";
import { searchLeads } from "@/lib/queries/leads";
import { overviewData } from "@/lib/queries/overview";
import { campaignPerformance, landingPagePerformance, sourceBreakdowns, sourcePerformance } from "@/lib/queries/sources";
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
 * ⚠️ reply_to_thread means MCP_API_TOKEN can TEXT CUSTOMERS. The reply route
 * itself is deliberately session-only and stays that way; exposing the same
 * action here was a deliberate Phase 3 decision (GENERATIVE-UI.md) so the
 * inbox is operable generatively. Treat the token accordingly: it is not a
 * read-only credential any more, and rotating it is one env change.
 */

/** Bound every tool result: a model client's context is the scarce resource. */
const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** Long free text (transcripts, bodies) is clipped, with a marker, not dropped. */
const clip = (s: string | null, max = 4000): string | null =>
  s && s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "funnel_overview",
      {
        title: "Funnel overview",
        description:
          "The business at a glance: contacts → estimates → won funnel, daily spend/revenue series, and top sources by revenue. " +
          "Reads roi_daily (the aggregate of record) under the currently selected attribution model, with recruiting campaigns excluded. " +
          "All money is integer cents; daily dates are America/Chicago business dates.",
        inputSchema: FunnelOverviewInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days }) => json(await overviewData(days)),
    );

    server.registerTool(
      "roi_summary",
      {
        title: "ROI by channel, campaign, or location",
        description:
          "Marketing performance from roi_daily: contacts, estimates (countable: scheduled or won, not cancelled), won, spend and revenue in cents. " +
          "grain=channel adds a cancelled column (counted via isCancelledEstimate, the exact complement of countable) and per-source location splits. " +
          "grain=campaign is the floor of money reporting — below it the sample is noise. " +
          "Windows are business-date (America/Chicago); estimates here bucket on the CONTACT date, so counts will not reconcile row-for-row with list_estimates (which windows on estimate creation). Both are correct for their own question.",
        inputSchema: RoiSummaryInput.shape,
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
      "list_estimates",
      {
        title: "List estimates",
        description:
          "The opportunity list — every live estimate (not cancelled, not deleted) windowed on when it was WRITTEN, with its full attribution chain " +
          "(source → campaign → landing page → keyword → what the caller said). Filters accept `none` to mean unattributed — asking for the untracked ones directly is the point. " +
          "The returned agg is computed over the whole filtered window, not just the returned rows. Close rate = won ÷ agg.countable (scheduled or won), NEVER ÷ agg.total — " +
          "dividing by the listed total is the 25%-vs-48% close-rate error this app exists to prevent. `outcome` is decided by customer option APPROVAL, never by HCP's work_status.",
        inputSchema: ListEstimatesInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, limit, ...filters }) => json(await listEstimates({ days, filters, limit })),
    );

    server.registerTool(
      "estimate_detail",
      {
        title: "Estimate detail",
        description:
          "One estimate with its customer (read through the HousecallPro link — this app stores no customer data), its attribution chain, " +
          "and the tracked contact behind it (leadId + conversationId to follow into get_thread). Null attribution fields mean no tracked contact matched: repeat business, a referral, or an estimate written in the field.",
        inputSchema: EstimateDetailInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const detail = await getEstimateDetail(id);
        return json(detail ?? { error: "not_found", id });
      },
    );

    server.registerTool(
      "landing_pages",
      {
        title: "Landing-page performance",
        description:
          "CRO view: sessions (crawlers excluded), contacts, conversion, estimates, won and revenue per landing path. Deliberately has NO spend — money attaches to campaigns, not pages. " +
          "Reads raw session/lead timestamps, so totals will not reconcile with roi_summary at a window edge. Rates on under ~30 sessions are noise wearing a percent sign — suppress them when presenting. " +
          "unknownUa sessions carry no user-agent (recorded only from 2026-08-13) and are counted as human.",
        inputSchema: LandingPagesInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days }) => json(await landingPagePerformance(days)),
    );

    server.registerTool(
      "list_threads",
      {
        title: "List inbox threads",
        description:
          "The inbox: one thread per PERSON (contact-centric), newest activity first, every channel folded together. channel filters to threads CONTAINING that channel. " +
          "Recruiting enquiries appear here by design (someone contacting the business is inbox-worthy) but never become leads, so they stay out of ROI. " +
          "smsOptedOut=true means outbound texting is blocked in code — the consent gate lives server-side.",
        inputSchema: ListThreadsInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, channel, state, limit }) => {
        const { threads, counts } = await listThreads({ days, channel, state, limit });
        return json({
          counts,
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
      "get_thread",
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
        if (!d) return json({ error: "not_found", id });
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
            isLead: l.isLead,
            leadReason: l.leadReason,
            quoteValueCents: l.quoteValueCents,
            salesValueCents: l.salesValueCents,
          })),
        });
      },
    );

    server.registerTool(
      "list_leads",
      {
        title: "Search leads",
        description:
          "Raw lead records with full attribution fields (source, campaign, click ids, landing page, self-reported source) — the support-question tool: " +
          '"did that call land with the right source?", "which callers to the static Google Ads number had no click id?". ' +
          "A lead is one tracked ENQUIRY, not a person (that is a thread) and not an opportunity (that is an estimate). selfReportedSource is the only field that can say what is inside the `direct` bucket.",
        inputSchema: ListLeadsInput.shape,
        annotations: { readOnlyHint: true },
      },
      async (p) => json({ leads: await searchLeads(p) }),
    );

    server.registerTool(
      "spend_summary",
      {
        title: "Ad spend",
        description:
          "What the platforms billed, by platform and campaign: impressions, clicks, spend in cents. Reads ad_spend directly, so EXCLUDED (recruiting/brand) campaigns are " +
          "visible here flagged excluded:true — they are kept out of every ROI number but their spend stays on record. Use roi_summary for return on this spend.",
        inputSchema: SpendSummaryInput.shape,
        annotations: { readOnlyHint: true },
      },
      async ({ days, platform }) => json(await spendSummary({ days, platform })),
    );

    server.registerTool(
      "diagnostics",
      {
        title: "Operational diagnostics",
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
      "attribution_health",
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
      "reply_to_thread",
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
            // Consent/config refusals are state, not transport: report the code
            // (opted_out, no_destination, no_sender, provider, empty) so the
            // client can explain rather than retry.
            return { ...json({ ok: false, error: err.message, code: err.code }), isError: true };
          }
          throw err;
        }
      },
    );

    server.registerTool(
      "set_thread_state",
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
      "classify_lead",
      {
        title: "Mark a lead as lead / not a lead",
        description:
          "The Lead/Not toggle, for inbox triage only — NO metric reads is_lead any more (estimates are counted from HousecallPro), so this cannot move ROI numbers. " +
          "A boolean sets a manual verdict the auto-classifier will not overwrite; null clears the override and re-runs the classifier on the call transcript.",
        inputSchema: ClassifyLeadInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ id, isLead }) => {
        const row = await setLeadClassification(id, isLead);
        if (!row) return { ...json({ ok: false, error: "lead not found", id }), isError: true };
        return json({ ok: true, ...row });
      },
    );

    server.registerTool(
      "trigger_sync",
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
  },
  {
    serverInfo: { name: "arbor-lead-tracking", version: "1.0.0" },
    instructions:
      "Read-only tools over Arbor Management's lead-tracking and ROI data. " +
      "Money is integer cents. Two window shapes exist: roi_summary/funnel_overview bucket on America/Chicago business dates by CONTACT date; " +
      "list_estimates windows on estimate CREATION; landing_pages uses raw timestamps. Totals across shapes will not reconcile at window edges — that is documented behavior, not a data bug. " +
      "Close rates always divide by countable estimates (scheduled or won), never by everything listed.",
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
 * Fail-closed bearer gate. MCP_API_TOKEN unset → every request 401s, so an
 * environment that never opted in exposes nothing. Timing-safe compare.
 */
function authorized(req: Request): boolean {
  const configured = env.MCP_API_TOKEN;
  if (!configured) return false;
  return secretEquals(req.headers.get("authorization"), `Bearer ${configured}`);
}

async function guarded(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
