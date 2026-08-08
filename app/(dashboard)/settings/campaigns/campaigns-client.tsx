"use client";

import { useEffect, useState } from "react";
import { dollars } from "@/lib/format";

type Campaign = {
  id: string;
  platform: string;
  externalCampaignId: string;
  name: string | null;
  excluded: boolean;
  spendCents: number;
  leadsCount: number;
};

const PLATFORM_LABEL: Record<string, string> = {
  google: "Google Ads",
  google_lsa: "Google LSA",
  facebook: "Facebook",
};

export function CampaignsClient() {
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/campaigns");
        const body = await res.json();
        if (body.ok) {
          setRows(body.campaigns);
          setExcluded(new Set<string>(body.campaigns.filter((c: Campaign) => c.excluded).map((c: Campaign) => c.id)));
        } else setErr(body.error || "Couldn't load campaigns");
      } catch {
        setErr("Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggle(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/settings/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedIds: [...excluded] }),
      });
      const body = await res.json();
      setMsg(res.ok && body.ok ? "Saved — takes effect on the next sync." : body.error || "Save failed");
    } catch {
      setMsg("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function cleanup() {
    if (!confirm("Delete leads already captured from the flagged campaigns? This can't be undone.")) return;
    setCleaning(true);
    setCleanMsg("");
    try {
      const res = await fetch("/api/settings/campaigns/cleanup", { method: "POST" });
      const body = await res.json();
      setCleanMsg(
        res.ok && body.ok ? `Removed ${body.removed} lead(s)${body.note ? ` — ${body.note}` : ""}.` : body.error || "Cleanup failed",
      );
    } catch {
      setCleanMsg("Network error");
    } finally {
      setCleaning(false);
    }
  }

  if (loading) return <div className="empty">Loading campaigns…</div>;
  if (err) return <div className="empty" style={{ textAlign: "left" }}>Couldn&apos;t load campaigns — {err}</div>;
  if (!rows?.length) {
    return <div className="empty">No campaigns yet — they appear once the spend sync has run at least once.</div>;
  }

  // Leads still sitting in the inbox against a flagged campaign — what cleanup removes.
  const strandedLeads = rows.filter((c) => excluded.has(c.id)).reduce((n, c) => n + c.leadsCount, 0);

  return (
    <>
      <div className="card pad" style={{ marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Uncheck any campaign that isn&apos;t trying to win customers — <strong>arborist recruiting</strong>, brand
          awareness. Its spend and leads stay on record but are left out of every ROI number: leads, CPL, revenue and
          ROAS. Recruiting spend counted as customer acquisition drags the whole channel&apos;s ROAS down.
        </div>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 44 }} title="Counts toward ROI">ROI</th>
              <th>Campaign</th>
              <th>Platform</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Leads</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const off = excluded.has(c.id);
              return (
                <tr key={c.id} style={off ? { opacity: 0.55 } : undefined}>
                  <td>
                    <input type="checkbox" checked={!off} onChange={() => toggle(c.id)} />
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {c.name ?? "Unnamed campaign"}
                    {off && <span className="badge" style={{ marginLeft: 8 }}>not counted</span>}
                    <div className="muted mono" style={{ fontSize: 11 }}>{c.externalCampaignId}</div>
                  </td>
                  <td className="muted">{PLATFORM_LABEL[c.platform] ?? c.platform}</td>
                  <td className="mono muted" style={{ textAlign: "right" }}>{dollars(c.spendCents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.leadsCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>

      <div
        style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
      >
        <button className="btn" onClick={cleanup} disabled={cleaning || !strandedLeads} style={!strandedLeads ? { opacity: 0.5 } : undefined}>
          {cleaning ? "Removing…" : "Remove leads already captured from unchecked campaigns"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {cleanMsg ||
            (strandedLeads
              ? `${strandedLeads} lead(s) still in the inbox from unchecked campaigns. Save first, then remove.`
              : "Nothing to remove — ROI already ignores unchecked campaigns.")}
        </span>
      </div>
    </>
  );
}
