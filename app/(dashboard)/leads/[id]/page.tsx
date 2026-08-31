import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import {
  attributions,
  calls,
  campaigns,
  facebookLeads,
  formSubmissions,
  hcpEstimates,
  hcpJobs,
  leads,
  messages,
  sources,
  trackingNumbers,
  webSessions,
} from "@/lib/db/schema";
import { dateTime, dollars, durationLabel } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../../lead-toggle";
import { stageClass, TYPE_META } from "../../stage";

export const dynamic = "force-dynamic";

/** Definition row — omits itself when the value is empty so cards stay dense. */
function Def({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  if (children == null || children === "" || children === false) return null;
  return (
    <div className="def" title={title}>
      <span className="def-k">{label}</span>
      <span className="def-v">{children}</span>
    </div>
  );
}

/** Render a jsonb fields payload (form / FB lead answers) as definition rows. */
function FieldRows({ fields }: { fields: unknown }) {
  if (!fields || typeof fields !== "object") return null;
  const entries = Object.entries(fields as Record<string, unknown>).filter(
    ([, v]) => typeof v === "string" || typeof v === "number",
  );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, v]) => (
        <Def key={k} label={k.replace(/_/g, " ")}>{String(v)}</Def>
      ))}
    </>
  );
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [row] = await db
    .select({
      lead: leads,
      sourceName: sources.displayName,
      sourceKey: sources.key,
      campaignName: campaigns.name,
      campaignPlatform: campaigns.platform,
    })
    .from(leads)
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(eq(leads.id, id))
    .limit(1);
  if (!row) notFound();
  const lead = row.lead;

  const [callRows, forms, fbRows, messageRows, touches, session, estimate, job] = await Promise.all([
    db
      .select({ call: calls, dialedNumber: trackingNumbers.phoneNumber, dialedName: trackingNumbers.friendlyName })
      .from(calls)
      .leftJoin(trackingNumbers, eq(calls.trackingNumberId, trackingNumbers.id))
      .where(eq(calls.leadId, lead.id)),
    db.select().from(formSubmissions).where(eq(formSubmissions.leadId, lead.id)),
    db.select().from(facebookLeads).where(eq(facebookLeads.leadId, lead.id)),
    db.select().from(messages).where(eq(messages.leadId, lead.id)).orderBy(asc(messages.occurredAt)),
    db.select().from(attributions).where(eq(attributions.leadId, lead.id)).orderBy(asc(attributions.occurredAt)),
    lead.webSessionId
      ? db.select().from(webSessions).where(eq(webSessions.id, lead.webSessionId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    lead.hcpEstimateId
      ? db.select().from(hcpEstimates).where(eq(hcpEstimates.id, lead.hcpEstimateId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    lead.hcpJobId
      ? db.select().from(hcpJobs).where(eq(hcpJobs.id, lead.hcpJobId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const t = TYPE_META[lead.type] ?? { ic: "•", label: lead.type };
  const who = lead.name || formatPhoneDisplay(lead.phoneE164) || lead.emailLc || "Unknown contact";
  const clickId = lead.gclid
    ? { label: "gclid (Google Ads click)", value: lead.gclid }
    : lead.fbclid
      ? { label: "fbclid (Facebook click)", value: lead.fbclid }
      : null;
  const attributed = Boolean(lead.sourceId);

  return (
    <>
      <Link href="/leads" className="backlink">← Leads</Link>
      {lead.conversationId && (
        <Link href={`/inbox/${lead.conversationId}`} className="backlink" style={{ marginLeft: 14 }}>
          Full conversation →
        </Link>
      )}

      <div className="page-head">
        <div>
          <h1 className="page-title">{t.ic} {who}</h1>
          <p className="page-sub">
            {t.label} lead · {dateTime(lead.occurredAt)}
          </p>
        </div>
        <div className="controls">
          {lead.isSpam && <span className="badge bad">spam</span>}
          {lead.isDuplicate && <span className="badge muted-strike">duplicate</span>}
          <span className={stageClass(lead.status)}>{lead.status}</span>
          {/* Available on every type, not just calls: a junk form submission has to
              be ejectable from the Leads list too, and this is the only control that
              does it (the list itself no longer carries one). */}
          <LeadToggle leadId={lead.id} isLead={lead.isLead} manual={lead.isLeadManual ?? false} />
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          {/* What happened — the captured interaction itself */}
          {callRows.map(({ call, dialedNumber, dialedName }) => (
            <div className="card" key={call.id}>
              <div className="card-head">
                <h3>☎ Call</h3>
                <span className="muted">{dateTime(call.createdAt)}</span>
              </div>
              <div className="card-body">
                <div className="def-list">
                  <Def label="From">{formatPhoneDisplay(call.fromNumber)}</Def>
                  <Def label="Dialed">
                    {formatPhoneDisplay(dialedNumber)}
                    {dialedName ? <span className="muted"> · {dialedName}</span> : null}
                  </Def>
                  <Def label="Forwarded to">{formatPhoneDisplay(call.toDestination)}</Def>
                  <Def label="Outcome">
                    {call.voicemail && !call.answered ? "voicemail" : call.answered ? "answered" : call.status || "—"}
                    {call.durationSec ? <span className="muted"> · {durationLabel(call.durationSec)}</span> : null}
                  </Def>
                  <Def label="Intent">{call.intentLabel}</Def>
                  <Def label="Lead reason" title="Why this call was (or wasn't) classified as a lead">{lead.leadReason}</Def>
                </div>
                {call.recordingUrl && (
                  <audio controls preload="none" style={{ width: "100%", height: 36, marginTop: 12 }} src={`/api/calls/${call.id}/recording`} />
                )}
                {call.transcript && (
                  <div className="transcript" aria-label="Call transcript">{call.transcript}</div>
                )}
              </div>
            </div>
          ))}

          {forms.map((f) => (
            <div className="card" key={f.id}>
              <div className="card-head">
                <h3>✉ Form submission</h3>
                <span className="muted">{dateTime(f.submittedAt)}</span>
              </div>
              <div className="card-body">
                <div className="def-list">
                  <Def label="Page">{f.pageUrl}</Def>
                  <Def label="Form">{f.formId}</Def>
                  <FieldRows fields={f.fields} />
                </div>
              </div>
            </div>
          ))}

          {fbRows.map((fb) => (
            <div className="card" key={fb.id}>
              <div className="card-head">
                <h3>ⓕ Facebook lead</h3>
                <span className="muted">{dateTime(fb.createdTime ?? fb.createdAt)}</span>
              </div>
              <div className="card-body">
                <div className="def-list">
                  <FieldRows fields={fb.fields} />
                  <Def label="Form ID">{fb.fbFormId}</Def>
                  <Def label="Ad ID">{fb.fbAdId}</Def>
                  <Def label="Campaign ID">{fb.fbCampaignId}</Def>
                </div>
              </div>
            </div>
          ))}

          {messageRows.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>💬 Messages</h3>
                {messageRows[0].conversationId && (
                  <Link href={`/inbox/${messageRows[0].conversationId}`} className="link">Open thread →</Link>
                )}
              </div>
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {messageRows.map((m) => (
                  <div key={m.id}>
                    <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>
                      {m.direction === "inbound" ? "Received" : "Sent"} · {dateTime(m.occurredAt)}
                    </div>
                    <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                      {m.body?.trim() || <span className="muted">(no text)</span>}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* `message` duplicates the first text's body for SMS leads — only worth a
              card of its own for form/FB leads, which have no message rows. */}
          {lead.message && messageRows.length === 0 && (
            <div className="card">
              <div className="card-head"><h3>Message</h3></div>
              <div className="card-body"><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{lead.message}</p></div>
            </div>
          )}

          {callRows.length === 0 && forms.length === 0 && fbRows.length === 0 && messageRows.length === 0 && !lead.message && (
            <div className="empty">No interaction details recorded for this lead.</div>
          )}
        </div>

        <div className="detail-side">
          {/* Attribution — the full journey picture */}
          <div className="card">
            <div className="card-head">
              <h3>Attribution</h3>
              {!attributed && <span className="badge warn">unattributed</span>}
            </div>
            <div className="card-body">
              <div className="def-list">
                <Def label="Source">
                  <span style={{ fontWeight: 600 }}>{row.sourceName ?? row.sourceKey ?? "Unattributed"}</span>
                  {row.sourceKey && row.sourceName ? <span className="muted mono" style={{ fontSize: 11 }}> {row.sourceKey}</span> : null}
                </Def>
                <Def label="Medium">{lead.medium}</Def>
                <Def label="Campaign">
                  {row.campaignName ?? null}
                  {row.campaignPlatform ? <span className="muted"> · {row.campaignPlatform}</span> : null}
                </Def>
                <Def label="Keyword">{lead.keyword}</Def>
                <Def label="Landing page">{lead.landingPage ?? session?.landingPage}</Def>
                <Def label="Referrer">{lead.referrer ?? session?.referrer}</Def>
                {clickId && (
                  <Def label="Click ID" title={clickId.label}>
                    <span className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{clickId.value}</span>
                  </Def>
                )}
                <Def label="First seen">{session ? dateTime(session.startedAt) : null}</Def>
                <Def label="UTM">
                  {session && (session.campaign || session.content || session.term)
                    ? [session.campaign, session.content, session.term].filter(Boolean).join(" / ")
                    : null}
                </Def>
              </div>
              {!attributed && (
                <p className="muted" style={{ fontSize: 12, margin: "12px 0 0" }}>
                  No source could be determined for this lead — no click ID, UTM, referrer, or tracking-number match.
                </p>
              )}
              {touches.length > 1 && (
                <div className="touches">
                  {touches.map((a) => (
                    <div key={a.id} className="touch">
                      <span className="badge">{a.touchType}</span>
                      <span className="muted" style={{ fontSize: 12 }}>{a.occurredAt ? dateTime(a.occurredAt) : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Value — what this lead is worth */}
          <div className="card">
            <div className="card-head"><h3>Value</h3></div>
            <div className="card-body">
              <div className="def-list">
                <Def label="Quoted">{lead.quoteValueCents ? dollars(lead.quoteValueCents) : null}</Def>
                <Def label="Won">
                  {lead.salesValueCents ? (
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(lead.salesValueCents)}</span>
                  ) : null}
                </Def>
                {estimate && (
                  <Def label="HCP estimate">
                    {estimate.won ? "won" : estimate.status || "open"}
                    <span className="muted"> · {dollars(estimate.won ? estimate.approvedAmountCents : estimate.totalAmountCents)}</span>
                    {estimate.approvedAtHcp ? <span className="muted"> · approved {dateTime(estimate.approvedAtHcp)}</span> : null}
                  </Def>
                )}
                {job && (
                  <Def label="HCP job">
                    {job.workStatus || "—"}
                    <span className="muted"> · {dollars(job.totalAmountCents)}</span>
                  </Def>
                )}
              </div>
              {!lead.quoteValueCents && !lead.salesValueCents && !estimate && !job && (
                <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                  Not matched to a HousecallPro estimate yet. Matching runs on phone/email during the HCP sync.
                </p>
              )}
            </div>
          </div>

          {/* Contact */}
          <div className="card">
            <div className="card-head"><h3>Contact</h3></div>
            <div className="card-body">
              <div className="def-list">
                <Def label="Name">{lead.name}</Def>
                <Def label="Phone">{lead.phoneE164 ? <a href={`tel:${lead.phoneE164}`} className="link">{formatPhoneDisplay(lead.phoneE164)}</a> : null}</Def>
                <Def label="Email">{lead.emailLc ? <a href={`mailto:${lead.emailLc}`} className="link">{lead.emailLc}</a> : null}</Def>
                <Def label="Returning" title="This contact was seen before this lead">{lead.isFirstTime === false ? "yes" : null}</Def>
                {/* Why this does (or doesn't) count as an estimate request — the
                    thing the Leads list filters on. */}
                <Def label="Lead reason" title="Why this was classified as a lead or not">
                  {lead.leadReason}
                  {lead.isLeadManual ? <span className="muted"> · set by hand</span> : null}
                </Def>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
