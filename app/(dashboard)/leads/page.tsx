import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, sources } from "@/lib/db/schema";
import { dateTime, dollars } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const rows = await db
    .select({
      id: leads.id,
      type: leads.type,
      status: leads.status,
      name: leads.name,
      phone: leads.phoneE164,
      email: leads.emailLc,
      sourceKey: sources.key,
      location: leads.location,
      sales: leads.salesValueCents,
      occurredAt: leads.occurredAt,
    })
    .from(leads)
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .orderBy(desc(leads.occurredAt))
    .limit(100);

  return (
    <>
      <h1 className="page-title">Leads</h1>
      <p className="page-sub">Unified inbox — calls, forms, and Facebook leads</p>

      {rows.length === 0 ? (
        <div className="empty">No leads captured yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Contact</th>
              <th>Source</th>
              <th>Location</th>
              <th>Status</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.occurredAt)}</td>
                <td>
                  <span className="badge">{r.type}</span>
                </td>
                <td>
                  {r.name || "—"}
                  <br />
                  <span style={{ color: "var(--muted)" }}>
                    {formatPhoneDisplay(r.phone) || r.email || ""}
                  </span>
                </td>
                <td>{r.sourceKey ?? "—"}</td>
                <td>{r.location}</td>
                <td>
                  <span className="badge">{r.status}</span>
                </td>
                <td>{r.sales ? dollars(r.sales) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
