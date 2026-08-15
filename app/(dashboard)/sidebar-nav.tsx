"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Everything admin/config-shaped (numbers, integrations, sync) lives under
// Settings — the sidebar stays the day-to-day working set.
const NAV: Array<{ href: string; label: string; ic: string; section?: string }> = [
  { href: "/", label: "Overview", ic: "◧" },
  // Inbox = everything that came in (calls, texts, later email). Estimates = the
  // opportunities, counted from HousecallPro rather than from what we could track,
  // so repeat business and referrals appear instead of being invisible.
  { href: "/inbox", label: "Inbox", ic: "☎" },
  { href: "/estimates", label: "Estimates", ic: "✦" },
  // Sources covers channel, campaign and landing page as views on one page. They
  // were three nav items until 2026-08-15; they are one question at three grains,
  // and separate tabs meant three timeframes to keep in step by hand. /roi and
  // /pages redirect into the matching view.
  { href: "/sources", label: "Sources", ic: "◈" },
  { href: "/settings", label: "Settings", ic: "⚙", section: "Admin" },
];

export function SidebarNav() {
  const path = usePathname();

  // Most-specific match wins: a nav item is active only if it's the longest
  // href that prefixes the current path. Without this, /settings/integrations
  // would light up both "Settings" (via startsWith) and "Integrations".
  const matchLen = (href: string) =>
    href === "/" ? (path === "/" ? 1 : -1) : path === href || path.startsWith(href + "/") ? href.length : -1;
  const best = Math.max(...NAV.map((n) => matchLen(n.href)));
  const isActive = (href: string) => best >= 0 && matchLen(href) === best;

  return (
    <nav className="nav">
      {NAV.map((n) => (
        <div key={n.href}>
          {n.section && <div className="section">{n.section}</div>}
          <Link href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="ic">{n.ic}</span>
            {n.label}
          </Link>
        </div>
      ))}
    </nav>
  );
}
